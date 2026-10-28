package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"

	"github.com/multica-ai/multica/server/internal/cli"
)

// TAB key 是 ?view= 上的公共契约，agent 会用用户看到的页签名来问，所以要
// 容错掉常见别名，而不是让它去读 `--help` 再猜一次。
func TestNormalizeProjectTabAcceptsAliases(t *testing.T) {
	for input, want := range map[string]string{
		"features":    "features",
		"module":      "features",
		"modules":     "features",
		"asset":       "assets",
		"data-model":  "data-model",
		"data_model":  "data-model",
		"graph":       "data-model",
		"requirement": "requirements",
		"sprint":      "sprints",
		"iteration":   "sprints",
		"workflow":    "workflows",
		"deliverable": "deliverables",
		"  TASKS  ":   "tasks",
	} {
		got, ok := normalizeProjectTab(input)
		if !ok || got != want {
			t.Fatalf("normalizeProjectTab(%q) = (%q, %v), want %q", input, got, ok, want)
		}
	}

	if _, ok := normalizeProjectTab("overview"); ok {
		t.Fatal("unknown tab must be rejected so the caller can list valid keys")
	}
}

// 前端按项目模板裁剪 TAB（templates.ts: PROJECT_TEMPLATE_VIEWS）。CLI 若不复刻
// 这张表，会把用户界面里根本不存在的 TAB 介绍给 agent。
func TestProjectTabsForTemplateMatchesFrontend(t *testing.T) {
	cases := map[string][]string{
		"general": {"archive", "assets", "requirements", "tasks", "deliverables", "workflows", "sprints"},
		"rd":      {"archive", "assets", "features", "requirements", "tasks", "acceptance", "deliverables", "filing", "workflows", "sprints"},
		"data":    {"archive", "assets", "data-model", "requirements", "tasks", "acceptance", "deliverables", "workflows", "sprints"},
	}
	for template, want := range cases {
		if got := projectTabsForTemplate(template); !reflect.DeepEqual(got, want) {
			t.Fatalf("projectTabsForTemplate(%q) = %v, want %v", template, got, want)
		}
	}

	full := projectTabsForTemplate("full")
	if len(full) != len(projectTabDefs) {
		t.Fatalf("full template must expose all %d tabs, got %d", len(projectTabDefs), len(full))
	}
	// 未知 / 缺省模板（模板出现前的项目）保留全部页签，与前端 resolveProjectTemplate
	// 的 "unknown → full" 保持一致。
	if got := projectTabsForTemplate(""); len(got) != len(projectTabDefs) {
		t.Fatalf("unknown template must keep every tab, got %v", got)
	}
}

// deliverables 是 issue 级的档案行。项目级汇总只能从 artifacts 自己算，而
// agent 最常问的恰恰是「这个项目有哪些产出物」，所以聚合口径要钉死在测试里。
func TestAggregateProjectDeliverablesRollsUpByScopeStageIssue(t *testing.T) {
	artifacts := []map[string]any{
		{"scope": "requirement", "stage": float64(2), "issue_id": "iss-b", "rel_path": "docs/b.md"},
		{"scope": "requirement", "stage": float64(2), "issue_id": "iss-b", "rel_path": "docs/b2.md"},
		{"scope": "task", "stage": float64(0), "issue_id": "iss-a", "rel_path": "docs/a.md"},
		// 缺 stage 归 unassigned 阶段桶；缺 issue_id 的行才是未绑定池。
		{"scope": "task", "issue_id": "iss-a"},
		{"scope": "module", "stage": float64(5)},
	}

	got := aggregateProjectDeliverables(artifacts, 1)

	if got["total"] != 5 {
		t.Fatalf("total = %v, want 5", got["total"])
	}
	byScope := got["by_scope"].(map[string]int)
	if byScope["requirement"] != 2 || byScope["task"] != 2 || byScope["module"] != 1 {
		t.Fatalf("by_scope = %v", byScope)
	}
	byStage := got["by_stage"].(map[string]int)
	if byStage["2"] != 2 || byStage["5"] != 1 || byStage["unassigned"] != 2 {
		t.Fatalf("by_stage = %v (stage 0 and missing stage both count as unassigned)", byStage)
	}
	if got["unassigned"] != 1 {
		t.Fatalf("unassigned = %v, want 1 (only the module row has no issue)", got["unassigned"])
	}

	issues := got["by_issue"].([]map[string]any)
	if len(issues) != 3 {
		t.Fatalf("by_issue = %v", issues)
	}
	// 按 issue_id 排序，iss-a 的样本被 samplesPerIssue=1 截断。
	if issues[0]["issue_id"] != "iss-a" || issues[0]["artifact_count"] != 2 {
		t.Fatalf("first issue row = %v", issues[0])
	}
	if samples := issues[0]["sample_paths"].([]string); len(samples) != 1 || samples[0] != "docs/a.md" {
		t.Fatalf("sample_paths = %v, want one capped sample", samples)
	}
}

