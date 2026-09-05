package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// 档案同步的数据丢失防线（migration 455 project_artifact；原型
// docs/superpowers/specs/2026-09-05-project-archive-prototype.html anno④/anno⑤）。
//
// Two regressions are pinned here, both of them silent archive loss:
//
//  1. An empty manifest used to soft-delete EVERY live row of the archive
//     resource ("An empty manifest still deletes"), and the Web console's
//     「立即同步」 button sent exactly that — one click wiped the archive.
//     Empty is now a no-op; purging needs allow_empty_manifest.
//  2. The manifest upsert used to overwrite issue_id unconditionally, so a
//     human binding (source='manual', the 「仅改 DB 指针」 override) was undone
//     by the next CLI sync while the row still claimed a human made it.
//     Manual rows now keep their issue_id and are exempt from the soft-delete;
//     both are reported as preserved_manual.

// artifactSyncProbe is the response shape these assertions read. Declared here
// rather than reusing ArtifactSyncResult so a renamed JSON key fails the test
// loudly instead of decoding into a zero value that happens to match.
type artifactSyncProbe struct {
	CreatedCount      int    `json:"created_count"`
	UpdatedCount      int    `json:"updated_count"`
	DeletedCount      int    `json:"deleted_count"`
	PreservedManual   int    `json:"preserved_manual"`
	SkippedSoftDelete bool   `json:"skipped_soft_delete"`
	SkipReason        string `json:"skip_reason"`
}

// archiveSyncFixture builds the smallest world a sync can act on: a project,
// its archive directory resource wired into project.archive_resource_id, and
// two requirements in that project to bind artifacts to.
func archiveSyncFixture(t *testing.T) (projectID, resourceID, issueAID, issueBID string) {
	t.Helper()
	projectID = dbfx.Project(t, "Archive sync guard")
	resourceID = dbfx.Insert(t, "project_resource", testutil.Cols{
		"project_id":    projectID,
		"workspace_id":  testWorkspaceID,
		"resource_type": "local_directory",
		"resource_ref":  `{"daemon_id":"archive-guard","local_path":"/tmp/archive-sync-guard","execution_mode":"in_place"}`,
		"position":      0,
	})
	dbfx.Exec(t, `UPDATE project SET archive_resource_id = $1 WHERE id = $2`, resourceID, projectID)
	issueAID = dbfx.Issue(t, "档案守卫 需求 A", testutil.Cols{"project_id": projectID})
	issueBID = dbfx.Issue(t, "档案守卫 需求 B", testutil.Cols{"project_id": projectID})
	return projectID, resourceID, issueAID, issueBID
}

// withArtifactURLParams stamps several chi URL params at once. The shared
// withURLParam helper installs a fresh route context per call, so chaining it
// would drop the params added earlier — a bind request needs both {id} and
// {artifactId}.
func withArtifactURLParams(req *http.Request, kv ...string) *http.Request {
	rctx := chi.NewRouteContext()
	for i := 0; i+1 < len(kv); i += 2 {
		rctx.URLParams.Add(kv[i], kv[i+1])
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func postArtifactSync(t *testing.T, projectID string, body any) (*httptest.ResponseRecorder, artifactSyncProbe) {
	t.Helper()
	w := httptest.NewRecorder()
	req := withArtifactURLParams(
		newRequest(http.MethodPost, "/api/projects/"+projectID+"/artifacts/sync", body),
		"id", projectID,
	)
	testHandler.SyncProjectArtifacts(w, req)
	var probe artifactSyncProbe
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &probe); err != nil {
			t.Fatalf("decode sync response %q: %v", w.Body.String(), err)
		}
	}
	return w, probe
}

// syncManifestItem is one CLI manifest entry; only the fields a case cares
// about are set, the rest take the handler's required defaults.
func syncManifestItem(relPath, blobSha, scope, docType string, issueID string) map[string]any {
	item := map[string]any{
		"rel_path":   relPath,
		"blob_sha":   blobSha,
		"scope":      scope,
		"doc_type":   docType,
		"version":    1,
		"size_bytes": 128,
	}
	if issueID != "" {
		item["issue_id"] = issueID
	}
	return item
}

func bindArtifact(t *testing.T, projectID, artifactID, issueID string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := withArtifactURLParams(
		newRequest(http.MethodPost, "/api/projects/"+projectID+"/artifacts/"+artifactID+"/bind",
			map[string]any{"issue_id": issueID}),
		"id", projectID, "artifactId", artifactID,
	)
	testHandler.BindProjectArtifact(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("bind artifact %s: status = %d, body = %s", artifactID, w.Code, w.Body.String())
	}
}

func artifactIDByPath(t *testing.T, resourceID, relPath string) string {
	t.Helper()
	var id string
	dbfx.QueryRow(t,
		`SELECT id FROM project_artifact WHERE resource_id = $1 AND rel_path = $2`,
		resourceID, relPath).Scan(&id)
	return id
}

