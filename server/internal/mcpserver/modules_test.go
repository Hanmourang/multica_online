package mcpserver

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 工具面单测：不连 DB、不连真 API。上游用 httptest 顶替，锁死三条不变式——
// ① 工具到 REST 的映射（method/path/body）；② Authorization 原样透传；
// ③ 破坏性动作与 flag 门控在发请求之前就被拦住。

const (
	testProject = "11111111-1111-1111-1111-111111111111"
	testModule  = "22222222-2222-2222-2222-222222222222"
)

type upstreamCall struct {
	method string
	path   string
	query  string
	auth   string
	body   string
}

// newModuleFacade 起一个假上游并返回挂在它上面的 façade。
func newModuleFacade(t *testing.T, specCenter bool) (*Server, *[]upstreamCall) {
	t.Helper()
	calls := &[]upstreamCall{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		*calls = append(*calls, upstreamCall{
			method: r.Method,
			path:   r.URL.Path,
			query:  r.URL.RawQuery,
			auth:   r.Header.Get("Authorization"),
			body:   string(raw),
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(upstream.Close)
	return NewModuleFacade(upstream.URL, specCenter), calls
}

// callModule 发一次 tools/call，返回文本内容与是否 isError。
func callModule(t *testing.T, srv *Server, name string, args map[string]any, auth string) (string, bool) {
	t.Helper()
	rawArgs, _ := json.Marshal(args)
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(`1`),
		"method":  "tools/call",
		"params":  map[string]any{"name": name, "arguments": json.RawMessage(rawArgs)},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/mcp/modules", strings.NewReader(string(body)))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	var resp struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
		Error *jsonRPCError `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, w.Body.String())
	}
	if len(resp.Result.Content) == 0 {
		return "", true
	}
	return resp.Result.Content[0].Text, resp.Result.IsError
}

func listedTools(t *testing.T, srv *Server) []string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(`1`), "method": "tools/list",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/mcp/modules", strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	var resp struct {
		Result struct {
			Tools []toolDef `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	names := make([]string, 0, len(resp.Result.Tools))
	for _, tool := range resp.Result.Tools {
		names = append(names, tool.Name)
	}
	return names
}

func TestModuleFacadeListsOnlyModuleTools(t *testing.T) {
	srv, _ := newModuleFacade(t, true)
	names := listedTools(t, srv)
	for _, name := range names {
		if !strings.HasPrefix(name, "modules_") {
			t.Fatalf("module facade must not expose %q", name)
		}
	}
	if len(names) != len(moduleTools) {
		t.Fatalf("want %d tools, got %d: %v", len(moduleTools), len(names), names)
	}
}

// flag 关闭时 spec / 原型 / 对账工具既不列出、也调不动。
func TestModuleFacadeHidesSpecToolsWhenFlagOff(t *testing.T) {
	srv, _ := newModuleFacade(t, false)
	for _, name := range listedTools(t, srv) {
		switch name {
		case "modules_spec_get", "modules_spec_publish", "modules_reconcile", "modules_coverage",
			"modules_spec_feature_add", "modules_spec_feature_update", "modules_spec_feature_remove",
			"modules_spec_import",
			"modules_prototype_versions", "modules_prototype_register", "modules_prototype_read",
			"modules_prototype_upload", "modules_context",
			"modules_prototype_plan_create", "modules_prototype_plan_get", "modules_prototype_plan_apply",
			"modules_workspace_get", "modules_brief_patch",
			"modules_releases_list", "modules_release_publish", "modules_release_rollback":
			t.Fatalf("%q must be hidden while module_spec_center is off", name)
		}
	}
	text, isErr := callModule(t, srv, "modules_spec_get", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
	}, "Bearer mat_test")
	if !isErr || !strings.Contains(text, "module_spec_center is disabled") {
		t.Fatalf("want disabled error, got isErr=%v text=%s", isErr, text)
	}
}

func TestModuleCreateForwardsPathAndAuth(t *testing.T) {
	srv, calls := newModuleFacade(t, false)
	text, isErr := callModule(t, srv, "modules_create", map[string]any{
		"project_id": testProject,
		"name":       "订单中心",
		"color":      "#4F46E5",
	}, "Bearer mat_task_token")
	if isErr {
		t.Fatalf("unexpected tool error: %s", text)
	}
	if len(*calls) != 1 {
		t.Fatalf("want 1 upstream call, got %d", len(*calls))
	}
	call := (*calls)[0]
	if call.method != http.MethodPost || call.path != "/api/projects/"+testProject+"/modules" {
		t.Fatalf("bad upstream target: %s %s", call.method, call.path)
	}
	if call.auth != "Bearer mat_task_token" {
		t.Fatalf("Authorization must be forwarded verbatim, got %q", call.auth)
	}
	if !strings.Contains(call.body, "订单中心") {
		t.Fatalf("body must carry the name, got %s", call.body)
	}
}

func TestModuleDeleteNeedsConfirm(t *testing.T) {
	srv, calls := newModuleFacade(t, false)
	text, isErr := callModule(t, srv, "modules_delete", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
	}, "Bearer mat_test")
	if !isErr || !strings.Contains(text, "confirm=true") {
		t.Fatalf("want confirm gate, got isErr=%v text=%s", isErr, text)
	}
	if len(*calls) != 0 {
		t.Fatalf("refused delete must not reach the API, got %d calls", len(*calls))
	}

	if _, isErr := callModule(t, srv, "modules_delete", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"confirm":    true,
	}, "Bearer mat_test"); isErr {
		t.Fatalf("confirmed delete should pass the gate")
	}
	if len(*calls) != 1 || (*calls)[0].method != http.MethodDelete {
		t.Fatalf("want one DELETE, got %+v", *calls)
	}
}

