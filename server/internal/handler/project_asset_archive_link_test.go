package handler

// 档案 PATCH ↔ 资产 lifecycle 双向同事务联动（五阶段对齐 plan §4.3/§4.4）的
// DB 集成用例：资产原生档案（asset_binding_id 持链）与档案导入资产
// （external_ref.artifact_id）两类关联都要钉住。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// placementFixture 建一个带档案资源的项目，返回 projectID 与 archiveResourceID。
func placementFixture(t *testing.T) (projectID, resourceID string) {
	t.Helper()
	projectID = dbfx.Project(t, "Placement 联动")
	resourceID = dbfx.Insert(t, "project_resource", testutil.Cols{
		"project_id":    projectID,
		"workspace_id":  testWorkspaceID,
		"resource_type": "local_directory",
		"resource_ref":  `{"daemon_id":"placement-link","local_path":"/tmp/placement-link","execution_mode":"in_place"}`,
		"position":      0,
	})
	dbfx.Exec(t, `UPDATE project SET archive_resource_id = $1 WHERE id = $2`, resourceID, projectID)
	return projectID, resourceID
}

func insertAssetBinding(t *testing.T, projectID, name string, lifecycle *string, externalRef string) string {
	t.Helper()
	cols := testutil.Cols{
		"workspace_id":    testWorkspaceID,
		"project_id":      projectID,
		"asset_category":  "knowledge_repo",
		"asset_name":      name,
		"source":          "manual",
		"created_by_type": "member",
		"created_by_id":   testUserID,
		"external_ref":    externalRef,
	}
	if lifecycle != nil {
		cols["lifecycle_stage"] = *lifecycle
	}
	return dbfx.Insert(t, "project_asset_binding", cols)
}

func insertNativeArchiveRow(t *testing.T, projectID, resourceID, bindingID, relPath, docType string, stage int) string {
	t.Helper()
	return dbfx.Insert(t, "project_artifact", testutil.Cols{
		"workspace_id":     testWorkspaceID,
		"project_id":       projectID,
		"resource_id":      resourceID,
		"scope":            "project",
		"stage":            stage,
		"doc_type":         docType,
		"version":          1,
		"rel_path":         relPath,
		"blob_sha":         "",
		"size_bytes":       0,
		"source":           "asset",
		"asset_binding_id": bindingID,
	})
}

func patchArtifact(t *testing.T, projectID, artifactID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := withArtifactURLParams(
		newRequest(http.MethodPatch, "/api/projects/"+projectID+"/artifacts/"+artifactID, body),
		"id", projectID, "artifactId", artifactID,
	)
	testHandler.PatchProjectArtifact(w, req)
	return w
}

func decodeArtifactResponse(t *testing.T, w *httptest.ResponseRecorder) ProjectArtifactResponse {
	t.Helper()
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp ProjectArtifactResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response %q: %v", w.Body.String(), err)
	}
	return resp
}

func bindingLifecycle(t *testing.T, bindingID string) string {
	t.Helper()
	var stage *string
	dbfx.QueryRow(t, `SELECT lifecycle_stage FROM project_asset_binding WHERE id = $1`, bindingID).Scan(&stage)
	if stage == nil {
		return ""
	}
	return *stage
}

func TestPatchArtifactNativeLinkReverseLifecycle(t *testing.T) {
	projectID, resourceID := placementFixture(t)
	bindingID := insertAssetBinding(t, projectID, "联动-原生", strp("S1"), `{}`)
	artifactID := insertNativeArchiveRow(t, projectID, resourceID, bindingID,
		"overview/research/联动态.md", "research", 1)

	// stage 单侧编辑 → 统一映射补 doc_type/rel_path，并反写 binding S1→S3。
	w := patchArtifact(t, projectID, artifactID, map[string]any{"stage": 3})
	resp := decodeArtifactResponse(t, w)
	if resp.Stage == nil || *resp.Stage != 3 || resp.DocType != "architecture" {
		t.Errorf("artifact placement = (%v,%q), want (3,architecture)", resp.Stage, resp.DocType)
	}
	if resp.RelPath != "overview/architecture/联动态.md" {
		t.Errorf("rel_path = %q, want shelf move", resp.RelPath)
	}
	if resp.Source != "asset" {
		t.Errorf("source = %q, asset-native row must keep 'asset'", resp.Source)
	}
	if got := bindingLifecycle(t, bindingID); got != "S3" {
		t.Errorf("binding lifecycle = %q, want S3", got)
	}

	// doc_type 单独编辑（携带旧 stage）→ 反向校正 stage=5 + S5。
	w = patchArtifact(t, projectID, artifactID, map[string]any{"doc_type": "iteration", "stage": 3})
	resp = decodeArtifactResponse(t, w)
	if resp.Stage == nil || *resp.Stage != 5 || resp.DocType != "iteration" {
		t.Errorf("artifact placement = (%v,%q), want (5,iteration)", resp.Stage, resp.DocType)
	}
	if got := bindingLifecycle(t, bindingID); got != "S5" {
		t.Errorf("binding lifecycle = %q, want S5", got)
	}

	// 移入未分阶保留区 → stage NULL + lifecycle 清空。
	w = patchArtifact(t, projectID, artifactID, map[string]any{"doc_type": "asset"})
	resp = decodeArtifactResponse(t, w)
	if resp.Stage != nil || resp.DocType != "asset" {
		t.Errorf("unstaged placement = (%v,%q), want (NULL,asset)", resp.Stage, resp.DocType)
	}
	if got := bindingLifecycle(t, bindingID); got != "" {
		t.Errorf("binding lifecycle = %q, want cleared", got)
	}
}

