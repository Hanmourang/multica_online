package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestListProjectArtifacts_AssetRoleLinks 钉住交付物口径依赖的两类关联解析：
//   - archive-import 只把 artifact_id 存在 binding.external_ref 里 →
//     列表仍要给该档案补上 asset_binding_id/asset_role；
//   - 资产原生入档（source='asset'）→ 同样补关联，未标对象时 role 缺省。
//
// 前端据此把「对象≠产物」的档案挡在交付物 TAB 之外，两个字段任一丢失都会
// 让上传的输入物重新混进交付物。
func TestListProjectArtifacts_AssetRoleLinks(t *testing.T) {
	w := httptest.NewRecorder()
	testHandler.CreateProject(w, newRequest("POST", "/api/projects?workspace_id="+testWorkspaceID, map[string]any{
		"title": "Deliverable asset links",
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
			"local_path": "/tmp/archive-asset-links",
			"daemon_id":  "daemon-asset-links",
		},
	}), "id", project.ID))
	if w.Code != http.StatusCreated {
		t.Fatalf("resource: %d %s", w.Code, w.Body.String())
	}

	createArtifact := func(rel string) string {
		t.Helper()
		rec := httptest.NewRecorder()
		testHandler.CreateProjectArtifact(rec, withURLParam(newRequest("POST", "/api/projects/"+project.ID+"/artifacts", map[string]any{
			"scope":    "project",
			"doc_type": "research",
			"rel_path": rel,
			"version":  1,
		}), "id", project.ID))
		if rec.Code != http.StatusCreated {
			t.Fatalf("create artifact %s: %d %s", rel, rec.Code, rec.Body.String())
		}
		var body ProjectArtifactResponse
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return body.ID
	}

	bind := func(body map[string]any) {
		t.Helper()
		rec := httptest.NewRecorder()
		testHandler.BindProjectAsset(rec, withURLParam(newRequest("POST", "/api/projects/"+project.ID+"/assets", body), "id", project.ID))
		if rec.Code != http.StatusCreated {
			t.Fatalf("bind %v: %d %s", body["asset_name"], rec.Code, rec.Body.String())
		}
	}

	inputID := createArtifact("overview/research/import-in.md")
	outputID := createArtifact("overview/research/import-out.md")
	bind(map[string]any{
		"asset_category": "knowledge_repo",
		"asset_name":     "import-in",
		"source":         "archive",
		"asset_role":     "input",
		"external_ref":   map[string]any{"artifact_id": inputID, "rel_path": "import-in.md"},
	})
	bind(map[string]any{
		"asset_category": "knowledge_repo",
		"asset_name":     "import-out",
		"source":         "archive",
		"asset_role":     "output",
		"external_ref":   map[string]any{"artifact_id": outputID, "rel_path": "import-out.md"},
	})
	// 原生入档：只有 filename 载荷、未标对象 → 新建 source='asset' 档案行。
	bind(map[string]any{
		"asset_category": "other",
		"asset_name":     "upload-note",
		"source":         "manual",
		"external_ref":   map[string]any{"filename": "upload-note.md", "rel_path": "upload-note.md"},
	})

	rec := httptest.NewRecorder()
	testHandler.ListProjectArtifacts(rec, withURLParam(
		newRequest("GET", "/api/projects/"+project.ID+"/artifacts", nil), "id", project.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Artifacts []ProjectArtifactResponse `json:"artifacts"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}

	byPath := map[string]ProjectArtifactResponse{}
	for _, a := range body.Artifacts {
		byPath[a.RelPath] = a
	}

	in, ok := byPath["overview/research/import-in.md"]
	if !ok || in.AssetBindingID == nil || in.AssetRole == nil || *in.AssetRole != "input" {
		t.Fatalf("import input link not resolved: %+v", in)
	}
	out, ok := byPath["overview/research/import-out.md"]
	if !ok || out.AssetBindingID == nil || out.AssetRole == nil || *out.AssetRole != "output" {
		t.Fatalf("import output link not resolved: %+v", out)
	}
	native, ok := byPath["assets/other/upload-note.md"]
	if !ok || native.AssetBindingID == nil {
		t.Fatalf("native asset link not resolved: %+v", native)
	}
	if native.AssetRole != nil {
		t.Fatalf("unclassified asset must keep role empty, got %q", *native.AssetRole)
	}
}
