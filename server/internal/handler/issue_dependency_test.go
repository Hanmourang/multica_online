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

// 依赖边 API：PUT 全量置换 + GET 列表。校验规则（spec §3/§6）：
//   - 依赖双方必须同模块（且都必须有模块）——同模块串行靠依赖 DAG 表达；
//   - 写入防环（DFS），违反 409；
//   - PUT 是置换语义，传空数组即清空。
func TestIssueDependencies(t *testing.T) {
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	projectP := createModuleTestProject(t, "Deps P "+suffix)
	modM := createModuleTestModule(t, projectP.ID, "内核")
	modFlow := createModuleTestModule(t, projectP.ID, "Flow 编排")

	insertIssue := func(title, moduleID string) string {
		t.Helper()
		var moduleArg any
		if moduleID != "" {
			moduleArg = moduleID
		}
		var id string
		if err := testPool.QueryRow(ctx, `
			INSERT INTO issue (
				workspace_id, title, status, priority, creator_type, creator_id,
				number, position, project_id, module_id
			)
			VALUES (
				$1, $2, 'todo', 'none', 'member', $3,
				(SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE workspace_id = $1),
				100, $4, $5
			)
			RETURNING id
		`, testWorkspaceID, title+" "+suffix, testUserID, projectP.ID, moduleArg).Scan(&id); err != nil {
			t.Fatalf("insert issue %q: %v", title, err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, id)
		})
		return id
	}

	issueA := insertIssue("Deps A", modM.ID)
	issueB := insertIssue("Deps B", modM.ID)
	issueX := insertIssue("Deps X", modFlow.ID) // 同项目异模块
	issueN := insertIssue("Deps N", "")         // 无模块

	putDeps := func(issueID string, dependsOn []string) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("PUT", "/api/issues/"+issueID+"/dependencies", map[string]any{"depends_on": dependsOn})
		req = withURLParams(req, "id", issueID)
		testHandler.PutIssueDependencies(w, req)
		return w
	}
	getDeps := func(issueID string) []IssueDependencyItem {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("GET", "/api/issues/"+issueID+"/dependencies", nil)
		req = withURLParams(req, "id", issueID)
		testHandler.GetIssueDependencies(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("GetIssueDependencies: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var out []IssueDependencyItem
		if err := json.NewDecoder(w.Body).Decode(&out); err != nil {
			t.Fatalf("decode dependencies: %v", err)
		}
		return out
	}

	// 1) A ← B（A 依赖 B）→ 200；GET 返回 B 及其 status
	if w := putDeps(issueA, []string{issueB}); w.Code != http.StatusOK {
		t.Fatalf("put A<-B: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	deps := getDeps(issueA)
	if len(deps) != 1 || deps[0].IssueID != issueB {
		t.Fatalf("deps of A = %+v, want [%s]", deps, issueB)
	}
	if deps[0].Status != "todo" {
		t.Errorf("dep status = %q, want todo", deps[0].Status)
	}

	// 2) A ← X（异模块）→ 409
	if w := putDeps(issueA, []string{issueX}); w.Code != http.StatusConflict {
		t.Fatalf("put A<-X cross-module: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 3) N（无模块）← B → 409
	if w := putDeps(issueN, []string{issueB}); w.Code != http.StatusConflict {
		t.Fatalf("put N<-B no-module: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 4) 先清空 A 的前置，B ← A → 200；随后 A ← B → 409（成环）
	if w := putDeps(issueA, []string{}); w.Code != http.StatusOK {
		t.Fatalf("clear A deps: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if w := putDeps(issueB, []string{issueA}); w.Code != http.StatusOK {
		t.Fatalf("put B<-A: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if w := putDeps(issueA, []string{issueB}); w.Code != http.StatusConflict {
		t.Fatalf("put A<-B cycle: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 5) 被拒的写入不破坏现状：A 仍为空、B ← A 保留；清空 B → 200
	if deps := getDeps(issueA); len(deps) != 0 {
		t.Fatalf("deps of A after rejected cycle = %+v, want empty", deps)
	}
	deps = getDeps(issueB)
	if len(deps) != 1 || deps[0].IssueID != issueA {
		t.Fatalf("deps of B = %+v, want [%s]", deps, issueA)
	}
	if w := putDeps(issueB, []string{}); w.Code != http.StatusOK {
		t.Fatalf("clear B deps: expected 200, got %d: %s", w.Code, w.Body.String())
	}
}
