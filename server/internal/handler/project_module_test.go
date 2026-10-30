package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 模块 CRUD 生命周期：创建 → 列表 → 改名 → 重名冲突 → 删除。
// 模式对齐 project_resource_test.go：直接调用 handler，httptest 记录响应。
func TestProjectModuleLifecycle(t *testing.T) {
	// 准备一个项目
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects?workspace_id="+testWorkspaceID, map[string]any{
		"title": "Module lifecycle project",
	})
	testHandler.CreateProject(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProject: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var project ProjectResponse
	if err := json.NewDecoder(w.Body).Decode(&project); err != nil {
		t.Fatalf("decode CreateProject: %v", err)
	}
	defer func() {
		req := newRequest("DELETE", "/api/projects/"+project.ID, nil)
		req = withURLParam(req, "id", project.ID)
		testHandler.DeleteProject(httptest.NewRecorder(), req)
	}()

	// 创建模块
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+project.ID+"/modules", map[string]any{
		"name": "内核与配置", "color": "#5B7FFF",
	})
	req = withURLParam(req, "id", project.ID)
	testHandler.CreateProjectModule(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProjectModule: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var created ProjectModuleResponse
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatalf("decode CreateProjectModule: %v", err)
	}
	if created.Name != "内核与配置" || created.Color != "#5B7FFF" {
		t.Errorf("created = %+v", created)
	}

	// 项目内重名 → 409
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+project.ID+"/modules", map[string]any{"name": "内核与配置"})
	req = withURLParam(req, "id", project.ID)
	testHandler.CreateProjectModule(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate name: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 缺省色值
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+project.ID+"/modules", map[string]any{"name": "Flow 与编排"})
	req = withURLParam(req, "id", project.ID)
	testHandler.CreateProjectModule(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProjectModule default color: expected 201, got %d", w.Code)
	}
	var second ProjectModuleResponse
	if err := json.NewDecoder(w.Body).Decode(&second); err != nil {
		t.Fatalf("decode second: %v", err)
	}
	if second.Color != "#8A8F98" {
		t.Errorf("default color = %q, want #8A8F98", second.Color)
	}

	// 列表含两个模块
	w = httptest.NewRecorder()
	req = newRequest("GET", "/api/projects/"+project.ID+"/modules", nil)
	req = withURLParam(req, "id", project.ID)
	testHandler.ListProjectModules(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ListProjectModules: expected 200, got %d", w.Code)
	}
	var list struct {
		Modules []ProjectModuleResponse `json:"modules"`
		Total   int                     `json:"total"`
	}
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if list.Total != 2 {
		t.Fatalf("list total = %d, want 2", list.Total)
	}

	// 改名
	w = httptest.NewRecorder()
	newName := "内核"
	req = newRequest("PATCH", "/api/projects/"+project.ID+"/modules/"+created.ID, map[string]any{"name": newName})
	req = withURLParams(req, "id", project.ID, "moduleId", created.ID)
	testHandler.UpdateProjectModule(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("UpdateProjectModule: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var updated ProjectModuleResponse
	if err := json.NewDecoder(w.Body).Decode(&updated); err != nil {
		t.Fatalf("decode update: %v", err)
	}
	if updated.Name != newName || updated.Color != "#5B7FFF" {
		t.Errorf("updated = %+v, want name=%q color kept", updated, newName)
	}

	// 删除后列表只剩一个
	// 先给待删模块挂一个模块自有原型（issue_id 为空）：owner_check 要求
	// issue_id 与 module_id 至少一个非空，FK 的 SET NULL 会把这种行改成两个都空
	// 并撞 CHECK —— 之前正是这样让整个删除 500。
	if _, err := testHandler.DB.Exec(t.Context(), `
		INSERT INTO issue_prototype_version
			(workspace_id, module_id, version, html_path, prompt, status, created_by_type, created_by_id)
		VALUES ($1, $2, 1, 'prototypes/flow/prototype-v1.html', 'manual upload', 'confirmed', 'member', $3)`,
		testWorkspaceID, second.ID, testUserID); err != nil {
		t.Fatalf("seed module-owned prototype version: %v", err)
	}
	// 模块自有原型的档案行（doc_module 存模块名）也要跟着模块一起软删。
	if _, err := testHandler.DB.Exec(t.Context(), `
		INSERT INTO project_artifact
			(workspace_id, project_id, scope, stage, doc_type, version, rel_path, blob_sha, source, doc_module)
		VALUES ($1, $2, 'project', 1, 'prototype', 1, 'prototypes/flow/prototype-v1.html', '', 'manual', $3)`,
		testWorkspaceID, project.ID, second.Name); err != nil {
		t.Fatalf("seed module prototype artifact: %v", err)
	}

	w = httptest.NewRecorder()
	req = newRequest("DELETE", "/api/projects/"+project.ID+"/modules/"+second.ID, nil)
	req = withURLParams(req, "id", project.ID, "moduleId", second.ID)
	testHandler.DeleteProjectModule(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("DeleteProjectModule: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// 模块自有原型没有可回落的宿主，跟着模块一起消失；不能留下孤儿版本。
	var orphans int
	if err := testHandler.DB.QueryRow(t.Context(),
		`SELECT count(*) FROM issue_prototype_version WHERE module_id = $1`, second.ID,
	).Scan(&orphans); err != nil {
		t.Fatalf("count module prototype versions: %v", err)
	}
	if orphans != 0 {
		t.Errorf("module-owned prototype versions left behind: %d", orphans)
	}

	var artifactGone bool
	if err := testHandler.DB.QueryRow(t.Context(),
		`SELECT deleted_at IS NOT NULL FROM project_artifact
		  WHERE project_id = $1 AND rel_path = 'prototypes/flow/prototype-v1.html'`,
		project.ID,
	).Scan(&artifactGone); err != nil {
		t.Fatalf("read module prototype artifact: %v", err)
	}
	if !artifactGone {
		t.Error("module-owned prototype artifact should be soft-deleted with its module")
	}

	w = httptest.NewRecorder()
	req = newRequest("GET", "/api/projects/"+project.ID+"/modules", nil)
	req = withURLParam(req, "id", project.ID)
	testHandler.ListProjectModules(w, req)
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatalf("decode list after delete: %v", err)
	}
	if list.Total != 1 {
		t.Fatalf("list total after delete = %d, want 1", list.Total)
	}
}
