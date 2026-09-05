package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// 档案同步配置 + 分阶段诊断 + 批量绑定候选（migration 461；
// spec §4.9.3/4.9.6/4.9.7；原型 #f2 五阶段流水线、#f3 控制台标注①-③）。

// ── 纯函数：三因子置信度 ────────────────────────────────────────────────────

func TestScoreBindCandidate_KeySuffixDominates(t *testing.T) {
	now := time.Now()
	conf := scoreBindCandidate(bindScoreInput{
		RequirementKey:  "REQ-20260811-02",
		ArtifactCreated: now,
		IssueNumber:     2,
		IssueTitle:      "配置投影与可视化编排",
		IssueCreated:    now,
	})
	// key 后缀 1.0×0.5 + 时间窗 1.0×0.15 = 0.65，标题零重叠时仍 > 0.6。
	if conf < 0.6 {
		t.Fatalf("key suffix + time window alone should clear 0.6, got %f", conf)
	}
	if conf >= 0.85 {
		t.Fatalf("without title similarity conf must stay below the 0.85 auto-bind bar, got %f", conf)
	}
}

func TestScoreBindCandidate_FullSignalAutoBinds(t *testing.T) {
	now := time.Now()
	conf := scoreBindCandidate(bindScoreInput{
		RequirementKey:  "REQ-20260811-02",
		ArtifactHint:    "配置投影与可视化编排",
		ArtifactCreated: now,
		IssueNumber:     2,
		IssueTitle:      "配置投影与可视化编排",
		IssueCreated:    now,
	})
	if conf < 0.85 {
		t.Fatalf("key + title + time aligned must clear the 0.85 auto-bind bar, got %f", conf)
	}
}

func TestScoreBindCandidate_NoSignalSuggestsNew(t *testing.T) {
	conf := scoreBindCandidate(bindScoreInput{
		RequirementKey:  "REQ-20260811-99",
		ArtifactHint:    "plan",
		ArtifactCreated: time.Now(),
		IssueNumber:     3,
		IssueTitle:      "完全不同的标题",
		IssueCreated:    time.Now().Add(-90 * 24 * time.Hour),
	})
	if conf >= 0.6 {
		t.Fatalf("no key/title/time signal must stay under 0.6 (suggest new issue), got %f", conf)
	}
}

func TestArtifactTitleHint(t *testing.T) {
	got := artifactTitleHint("requirements/REQ-20260811-02-配置投影/s2-plan/plan.md")
	if got != "requirements 配置投影 s2-plan plan" {
		t.Fatalf("unexpected hint: %q", got)
	}
	got = artifactTitleHint("requirements/REQ-20260811-02/s2-plan/plan.md")
	if got != "requirements s2-plan plan" {
		t.Fatalf("REQ dir without slug must contribute nothing: %q", got)
	}
}

func TestRequirementKeySuffixNumber(t *testing.T) {
	if n, ok := requirementKeySuffixNumber("REQ-20260811-02"); !ok || n != 2 {
		t.Fatalf("REQ-20260811-02 -> want (2,true), got (%d,%v)", n, ok)
	}
	if _, ok := requirementKeySuffixNumber("REQ-ABC"); ok {
		t.Fatal("non-numeric suffix must report ok=false")
	}
	if _, ok := requirementKeySuffixNumber(""); ok {
		t.Fatal("empty key must report ok=false")
	}
}

func TestJaccardTokens_IdenticalAndDisjoint(t *testing.T) {
	if got := jaccardTokens("配置投影", "配置投影"); got != 1 {
		t.Fatalf("identical strings -> want 1, got %f", got)
	}
	if got := jaccardTokens("aaa", "bbb"); got != 0 {
		t.Fatalf("disjoint tokens -> want 0, got %f", got)
	}
	if got := jaccardTokens("", "x"); got != 0 {
		t.Fatalf("empty side -> want 0, got %f", got)
	}
}

// ── sync config GET/PUT ─────────────────────────────────────────────────────

