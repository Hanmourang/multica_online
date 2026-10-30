package handler

// 五阶段对齐 plan §4.8 / §9.1「资产 handler」行的 DB 集成用例：
// 批量端点同时覆盖项目级与 issue 级行（issue_id IS NULL 限制已移除）、
// id = ANY + workspace_id + project_id 防越权、注入档案同步失败后整事务
// 回滚且无部分写入；bind / 单行 meta 用同一条 FK 注入路径钉住事务语义。

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// 不存在的 attachment id（格式合法，触发 project_artifact_attachment_id_fkey）。
const missingAttachmentID = "00000000-0000-0000-0000-000000000bad"

func postBatchMeta(t *testing.T, projectID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := withURLParams(
		newRequest(http.MethodPost, "/api/projects/"+projectID+"/assets/batch-meta", body),
		"id", projectID,
	)
	testHandler.BatchUpdateAssetMeta(w, req)
	return w
}

func bindingLifecycleCol(t *testing.T, bindingID string) string {
	t.Helper()
	var val *string
	dbfx.QueryRow(t, `SELECT lifecycle_stage FROM project_asset_binding WHERE id = $1`, bindingID).Scan(&val)
	if val == nil {
		return ""
	}
	return *val
}

func artifactPlacementForBinding(t *testing.T, bindingID string) (int32, string, int) {
	t.Helper()
	var stage *int32
	var docType string
	err := testPool.QueryRow(context.Background(),
		`SELECT stage, doc_type FROM project_artifact
		 WHERE asset_binding_id = $1 AND deleted_at IS NULL LIMIT 1`, bindingID).Scan(&stage, &docType)
	if errors.Is(err, sql.ErrNoRows) {
		return -1, "", 0
	}
	if err != nil {
		t.Fatalf("query artifact for binding %s: %v", bindingID, err)
	}
	if stage == nil {
		return 0, docType, 1
	}
	return *stage, docType, 1
}

