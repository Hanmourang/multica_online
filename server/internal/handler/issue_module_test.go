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

// issue 模块字段扩展：module_id / avoid_conflict 的创建、更新与项目边界。
// spec §6: PATCH /issues/:id 扩展 module_id、avoid_conflict（module 必须属于
// issue 所在项目）；spec §5: 无模块任务不参与任何锁（显式 null 清空即回退）。
//
// 响应断言刻意解码进本地 moduleShape 而非 IssueResponse：新字段落地前该结构
// 可编译、断言变红（TDD red），落地后转绿。
type issueModuleShape struct {
	ModuleID      *string `json:"module_id"`
	AvoidConflict bool    `json:"avoid_conflict"`
}

func createModuleTestProject(t *testing.T, title string) ProjectResponse {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects?workspace_id="+testWorkspaceID, map[string]any{"title": title})
	testHandler.CreateProject(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProject %q: expected 201, got %d: %s", title, w.Code, w.Body.String())
	}
	var p ProjectResponse
	if err := json.NewDecoder(w.Body).Decode(&p); err != nil {
		t.Fatalf("decode project: %v", err)
	}
	t.Cleanup(func() {
		req := newRequest("DELETE", "/api/projects/"+p.ID, nil)
		req = withURLParams(req, "id", p.ID)
		testHandler.DeleteProject(httptest.NewRecorder(), req)
	})
	return p
}

func createModuleTestModule(t *testing.T, projectID, name string) ProjectModuleResponse {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/modules", map[string]any{"name": name})
	req = withURLParams(req, "id", projectID)
	testHandler.CreateProjectModule(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProjectModule %q: expected 201, got %d: %s", name, w.Code, w.Body.String())
	}
	var m ProjectModuleResponse
	if err := json.NewDecoder(w.Body).Decode(&m); err != nil {
		t.Fatalf("decode module: %v", err)
	}
	return m
}

func TestUpdateIssueModuleFields(t *testing.T) {
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	projectP := createModuleTestProject(t, "Module fields P "+suffix)
	projectP2 := createModuleTestProject(t, "Module fields P2 "+suffix)
	modM := createModuleTestModule(t, projectP.ID, "内核")
	modOther := createModuleTestModule(t, projectP2.ID, "异项目模块")

	// issue I 属于项目 P（直接插库，避免与创建路径的新字段耦合）
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
	`, testWorkspaceID, "Module fields issue "+suffix, testUserID, projectP.ID).Scan(&issueID); err != nil {
		t.Fatalf("insert issue: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID)
	})

	patch := func(body map[string]any) (*httptest.ResponseRecorder, issueModuleShape) {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("PATCH", "/api/issues/"+issueID, body)
		req = withURLParams(req, "id", issueID)
		testHandler.UpdateIssue(w, req)
		var resp issueModuleShape
		if w.Code == http.StatusOK {
			if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
				t.Fatalf("decode patch response: %v", err)
			}
		}
		return w, resp
	}

	// 1) 设置 module + avoid_conflict → 200 且响应携带
	w, resp := patch(map[string]any{"module_id": modM.ID, "avoid_conflict": true})
	if w.Code != http.StatusOK {
		t.Fatalf("set module: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if resp.ModuleID == nil || *resp.ModuleID != modM.ID {
		t.Errorf("module_id = %v, want %s", resp.ModuleID, modM.ID)
	}
	if !resp.AvoidConflict {
		t.Error("avoid_conflict = false, want true")
	}

	// 2) 异项目模块 → 409（module 必须属于 issue 所在项目）
	w, _ = patch(map[string]any{"module_id": modOther.ID})
	if w.Code != http.StatusConflict {
		t.Fatalf("foreign module: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 3) 显式 null 清空模块；avoid_conflict 未触及则保留
	w, resp = patch(map[string]any{"module_id": nil})
	if w.Code != http.StatusOK {
		t.Fatalf("clear module: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if resp.ModuleID != nil {
		t.Errorf("module_id after clear = %v, want nil", *resp.ModuleID)
	}
	if !resp.AvoidConflict {
		t.Error("avoid_conflict should stay true when not touched")
	}

	// 4) 换项目：挂回 M 后移到 P2 —— 模块是项目作用域，跨项目移动自动清空，
	// 保持「模块属于 issue 所在项目」不变式。
	if w, _ := patch(map[string]any{"module_id": modM.ID}); w.Code != http.StatusOK {
		t.Fatalf("re-attach module: expected 200, got %d", w.Code)
	}
	w, resp = patch(map[string]any{"project_id": projectP2.ID})
	if w.Code != http.StatusOK {
		t.Fatalf("move project: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if resp.ModuleID != nil {
		t.Errorf("module_id after project move = %v, want nil (auto-cleared)", *resp.ModuleID)
	}
}

// 创建路径：module_id / avoid_conflict 随创建写入；异项目模块或无项目挂模块拒绝。
func TestCreateIssueModuleFields(t *testing.T) {
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	projectP := createModuleTestProject(t, "Module create P "+suffix)
	projectP2 := createModuleTestProject(t, "Module create P2 "+suffix)
	modM := createModuleTestModule(t, projectP.ID, "内核")
	modOther := createModuleTestModule(t, projectP2.ID, "异项目模块")

	create := func(body map[string]any) (*httptest.ResponseRecorder, issueModuleShape, string) {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, body)
		testHandler.CreateIssue(w, req)
		var resp issueModuleShape
		var issueID string
		if w.Code == http.StatusCreated {
			var full struct {
				issueModuleShape
				ID string `json:"id"`
			}
			if err := json.NewDecoder(w.Body).Decode(&full); err != nil {
				t.Fatalf("decode create response: %v", err)
			}
			resp = full.issueModuleShape
			issueID = full.ID
			t.Cleanup(func() {
				testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID)
			})
		}
		return w, resp, issueID
	}

	// 1) 携带模块 + 避免冲突创建 → 201 且字段回显
	w, resp, issueID := create(map[string]any{
		"title":          "Module create issue " + suffix,
		"project_id":     projectP.ID,
		"module_id":      modM.ID,
		"avoid_conflict": true,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create with module: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	if issueID == "" {
		t.Fatal("create with module: empty issue id")
	}
	if resp.ModuleID == nil || *resp.ModuleID != modM.ID {
		t.Errorf("created module_id = %v, want %s", resp.ModuleID, modM.ID)
	}
	if !resp.AvoidConflict {
		t.Error("created avoid_conflict = false, want true")
	}

	// 2) 异项目模块 → 400
	w, _, _ = create(map[string]any{
		"title":      "Module create mismatch " + suffix,
		"project_id": projectP.ID,
		"module_id":  modOther.ID,
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("create with foreign module: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// 3) 无项目挂模块 → 400（模块是项目作用域）
	w, _, _ = create(map[string]any{
		"title":     "Module create orphan " + suffix,
		"module_id": modM.ID,
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("create module without project: expected 400, got %d: %s", w.Code, w.Body.String())
	}
}
