package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNormalizeDocModule(t *testing.T) {
	if got := normalizeDocModule("  features/deepseek-harness  "); got != "deepseek-harness" {
		t.Fatalf("got %q", got)
	}
	if got := normalizeDocModule(""); got != "" {
		t.Fatalf("empty: %q", got)
	}
}

func TestNormalizeDocClass(t *testing.T) {
	cases := []struct {
		explicit, docType, rel, want string
	}{
		{"prd", "product-design", "overview/product-design/x.md", "prd"},
		{"", "product-design", "overview/product-design/PRD.md", "prd"},
		{"", "research", "overview/research/MRD.md", "mrd"},
		{"", "requirement", "requirements/REQ-20260913-01/requirement.md", "prd"},
		{"", "work-plan", "change_logs/multica/plans/x.md", "roadmap"},
		{"nope", "architecture", "overview/architecture/a.md", ""},
	}
	for _, c := range cases {
		if got := normalizeDocClass(c.explicit, c.docType, c.rel); got != c.want {
			t.Errorf("%q %s %s: got %q want %q", c.explicit, c.docType, c.rel, got, c.want)
		}
	}
}

func TestListProjectArtifacts_DocClassAndQ(t *testing.T) {
	w := httptest.NewRecorder()
	testHandler.CreateProject(w, newRequest("POST", "/api/projects?workspace_id="+testWorkspaceID, map[string]any{
		"title": "Archive doc class list",
	}))
	project := decodeProject(t, w, http.StatusCreated)
	t.Cleanup(func() {
		req := withURLParam(newRequest("DELETE", "/api/projects/"+project.ID, nil), "id", project.ID)
		testHandler.DeleteProject(httptest.NewRecorder(), req)
	})

	w = httptest.NewRecorder()
	testHandler.CreateProjectResource(w, withURLParam(newRequest("POST", "/api/projects/"+project.ID+"/resources", map[string]any{
		"resource_type": "local_directory",
		"resource_ref": map[string]any{
			"local_path": "/tmp/archive-doc-class",
			"daemon_id":  "daemon-doc-class",
		},
	}), "id", project.ID))
	if w.Code != http.StatusCreated {
		t.Fatalf("resource: %d %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	testHandler.CreateProjectArtifact(w, withURLParam(newRequest("POST", "/api/projects/"+project.ID+"/artifacts", map[string]any{
		"scope":     "project",
		"doc_type":  "product-design",
		"doc_class": "prd",
		"rel_path":  "overview/product-design/PRD.md",
		"version":   1,
	}), "id", project.ID))
	if w.Code != http.StatusCreated {
		t.Fatalf("create prd: %d %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	testHandler.CreateProjectArtifact(w, withURLParam(newRequest("POST", "/api/projects/"+project.ID+"/artifacts", map[string]any{
		"scope":    "project",
		"doc_type": "architecture",
		"rel_path": "overview/architecture/architecture.md",
		"version":  1,
	}), "id", project.ID))
	if w.Code != http.StatusCreated {
		t.Fatalf("create arch: %d %s", w.Code, w.Body.String())
	}

	assertList := func(query string, want int) []ProjectArtifactResponse {
		t.Helper()
		rec := httptest.NewRecorder()
		testHandler.ListProjectArtifacts(rec, withURLParam(
			newRequest("GET", "/api/projects/"+project.ID+"/artifacts"+query, nil),
			"id", project.ID,
		))
		if rec.Code != http.StatusOK {
			t.Fatalf("list %s: %d %s", query, rec.Code, rec.Body.String())
		}
		var body struct {
			Artifacts []ProjectArtifactResponse `json:"artifacts"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body.Artifacts) != want {
			t.Fatalf("list %s: got %d want %d", query, len(body.Artifacts), want)
		}
		return body.Artifacts
	}

	prd := assertList("?doc_class=prd", 1)
	if prd[0].DocClass == nil || *prd[0].DocClass != "prd" {
		t.Fatalf("doc_class not persisted: %+v", prd[0].DocClass)
	}
	assertList("?q=PRD", 1)
	assertList("?doc_class=planning", 1)
	assertList("?doc_type=architecture", 1)
}