func liveArtifactCount(t *testing.T, resourceID string) int {
	t.Helper()
	return dbfx.Count(t,
		`SELECT count(*) FROM project_artifact WHERE resource_id = $1 AND deleted_at IS NULL`,
		resourceID)
}

// seedSyncedArtifacts inserts rows straight into the table the way a previous
// CLI sync would have left them, so a case can start from a populated archive
// without spending its first assertion on the upsert path.
func seedSyncedArtifacts(t *testing.T, resourceID, projectID string, relPaths ...string) {
	t.Helper()
	for i, relPath := range relPaths {
		dbfx.Insert(t, "project_artifact", testutil.Cols{
			"workspace_id": testWorkspaceID,
			"project_id":   projectID,
			"resource_id":  resourceID,
			"scope":        "project",
			"doc_type":     "product-design",
			"version":      1,
			"rel_path":     relPath,
			"blob_sha":     "seed-sha-" + string(rune('a'+i)),
			"size_bytes":   64,
			"source":       "sync",
		})
	}
}

// TestSyncProjectArtifacts_EmptyManifestIsNoOp is 用例 A: the exact request the
// Web console used to send must not delete anything, and must say so. The
// second phase proves the guard did not simply disable the diff — a manifest
// that names one of three paths still soft-deletes the other two.
func TestSyncProjectArtifacts_EmptyManifestIsNoOp(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	projectID, resourceID, _, _ := archiveSyncFixture(t)
	seedSyncedArtifacts(t, resourceID, projectID,
		"overview/product-design.md",
		"requirements/s1-a/design.md",
		"_shared/glossary.md",
	)

	w, got := postArtifactSync(t, projectID, map[string]any{"artifacts": []map[string]any{}})
	if w.Code != http.StatusOK {
		t.Fatalf("empty manifest: status = %d, body = %s", w.Code, w.Body.String())
	}
	if !got.SkippedSoftDelete {
		t.Fatalf("empty manifest: skipped_soft_delete = false, want true (body = %s)", w.Body.String())
	}
	if got.SkipReason != "empty_manifest" {
		t.Fatalf("empty manifest: skip_reason = %q, want %q", got.SkipReason, "empty_manifest")
	}
	if got.DeletedCount != 0 || got.CreatedCount != 0 || got.UpdatedCount != 0 {
		t.Fatalf("empty manifest: created/updated/deleted = %d/%d/%d, want 0/0/0",
			got.CreatedCount, got.UpdatedCount, got.DeletedCount)
	}
	if n := liveArtifactCount(t, resourceID); n != 3 {
		t.Fatalf("empty manifest soft-deleted rows: live = %d, want 3", n)
	}

	// Control: a real manifest still diffs. Naming one of the three paths
	// deletes the two that dropped out.
	w, got = postArtifactSync(t, projectID, map[string]any{
		"artifacts": []map[string]any{
			syncManifestItem("overview/product-design.md", "sha-next", "project", "product-design", ""),
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("single-item manifest: status = %d, body = %s", w.Code, w.Body.String())
	}
	if got.SkippedSoftDelete || got.SkipReason != "" {
		t.Fatalf("single-item manifest: skipped_soft_delete = %v (%q), want false", got.SkippedSoftDelete, got.SkipReason)
	}
	if got.UpdatedCount != 1 || got.DeletedCount != 2 {
		t.Fatalf("single-item manifest: updated/deleted = %d/%d, want 1/2", got.UpdatedCount, got.DeletedCount)
	}
	if n := liveArtifactCount(t, resourceID); n != 1 {
		t.Fatalf("single-item manifest: live = %d, want 1", n)
	}
}

// TestSyncProjectArtifacts_MissingArtifactsFieldIsBadRequest pins the other
// half of the guard: an absent `artifacts` key is still a protocol error. Go's
// decoder leaves the slice nil for a missing key but returns an empty NON-nil
// slice for `[]`, so the two are distinguishable and only `[]` is a no-op.
func TestSyncProjectArtifacts_MissingArtifactsFieldIsBadRequest(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	projectID, resourceID, _, _ := archiveSyncFixture(t)
	seedSyncedArtifacts(t, resourceID, projectID, "overview/product-design.md")

	w := httptest.NewRecorder()
	req := withArtifactURLParams(
		newRequest(http.MethodPost, "/api/projects/"+projectID+"/artifacts/sync", map[string]any{}),
		"id", projectID,
	)
	testHandler.SyncProjectArtifacts(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing artifacts: status = %d, want 400 (body = %s)", w.Code, w.Body.String())
	}
	if n := liveArtifactCount(t, resourceID); n != 1 {
		t.Fatalf("missing artifacts: live = %d, want 1 (a rejected request must not write)", n)
	}
}

// TestSyncProjectArtifacts_EmptyManifestPurgeRequiresExplicitFlag is 用例 C:
// clearing the archive is still possible, but only for a caller that says so.
// The flag lifts the empty-manifest rule and nothing else — source='manual'
// rows stay exempt, because a purge removes synced pointers, not human calls.
func TestSyncProjectArtifacts_EmptyManifestPurgeRequiresExplicitFlag(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	projectID, resourceID, issueAID, _ := archiveSyncFixture(t)
	seedSyncedArtifacts(t, resourceID, projectID,
		"overview/product-design.md",
		"requirements/s1-a/design.md",
	)
	// A third row a human bound by hand.
	manualPath := "requirements/s1-a/manual-note.md"
	seedSyncedArtifacts(t, resourceID, projectID, manualPath)
	bindArtifact(t, projectID, artifactIDByPath(t, resourceID, manualPath), issueAID)

	w, got := postArtifactSync(t, projectID, map[string]any{
		"artifacts":            []map[string]any{},
		"allow_empty_manifest": true,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("confirmed purge: status = %d, body = %s", w.Code, w.Body.String())
	}
	if got.SkippedSoftDelete || got.SkipReason != "" {
		t.Fatalf("confirmed purge: skipped_soft_delete = %v (%q), want false", got.SkippedSoftDelete, got.SkipReason)
	}
	if got.DeletedCount != 2 {
		t.Fatalf("confirmed purge: deleted_count = %d, want 2 (the two synced rows)", got.DeletedCount)
	}
	if got.PreservedManual != 1 {
		t.Fatalf("confirmed purge: preserved_manual = %d, want 1", got.PreservedManual)
	}
	if n := liveArtifactCount(t, resourceID); n != 1 {
		t.Fatalf("confirmed purge: live = %d, want 1 (only the manual row)", n)
	}
	var source string
	dbfx.QueryRow(t,
		`SELECT source FROM project_artifact WHERE resource_id = $1 AND deleted_at IS NULL`,
		resourceID).Scan(&source)
	if source != "manual" {
		t.Fatalf("confirmed purge survivor: source = %q, want %q", source, "manual")
	}
}

// TestSyncProjectArtifacts_ManualBindingSurvivesLaterSync is 用例 B: the
// override path the prototype warns about (anno⑤). A row bound by hand keeps
// its issue_id when the next manifest disagrees, while a machine-owned row in
// the very same manifest follows the manifest — the protection is targeted, not
// a blanket freeze. Pointer metadata (blob_sha) still refreshes on both.
func TestSyncProjectArtifacts_ManualBindingSurvivesLaterSync(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	projectID, resourceID, issueAID, issueBID := archiveSyncFixture(t)

	const manualPath = "requirements/s1-a/design.md"
	const syncedPath = "requirements/s1-b/design.md"
	w, got := postArtifactSync(t, projectID, map[string]any{
		"artifacts": []map[string]any{
			syncManifestItem(manualPath, "sha-v1", "requirement", "architecture", issueBID),
			syncManifestItem(syncedPath, "sha-v1", "requirement", "architecture", issueBID),
		},
	})
	if w.Code != http.StatusOK || got.CreatedCount != 2 {
		t.Fatalf("seed sync: status = %d, created = %d, body = %s", w.Code, got.CreatedCount, w.Body.String())
	}

	// The human override: 「仅改 DB 指针」 rebinds the first row to 需求 A and
	// stamps source='manual'.
	bindArtifact(t, projectID, artifactIDByPath(t, resourceID, manualPath), issueAID)

	// Next CLI sync disagrees about BOTH rows and carries a new blob sha.
	w, got = postArtifactSync(t, projectID, map[string]any{
		"artifacts": []map[string]any{
			syncManifestItem(manualPath, "sha-v2", "requirement", "architecture", issueBID),
			syncManifestItem(syncedPath, "sha-v2", "requirement", "architecture", issueAID),
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("second sync: status = %d, body = %s", w.Code, w.Body.String())
	}
	if got.PreservedManual != 1 {
		t.Fatalf("second sync: preserved_manual = %d, want 1", got.PreservedManual)
	}
	if got.UpdatedCount != 2 || got.DeletedCount != 0 {
		t.Fatalf("second sync: updated/deleted = %d/%d, want 2/0", got.UpdatedCount, got.DeletedCount)
	}

	var issueID, source, blobSha string
	dbfx.QueryRow(t,
		`SELECT issue_id::text, source, blob_sha FROM project_artifact
		 WHERE resource_id = $1 AND rel_path = $2`, resourceID, manualPath,
	).Scan(&issueID, &source, &blobSha)
	if issueID != issueAID {
		t.Fatalf("manual row issue_id = %s, want %s (the human binding was overwritten)", issueID, issueAID)
	}
	if source != "manual" {
		t.Fatalf("manual row source = %q, want %q", source, "manual")
	}
	if blobSha != "sha-v2" {
		t.Fatalf("manual row blob_sha = %q, want %q (pointer metadata must still refresh)", blobSha, "sha-v2")
	}

	dbfx.QueryRow(t,
		`SELECT issue_id::text, source, blob_sha FROM project_artifact
		 WHERE resource_id = $1 AND rel_path = $2`, resourceID, syncedPath,
	).Scan(&issueID, &source, &blobSha)
	if issueID != issueAID {
		t.Fatalf("synced row issue_id = %s, want %s (a machine row follows the manifest)", issueID, issueAID)
	}
	if source != "sync" {
		t.Fatalf("synced row source = %q, want %q", source, "sync")
	}
}

// TestSyncProjectArtifacts_ManualRowExemptFromSoftDelete covers the delete half
// of the same invariant: a manual row that the manifest does not mention is NOT
// a file that disappeared — it is a row the path contract never described, so
// the contract may not retire it. Synced rows absent from the manifest still do
// get soft-deleted, and both numbers land in the response.
func TestSyncProjectArtifacts_ManualRowExemptFromSoftDelete(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	projectID, resourceID, issueAID, _ := archiveSyncFixture(t)
	seedSyncedArtifacts(t, resourceID, projectID,
		"overview/product-design.md",  // synced, will drop out of the manifest
		"requirements/s1-a/design.md", // bound by hand, will drop out too
	)
	bindArtifact(t, projectID, artifactIDByPath(t, resourceID, "requirements/s1-a/design.md"), issueAID)

	w, got := postArtifactSync(t, projectID, map[string]any{
		"artifacts": []map[string]any{
			syncManifestItem("_shared/glossary.md", "sha-new", "shared", "research", ""),
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("manifest diff: status = %d, body = %s", w.Code, w.Body.String())
	}
	if got.DeletedCount != 1 {
		t.Fatalf("manifest diff: deleted_count = %d, want 1 (only the synced row)", got.DeletedCount)
	}
	if got.PreservedManual != 1 {
		t.Fatalf("manifest diff: preserved_manual = %d, want 1", got.PreservedManual)
	}

	var deleted bool
	dbfx.QueryRow(t,
		`SELECT (deleted_at IS NOT NULL) FROM project_artifact
		 WHERE resource_id = $1 AND rel_path = 'requirements/s1-a/design.md'`, resourceID,
	).Scan(&deleted)
	if deleted {
		t.Fatal("manual row was soft-deleted by the manifest diff, want it exempt")
	}
	dbfx.QueryRow(t,
		`SELECT (deleted_at IS NOT NULL) FROM project_artifact
		 WHERE resource_id = $1 AND rel_path = 'overview/product-design.md'`, resourceID,
	).Scan(&deleted)
	if !deleted {
		t.Fatal("synced row absent from the manifest survived, want it soft-deleted")
	}
	if n := liveArtifactCount(t, resourceID); n != 2 {
		t.Fatalf("manifest diff: live = %d, want 2 (manual row + the new one)", n)
	}
}

// TestSyncProjectArtifacts_AllItemsRejectedSkipsSoftDelete covers the sibling
// hazard the empty-manifest guard would otherwise leave open: a manifest whose
// every item fails validation names no path at all, so diffing against it would
// delete the archive on the strength of a caller-side bug.
func TestSyncProjectArtifacts_AllItemsRejectedSkipsSoftDelete(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	projectID, resourceID, _, _ := archiveSyncFixture(t)
	seedSyncedArtifacts(t, resourceID, projectID,
		"overview/product-design.md",
		"requirements/s1-a/design.md",
	)

	w, got := postArtifactSync(t, projectID, map[string]any{
		"artifacts": []map[string]any{
			// scope outside shared/project/requirement → rejected.
			syncManifestItem("overview/product-design.md", "sha-x", "galaxy", "product-design", ""),
			// stage out of 1..4 → rejected.
			map[string]any{
				"rel_path": "requirements/s1-a/design.md", "blob_sha": "sha-y",
				"scope": "requirement", "doc_type": "architecture", "version": 1, "stage": 9,
			},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("all-rejected manifest: status = %d, body = %s", w.Code, w.Body.String())
	}
	if !got.SkippedSoftDelete || got.SkipReason != "no_valid_items" {
		t.Fatalf("all-rejected manifest: skipped_soft_delete = %v (%q), want true (no_valid_items)",
			got.SkippedSoftDelete, got.SkipReason)
	}
	if got.DeletedCount != 0 {
		t.Fatalf("all-rejected manifest: deleted_count = %d, want 0", got.DeletedCount)
	}
	if n := liveArtifactCount(t, resourceID); n != 2 {
		t.Fatalf("all-rejected manifest: live = %d, want 2", n)
	}
}
