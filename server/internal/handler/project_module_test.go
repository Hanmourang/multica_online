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
	w = httptest.NewRecorder()
	req = newRequest("DELETE", "/api/projects/"+project.ID+"/modules/"+second.ID, nil)
	req = withURLParams(req, "id", project.ID, "moduleId", second.ID)
	testHandler.DeleteProjectModule(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("DeleteProjectModule: expected 200, got %d: %s", w.Code, w.Body.String())
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
