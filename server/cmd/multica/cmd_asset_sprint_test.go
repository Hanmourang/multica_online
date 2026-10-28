package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 资产命令族必须覆盖「读全量 + 写单条 + 删单条」三件事。少一个，agent 就会退回
// 到用 project tab 只读，或者干脆去猜端点。
func TestAssetCommandExposesReadAndWriteSurface(t *testing.T) {
	want := []string{"bind", "list", "matrix", "meta", "sync", "unbind"}
	got := map[string]bool{}
	for _, child := range assetCmd.Commands() {
		got[child.Name()] = true
	}
	for _, name := range want {
		if !got[name] {
			t.Fatalf("asset %s is missing; commands are %v", name, commandNames(got))
		}
	}
}

// 迭代的完整生命周期：读、建、改、启停、纳管、移除、删。
func TestSprintCommandExposesFullLifecycle(t *testing.T) {
	want := []string{"assign", "complete", "create", "delete", "get", "list", "progress", "reopen", "remove", "start", "update"}
	got := map[string]bool{}
	for _, child := range sprintCmd.Commands() {
		got[child.Name()] = true
	}
	for _, name := range want {
		if !got[name] {
			t.Fatalf("sprint %s is missing; commands are %v", name, commandNames(got))
		}
	}
}

// 破坏性操作在非终端（agent / 脚本）下必须直接拒绝：这是「删除需审批」的
// 执行侧闸门，没有 --yes 时绝不能真的写。
func TestConfirmDestructiveRefusesAgentRunsWithoutYes(t *testing.T) {
	restore := stdinIsTerminal
	stdinIsTerminal = func() bool { return false }
	defer func() { stdinIsTerminal = restore }()

	cmd := &cobra.Command{}
	addDestructiveFlags(cmd)

	err := confirmDestructive(cmd, "Delete sprint s-1")
	if err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("err = %v, want a refusal that names --yes", err)
	}
	if !strings.Contains(err.Error(), "Delete sprint s-1") {
		t.Fatalf("err = %v, want the question echoed so the person can approve it", err)
	}

	if err := cmd.Flags().Set("yes", "true"); err != nil {
		t.Fatalf("set --yes: %v", err)
	}
	if err := confirmDestructive(cmd, "Delete sprint s-1"); err != nil {
		t.Fatalf("--yes must pass the gate: %v", err)
	}
}

// 读面：不带 project 时必须是工作区全量（资产管理页），而不是悄悄加一个
// projectId= 空值让服务端回 400。
func TestFetchAssetPageWorkspaceWideOmitsProjectID(t *testing.T) {
	var gotPath string
	var gotQuery url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.Query()
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}, "totalCount": 3})
	}))
	defer server.Close()

	client := cli.NewAPIClient(server.URL, "ws-1", "tok")
	page, err := fetchAssetPage(context.Background(), client, assetQuery{Limit: 500})
	if err != nil {
		t.Fatalf("fetchAssetPage: %v", err)
	}
	if gotPath != "/api/assets/page" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotQuery.Has("projectId") {
		t.Fatalf("workspace-wide read must not send projectId: %v", gotQuery)
	}
	if gotQuery.Get("pageSize") != "200" {
		t.Fatalf("pageSize = %q, want the 200 cap (handler max)", gotQuery.Get("pageSize"))
	}
	if gotQuery.Has("limit") {
		t.Fatalf("limit must never be sent: %v", gotQuery)
	}
	if page.TotalCount != 3 {
		t.Fatalf("total = %d, want totalCount 3", page.TotalCount)
	}
}

func TestFetchAssetPageProjectScopeNeedsProject(t *testing.T) {
	client := cli.NewAPIClient("http://127.0.0.1:1", "ws-1", "tok")
	if _, err := fetchAssetPage(context.Background(), client, assetQuery{Scope: "project"}); err == nil {
		t.Fatal("project scope without a project id must fail fast, not hit the network")
	}
}

// 迭代引用可以写名字：agent 拿到的是人话（「2026-W45」），不是 uuid。
func TestResolveSprintAcceptsPrefixAndName(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sprints": []any{
				map[string]any{"id": "11111111-aaaa", "name": "2026-W44"},
				map[string]any{"id": "22222222-bbbb", "name": "2026-W45"},
			},
		})
	}))
	defer server.Close()

	client := cli.NewAPIClient(server.URL, "ws-1", "tok")
	for _, ref := range []string{"22222222-bbbb", "2222", "2026-w45"} {
		sprint, err := resolveSprint(context.Background(), client, "proj-1", ref)
		if err != nil {
			t.Fatalf("resolveSprint(%q): %v", ref, err)
		}
		if strVal(sprint, "id") != "22222222-bbbb" {
			t.Fatalf("resolveSprint(%q) = %v", ref, sprint)
		}
	}
	if _, err := resolveSprint(context.Background(), client, "proj-1", "nope"); err == nil {
		t.Fatal("unknown ref must fail with a pointer to sprint list")
	}
}

func commandNames(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