func TestModuleUpdateSendsOnlyPresentFields(t *testing.T) {
	srv, calls := newModuleFacade(t, false)
	if _, isErr := callModule(t, srv, "modules_update", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"name":       "新名字",
	}, "Bearer mat_test"); isErr {
		t.Fatalf("rename should succeed")
	}
	body := (*calls)[0].body
	if strings.Contains(body, "color") || strings.Contains(body, "graph_node_id") {
		t.Fatalf("absent fields must not be forwarded: %s", body)
	}
	if !strings.Contains(body, "新名字") {
		t.Fatalf("rename body missing name: %s", body)
	}

	(*calls) = nil
	if _, isErr := callModule(t, srv, "modules_update", map[string]any{
		"project_id":    testProject,
		"module_id":     testModule,
		"graph_node_id": "",
	}, "Bearer mat_test"); isErr {
		t.Fatalf("unbind should succeed")
	}
	if !strings.Contains((*calls)[0].body, `"graph_node_id":""`) {
		t.Fatalf("empty graph_node_id must be forwarded as unbind: %s", (*calls)[0].body)
	}
}

func TestModuleRequirementsCarriesModuleFilter(t *testing.T) {
	srv, calls := newModuleFacade(t, false)
	if _, isErr := callModule(t, srv, "modules_requirements", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"kind":       "requirement",
	}, "Bearer mat_test"); isErr {
		t.Fatalf("requirements should succeed")
	}
	call := (*calls)[0]
	if call.path != "/api/issues" {
		t.Fatalf("bad path: %s", call.path)
	}
	for _, want := range []string{"project_id=" + testProject, "module_id=" + testModule, "kind=requirement"} {
		if !strings.Contains(call.query, want) {
			t.Fatalf("query %q missing %q", call.query, want)
		}
	}
}

func TestModuleToolsRejectBadUUIDBeforeForwarding(t *testing.T) {
	srv, calls := newModuleFacade(t, false)
	text, isErr := callModule(t, srv, "modules_get", map[string]any{
		"project_id": testProject,
		"module_id":  "../../admin",
	}, "Bearer mat_test")
	if !isErr || !strings.Contains(text, "must be a UUID") {
		t.Fatalf("want uuid rejection, got isErr=%v text=%s", isErr, text)
	}
	if len(*calls) != 0 {
		t.Fatalf("bad id must not reach the API")
	}
}

func TestModuleToolsRequireAuthorization(t *testing.T) {
	srv, calls := newModuleFacade(t, false)
	text, isErr := callModule(t, srv, "modules_list", map[string]any{"project_id": testProject}, "")
	if !isErr || !strings.Contains(text, "unauthorized") {
		t.Fatalf("want unauthorized, got isErr=%v text=%s", isErr, text)
	}
	if len(*calls) != 0 {
		t.Fatalf("unauthenticated call must not reach the API")
	}
}

