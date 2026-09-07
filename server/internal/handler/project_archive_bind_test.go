package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUpdateProjectBindsAndClearsArchiveResource(t *testing.T) {
	w := httptest.NewRecorder()
	testHandler.CreateProject(w, newRequest("POST", "/api/projects?workspace_id="+testWorkspaceID, map[string]any{
		"title": "Archive bind project",
	}))
	project := decodeProject(t, w, http.StatusCreated)
	t.Cleanup(func() {
		req := withURLParam(newRequest("DELETE", "/api/projects/"+project.ID, nil), "id", project.ID)
		testHandler.DeleteProject(httptest.NewRecorder(), req)
	})
	if project.ArchiveResourceID != nil {
		t.Fatalf("new project archive_resource_id = %v, want nil", project.ArchiveResourceID)
	}

	w = httptest.NewRecorder()
	req := withURLParam(newRequest("POST", "/api/projects/"+project.ID+"/resources", map[string]any{
		"resource_type": "local_directory",
		"resource_ref": map[string]any{
			"local_path": "/tmp/archive-bind",
			"daemon_id":  "daemon-archive-bind",
		},
	}), "id", project.ID)
	testHandler.CreateProjectResource(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProjectResource: %d %s", w.Code, w.Body.String())
	}
	var resource ProjectResourceResponse
	if err := json.NewDecoder(w.Body).Decode(&resource); err != nil {
		t.Fatalf("decode resource: %v", err)
	}

	w = httptest.NewRecorder()
	testHandler.UpdateProject(w, withURLParam(newRequest("PUT", "/api/projects/"+project.ID, map[string]any{
		"archive_resource_id": resource.ID,
	}), "id", project.ID))
	bound := decodeProject(t, w, http.StatusOK)
	if bound.ArchiveResourceID == nil || *bound.ArchiveResourceID != resource.ID {
		t.Fatalf("bound archive_resource_id = %v, want %s", bound.ArchiveResourceID, resource.ID)
	}

	w = httptest.NewRecorder()
	testHandler.GetProject(w, withURLParam(newRequest("GET", "/api/projects/"+project.ID, nil), "id", project.ID))
	got := decodeProject(t, w, http.StatusOK)
	if got.ArchiveResourceID == nil || *got.ArchiveResourceID != resource.ID {
		t.Fatalf("GET archive_resource_id = %v, want %s", got.ArchiveResourceID, resource.ID)
	}

	w = httptest.NewRecorder()
	testHandler.UpdateProject(w, withURLParam(newRequest("PUT", "/api/projects/"+project.ID, map[string]any{
		"archive_resource_id": nil,
	}), "id", project.ID))
	cleared := decodeProject(t, w, http.StatusOK)
	if cleared.ArchiveResourceID != nil {
		t.Fatalf("cleared archive_resource_id = %v, want nil", cleared.ArchiveResourceID)
	}
}

func TestCreateProjectArtifactAutoBindsLocalDirectory(t *testing.T) {
	w := httptest.NewRecorder()
	testHandler.CreateProject(w, newRequest("POST", "/api/projects?workspace_id="+testWorkspaceID, map[string]any{
		"title": "Archive create autobind",
	}))
	project := decodeProject(t, w, http.StatusCreated)
	t.Cleanup(func() {
		req := withURLParam(newRequest("DELETE", "/api/projects/"+project.ID, nil), "id", project.ID)
		testHandler.DeleteProject(httptest.NewRecorder(), req)
	})

	w = httptest.NewRecorder()
	req := withURLParam(newRequest("POST", "/api/projects/"+project.ID+"/resources", map[string]any{
		"resource_type": "local_directory",
		"resource_ref": map[string]any{
			"local_path": "/tmp/archive-autobind",
			"daemon_id":  "daemon-archive-autobind",
		},
	}), "id", project.ID)
	testHandler.CreateProjectResource(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProjectResource: %d %s", w.Code, w.Body.String())
	}
	var resource ProjectResourceResponse
	if err := json.NewDecoder(w.Body).Decode(&resource); err != nil {
		t.Fatalf("decode resource: %v", err)
	}

	w = httptest.NewRecorder()
	testHandler.CreateProjectArtifact(w, withURLParam(newRequest("POST", "/api/projects/"+project.ID+"/artifacts", map[string]any{
		"scope":    "project",
		"doc_type": "architecture",
		"rel_path": "overview/architecture/architecture.md",
		"version":  1,
	}), "id", project.ID))
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProjectArtifact: %d %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	testHandler.GetProject(w, withURLParam(newRequest("GET", "/api/projects/"+project.ID, nil), "id", project.ID))
	got := decodeProject(t, w, http.StatusOK)
	if got.ArchiveResourceID == nil || *got.ArchiveResourceID != resource.ID {
		t.Fatalf("auto-bind archive_resource_id = %v, want %s", got.ArchiveResourceID, resource.ID)
	}
}

func TestCreateProjectArtifactWithoutResourceReturns404(t *testing.T) {
	w := httptest.NewRecorder()
	testHandler.CreateProject(w, newRequest("POST", "/api/projects?workspace_id="+testWorkspaceID, map[string]any{
		"title": "Archive create missing",
	}))
	project := decodeProject(t, w, http.StatusCreated)
	t.Cleanup(func() {
		req := withURLParam(newRequest("DELETE", "/api/projects/"+project.ID, nil), "id", project.ID)
		testHandler.DeleteProject(httptest.NewRecorder(), req)
	})

	w = httptest.NewRecorder()
	testHandler.CreateProjectArtifact(w, withURLParam(newRequest("POST", "/api/projects/"+project.ID+"/artifacts", map[string]any{
		"scope":    "project",
		"doc_type": "architecture",
		"rel_path": "overview/architecture/architecture.md",
		"version":  1,
	}), "id", project.ID))
	if w.Code != http.StatusNotFound {
		t.Fatalf("CreateProjectArtifact unbound: %d %s", w.Code, w.Body.String())
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if body.Code != "archive_resource_missing" {
		t.Fatalf("error code = %q, want archive_resource_missing (%s)", body.Code, body.Error)
	}
}
