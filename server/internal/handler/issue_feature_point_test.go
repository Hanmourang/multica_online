package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// issue 绑定功能点：feature_code 是归属链的最后一跳
// （项目 → 功能模块 → 原型图 → 功能点），编号的作用域是模块。
//
// 三条不变量在这份测试里各占一段：
//   - 无模块就没有功能点（409），DB 侧同一件事由 CHECK 兜底；
//   - 编号必须在这条 issue 的模块里存在（404，跨模块同号不算数）；
//   - 换/清模块时未显式重设的功能点自动清空（编号不能跨模块继承）。
type issueFeatureShape struct {
	ModuleID    *string `json:"module_id"`
	FeatureCode *string `json:"feature_code"`
}

// seedModuleFeature 直接写投影表：功能点的真源是模块 spec，这里只测引用校验，
// 不必绕一圈 publish 规格。
func seedModuleFeature(t *testing.T, moduleID, code, title string) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(), `
		INSERT INTO project_module_feature (module_id, code, title, kind)
		VALUES ($1, $2, $3, 'core')
		ON CONFLICT (module_id, code) DO NOTHING
	`, moduleID, code, title); err != nil {
		t.Fatalf("seed feature %s/%s: %v", moduleID, code, err)
	}
}

// seedFeaturePointProject 直接建项目/模块，不经 CreateProject/CreateProjectModule：
// 这两个接口会顺带初始化模块规格中心（484）相关的列，而本机开发库不一定跑到
// 那一步。本文件要验的只是「功能点归属」的读写口径，项目与模块用最小行即可。
func seedFeaturePointProject(t *testing.T, title string) (projectID string, moduleIDs map[string]string) {
	t.Helper()
	ctx := context.Background()
	if err := testPool.QueryRow(ctx, `
		INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id
	`, testWorkspaceID, title).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM project WHERE id = $1`, projectID)
	})
	moduleIDs = map[string]string{}
	for _, name := range []string{"本体对象页", "本体详情页", "异项目模块"} {
		var moduleID string
		if err := testPool.QueryRow(ctx, `
			INSERT INTO project_module (project_id, workspace_id, name, color)
			VALUES ($1, $2, $3, $4) RETURNING id
		`, projectID, testWorkspaceID, name, "#64748b").Scan(&moduleID); err != nil {
			t.Fatalf("insert module %q: %v", name, err)
		}
		moduleIDs[name] = moduleID
	}
	return projectID, moduleIDs
}

func TestUpdateIssueFeaturePoint(t *testing.T) {
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	projectP, modulesP := seedFeaturePointProject(t, "Feature point P "+suffix)
	// 第二个项目：用于验证「跨项目同号功能点」不被接受。
	_, modulesP2 := seedFeaturePointProject(t, "Feature point P2 "+suffix)
	modM := modulesP["本体对象页"]
	modM2 := modulesP["本体详情页"]
	modOther := modulesP2["异项目模块"]

	seedModuleFeature(t, modM, "FP-01", "对象列表")
	seedModuleFeature(t, modM, "FP-02", "对象编辑")
	seedModuleFeature(t, modM2, "FP-01", "详情侧栏")
	seedModuleFeature(t, modOther, "FP-02", "异项目同号功能点")

	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (
			workspace_id, title, status, priority, creator_type, creator_id,
			number, position, project_id
		)
		VALUES (
			$1, $2, 'todo', 'none', 'member', $3,
			(SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE workspace_id = $1),
			100, $4
		)
		RETURNING id
	`, testWorkspaceID, "Feature point issue "+suffix, testUserID, projectP).Scan(&issueID); err != nil {
		t.Fatalf("insert issue: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID)
	})

	patch := func(body map[string]any) (*httptest.ResponseRecorder, issueFeatureShape) {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("PATCH", "/api/issues/"+issueID, body)
		req = withURLParams(req, "id", issueID)
		testHandler.UpdateIssue(w, req)
		var resp issueFeatureShape
		if w.Code == http.StatusOK {
			if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
				t.Fatalf("decode patch response: %v", err)
			}
		}
		return w, resp
	}

	// 1) 没有模块就直接挂功能点 → 409（功能点是模块规格的一部分）
	if w, _ := patch(map[string]any{"feature_code": "FP-01"}); w.Code != http.StatusConflict {
		t.Fatalf("feature without module: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 2) 挂模块（不点功能点）→ 200，功能点仍为空
	if w, resp := patch(map[string]any{"module_id": modM}); w.Code != http.StatusOK {
		t.Fatalf("attach module: expected 200, got %d: %s", w.Code, w.Body.String())
	} else if resp.FeatureCode != nil {
		t.Errorf("feature_code after module attach = %v, want nil", *resp.FeatureCode)
	}

	// 3) 合法编号 → 200 且回显
	if w, resp := patch(map[string]any{"feature_code": "FP-01"}); w.Code != http.StatusOK {
		t.Fatalf("bind feature: expected 200, got %d: %s", w.Code, w.Body.String())
	} else if resp.FeatureCode == nil || *resp.FeatureCode != "FP-01" {
		t.Errorf("feature_code = %v, want FP-01", resp.FeatureCode)
	}

	// 4) 编号不在该模块的投影里 → 404（不泄露存在性，与 sprint 同款）
	if w, _ := patch(map[string]any{"feature_code": "FP-99"}); w.Code != http.StatusNotFound {
		t.Fatalf("unknown feature: expected 404, got %d: %s", w.Code, w.Body.String())
	}

	// 5) 换模块而未重设 → 旧编号自动清空（编号只在模块内唯一）
	if w, resp := patch(map[string]any{"module_id": modM2}); w.Code != http.StatusOK {
		t.Fatalf("switch module: expected 200, got %d: %s", w.Code, w.Body.String())
	} else {
		if resp.ModuleID == nil || *resp.ModuleID != modM2 {
			t.Errorf("module_id = %v, want %s", resp.ModuleID, modM2)
		}
		if resp.FeatureCode != nil {
			t.Errorf("feature_code after module switch = %v, want nil (auto-cleared)", *resp.FeatureCode)
		}
	}

	// 6) 跨模块同号不算数：FP-02 只属于 M，站在 M2 上挂它 → 404
	if w, _ := patch(map[string]any{"feature_code": "FP-02"}); w.Code != http.StatusNotFound {
		t.Fatalf("cross-module code: expected 404, got %d: %s", w.Code, w.Body.String())
	}

	// 7) 换模块 + 同时指定新模块的功能点 → 一次写完
	if w, resp := patch(map[string]any{
		"module_id":    modM,
		"feature_code": "FP-02",
	}); w.Code != http.StatusOK {
		t.Fatalf("move module with feature: expected 200, got %d: %s", w.Code, w.Body.String())
	} else if resp.FeatureCode == nil || *resp.FeatureCode != "FP-02" {
		t.Errorf("feature_code = %v, want FP-02", resp.FeatureCode)
	}

	// 8) 显式 null = 解绑功能点，模块保留
	if w, resp := patch(map[string]any{"feature_code": nil}); w.Code != http.StatusOK {
		t.Fatalf("unbind feature: expected 200, got %d: %s", w.Code, w.Body.String())
	} else {
		if resp.FeatureCode != nil {
			t.Errorf("feature_code after unbind = %v, want nil", *resp.FeatureCode)
		}
		if resp.ModuleID == nil || *resp.ModuleID != modM {
			t.Errorf("module_id after unbind = %v, want %s", resp.ModuleID, modM)
		}
	}

	// 9) DB CHECK：绕过 handler 直接清模块而保留功能点必须失败
	if w, _ := patch(map[string]any{"feature_code": "FP-01"}); w.Code != http.StatusOK {
		t.Fatalf("rebind feature: expected 200, got %d", w.Code)
	}
	if _, err := testPool.Exec(ctx, `UPDATE issue SET module_id = NULL WHERE id = $1`, issueID); err == nil {
		t.Fatal("UPDATE clearing module while feature_code set should violate issue_feature_code_requires_module")
	}
}

func TestCreateIssueFeaturePoint(t *testing.T) {
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	projectP, modulesP := seedFeaturePointProject(t, "Feature point create P "+suffix)
	modM := modulesP["本体对象页"]
	seedModuleFeature(t, modM, "FP-01", "确认订单")

	create := func(body map[string]any) (*httptest.ResponseRecorder, issueFeatureShape) {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, body)
		testHandler.CreateIssue(w, req)
		var resp issueFeatureShape
		if w.Code == http.StatusCreated {
			var full struct {
				issueFeatureShape
				ID string `json:"id"`
			}
			if err := json.NewDecoder(w.Body).Decode(&full); err != nil {
				t.Fatalf("decode create response: %v", err)
			}
			resp = full.issueFeatureShape
			t.Cleanup(func() {
				testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, full.ID)
			})
		}
		return w, resp
	}

	// 1) 模块 + 功能点一起创建 → 201 且回显到响应
	w, resp := create(map[string]any{
		"title":        "Feature point create issue " + suffix,
		"project_id":   projectP,
		"module_id":    modM,
		"feature_code": "FP-01",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create with feature: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	if resp.FeatureCode == nil || *resp.FeatureCode != "FP-01" {
		t.Errorf("created feature_code = %v, want FP-01", resp.FeatureCode)
	}

	// 2) 编号不在该模块 → 404
	w, _ = create(map[string]any{
		"title":        "Feature point unknown " + suffix,
		"project_id":   projectP,
		"module_id":    modM,
		"feature_code": "FP-77",
	})
	if w.Code != http.StatusNotFound {
		t.Fatalf("create with unknown feature: expected 404, got %d: %s", w.Code, w.Body.String())
	}

	// 3) 有编号没模块 → 409
	w, _ = create(map[string]any{
		"title":        "Feature point orphan " + suffix,
		"project_id":   projectP,
		"feature_code": "FP-01",
	})
	if w.Code != http.StatusConflict {
		t.Fatalf("create feature without module: expected 409, got %d: %s", w.Code, w.Body.String())
	}
}
