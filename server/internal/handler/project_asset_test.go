package handler

import (
	"encoding/json"
	"math"
	"net/http"
	"testing"
)

// 资产管理纯函数单测（migration 471；spec 03_资产管理模块.md §E/§C）。
// 与 project_archive_sync_config_test.go 同源约定：只测无 DB 的纯逻辑，
// 集成用例（bind/list/unbind）依赖真实 Postgres，由 handler_test.go 的
// TestMain 在 DB 不可达时整体跳过，这里不重复搭建。

func almostEqual(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

// 相关性独占：RelatedToMe=1、其余为 0 → 0.5，主导理由 recent。
func TestScoreAssetCandidate_RelationDominates(t *testing.T) {
	score, reason := scoreAssetCandidate(assetScoreInput{RelatedToMe: true})
	if !almostEqual(score, 0.5) {
		t.Fatalf("relation-only score should be exactly 0.5, got %f", score)
	}
	if reason != "recent" {
		t.Fatalf("dominant reason should be recent, got %q", reason)
	}
}

// 协作频率权重 0.3 单独最高时主导理由 joint。
func TestScoreAssetCandidate_UsageDominantReason(t *testing.T) {
	score, reason := scoreAssetCandidate(assetScoreInput{UsageRatio: 1})
	if !almostEqual(score, 0.3) {
		t.Fatalf("usage-only score should be 0.3, got %f", score)
	}
	if reason != "joint" {
		t.Fatalf("dominant reason should be joint, got %q", reason)
	}
}

// 图谱热度 0.2 权重最低，单独最高时主导理由 hot。
func TestScoreAssetCandidate_HeatReason(t *testing.T) {
	_, reason := scoreAssetCandidate(assetScoreInput{GraphHeat: 1})
	if reason != "hot" {
		t.Fatalf("heat-only dominant reason should be hot, got %q", reason)
	}
}

// 全信号相加 = 1.0（0.5 + 0.3 + 0.2），封顶不越界。
func TestScoreAssetCandidate_AllSignalsSumToOne(t *testing.T) {
	score, _ := scoreAssetCandidate(assetScoreInput{RelatedToMe: true, UsageRatio: 1, GraphHeat: 1})
	if !almostEqual(score, 1.0) {
		t.Fatalf("all signals must sum to 1.0, got %f", score)
	}
}

// 无信号 → 0 分、空理由（不推荐）。
func TestScoreAssetCandidate_NoSignalEmptyReason(t *testing.T) {
	score, reason := scoreAssetCandidate(assetScoreInput{})
	if score != 0 {
		t.Fatalf("no-signal score should be 0, got %f", score)
	}
	if reason != "" {
		t.Fatalf("no-signal reason must be empty, got %q", reason)
	}
}

// clampUnit 越界钳制（负数→0，>1→1，中间原样）。
func TestClampUnit(t *testing.T) {
	if clampUnit(-0.5) != 0 {
		t.Fatal("negative must clamp to 0")
	}
	if clampUnit(1.5) != 1 {
		t.Fatal("above-one must clamp to 1")
	}
	if !almostEqual(clampUnit(0.42), 0.42) {
		t.Fatal("in-range must pass through")
	}
}

// 超范围输入被钳制后分值不越 [0,1]。
func TestScoreAssetCandidate_ClampsOutOfRange(t *testing.T) {
	score, _ := scoreAssetCandidate(assetScoreInput{UsageRatio: 5, GraphHeat: -3})
	if score < 0 || score > 1 {
		t.Fatalf("score must stay in [0,1] after clamping, got %f", score)
	}
	// usage clamps to 1 → 0.3, heat clamps to 0.
	if !almostEqual(score, 0.3) {
		t.Fatalf("expected 0.3 from clamped usage only, got %f", score)
	}
}

func TestExtractRefURL(t *testing.T) {
	if got := extractRefURL(json.RawMessage(`{"url":"https://x/y.git","extra":1}`)); got != "https://x/y.git" {
		t.Fatalf("unexpected url: %q", got)
	}
	if got := extractRefURL(json.RawMessage(`{}`)); got != "" {
		t.Fatalf("missing url must be empty, got %q", got)
	}
	if got := extractRefURL(json.RawMessage(`not-json`)); got != "" {
		t.Fatalf("invalid json must degrade to empty, got %q", got)
	}
}

// externalRefForURL 注入 url 且保留其它字段。
func TestExternalRefForURL_PreservesOtherFields(t *testing.T) {
	out := externalRefForURL(json.RawMessage(`{"branch":"main"}`), "https://a/b.git")
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("output must be valid json: %v", err)
	}
	if m["url"] != "https://a/b.git" {
		t.Fatalf("url not injected: %v", m["url"])
	}
	if m["branch"] != "main" {
		t.Fatalf("existing field dropped: %v", m)
	}
}

func TestParseAssetPagingDefaultsAndBounds(t *testing.T) {
	setQuery := func(raw string) *http.Request {
		r, _ := http.NewRequest(http.MethodGet, "/assets/page?"+raw, nil)
		return r
	}
	if page, size := parseAssetPaging(setQuery("")); page != 1 || size != 20 {
		t.Fatalf("defaults should be page=1 size=20, got %d/%d", page, size)
	}
	if page, size := parseAssetPaging(setQuery("toPage=3&pageSize=50")); page != 3 || size != 50 {
		t.Fatalf("explicit paging not parsed, got %d/%d", page, size)
	}
	// 越界 / 非法值回落默认。
	if _, size := parseAssetPaging(setQuery("pageSize=9999")); size != 20 {
		t.Fatalf("oversized pageSize must fall back to 20, got %d", size)
	}
	if page, _ := parseAssetPaging(setQuery("toPage=abc")); page != 1 {
		t.Fatalf("non-numeric page must default to 1, got %d", page)
	}
}
