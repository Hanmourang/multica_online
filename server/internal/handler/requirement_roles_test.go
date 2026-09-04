package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 项目默认班底 CRUD + 必选/重复校验（spec: 2026-09-04-requirement-calendar-design.md §5.2/§9）。
// PUT 为 whole-document replace：客户端一次提交完整班底，服务端单语句原子替换。
// 必选角色：pm / developer 至少各一行 enabled（研发可多个 agent）。
func TestProjectRoleDefaultsCRUD(t *testing.T) {
	projectID := dbfx.Project(t, "班底 CRUD 项目")
	atlas := dbfx.Agent(t, "Atlas", testRuntimeID)
	nova := dbfx.Agent(t, "Nova", testRuntimeID)
	orion := dbfx.Agent(t, "Orion", testRuntimeID)
	rex := dbfx.Agent(t, "Rex", testRuntimeID)

	roleURL := "/api/projects/" + projectID + "/role-defaults"
	withProject := func(req *http.Request) *http.Request { return withURLParam(req, "id", projectID) }

	getRoles := func(t *testing.T) []RoleAssignmentResponse {
		t.Helper()
		w := httptest.NewRecorder()
		testHandler.ListProjectRoleDefaults(w, withProject(newRequest("GET", roleURL, nil)))
		if w.Code != http.StatusOK {
			t.Fatalf("GET role-defaults: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var body struct {
			Roles []RoleAssignmentResponse `json:"roles"`
			Total int                      `json:"total"`
		}
		if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
			t.Fatalf("decode GET: %v", err)
		}
		if body.Total != len(body.Roles) {
			t.Fatalf("total = %d, but %d roles returned", body.Total, len(body.Roles))
		}
		return body.Roles
	}

	putRoles := func(t *testing.T, entries []map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		testHandler.ReplaceProjectRoleDefaults(w,
			withProject(newRequest("PUT", roleURL, map[string]any{"entries": entries})))
		return w
	}

	entry := func(role, agentID string, enabled bool) map[string]any {
		return map[string]any{
			"role": role, "assignee_type": "agent", "assignee_id": agentID, "enabled": enabled,
		}
	}

	// GET 空班底
	if got := getRoles(t); len(got) != 0 {
		t.Fatalf("fresh project must have no role defaults, got %d", len(got))
	}

	// PUT 全量替换：pm=Atlas / prototyper=Nova / developer=[Orion, Rex]
	w := putRoles(t, []map[string]any{
		entry("pm", atlas, true),
		entry("prototyper", nova, true),
		entry("developer", orion, true),
		entry("developer", rex, true),
	})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT role-defaults: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	roles := getRoles(t)
	if len(roles) != 4 {
		t.Fatalf("after PUT: expected 4 roles, got %d: %+v", len(roles), roles)
	}
	devCount := 0
	for _, r := range roles {
		if r.Role == "developer" {
			devCount++
			if !r.Enabled {
				t.Errorf("developer %s must stay enabled", r.AssigneeID)
			}
		}
	}
	if devCount != 2 {
		t.Errorf("developer rows = %d, want 2（研发角色可指定多个 agent）", devCount)
	}

	// PUT 追加停用的 tester（enabled=false 占位）
	w = putRoles(t, []map[string]any{
		entry("pm", atlas, true),
		entry("prototyper", nova, true),
		entry("developer", orion, true),
		entry("developer", rex, true),
		entry("tester", rex, false),
	})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT with disabled tester: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	roles = getRoles(t)
	if len(roles) != 5 {
		t.Fatalf("after tester PUT: expected 5 roles, got %d", len(roles))
	}
	foundTester := false
	for _, r := range roles {
		if r.Role == "tester" {
			foundTester = true
			if r.Enabled {
				t.Errorf("tester must be disabled after PUT")
			}
		}
	}
	if !foundTester {
		t.Errorf("tester row missing after PUT")
	}

	// 必选校验：pm 停用 → 409
	w = putRoles(t, []map[string]any{
		entry("pm", atlas, false),
		entry("developer", orion, true),
	})
	if w.Code != http.StatusConflict {
		t.Errorf("pm disabled: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 必选校验：developer 缺失 → 409
	w = putRoles(t, []map[string]any{
		entry("pm", atlas, true),
	})
	if w.Code != http.StatusConflict {
		t.Errorf("developer missing: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 同 role 内重复 assignee → 409
	w = putRoles(t, []map[string]any{
		entry("pm", atlas, true),
		entry("developer", orion, true),
		entry("developer", orion, true),
	})
	if w.Code != http.StatusConflict {
		t.Errorf("duplicate developer: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 非法 role → 400
	w = putRoles(t, []map[string]any{
		entry("pm", atlas, true),
		entry("developer", orion, true),
		entry("wizard", nova, true),
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("unknown role: expected 400, got %d: %s", w.Code, w.Body.String())
	}
}
