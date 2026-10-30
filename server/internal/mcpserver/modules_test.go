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
			"modules_prototype_versions", "modules_prototype_register",
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

func TestModuleToolsNeedSelfBaseURL(t *testing.T) {
	srv := NewModuleFacade("", false)
	text, isErr := callModule(t, srv, "modules_list", map[string]any{"project_id": testProject}, "Bearer mat_test")
	if !isErr || !strings.Contains(text, "MULTICA_PUBLIC_URL") {
		t.Fatalf("want configuration error, got isErr=%v text=%s", isErr, text)
	}
}
