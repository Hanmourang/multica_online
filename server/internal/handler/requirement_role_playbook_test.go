package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
)

func ensureRolePlaybookSchema(t *testing.T) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(), `SELECT 1 FROM project_role_playbook LIMIT 0`); err == nil {
		return
	}
	sql, err := os.ReadFile("../migrations/462_role_playbook.up.sql")
	if err != nil {
		sql, err = os.ReadFile("../../migrations/462_role_playbook.up.sql")
	}
	if err != nil {
		t.Skipf("role playbook migration not applied and file not found: %v", err)
	}
	if _, err := testPool.Exec(context.Background(), string(sql)); err != nil {
		t.Fatalf("apply role playbook schema: %v", err)
	}
}

func TestProjectRolePlaybooksCRUD(t *testing.T) {
	ensureRolePlaybookSchema(t)
	projectID := dbfx.Project(t, "角色标准 CRUD 项目")
	url := "/api/projects/" + projectID + "/role-playbooks"
	withProject := func(req *http.Request) *http.Request { return withURLParam(req, "id", projectID) }

	get := func(t *testing.T) map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		testHandler.ListProjectRolePlaybooks(w, withProject(newRequest("GET", url, nil)))
		if w.Code != http.StatusOK {
			t.Fatalf("GET playbooks: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var body map[string]any
		if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
			t.Fatalf("decode GET: %v", err)
		}
		return body
	}

	fresh := get(t)
	playbooks, _ := fresh["playbooks"].(map[string]any)
	if playbooks["pm"] == nil {
		t.Fatalf("GET empty project must still return resolved builtins: %+v", fresh)
	}
	overrides, _ := fresh["overrides"].(map[string]any)
	if len(overrides) != 0 {
		t.Fatalf("fresh project must have no overrides, got %+v", overrides)
	}

	w := httptest.NewRecorder()
	testHandler.ReplaceProjectRolePlaybooks(w, withProject(newRequest("PUT", url, map[string]any{
		"overrides": map[string]any{
			"developer": map[string]any{
				"standards": "只允许改 packages/views",
				"init_mode": "checklist",
			},
		},
	})))
	if w.Code != http.StatusOK {
		t.Fatalf("PUT playbooks: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	after := get(t)
	ov, _ := after["overrides"].(map[string]any)
	dev, _ := ov["developer"].(map[string]any)
	if dev["standards"] != "只允许改 packages/views" {
		t.Fatalf("developer override lost: %+v", ov)
	}
	resolved, _ := after["playbooks"].(map[string]any)
	devResolved, _ := resolved["developer"].(map[string]any)
	if devResolved["source"] != "custom" {
		t.Fatalf("resolved developer should be custom: %+v", devResolved)
	}
	if devResolved["background"] == "" {
		t.Fatalf("unoverridden background should fall back to builtin")
	}

	w = httptest.NewRecorder()
	testHandler.ReplaceProjectRolePlaybooks(w, withProject(newRequest("PUT", url, map[string]any{
		"overrides": map[string]any{"wizard": map[string]any{"background": "x"}},
	})))
	if w.Code != http.StatusBadRequest {
		t.Errorf("unknown role: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	testHandler.ReplaceProjectRolePlaybooks(w, withProject(newRequest("PUT", url, map[string]any{
		"overrides": map[string]any{"pm": map[string]any{"init_mode": "freestyle"}},
	})))
	if w.Code != http.StatusBadRequest {
		t.Errorf("invalid init_mode: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// 清空覆盖
	w = httptest.NewRecorder()
	testHandler.ReplaceProjectRolePlaybooks(w, withProject(newRequest("PUT", url, map[string]any{
		"overrides": map[string]any{},
	})))
	if w.Code != http.StatusOK {
		t.Fatalf("PUT empty: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	cleared := get(t)
	if ov, _ := cleared["overrides"].(map[string]any); len(ov) != 0 {
		t.Fatalf("empty PUT should drop overrides: %+v", ov)
	}
}

func TestIssueRolePlaybooksSnapshotAndOverride(t *testing.T) {
	ensureRolePlaybookSchema(t)
	projectID := dbfx.Project(t, "角色标准快照项目")
	projURL := "/api/projects/" + projectID + "/role-playbooks"
	w := httptest.NewRecorder()
	testHandler.ReplaceProjectRolePlaybooks(w, withURLParam(newRequest("PUT", projURL, map[string]any{
		"overrides": map[string]any{
			"pm": map[string]any{"background": "项目级 PM 必须先写风险"},
		},
	}), "id", projectID))
	if w.Code != http.StatusOK {
		t.Fatalf("seed project playbook: %d %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	testHandler.CreateIssue(w, newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title": "带项目需求", "project_id": projectID,
	}))
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: %d %s", w.Code, w.Body.String())
	}
	var created IssueResponse
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatalf("decode CreateIssue: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, created.ID)
	})
	issueID := created.ID
	issueURL := "/api/issues/" + issueID + "/role-playbooks"
	w = httptest.NewRecorder()
	testHandler.ListIssueRolePlaybooks(w, withURLParam(newRequest("GET", issueURL, nil), "id", issueID))
	if w.Code != http.StatusOK {
		t.Fatalf("GET issue playbooks: %d %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	ov, _ := body["overrides"].(map[string]any)
	pm, _ := ov["pm"].(map[string]any)
	if pm["background"] != "项目级 PM 必须先写风险" {
		t.Fatalf("create should snapshot project playbook, got %+v", ov)
	}

	w = httptest.NewRecorder()
	testHandler.ReplaceIssueRolePlaybooks(w, withURLParam(newRequest("PUT", issueURL, map[string]any{
		"overrides": map[string]any{
			"pm": map[string]any{"background": "本需求 PM 只拆本模块"},
		},
	}), "id", issueID))
	if w.Code != http.StatusOK {
		t.Fatalf("PUT issue playbooks: %d %s", w.Code, w.Body.String())
	}

	// 改项目默认不得影响已快照需求
	w = httptest.NewRecorder()
	testHandler.ReplaceProjectRolePlaybooks(w, withURLParam(newRequest("PUT", projURL, map[string]any{
		"overrides": map[string]any{
			"pm": map[string]any{"background": "项目后来改了"},
		},
	}), "id", projectID))
	if w.Code != http.StatusOK {
		t.Fatalf("update project playbook: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	testHandler.ListIssueRolePlaybooks(w, withURLParam(newRequest("GET", issueURL, nil), "id", issueID))
	_ = json.NewDecoder(w.Body).Decode(&body)
	ov, _ = body["overrides"].(map[string]any)
	pm, _ = ov["pm"].(map[string]any)
	if pm["background"] != "本需求 PM 只拆本模块" {
		t.Fatalf("issue snapshot must stay after project change: %+v", ov)
	}

	if service.BuiltinRolePlaybook("pm").Background == "" {
		t.Fatal("sanity: builtin pm exists")
	}
}