func TestArchiveSyncConfig_DefaultsThenRoundTrip(t *testing.T) {
	projectID := dbfx.Project(t, "Sync config round trip")

	// 未配置过的项目返回 migration 461 的默认值（不落库）。
	w := httptest.NewRecorder()
	req := withArtifactURLParams(newRequest(http.MethodGet, "/api/projects/"+projectID+"/archive/sync-config", nil), "id", projectID)
	testHandler.GetArchiveSyncConfig(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET default: want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var cfg ArchiveSyncConfigResponse
	if err := json.Unmarshal(w.Body.Bytes(), &cfg); err != nil {
		t.Fatalf("decode default: %v", err)
	}
	if cfg.SyncMode != "manual" || cfg.ConflictPolicy != "path_first" || cfg.BatchBindThreshold != 0.85 {
		t.Fatalf("defaults mismatch: %+v", cfg)
	}

	// PUT upsert 后 GET 读回一致。
	threshold := 0.9
	body := map[string]any{
		"sync_mode":            "scheduled",
		"conflict_policy":      "review_queue",
		"scope_filter":         map[string]any{"include": []string{"requirements/"}},
		"batch_bind_threshold": threshold,
		"cron_expr":            "*/15 * * * *",
	}
	w = httptest.NewRecorder()
	req = withArtifactURLParams(newRequest(http.MethodPut, "/api/projects/"+projectID+"/archive/sync-config", body), "id", projectID)
	testHandler.PutArchiveSyncConfig(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT: want 200, got %d (%s)", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	req = withArtifactURLParams(newRequest(http.MethodGet, "/api/projects/"+projectID+"/archive/sync-config", nil), "id", projectID)
	testHandler.GetArchiveSyncConfig(w, req)
	if err := json.Unmarshal(w.Body.Bytes(), &cfg); err != nil {
		t.Fatalf("decode saved: %v", err)
	}
	if cfg.SyncMode != "scheduled" || cfg.ConflictPolicy != "review_queue" || cfg.BatchBindThreshold != threshold {
		t.Fatalf("round trip mismatch: %+v", cfg)
	}
	if cfg.CronExpr == nil || *cfg.CronExpr != "*/15 * * * *" {
		t.Fatalf("cron_expr not persisted: %+v", cfg.CronExpr)
	}
}

func TestArchiveSyncConfig_RejectsBadEnums(t *testing.T) {
	projectID := dbfx.Project(t, "Sync config validation")
	body := map[string]any{"sync_mode": "continuous", "conflict_policy": "path_first"}
	w := httptest.NewRecorder()
	req := withArtifactURLParams(newRequest(http.MethodPut, "/api/projects/"+projectID+"/archive/sync-config", body), "id", projectID)
	testHandler.PutArchiveSyncConfig(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad sync_mode: want 400, got %d", w.Code)
	}
}

// ── diagnostics POST/GET ────────────────────────────────────────────────────

func TestArchiveSyncDiagnostics_ReportAndList(t *testing.T) {
	projectID := dbfx.Project(t, "Sync diagnostics")

	body := map[string]any{
		"sync_run_id": "run-2026-0906-01",
		"entries": []map[string]any{
			{"stage": "scan", "level": "info", "message": "scanned 412 files"},
			{"stage": "parse", "level": "warning", "rel_path": "requirements/REQ-1/s5-review/x.md", "message": "unknown stage s5"},
			{"stage": "upload", "level": "error", "rel_path": "big.zip", "message": "exceeds 100MB", "detail": map[string]any{"size": 104857600}},
		},
	}
	w := httptest.NewRecorder()
	req := withArtifactURLParams(newRequest(http.MethodPost, "/api/projects/"+projectID+"/archive/sync-diagnostics", body), "id", projectID)
	testHandler.PostArchiveSyncDiagnostics(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("POST: want 201, got %d (%s)", w.Code, w.Body.String())
	}

	// 按 run 过滤读回 3 条；按 stage 过滤读回 1 条。
	w = httptest.NewRecorder()
	req = withArtifactURLParams(newRequest(http.MethodGet, "/api/projects/"+projectID+"/archive/sync-diagnostics?sync_run_id=run-2026-0906-01", nil), "id", projectID)
	testHandler.ListArchiveSyncDiagnostics(w, req)
	var list struct {
		Diagnostics []SyncDiagnosticEntry `json:"diagnostics"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Diagnostics) != 3 {
		t.Fatalf("want 3 diagnostics for the run, got %d", len(list.Diagnostics))
	}

	w = httptest.NewRecorder()
	req = withArtifactURLParams(newRequest(http.MethodGet, "/api/projects/"+projectID+"/archive/sync-diagnostics?stage=upload", nil), "id", projectID)
	testHandler.ListArchiveSyncDiagnostics(w, req)
	list.Diagnostics = nil
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode filtered: %v", err)
	}
	if len(list.Diagnostics) != 1 || list.Diagnostics[0].Message != "exceeds 100MB" {
		t.Fatalf("stage=upload filter mismatch: %+v", list.Diagnostics)
	}
}

func TestArchiveSyncDiagnostics_RejectsBadStage(t *testing.T) {
	projectID := dbfx.Project(t, "Sync diagnostics validation")
	body := map[string]any{
		"sync_run_id": "run-x",
		"entries":     []map[string]any{{"stage": "deploy", "level": "info", "message": "m"}},
	}
	w := httptest.NewRecorder()
	req := withArtifactURLParams(newRequest(http.MethodPost, "/api/projects/"+projectID+"/archive/sync-diagnostics", body), "id", projectID)
	testHandler.PostArchiveSyncDiagnostics(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad stage: want 400, got %d", w.Code)
	}
}

// ── bind candidates ─────────────────────────────────────────────────────────

func TestListArtifactBindCandidates_RanksAndPersistsConfidence(t *testing.T) {
	projectID, resourceID, _, _ := archiveSyncFixture(t)
	// 命中候选的 issue：number 由 dbfx.Issue 分配，读出来构造同尾号的 key。
	var issueNumber int32
	var issueTitle string
	if err := testPool.QueryRow(context.Background(),
		`SELECT number, title FROM issue WHERE project_id = $1 ORDER BY number LIMIT 1`, projectID,
	).Scan(&issueNumber, &issueTitle); err != nil {
		t.Fatalf("load fixture issue: %v", err)
	}

	artifactID := dbfx.Insert(t, "project_artifact", testutil.Cols{
		"workspace_id":    testWorkspaceID,
		"project_id":      projectID,
		"resource_id":     resourceID,
		"scope":           "requirement",
		"doc_type":        "plan",
		"rel_path":        "requirements/REQ-20260811-02/s2-plan/plan.md",
		"requirement_key": "REQ-20260811-02",
		"blob_sha":        "sha-candidate-1",
		"source":          "sync",
	})

	// key 尾号必须对上 fixture issue 的 number，否则候选为空。
	dbfx.Exec(t, `UPDATE project_artifact SET requirement_key = $1 WHERE id = $2`,
		"REQ-20260811-"+pad2(int(issueNumber)), artifactID)

	w := httptest.NewRecorder()
	req := withArtifactURLParams(newRequest(http.MethodGet, "/api/projects/"+projectID+"/artifacts/bind-candidates", nil), "id", projectID)
	testHandler.ListArtifactBindCandidates(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Candidates []BindCandidate `json:"candidates"`
		Threshold  float64         `json:"threshold"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Candidates) == 0 {
		t.Fatal("want at least one candidate for the key-matched artifact")
	}
	top := resp.Candidates[0]
	if top.ArtifactID != artifactID {
		t.Fatalf("top candidate artifact mismatch: %s", top.ArtifactID)
	}
	if top.Confidence <= 0 || top.Confidence > 1 {
		t.Fatalf("confidence out of range: %f", top.Confidence)
	}

	// 置信度写回 project_artifact.confidence（§4.9.3 评估痕迹）。
	var persisted float64
	if err := testPool.QueryRow(context.Background(),
		`SELECT confidence FROM project_artifact WHERE id = $1`, artifactID,
	).Scan(&persisted); err != nil {
		t.Fatalf("confidence not persisted: %v", err)
	}
	if persisted != top.Confidence {
		t.Fatalf("persisted confidence %f != response %f", persisted, top.Confidence)
	}
}

func pad2(n int) string {
	return fmt.Sprintf("%02d", n)
}