func TestPatchArtifactImportedLinkReverseLifecycle(t *testing.T) {
	projectID, resourceID := placementFixture(t)
	// 档案原生行（导入来源）+ external_ref 指向它的资产 binding。
	artifactID := dbfx.Insert(t, "project_artifact", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"project_id":   projectID,
		"resource_id":  resourceID,
		"scope":        "project",
		"stage":        2,
		"doc_type":     "product-design",
		"version":      1,
		"rel_path":     "overview/product-design/原型说明.md",
		"blob_sha":     "abc",
		"size_bytes":   10,
		"source":       "sync",
	})
	bindingID := insertAssetBinding(t, projectID, "联动-导入", strp("S2"),
		`{"artifact_id":"`+artifactID+`"}`)

	w := patchArtifact(t, projectID, artifactID, map[string]any{"stage": 4})
	resp := decodeArtifactResponse(t, w)
	if resp.Stage == nil || *resp.Stage != 4 || resp.DocType != "retrospective" {
		t.Errorf("placement = (%v,%q), want (4,retrospective)", resp.Stage, resp.DocType)
	}
	// 导入关联行不是资产原生：维持原规则写 'manual'。
	if resp.Source != "manual" {
		t.Errorf("source = %q, want manual for non-native linked row", resp.Source)
	}
	if got := bindingLifecycle(t, bindingID); got != "S4" {
		t.Errorf("binding lifecycle = %q, want S4", got)
	}

	// 矛盾组合（stage 与 doc_type 不同货架）→ 400，不写库。
	w = patchArtifact(t, projectID, artifactID, map[string]any{"stage": 2, "doc_type": "iteration"})
	if w.Code != http.StatusBadRequest {
		t.Errorf("contradiction status = %d, want 400; body=%s", w.Code, w.Body.String())
	}
	if got := bindingLifecycle(t, bindingID); got != "S4" {
		t.Errorf("binding lifecycle mutated after rejection: %q", got)
	}
}

func TestPatchArtifactUnlinkedKeepsManualRule(t *testing.T) {
	projectID, resourceID := placementFixture(t)
	artifactID := dbfx.Insert(t, "project_artifact", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"project_id":   projectID,
		"resource_id":  resourceID,
		"scope":        "project",
		"stage":        1,
		"doc_type":     "research",
		"version":      1,
		"rel_path":     "overview/research/独立文档.md",
		"blob_sha":     "abc",
		"size_bytes":   10,
		"source":       "sync",
	})

	// 非关联行：stage 单侧编辑不强制货架映射（doc_type 保持原值）。
	w := patchArtifact(t, projectID, artifactID, map[string]any{"stage": 5})
	resp := decodeArtifactResponse(t, w)
	if resp.Stage == nil || *resp.Stage != 5 || resp.DocType != "research" {
		t.Errorf("unlinked edit = (%v,%q), want (5,research)", resp.Stage, resp.DocType)
	}
	if resp.Source != "manual" {
		t.Errorf("source = %q, want manual", resp.Source)
	}

	// moduleOnly 不改 source。
	dbfx.Exec(t, `UPDATE project_artifact SET source='sync' WHERE id=$1`, artifactID)
	w = patchArtifact(t, projectID, artifactID, map[string]any{"doc_module": "评估"})
	resp = decodeArtifactResponse(t, w)
	if resp.Source != "sync" {
		t.Errorf("moduleOnly source = %q, want sync preserved", resp.Source)
	}
}