// 上游 4xx 必须变成可读的 isError，而不是让模型看到空结果。
func TestModuleToolSurfacesUpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"duplicate name","code":"duplicate_name"}`))
	}))
	defer upstream.Close()
	srv := NewModuleFacade(upstream.URL, false)

	text, isErr := callModule(t, srv, "modules_create", map[string]any{
		"project_id": testProject,
		"name":       "重复",
	}, "Bearer mat_test")
	if !isErr || !strings.Contains(text, "HTTP 409") || !strings.Contains(text, "duplicate name") {
		t.Fatalf("want 409 surfaced, got isErr=%v text=%s", isErr, text)
	}
}

func TestModulePlanToolsForwardToPlanEndpoints(t *testing.T) {
	srv, calls := newModuleFacade(t, true)
	auth := "Bearer mat_test"

	if _, isErr := callModule(t, srv, "modules_prototype_plan_create", map[string]any{
		"project_id":        testProject,
		"module_id":         testModule,
		"candidate_version": 7,
		"new_spec":          map[string]any{"features": []any{}},
	}, auth); isErr {
		t.Fatalf("plan create should succeed")
	}
	create := (*calls)[0]
	if create.method != http.MethodPost ||
		create.path != "/api/projects/"+testProject+"/modules/"+testModule+"/prototype-plans" {
		t.Fatalf("bad plan create target: %s %s", create.method, create.path)
	}
	for _, want := range []string{`"candidate_version":7`, `"new_spec"`} {
		if !strings.Contains(create.body, want) {
			t.Fatalf("plan body %s missing %s", create.body, want)
		}
	}

	planID := "33333333-3333-3333-3333-333333333333"
	*calls = nil
	if _, isErr := callModule(t, srv, "modules_prototype_plan_apply", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"plan_id":    planID,
	}, auth); isErr {
		t.Fatalf("plan apply should succeed")
	}
	apply := (*calls)[0]
	if apply.method != http.MethodPost ||
		apply.path != "/api/projects/"+testProject+"/modules/"+testModule+"/prototype-plans/"+planID+"/apply" {
		t.Fatalf("bad plan apply target: %s %s", apply.method, apply.path)
	}
}

func TestModulePlanCreateNeedsCandidateVersion(t *testing.T) {
	srv, calls := newModuleFacade(t, true)
	text, isErr := callModule(t, srv, "modules_prototype_plan_create", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
	}, "Bearer mat_test")
	if !isErr || !strings.Contains(text, "candidate_version") {
		t.Fatalf("want candidate_version rejection, got isErr=%v text=%s", isErr, text)
	}
	if len(*calls) != 0 {
		t.Fatalf("bad plan args must not reach the API")
	}
}

func TestModuleWorkspaceToolsForwardToWorkspaceEndpoints(t *testing.T) {
	srv, calls := newModuleFacade(t, true)
	auth := "Bearer mat_test"

	if _, isErr := callModule(t, srv, "modules_workspace_get", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
	}, auth); isErr {
		t.Fatalf("workspace get should succeed")
	}
	read := (*calls)[0]
	if read.method != http.MethodGet ||
		read.path != "/api/projects/"+testProject+"/modules/"+testModule+"/workspace" {
		t.Fatalf("bad workspace target: %s %s", read.method, read.path)
	}

	*calls = nil
	if _, isErr := callModule(t, srv, "modules_brief_patch", map[string]any{
		"project_id":   testProject,
		"module_id":    testModule,
		"base_version": 3,
		"fields":       map[string]any{"brief.goal": "把下单链路收敛成一步"},
		"source":       "agent",
		"note":         "补全目标",
	}, auth); isErr {
		t.Fatalf("brief patch should succeed")
	}
	patch := (*calls)[0]
	if patch.method != http.MethodPost ||
		patch.path != "/api/projects/"+testProject+"/modules/"+testModule+"/workspace/patch" {
		t.Fatalf("bad brief patch target: %s %s", patch.method, patch.path)
	}
	for _, want := range []string{`"base_version":3`, `"brief.goal"`, `"source":"agent"`} {
		if !strings.Contains(patch.body, want) {
			t.Fatalf("patch body %s missing %s", patch.body, want)
		}
	}

	*calls = nil
	if _, isErr := callModule(t, srv, "modules_release_rollback", map[string]any{
		"project_id":      testProject,
		"module_id":       testModule,
		"release_version": 2,
	}, auth); isErr {
		t.Fatalf("release rollback should succeed")
	}
	rollback := (*calls)[0]
	if rollback.method != http.MethodPost ||
		rollback.path != "/api/projects/"+testProject+"/modules/"+testModule+"/releases/2/rollback" {
		t.Fatalf("bad rollback target: %s %s", rollback.method, rollback.path)
	}
}

func TestModuleBriefPatchNeedsBaseVersion(t *testing.T) {
	srv, calls := newModuleFacade(t, true)
	text, isErr := callModule(t, srv, "modules_brief_patch", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"fields":     map[string]any{"brief.goal": "x"},
	}, "Bearer mat_test")
	if !isErr || !strings.Contains(text, "base_version") {
		t.Fatalf("want base_version rejection, got isErr=%v text=%s", isErr, text)
	}
	if len(*calls) != 0 {
		t.Fatalf("bad brief args must not reach the API")
	}
}

// 模块自有原型的维护面：修正 / 确认 / 删除 / 解析。四条都是「不产生新版本」
// 的编辑动作，映射错了就会静默改到别的版本，所以 method + path 一起钉死。
func TestModulePrototypeMaintenanceTools(t *testing.T) {
	srv, calls := newModuleFacade(t, true)
	auth := "Bearer mat_test"

	if _, isErr := callModule(t, srv, "modules_prototype_update", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"version":    3,
		"prompt":     "修正为群设置版",
	}, auth); isErr {
		t.Fatalf("prompt-only update should succeed")
	}
	patch := (*calls)[0]
	if patch.method != http.MethodPatch ||
		patch.path != "/api/projects/"+testProject+"/modules/"+testModule+"/prototype-versions/3" {
		t.Fatalf("bad update target: %s %s", patch.method, patch.path)
	}
	if strings.Contains(patch.body, "html_path") || strings.Contains(patch.body, "status") {
		t.Fatalf("absent fields must not be forwarded: %s", patch.body)
	}
	if !strings.Contains(patch.body, "修正为群设置版") {
		t.Fatalf("update body missing prompt: %s", patch.body)
	}

	*calls = nil
	if _, isErr := callModule(t, srv, "modules_prototype_update", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"version":    3,
	}, auth); !isErr {
		t.Fatalf("an update with no field must be rejected")
	}
	if len(*calls) != 0 {
		t.Fatalf("empty update must not reach the API, got %d calls", len(*calls))
	}

	if _, isErr := callModule(t, srv, "modules_prototype_confirm", map[string]any{
		"project_id":    testProject,
		"module_id":     testModule,
		"version":       3,
		"set_canonical": true,
	}, auth); isErr {
		t.Fatalf("confirm should succeed")
	}
	confirm := (*calls)[len(*calls)-1]
	if confirm.method != http.MethodPost ||
		confirm.path != "/api/projects/"+testProject+"/modules/"+testModule+"/prototype-versions/3/confirm" {
		t.Fatalf("bad confirm target: %s %s", confirm.method, confirm.path)
	}
	if !strings.Contains(confirm.body, `"set_canonical":true`) {
		t.Fatalf("confirm body must carry set_canonical: %s", confirm.body)
	}

	*calls = nil
	text, isErr := callModule(t, srv, "modules_prototype_delete", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"version":    3,
	}, auth)
	if !isErr || !strings.Contains(text, "confirm=true") {
		t.Fatalf("want confirm gate, got isErr=%v text=%s", isErr, text)
	}
	if len(*calls) != 0 {
		t.Fatalf("refused delete must not reach the API")
	}
	if _, isErr := callModule(t, srv, "modules_prototype_delete", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"version":    3,
		"confirm":    true,
	}, auth); isErr {
		t.Fatalf("confirmed delete should pass the gate")
	}
	if got := (*calls)[len(*calls)-1]; got.method != http.MethodDelete ||
		!strings.HasSuffix(got.path, "/prototype-versions/3") {
		t.Fatalf("bad delete target: %s %s", got.method, got.path)
	}

	*calls = nil
	if _, isErr := callModule(t, srv, "modules_prototype_parse", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"version":    3,
	}, auth); !isErr {
		t.Fatalf("parse without anchors must be rejected")
	}
	if len(*calls) != 0 {
		t.Fatalf("anchors-less parse must not reach the API")
	}
	if _, isErr := callModule(t, srv, "modules_prototype_parse", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"version":    3,
		"anchors":    map[string]any{"fp.chat.group": map[string]any{"count": 1, "title": "群设置"}},
	}, auth); isErr {
		t.Fatalf("parse with anchors should succeed")
	}
	parse := (*calls)[len(*calls)-1]
	if parse.method != http.MethodPost || !strings.HasSuffix(parse.path, "/prototype-versions/3/parse") {
		t.Fatalf("bad parse target: %s %s", parse.method, parse.path)
	}
	if !strings.Contains(parse.body, "fp.chat.group") {
		t.Fatalf("parse body must carry the anchors: %s", parse.body)
	}
}

func TestModuleToolsNeedSelfBaseURL(t *testing.T) {
	srv := NewModuleFacade("", false)
	text, isErr := callModule(t, srv, "modules_list", map[string]any{"project_id": testProject}, "Bearer mat_test")
	if !isErr || !strings.Contains(text, "MULTICA_PUBLIC_URL") {
		t.Fatalf("want configuration error, got isErr=%v text=%s", isErr, text)
	}
}

// specFeatureUpstream 顶替「GET /spec 返回 FP-01，写动作回 spec_version」的上游。
func specFeatureUpstream(t *testing.T, calls *[]upstreamCall) *Server {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		*calls = append(*calls, upstreamCall{
			method: r.Method,
			path:   r.URL.Path,
			auth:   r.Header.Get("Authorization"),
			body:   string(raw),
		})
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/spec") {
			_, _ = w.Write([]byte(`{"spec":{"schema":"module_spec/v1","summary":"s","features":[{"code":"FP-01","title":"登录","kind":"core"}]},"spec_version":3}`))
			return
		}
		_, _ = w.Write([]byte(`{"spec_version":4}`))
	}))
	t.Cleanup(upstream.Close)
	return NewModuleFacade(upstream.URL, true)
}

// 单条功能点的读改写：先读整份 spec，只动点名那一行，再带乐观锁 publish。
// 这三条工具存在的理由就是不让 MCP-only 的 agent 去整份覆盖。
func TestModuleSpecFeatureToolsReadModifyWrite(t *testing.T) {
	calls := &[]upstreamCall{}
	srv := specFeatureUpstream(t, calls)
	auth := "Bearer mat_test"

	text, isErr := callModule(t, srv, "modules_spec_feature_add", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"code":       "FP-02",
		"title":      "群设置",
		"group":      "会话",
	}, auth)
	if isErr {
		t.Fatalf("add should succeed, got %s", text)
	}
	if len(*calls) != 2 {
		t.Fatalf("want read + publish, got %d calls: %+v", len(*calls), *calls)
	}
	read, publish := (*calls)[0], (*calls)[1]
	if read.method != http.MethodGet || read.path != "/api/projects/"+testProject+"/modules/"+testModule+"/spec" {
		t.Fatalf("bad read target: %s %s", read.method, read.path)
	}
	if publish.method != http.MethodPost || publish.path != "/api/projects/"+testProject+"/modules/"+testModule+"/spec/publish" {
		t.Fatalf("bad publish target: %s %s", publish.method, publish.path)
	}
	if publish.auth != auth {
		t.Fatalf("Authorization must be forwarded verbatim, got %q", publish.auth)
	}
	for _, want := range []string{`"FP-01"`, `"FP-02"`, `群设置`, `"expected_version":3`} {
		if !strings.Contains(publish.body, want) {
			t.Fatalf("publish body missing %s: %s", want, publish.body)
		}
	}
	if !strings.Contains(text, `"feature_count":2`) {
		t.Fatalf("result must report the new count, got %s", text)
	}

	*calls = (*calls)[:0]
	if _, isErr := callModule(t, srv, "modules_spec_feature_add", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"code":       "FP-01",
		"title":      "重复",
	}, auth); !isErr {
		t.Fatalf("adding an existing code must be refused before publishing")
	}
	if len(*calls) != 1 {
		t.Fatalf("duplicate add must stop after the read, got %d calls", len(*calls))
	}

	*calls = (*calls)[:0]
	if _, isErr := callModule(t, srv, "modules_spec_feature_update", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"code":       "FP-01",
		"title":      "登录（改）",
	}, auth); isErr {
		t.Fatalf("update should succeed")
	}
	if len(*calls) != 2 {
		t.Fatalf("want read + publish, got %d calls", len(*calls))
	}
	updated := (*calls)[1].body
	if !strings.Contains(updated, `"title":"登录（改）"`) || !strings.Contains(updated, `"kind":"core"`) {
		t.Fatalf("update must only touch the named row: %s", updated)
	}

	*calls = (*calls)[:0]
	if _, isErr := callModule(t, srv, "modules_spec_feature_remove", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"code":       "FP-01",
	}, auth); isErr {
		t.Fatalf("remove should succeed")
	}
	removed := (*calls)[1].body
	if strings.Contains(removed, `"FP-01"`) {
		t.Fatalf("remove must drop the row from the published spec: %s", removed)
	}
	if !strings.Contains(removed, `"features":[]`) {
		t.Fatalf("remove must leave an empty feature list: %s", removed)
	}
}

// 改一个不存在的功能点：必须报错，不能隐式新增。
func TestModuleSpecFeatureUpdateRejectsUnknownCode(t *testing.T) {
	calls := &[]upstreamCall{}
	srv := specFeatureUpstream(t, calls)
	text, isErr := callModule(t, srv, "modules_spec_feature_update", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"code":       "FP-99",
		"title":      "不存在",
	}, "Bearer mat_test")
	if !isErr || !strings.Contains(text, "not found") {
		t.Fatalf("want not-found, got isErr=%v text=%s", isErr, text)
	}
	if len(*calls) != 1 {
		t.Fatalf("unknown code must stop after the read, got %d calls", len(*calls))
	}
}

// 需求归属的挂载/摘除只改 issue.module_id（与 CLI setModuleRequirement 同一口径）。
func TestModuleRequirementAttachDetachForwardToIssue(t *testing.T) {
	srv, calls := newModuleFacade(t, false)
	issue := "33333333-3333-3333-3333-333333333333"
	auth := "Bearer mat_test"

	if _, isErr := callModule(t, srv, "modules_requirements_attach", map[string]any{
		"project_id":   testProject,
		"module_id":    testModule,
		"issue_id":     issue,
		"feature_code": "FP-03",
	}, auth); isErr {
		t.Fatalf("attach should succeed")
	}
	attach := (*calls)[0]
	if attach.method != http.MethodPut || attach.path != "/api/issues/"+issue {
		t.Fatalf("bad attach target: %s %s", attach.method, attach.path)
	}
	for _, want := range []string{testModule, "FP-03"} {
		if !strings.Contains(attach.body, want) {
			t.Fatalf("attach body missing %s: %s", want, attach.body)
		}
	}

	if _, isErr := callModule(t, srv, "modules_requirements_detach", map[string]any{
		"project_id": testProject,
		"issue_id":   issue,
	}, auth); isErr {
		t.Fatalf("detach should succeed")
	}
	detach := (*calls)[1]
	if detach.method != http.MethodPut || detach.path != "/api/issues/"+issue {
		t.Fatalf("bad detach target: %s %s", detach.method, detach.path)
	}
	if !strings.Contains(detach.body, `"module_id":null`) {
		t.Fatalf("detach must send null, not an empty string: %s", detach.body)
	}
}

// 图谱桥接读：五条工具各自打到页面对应的只读端点，且都是 GET。
func TestModuleGraphReadToolsForwardToGraphRoutes(t *testing.T) {
	srv, calls := newModuleFacade(t, false)
	node := "graph:module-7"
	auth := "Bearer mat_test"

	cases := []struct {
		tool  string
		args  map[string]any
		path  string
		query string
	}{
		{"modules_graph_bridges", map[string]any{"project_id": testProject},
			"/api/projects/" + testProject + "/graph/modules", ""},
		{"modules_graph_objects", map[string]any{"project_id": testProject, "graph_node_id": node},
			"/api/projects/" + testProject + "/graph/modules/" + node + "/objects", ""},
		{"modules_graph_strategies", map[string]any{"project_id": testProject, "graph_node_id": node},
			"/api/projects/" + testProject + "/graph/modules/" + node + "/strategies", ""},
		{"modules_graph_changes", map[string]any{"project_id": testProject, "graph_node_id": node},
			"/api/projects/" + testProject + "/graph/modules/" + node + "/changes", ""},
		{"modules_graph_neighborhood", map[string]any{"project_id": testProject, "graph_node_id": node, "depth": 2},
			"/api/projects/" + testProject + "/graph/modules/" + node + "/neighborhood", "depth=2"},
	}
	for _, tc := range cases {
		*calls = (*calls)[:0]
		if _, isErr := callModule(t, srv, tc.tool, tc.args, auth); isErr {
			t.Fatalf("%s should succeed", tc.tool)
		}
		if len(*calls) != 1 {
			t.Fatalf("%s: want 1 call, got %d", tc.tool, len(*calls))
		}
		got := (*calls)[0]
		if got.method != http.MethodGet || got.path != tc.path || got.query != tc.query {
			t.Fatalf("%s: got %s %s?%s, want GET %s?%s", tc.tool, got.method, got.path, got.query, tc.path, tc.query)
		}
		if got.auth != auth {
			t.Fatalf("%s must forward Authorization, got %q", tc.tool, got.auth)
		}
	}
}

// 图谱节点 id 来自扫描产物、不保证 UUID，但不能被拿来拼路径穿越。
func TestModuleGraphReadRejectsUnsafeNodeID(t *testing.T) {
	srv, calls := newModuleFacade(t, false)
	for _, node := range []string{"", "../../issue", "node/../x", "node?x=1"} {
		text, isErr := callModule(t, srv, "modules_graph_objects", map[string]any{
			"project_id":    testProject,
			"graph_node_id": node,
		}, "Bearer mat_test")
		if !isErr {
			t.Fatalf("node %q must be rejected, got %s", node, text)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("an unsafe node id must not reach upstream, got %d calls", len(*calls))
	}
}

// 邻域深度超出 1..3 时不发请求。
func TestModuleGraphNeighborhoodRejectsBadDepth(t *testing.T) {
	srv, calls := newModuleFacade(t, false)
	for _, depth := range []int{0, 4, -1} {
		if _, isErr := callModule(t, srv, "modules_graph_neighborhood", map[string]any{
			"project_id":    testProject,
			"graph_node_id": "node-1",
			"depth":         depth,
		}, "Bearer mat_test"); !isErr {
			t.Fatalf("depth %d must be rejected", depth)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("a bad depth must not reach upstream, got %d calls", len(*calls))
	}
}

// 每个工具的 InputSchema 都是手写 JSON：一处括号或引号写错，tools/list 会在运行时
// 崩给所有 agent 看，而编译期毫无提示。顺带盯住 required 必须真的声明过。
func TestModuleToolSchemasAreValidJSON(t *testing.T) {
	for _, tool := range moduleTools {
		var schema struct {
			Type       string                     `json:"type"`
			Properties map[string]json.RawMessage `json:"properties"`
			Required   []string                   `json:"required"`
		}
		if err := json.Unmarshal(tool.def.InputSchema, &schema); err != nil {
			t.Fatalf("%s: InputSchema is not valid JSON: %v", tool.def.Name, err)
		}
		if schema.Type != "object" {
			t.Fatalf("%s: InputSchema.type must be object, got %q", tool.def.Name, schema.Type)
		}
		for _, key := range schema.Required {
			if _, ok := schema.Properties[key]; !ok {
				t.Fatalf("%s: required key %q is not declared in properties", tool.def.Name, key)
			}
		}
	}
}

// 「从原型导入」把 HTML 里的 data-fp 锚点变成功能点：读 spec → 合并 → 发布。
// 服务端读不到 agent 机器上的文件，所以正文是内联传的，路径只有 /spec 与 /spec/publish。
func TestModuleSpecImportPublishesAnchorsAsFeaturePoints(t *testing.T) {
	srv, calls := newModuleFacade(t, true)
	html := `<section data-fp="FP-01" data-title="群列表"></section>` +
		`<section data-fp="FP-02" data-title="群设置"></section>`
	text, isErr := callModule(t, srv, "modules_spec_import", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"html":       html,
	}, "Bearer mat_task")
	if isErr {
		t.Fatalf("unexpected tool error: %s", text)
	}
	if len(*calls) != 2 {
		t.Fatalf("want GET spec + POST publish, got %+v", *calls)
	}
	if call := (*calls)[0]; call.method != http.MethodGet || call.path != "/api/projects/"+testProject+"/modules/"+testModule+"/spec" {
		t.Fatalf("first call must read the spec, got %s %s", call.method, call.path)
	}
	publish := (*calls)[1]
	if publish.method != http.MethodPost || publish.path != "/api/projects/"+testProject+"/modules/"+testModule+"/spec/publish" {
		t.Fatalf("second call must publish, got %s %s", publish.method, publish.path)
	}
	for _, want := range []string{"FP-01", "群列表", "FP-02", "expected_version"} {
		if !strings.Contains(publish.body, want) {
			t.Fatalf("publish body must carry %q, got %s", want, publish.body)
		}
	}
	if !strings.Contains(text, `"written":true`) || !strings.Contains(text, "FP-01") {
		t.Fatalf("report must say it wrote the imported codes, got %s", text)
	}
}

// dry-run 只回报会新增什么，一个写请求都不发。
func TestModuleSpecImportDryRunWritesNothing(t *testing.T) {
	srv, calls := newModuleFacade(t, true)
	text, isErr := callModule(t, srv, "modules_spec_import", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"html":       `<h2>会话</h2><h3>群列表</h3>`,
		"dry_run":    true,
	}, "Bearer mat_task")
	if isErr {
		t.Fatalf("unexpected tool error: %s", text)
	}
	for _, call := range *calls {
		if call.method != http.MethodGet {
			t.Fatalf("dry-run must not write, got %s %s", call.method, call.path)
		}
	}
	if !strings.Contains(text, `"written":false`) || !strings.Contains(text, "FP-01") {
		t.Fatalf("dry-run report must list what would be added, got %s", text)
	}
}

// 没有锚点也没有区块标题就拒绝：批量 publish 空 diff 等于什么都没做，但会让
// 调用方误以为导入了。空 HTML 同样直接拒，不发任何请求。
func TestModuleSpecImportRejectsEmptyInput(t *testing.T) {
	srv, calls := newModuleFacade(t, true)
	for _, args := range []map[string]any{
		{"project_id": testProject, "module_id": testModule},
		{"project_id": testProject, "module_id": testModule, "html": "   "},
		{"project_id": testProject, "module_id": testModule, "html": "<div>没有锚点也没有标题</div>"},
	} {
		if text, isErr := callModule(t, srv, "modules_spec_import", args, "Bearer mat_task"); !isErr {
			t.Fatalf("args %v must be rejected, got %s", args, text)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("rejected imports must not reach upstream, got %+v", *calls)
	}
}

// 上传登记的原型：html_path 只是虚拟路径，正文在 attachment 里——工具必须顺着
// 版本 → 档案 → 附件三跳把 HTML 取回来，而不是让调用方去 cat 一个不存在的文件。
func TestModulePrototypeReadFollowsArtifactToAttachment(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/prototype-versions"):
			_, _ = w.Write([]byte(`{"versions":[` +
				`{"version":2,"status":"pending","html_path":"prototypes/m/prototype-v2.html"},` +
				`{"version":1,"status":"confirmed","html_path":"prototypes/m/prototype-v1.html"}]}`))
		case r.URL.Path == "/api/projects/"+testProject+"/artifacts":
			if got := r.URL.Query().Get("doc_type"); got != "prototype" {
				t.Errorf("artifacts must be filtered to prototype rows, got doc_type=%q", got)
			}
			_, _ = w.Write([]byte(`{"artifacts":[{"id":"art-1","rel_path":"prototypes/m/prototype-v1.html",` +
				`"doc_type":"prototype","doc_module":"模块","version":1,"attachment_id":"att-1"}],"total":1}`))
		case strings.HasSuffix(r.URL.Path, "/modules"):
			_, _ = w.Write([]byte(`{"modules":[{"id":"` + testModule + `","name":"模块"}]}`))
		case r.URL.Path == "/api/attachments/att-1/content":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(`<h1 data-fp="FP-01">群列表</h1>`))
		default:
			t.Errorf("unexpected upstream call: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()

	srv := NewModuleFacade(upstream.URL, true)
	text, isErr := callModule(t, srv, "modules_prototype_read", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
	}, "Bearer mat_task")
	if isErr {
		t.Fatalf("want the HTML, got error: %s", text)
	}
	for _, want := range []string{`FP-01`, `att-1`, `"source":"server"`, `"version":1`} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in result: %s", want, text)
		}
	}
}

// register 只记路径，正文永远进不了服务端——这是「agent 改完原型，人在 Web 端
// 什么也看不到」的根因。upload 必须把字节 → 档案行（带 attachment）→ 版本行
// 三步都走完，并把 rel_path 拼成与界面一致的形状（含中文、空格转连字符）。
func TestModulePrototypeUploadStoresBytesBeforeRegistering(t *testing.T) {
	var (
		mu     strings.Builder
		calls  []upstreamCall
		htmlIn = `<h1 data-fp="fp.FP-01" data-title="群列表">群列表</h1>`
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		calls = append(calls, upstreamCall{method: r.Method, path: r.URL.Path, body: string(raw)})
		switch {
		case strings.HasSuffix(r.URL.Path, "/modules") && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"modules":[{"id":"` + testModule + `","name":"1.0 AI 助手（首页）"}]}`))
		case strings.HasSuffix(r.URL.Path, "/prototype-versions") && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"versions":[{"version":1,"status":"confirmed","html_path":"prototypes/x/prototype-v1.html"}]}`))
		case r.URL.Path == "/api/upload-file":
			mu.WriteString(string(raw))
			_, _ = w.Write([]byte(`{"id":"att-9"}`))
		case r.URL.Path == "/api/projects/"+testProject+"/artifacts":
			_, _ = w.Write([]byte(`{"id":"art-9"}`))
		case strings.HasSuffix(r.URL.Path, "/prototype-versions") && r.Method == http.MethodPost:
			_, _ = w.Write([]byte(`{"id":"ver-2","version":2}`))
		case strings.HasSuffix(r.URL.Path, "/parse"):
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			t.Errorf("unexpected upstream call: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()

	srv := NewModuleFacade(upstream.URL, true)
	text, isErr := callModule(t, srv, "modules_prototype_upload", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
		"html":       htmlIn,
	}, "Bearer mat_task")
	if isErr {
		t.Fatalf("upload failed: %s", text)
	}

	// 字节真的发给了 /api/upload-file（multipart），而不是只记一个路径。
	if !strings.Contains(mu.String(), "fp.FP-01") || !strings.Contains(mu.String(), "群列表") {
		t.Fatalf("upload body does not carry the HTML: %s", mu.String())
	}

	var artifact, version map[string]any
	for _, call := range calls {
		switch {
		case call.path == "/api/projects/"+testProject+"/artifacts":
			_ = json.Unmarshal([]byte(call.body), &artifact)
		case strings.HasSuffix(call.path, "/prototype-versions") && call.method == http.MethodPost:
			_ = json.Unmarshal([]byte(call.body), &version)
		}
	}
	wantPath := "prototypes/1.0-AI-助手（首页）/prototype-v2.html"
	if artifact["rel_path"] != wantPath {
		t.Fatalf("artifact rel_path = %v, want %s (same shape as the web UI)", artifact["rel_path"], wantPath)
	}
	if artifact["attachment_id"] != "att-9" {
		t.Fatalf("artifact must carry the attachment: %v", artifact)
	}
	if version["html_path"] != wantPath {
		t.Fatalf("version html_path = %v, want the archive rel_path %s", version["html_path"], wantPath)
	}
	if artifact == nil || version == nil {
		t.Fatalf("expected both the archive row and the version row, got calls=%+v", calls)
	}
}

// 改模块前的第一站：上下文必须一次回答「原型正文到底在哪」，否则模型会开始翻磁盘。
func TestModuleContextNamesWhereTheBytesLive(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/workspace"):
			_, _ = w.Write([]byte(`{"name":"1.0 AI 助手（首页）","spec_version":7,"canonical_prototype_version":1,` +
				`"brief":{"version":3,"fields":{"brief.goal":{"value":"让用户更快开口"}}},` +
				`"field_defs":[{"key":"brief.goal","scope":"brief"},{"key":"brief.scope","scope":"brief"}],` +
				`"features":[{"code":"FP-01","title":"群列表","filled":2,"total":4,` +
				`"detail":{"desc":"x","req":"y"},"acceptance_ok":0,"acceptance_total":0}]}`))
		case strings.HasSuffix(r.URL.Path, "/prototype-versions"):
			_, _ = w.Write([]byte(`{"versions":[{"version":1,"status":"confirmed","html_path":"prototypes/m/prototype-v1.html"}]}`))
		case r.URL.Path == "/api/projects/"+testProject+"/artifacts":
			_, _ = w.Write([]byte(`{"artifacts":[{"id":"art-1","rel_path":"prototypes/m/prototype-v1.html",` +
				`"doc_type":"prototype","doc_module":"m","version":1,"attachment_id":"att-1"}],"total":1}`))
		case strings.HasSuffix(r.URL.Path, "/reconcile"):
			if got := r.URL.Query().Get("version"); got != "1" {
				t.Errorf("reconcile must target the inspected version, got version=%q", got)
			}
			_, _ = w.Write([]byte(`{"coverage":{"total":1,"covered":1,"denominator":1},"rows":[]}`))
		default:
			t.Errorf("unexpected upstream call: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()

	srv := NewModuleFacade(upstream.URL, true)
	text, isErr := callModule(t, srv, "modules_context", map[string]any{
		"project_id": testProject,
		"module_id":  testModule,
	}, "Bearer mat_task")
	if isErr {
		t.Fatalf("context failed: %s", text)
	}
	for _, want := range []string{
		`"readable_from":"server"`, // 正文在附件存储里，不在磁盘
		`"version":1`,
		`"acceptance"`,  // FP-01 缺验收段
		`"brief.scope"`, // 只有 brief.scope 是空的
		`modules_brief_patch`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in context: %s", want, text)
		}
	}
	if strings.Contains(text, `"brief.goal"`) {
		t.Fatalf("brief.goal already has a value and must not be reported as a gap: %s", text)
	}
}
