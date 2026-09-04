package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 需求班底快照 + 必选校验（spec: 2026-09-04-requirement-calendar-design.md §5.2/§11）。
// 创建需求（顶层 issue + project）时从项目默认班底拷贝快照；项目默认的后续变更
// 不影响已建需求。创建路径同时由 server 回填 root_requirement_id（不接受客户端传值）。
func TestIssueRoleRosterSnapshot(t *testing.T) {
	projectID := dbfx.Project(t, "需求班底快照项目")
	atlas := dbfx.Agent(t, "RosterAtlas", testRuntimeID)
	orion := dbfx.Agent(t, "RosterOrion", testRuntimeID)
	kai := dbfx.Agent(t, "RosterKai", testRuntimeID)
	nova := dbfx.Agent(t, "RosterNova", testRuntimeID)

	entry := func(role, agentID string, enabled bool) map[string]any {
		return map[string]any{
			"role": role, "assignee_type": "agent", "assignee_id": agentID, "enabled": enabled,
		}
	}

	putProjectRoles := func(t *testing.T, entries []map[string]any, wantCode int) {
		t.Helper()
		w := httptest.NewRecorder()
		req := withURLParam(newRequest("PUT", "/api/projects/"+projectID+"/role-defaults",
			map[string]any{"entries": entries}), "id", projectID)
		testHandler.ReplaceProjectRoleDefaults(w, req)
		if w.Code != wantCode {
			t.Fatalf("PUT project role-defaults: expected %d, got %d: %s", wantCode, w.Code, w.Body.String())
		}
	}

	createIssue := func(t *testing.T, body map[string]any) string {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, body)
		testHandler.CreateIssue(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
		}
		var issue IssueResponse
		if err := json.NewDecoder(w.Body).Decode(&issue); err != nil {
			t.Fatalf("decode CreateIssue: %v", err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issue.ID)
		})
		return issue.ID
	}

	getIssueRoles := func(t *testing.T, issueID string) []RoleAssignmentResponse {
		t.Helper()
		w := httptest.NewRecorder()
		req := withURLParam(newRequest("GET", "/api/issues/"+issueID+"/roles", nil), "id", issueID)
		testHandler.ListIssueRoleAssignments(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("GET issue roles: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var body struct {
			Roles []RoleAssignmentResponse `json:"roles"`
			Total int                      `json:"total"`
		}
		if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
			t.Fatalf("decode GET issue roles: %v", err)
		}
		if body.Total != len(body.Roles) {
			t.Fatalf("total = %d, but %d roles returned", body.Total, len(body.Roles))
		}
		return body.Roles
	}

	putIssueRoles := func(t *testing.T, issueID string, entries []map[string]any, wantCode int) {
		t.Helper()
		w := httptest.NewRecorder()
		req := withURLParam(newRequest("PUT", "/api/issues/"+issueID+"/roles",
			map[string]any{"entries": entries}), "id", issueID)
		testHandler.ReplaceIssueRoleAssignments(w, req)
		if w.Code != wantCode {
			t.Fatalf("PUT issue roles: expected %d, got %d: %s", wantCode, w.Code, w.Body.String())
		}
	}

	assertRoot := func(t *testing.T, issueID, wantRoot string) {
		t.Helper()
		var got string
		dbfx.QueryRow(t, `SELECT root_requirement_id FROM issue WHERE id = $1`, issueID).Scan(&got)
		if got != wantRoot {
			t.Errorf("issue %s root_requirement_id = %s, want %s", issueID, got, wantRoot)
		}
	}

	findRole := func(roles []RoleAssignmentResponse, role string) *RoleAssignmentResponse {
		for i := range roles {
			if roles[i].Role == role {
				return &roles[i]
			}
		}
		return nil
	}

	// 项目默认班底：pm=Atlas + developer=Orion
	putProjectRoles(t, []map[string]any{
		entry("pm", atlas, true),
		entry("developer", orion, true),
	}, http.StatusOK)

	// 走真实 CreateIssue API 建顶层需求 → 班底快照应自动拷贝
	reqID := createIssue(t, map[string]any{"title": "班底快照需求", "project_id": projectID})

	// root 回填：顶层需求 root = 自身（spec §11：无 parent 的独立 issue 自成一组）
	assertRoot(t, reqID, reqID)

	roles := getIssueRoles(t, reqID)
	if len(roles) != 2 {
		t.Fatalf("snapshot: expected 2 roles, got %d: %+v", len(roles), roles)
	}
	if pm := findRole(roles, "pm"); pm == nil || pm.AssigneeID != atlas {
		t.Errorf("snapshot pm = %+v, want assignee Atlas", pm)
	}
	if dev := findRole(roles, "developer"); dev == nil || dev.AssigneeID != orion {
		t.Errorf("snapshot developer = %+v, want assignee Orion", dev)
	}

	// 子任务沿 parent 继承 root（= 需求 id）
	childID := createIssue(t, map[string]any{"title": "子任务", "parent_issue_id": reqID})
	assertRoot(t, childID, reqID)

	// 改项目默认（pm 换成 Kai）→ 需求快照不变
	putProjectRoles(t, []map[string]any{
		entry("pm", kai, true),
		entry("developer", orion, true),
	}, http.StatusOK)
	roles = getIssueRoles(t, reqID)
	if pm := findRole(roles, "pm"); pm == nil || pm.AssigneeID != atlas {
		t.Errorf("after project default change, requirement pm = %+v, want still Atlas", pm)
	}

	// PUT 需求班底把 developer 全停用 → 409（必选角色校验需求级同样生效）
	putIssueRoles(t, reqID, []map[string]any{
		entry("pm", atlas, true),
		entry("developer", orion, false),
	}, http.StatusConflict)

	// PUT 指派一个不在班底的 assignee 到 prototyper → 200（班底内新增），
	// GET 含新行（原快照两行不受影响）
	putIssueRoles(t, reqID, []map[string]any{
		entry("pm", atlas, true),
		entry("developer", orion, true),
		entry("prototyper", nova, true),
	}, http.StatusOK)
	roles = getIssueRoles(t, reqID)
	if len(roles) != 3 {
		t.Fatalf("after adding prototyper: expected 3 roles, got %d", len(roles))
	}
	if p := findRole(roles, "prototyper"); p == nil || p.AssigneeID != nova || !p.Enabled {
		t.Errorf("prototyper = %+v, want Nova enabled", p)
	}

	// 非需求（有 parent 的子任务）不挂班底端点语义：GET 子任务 roles 为空（快照只拷给顶层需求）
	if roles := getIssueRoles(t, childID); len(roles) != 0 {
		t.Errorf("child issue must have no roster snapshot, got %d", len(roles))
	}
}