func TestBatchMetaProjectAndIssueRowsWithArchiveSync(t *testing.T) {
	projectID, resourceID := placementFixture(t)
	issueID := dbfx.Issue(t, "批量-工作项", testutil.Cols{"project_id": projectID})

	// 项目级行：带文件名载荷 + 已存在的资产原生档案行（overview/research 标准货架路径）。
	projBinding := insertAssetBinding(t, projectID, "批量-项目级", strp("S1"), `{"filename":"批量.md"}`)
	dbfx.Exec(t,
		`INSERT INTO project_artifact (workspace_id, project_id, resource_id, scope, stage, doc_type,
			version, rel_path, blob_sha, size_bytes, source, asset_binding_id)
		 VALUES ($1, $2, $3, 'project', 1, 'research', 1, 'overview/research/批量.md', '', 0, 'asset', $4)`,
		testWorkspaceID, projectID, resourceID, projBinding)

	// 工作项级行：issue_id 非空，批量端点移除限制后必须同时命中。
	issueBinding := insertAssetBinding(t, projectID, "批量-issue级", strp("S1"), `{}`)
	dbfx.Exec(t, `UPDATE project_asset_binding SET issue_id = $1 WHERE id = $2`, issueID, issueBinding)

	w := postBatchMeta(t, projectID, map[string]any{
		"binding_ids":     []string{projBinding, issueBinding},
		"lifecycle_stage": "S5",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("batch meta status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Updated int `json:"updated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	if resp.Updated != 2 {
		t.Fatalf("updated = %d, want 2（issue 级行必须被覆盖）", resp.Updated)
	}
	for _, id := range []string{projBinding, issueBinding} {
		if got := bindingLifecycleCol(t, id); got != "S5" {
			t.Errorf("binding %s lifecycle = %q, want S5", id[:8], got)
		}
	}
	// 资产 → 档案同事务：S5 → (5, iteration)，标准货架路径段随之替换。
	stage, docType, count := artifactPlacementForBinding(t, projBinding)
	if count == 0 || stage != 5 || docType != "iteration" {
		t.Errorf("archive placement = (%d,%q,count=%d), want (5,iteration,1)", stage, docType, count)
	}
	var relPath string
	dbfx.QueryRow(t,
		`SELECT rel_path FROM project_artifact WHERE asset_binding_id = $1 AND deleted_at IS NULL`,
		projBinding).Scan(&relPath)
	if relPath != "overview/iteration/批量.md" {
		t.Errorf("rel_path = %q, want shelf segment swapped to iteration", relPath)
	}
}

func TestBatchMetaIgnoresForeignProjectAndMissingIDs(t *testing.T) {
	projectA, _ := placementFixture(t)
	projectB := dbfx.Project(t, "批量-B项目")
	idA := insertAssetBinding(t, projectA, "批量-A行", strp("S1"), `{}`)
	idB := insertAssetBinding(t, projectB, "批量-B行", strp("S1"), `{}`)

	w := postBatchMeta(t, projectA, map[string]any{
		"binding_ids":     []string{idA, idB, "00000000-0000-0000-0000-00000000fee1"},
		"lifecycle_stage": "S4",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Updated int `json:"updated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	if resp.Updated != 1 {
		t.Errorf("updated = %d, want 1（跨项目与不存在 ID 不得命中）", resp.Updated)
	}
	if got := bindingLifecycleCol(t, idA); got != "S4" {
		t.Errorf("A binding lifecycle = %q, want S4", got)
	}
	// 越权防护核心断言：B 项目的行必须原封不动。
	if got := bindingLifecycleCol(t, idB); got != "S1" {
		t.Errorf("B binding lifecycle = %q, want untouched S1", got)
	}
}

func TestBatchMetaSyncFailureRollsBackWholeTx(t *testing.T) {
	projectID, _ := placementFixture(t)
	healthy := insertAssetBinding(t, projectID, "批量-健康行", strp("S1"), `{"filename":"健康.md"}`)
	bad := insertAssetBinding(t, projectID, "批量-注入行", nil,
		`{"attachment_id":"`+missingAttachmentID+`"}`)

	w := postBatchMeta(t, projectID, map[string]any{
		"binding_ids":     []string{healthy, bad},
		"lifecycle_stage": "S3",
	})
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d want 500, body = %s", w.Code, w.Body.String())
	}
	// 任一行同步失败 → binding UPDATE 一并回滚，不允许部分提交。
	if got := bindingLifecycleCol(t, healthy); got != "S1" {
		t.Errorf("healthy lifecycle = %q, want rolled back to S1", got)
	}
	if got := bindingLifecycleCol(t, bad); got != "" {
		t.Errorf("bad lifecycle = %q, want rolled back to NULL", got)
	}
	if _, _, count := artifactPlacementForBinding(t, healthy); count != 0 {
		t.Errorf("healthy archive rows = %d, want 0（档案写入同事务回滚）", count)
	}
}

func TestUpdateAssetMetaSyncFailureRollsBack(t *testing.T) {
	projectID, _ := placementFixture(t)
	bindingID := insertAssetBinding(t, projectID, "单行-注入失败", nil,
		`{"attachment_id":"`+missingAttachmentID+`"}`)

	w := httptest.NewRecorder()
	req := withURLParams(
		newRequest(http.MethodPut, "/api/projects/"+projectID+"/assets/"+bindingID+"/meta",
			map[string]any{"lifecycle_stage": "S2"}),
		"id", projectID, "bindingId", bindingID,
	)
	testHandler.UpdateAssetMeta(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d want 500, body = %s", w.Code, w.Body.String())
	}
	if got := bindingLifecycleCol(t, bindingID); got != "" {
		t.Errorf("lifecycle = %q, want rolled back to NULL", got)
	}
}

// 行内关联编辑器只提交 links（不带阶段/标签），此时 SET 子句为空——早前会拼出
// `UPDATE ... SET  WHERE ...` 的非法 SQL 而 500，这条用例钉住「仅改关联」路径。
func TestUpdateAssetMetaLinksOnly(t *testing.T) {
	projectID, _ := placementFixture(t)
	bindingID := insertAssetBinding(t, projectID, "仅改关联", nil, `{}`)
	issueID := dbfx.Issue(t, "行内关联需求", testutil.Cols{"project_id": projectID})

	put := func(links []map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req := withURLParams(
			newRequest(http.MethodPut, "/api/projects/"+projectID+"/assets/"+bindingID+"/meta",
				map[string]any{"links": links}),
			"id", projectID, "bindingId", bindingID,
		)
		testHandler.UpdateAssetMeta(w, req)
		return w
	}

	if w := put([]map[string]any{{"issue_id": issueID, "link_type": "produces"}}); w.Code != http.StatusOK {
		t.Fatalf("status = %d want 200, body = %s", w.Code, w.Body.String())
	}
	count := dbfx.Count(t, `SELECT count(*) FROM asset_issue_link WHERE asset_binding_id = $1`, bindingID)
	if count != 1 {
		t.Errorf("links = %d, want 1", count)
	}

	// 提交空集 = 清空关联，同样不能 500。
	if w := put([]map[string]any{}); w.Code != http.StatusOK {
		t.Fatalf("status = %d want 200, body = %s", w.Code, w.Body.String())
	}
	count = dbfx.Count(t, `SELECT count(*) FROM asset_issue_link WHERE asset_binding_id = $1`, bindingID)
	if count != 0 {
		t.Errorf("links = %d, want 0", count)
	}
}

func TestBindAssetSyncFailureRollsBack(t *testing.T) {
	projectID, _ := placementFixture(t)
	w := httptest.NewRecorder()
	req := withURLParams(
		newRequest(http.MethodPost, "/api/projects/"+projectID+"/assets", map[string]any{
			"asset_category": "knowledge_repo",
			"asset_name":     "绑定-注入失败",
			"external_ref":   map[string]any{"attachment_id": missingAttachmentID},
			"lifecycle_stage": "S5",
		}),
		"id", projectID,
	)
	testHandler.BindProjectAsset(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d want 500, body = %s", w.Code, w.Body.String())
	}
	var count int
	dbfx.QueryRow(t,
		`SELECT count(*) FROM project_asset_binding WHERE project_id = $1 AND asset_name = '绑定-注入失败'`,
		projectID).Scan(&count)
	if count != 0 {
		t.Errorf("binding rows = %d, want 0（bind 与档案 upsert 同事务回滚）", count)
	}
}