func TestGetAssetLinkedArchivePreview(t *testing.T) {
	projectID, resourceID := placementFixture(t)

	// 资产原生关联：按 asset_binding_id 返回档案行。
	bindingID := insertAssetBinding(t, projectID, "预览-原生", strp("S1"), `{}`)
	nativeID := insertNativeArchiveRow(t, projectID, resourceID, bindingID,
		"overview/research/预览原生.md", "research", 1)
	w := httptest.NewRecorder()
	req := withArtifactURLParams(
		newRequest(http.MethodGet, "/api/projects/"+projectID+"/assets/"+bindingID+"/archive", nil),
		"id", projectID, "bindingId", bindingID,
	)
	testHandler.GetAssetLinkedArchive(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("native preview = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var resp ProjectArtifactResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ID != nativeID {
		t.Errorf("preview id = %q, want %q", resp.ID, nativeID)
	}

	// 档案导入关联：按 external_ref.artifact_id 返回原 artifact。
	importedArtifactID := dbfx.Insert(t, "project_artifact", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"project_id":   projectID,
		"resource_id":  resourceID,
		"scope":        "project",
		"stage":        3,
		"doc_type":     "architecture",
		"version":      1,
		"rel_path":     "overview/architecture/预览导入.md",
		"blob_sha":     "abc",
		"size_bytes":   8,
		"source":       "sync",
	})
	importBindingID := insertAssetBinding(t, projectID, "预览-导入", strp("S3"),
		`{"artifact_id":"`+importedArtifactID+`"}`)
	w = httptest.NewRecorder()
	req = withArtifactURLParams(
		newRequest(http.MethodGet, "/api/projects/"+projectID+"/assets/"+importBindingID+"/archive", nil),
		"id", projectID, "bindingId", importBindingID,
	)
	testHandler.GetAssetLinkedArchive(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("imported preview = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ID != importedArtifactID {
		t.Errorf("imported preview id = %q, want %q", resp.ID, importedArtifactID)
	}

	// 无关联档案：404（前端降级到附件预览）。
	bareBindingID := insertAssetBinding(t, projectID, "预览-无档", nil, `{"url":"https://x/y"}`)
	w = httptest.NewRecorder()
	req = withArtifactURLParams(
		newRequest(http.MethodGet, "/api/projects/"+projectID+"/assets/"+bareBindingID+"/archive", nil),
		"id", projectID, "bindingId", bareBindingID,
	)
	testHandler.GetAssetLinkedArchive(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("no-link preview = %d, want 404; body=%s", w.Code, w.Body.String())
	}
}

func TestDeleteArtifactLinkedConflict(t *testing.T) {
	projectID, resourceID := placementFixture(t)

	// 资产原生关联行：409。
	bindingID := insertAssetBinding(t, projectID, "删除守卫-原生", strp("S1"), `{}`)
	nativeID := insertNativeArchiveRow(t, projectID, resourceID, bindingID,
		"overview/research/删除守卫.md", "research", 1)
	w := httptest.NewRecorder()
	req := withArtifactURLParams(
		newRequest(http.MethodDelete, "/api/projects/"+projectID+"/artifacts/"+nativeID, nil),
		"id", projectID, "artifactId", nativeID,
	)
	testHandler.DeleteProjectArtifact(w, req)
	if w.Code != http.StatusConflict {
		t.Errorf("native linked delete = %d, want 409; body=%s", w.Code, w.Body.String())
	}

	// 档案导入关联行：409。
	syncedID := dbfx.Insert(t, "project_artifact", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"project_id":   projectID,
		"resource_id":  resourceID,
		"scope":        "project",
		"stage":        3,
		"doc_type":     "architecture",
		"version":      1,
		"rel_path":     "overview/architecture/导入守卫.md",
		"blob_sha":     "abc",
		"size_bytes":   10,
		"source":       "sync",
	})
	insertAssetBinding(t, projectID, "删除守卫-导入", strp("S3"),
		`{"artifact_id":"`+syncedID+`"}`)
	w = httptest.NewRecorder()
	req = withArtifactURLParams(
		newRequest(http.MethodDelete, "/api/projects/"+projectID+"/artifacts/"+syncedID, nil),
		"id", projectID, "artifactId", syncedID,
	)
	testHandler.DeleteProjectArtifact(w, req)
	if w.Code != http.StatusConflict {
		t.Errorf("imported linked delete = %d, want 409; body=%s", w.Code, w.Body.String())
	}

	// 非关联行：正常 204。
	plainID := dbfx.Insert(t, "project_artifact", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"project_id":   projectID,
		"resource_id":  resourceID,
		"scope":        "project",
		"doc_type":     "research",
		"version":      1,
		"rel_path":     "overview/research/普通删除.md",
		"blob_sha":     "abc",
		"size_bytes":   1,
		"source":       "sync",
	})
	w = httptest.NewRecorder()
	req = withArtifactURLParams(
		newRequest(http.MethodDelete, "/api/projects/"+projectID+"/artifacts/"+plainID, nil),
		"id", projectID, "artifactId", plainID,
	)
	testHandler.DeleteProjectArtifact(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("unlinked delete = %d, want 204; body=%s", w.Code, w.Body.String())
	}
}