// 资产页签只列项目级绑定（issue_id IS NULL），默认必须打到工作区聚合端点，
// 否则工作项级 / 档案导入的资产全部读不到；分页参数也必须是 toPage/pageSize
// —— handler 不认 limit，传 limit 只会拿到默认的 20 行。
func TestCollectTabAssetsScopeRouting(t *testing.T) {
	cases := []struct {
		name      string
		flags     map[string]string
		wantPath  string
		wantTotal int
	}{
		{
			name:      "default is workspace aggregate across both scopes",
			wantPath:  "/api/assets/page",
			wantTotal: 37,
		},
		{
			name:      "project scope matches the UI tab",
			flags:     map[string]string{"scope": "project"},
			wantPath:  "/api/projects/proj-1/assets/page",
			wantTotal: 5,
		},
		{
			name:      "issue scope reads one work item",
			flags:     map[string]string{"scope": "issue", "issue": "iss-9"},
			wantPath:  "/api/issues/iss-9/assets",
			wantTotal: 2,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotQuery url.Values
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotQuery = r.URL.Query()
				total := map[string]int{
					"/api/assets/page":                 37,
					"/api/projects/proj-1/assets/page": 5,
					"/api/issues/iss-9/assets":         2,
				}[r.URL.Path]
				_ = json.NewEncoder(w).Encode(map[string]any{
					"items":      []any{map[string]any{"id": "bind-1"}},
					"page":       1,
					"pageSize":   200,
					"totalCount": total,
					"totalPages": 1,
				})
			}))
			defer server.Close()

			resetTabGetFlags(t, tc.flags)
			payload := map[string]any{}
			client := cli.NewAPIClient(server.URL, "ws-1", "tok")
			if err := collectTabAssets(context.Background(), client, "proj-1", 200, projectTabGetCmd, payload); err != nil {
				t.Fatalf("collectTabAssets: %v", err)
			}

			if got := payload["total"]; got != tc.wantTotal {
				t.Fatalf("total = %v, want %d (must come from totalCount)", got, tc.wantTotal)
			}
			if gotQuery.Get("toPage") != "1" || gotQuery.Get("pageSize") != "200" {
				t.Fatalf("paging = %v, want toPage=1&pageSize=200", gotQuery)
			}
			if gotQuery.Has("limit") {
				t.Fatalf("limit must not be sent — the asset handlers ignore it: %v", gotQuery)
			}
			if gotQuery.Get("workspace_id") != "ws-1" {
				t.Fatalf("workspace_id = %q, want ws-1", gotQuery.Get("workspace_id"))
			}
			if tc.wantPath == "/api/assets/page" && gotQuery.Get("projectId") != "proj-1" {
				t.Fatalf("workspace aggregate must be narrowed by projectId, got %v", gotQuery)
			}
		})
	}
}

// assets --matrix 需要额外读一次概览端点，两个作用域一起回。
func TestCollectTabAssetsMatrixAddsOverview(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		switch r.URL.Path {
		case "/api/assets/overview":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bindings": []any{map[string]any{"id": "bind-1", "lifecycle_stage": "s2"}},
				"issues":   []any{map[string]any{"id": "iss-1", "title": "需求一"}},
			})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}, "totalCount": 0})
		}
	}))
	defer server.Close()

	resetTabGetFlags(t, map[string]string{"matrix": "true"})
	payload := map[string]any{}
	client := cli.NewAPIClient(server.URL, "ws-1", "tok")
	if err := collectTabAssets(context.Background(), client, "proj-1", 50, projectTabGetCmd, payload); err != nil {
		t.Fatalf("collectTabAssets: %v", err)
	}

	if len(paths) != 2 || paths[1] != "/api/assets/overview" {
		t.Fatalf("paths = %v, want the page then the overview", paths)
	}
	if got := payload["matrix_bindings"].([]map[string]any); len(got) != 1 {
		t.Fatalf("matrix_bindings = %v", payload["matrix_bindings"])
	}
}

// resetTabGetFlags 让每个用例从干净状态起步：cobra 的 flag 是包级单例，
// 上一条用例留下的 --scope/--issue 会静默改变下一条的路由。
func resetTabGetFlags(t *testing.T, values map[string]string) {
	t.Helper()
	flags := projectTabGetCmd.Flags()
	for _, name := range []string{"issue", "scope", "category", "name", "stage", "doc-class", "doc-type", "q", "doc"} {
		if err := flags.Set(name, ""); err != nil {
			t.Fatalf("reset --%s: %v", name, err)
		}
	}
	for _, name := range []string{"matrix", "unbound"} {
		if err := flags.Set(name, "false"); err != nil {
			t.Fatalf("reset --%s: %v", name, err)
		}
	}
	for name, value := range values {
		if err := flags.Set(name, value); err != nil {
			t.Fatalf("set --%s: %v", name, err)
		}
	}
}

func TestProjectTabEndpointCoversDedicatedTabs(t *testing.T) {
	for _, tab := range []string{"archive", "assets", "data-model", "requirements", "tasks", "acceptance", "filing", "workflows", "sprints"} {
		if _, err := projectTabEndpoint("proj-1", tab); err != nil {
			t.Fatalf("tab %q must have a collection endpoint: %v", tab, err)
		}
	}
	// features / deliverables 需要专门逻辑（模块聚合、issue 级），不能落在
	// 通用集合路径上。
	for _, tab := range []string{"features", "deliverables"} {
		if _, err := projectTabEndpoint("proj-1", tab); err == nil {
			t.Fatalf("tab %q must not resolve to a generic collection endpoint", tab)
		}
	}
}
