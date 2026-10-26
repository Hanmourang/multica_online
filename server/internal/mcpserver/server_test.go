package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeStore 是内存 Store，锁死协议行为而不依赖 DB。
type fakeStore struct {
	assets  []AssetView
	detail  map[string]AssetDetail
	listErr error
}

func (f *fakeStore) ListAssets(_ context.Context, _ Scope) ([]AssetView, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.assets, nil
}

func (f *fakeStore) SearchAssets(_ context.Context, _ Scope, query string) ([]AssetView, error) {
	out := []AssetView{}
	for _, a := range f.assets {
		if query == "" || bytes.Contains([]byte(a.Name), []byte(query)) {
			out = append(out, a)
		}
	}
	return out, nil
}

func (f *fakeStore) GetAsset(_ context.Context, _ Scope, bindingID string) (AssetDetail, error) {
	if d, ok := f.detail[bindingID]; ok {
		return d, nil
	}
	return AssetDetail{}, nil
}

func newTestServer() (*Server, *fakeStore) {
	store := &fakeStore{
		assets: []AssetView{{ID: "a1", Name: "prototype", Category: "design"}},
		detail: map[string]AssetDetail{"a1": {AssetView: AssetView{ID: "a1", Name: "prototype"}, Content: "blob"}},
	}
	return New(store), store
}

// rpcPost 发一次 JSON-RPC，返回解析后的响应信封。
func rpcPost(t *testing.T, h http.Handler, body map[string]any, scope *Scope) jsonRPCResponse {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(raw))
	if scope != nil {
		req = req.WithContext(WithScope(req.Context(), *scope))
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var resp jsonRPCResponse
	if w.Code == http.StatusAccepted {
		resp.ID = json.RawMessage("null")
		return resp
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, w.Body.String())
	}
	return resp
}

func TestInitialize(t *testing.T) {
	srv, _ := newTestServer()
	resp := rpcPost(t, srv.Handler(), map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(`1`), "method": "initialize",
	}, nil)
	if resp.Error != nil {
		t.Fatalf("initialize error: %+v", resp.Error)
	}
	result, _ := resp.Result.(map[string]any)
	if result["protocolVersion"] != protocolVersion {
		t.Fatalf("bad protocolVersion: %v", result["protocolVersion"])
	}
}

func TestToolsList(t *testing.T) {
	srv, _ := newTestServer()
	resp := rpcPost(t, srv.Handler(), map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(`2`), "method": "tools/list",
	}, nil)
	result, _ := resp.Result.(map[string]any)
	tools, _ := result["tools"].([]any)
	if len(tools) != 3 {
		t.Fatalf("expected 3 tools, got %d", len(tools))
	}
}

func TestUnknownMethod(t *testing.T) {
	srv, _ := newTestServer()
	resp := rpcPost(t, srv.Handler(), map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(`3`), "method": "bogus/method",
	}, nil)
	if resp.Error == nil || resp.Error.Code != -32601 {
		t.Fatalf("expected -32601, got %+v", resp.Error)
	}
}

func TestToolsCallRequiresScope(t *testing.T) {
	srv, _ := newTestServer()
	resp := rpcPost(t, srv.Handler(), map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(`4`), "method": "tools/call",
		"params": map[string]any{"name": "assets_list", "arguments": map[string]any{}},
	}, nil) // no scope
	if resp.Error == nil || resp.Error.Code != -32001 {
		t.Fatalf("expected -32001 unauthorized, got %+v", resp.Error)
	}
}

func TestToolsCallListAssets(t *testing.T) {
	srv, _ := newTestServer()
	scope := Scope{WorkspaceID: "w1", ProjectID: "p1"}
	resp := rpcPost(t, srv.Handler(), map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(`5`), "method": "tools/call",
		"params": map[string]any{"name": "assets_list", "arguments": map[string]any{}},
	}, &scope)
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
	result, _ := resp.Result.(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("expected 1 content item, got %d", len(content))
	}
	text, _ := content[0].(map[string]any)["text"].(string)
	var got []AssetView
	if err := json.Unmarshal([]byte(text), &got); err != nil {
		t.Fatalf("decode asset text: %v", err)
	}
	if len(got) != 1 || got[0].ID != "a1" {
		t.Fatalf("bad assets: %+v", got)
	}
}

func TestToolsCallGetContent(t *testing.T) {
	srv, _ := newTestServer()
	scope := Scope{WorkspaceID: "w1", ProjectID: "p1"}
	resp := rpcPost(t, srv.Handler(), map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(`6`), "method": "tools/call",
		"params": map[string]any{"name": "assets_get_content", "arguments": map[string]any{"bindingId": "a1"}},
	}, &scope)
	result, _ := resp.Result.(map[string]any)
	content, _ := result["content"].([]any)
	text, _ := content[0].(map[string]any)["text"].(string)
	var d AssetDetail
	_ = json.Unmarshal([]byte(text), &d)
	if d.Content != "blob" {
		t.Fatalf("expected content blob, got %q", d.Content)
	}
}

func TestToolsCallGetContentMissingID(t *testing.T) {
	srv, _ := newTestServer()
	scope := Scope{WorkspaceID: "w1", ProjectID: "p1"}
	resp := rpcPost(t, srv.Handler(), map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(`7`), "method": "tools/call",
		"params": map[string]any{"name": "assets_get_content", "arguments": map[string]any{}},
	}, &scope)
	// bindingId 缺失属工具级错误：MCP 语义下作为 isError 结果返回，非协议级 error。
	if resp.Error != nil {
		t.Fatalf("expected tool-level result not protocol error, got %+v", resp.Error)
	}
	result, _ := resp.Result.(map[string]any)
	if result["isError"] != true {
		t.Fatalf("expected isError true, got %+v", result)
	}
}

func TestToolsCallStoreErrorBecomesIsError(t *testing.T) {
	srv, store := newTestServer()
	store.listErr = errors.New("db down")
	scope := Scope{WorkspaceID: "w1", ProjectID: "p1"}
	resp := rpcPost(t, srv.Handler(), map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(`8`), "method": "tools/call",
		"params": map[string]any{"name": "assets_list", "arguments": map[string]any{}},
	}, &scope)
	result, _ := resp.Result.(map[string]any)
	if result["isError"] != true {
		t.Fatalf("expected isError true, got %+v", result)
	}
}

func TestNotificationNoBody(t *testing.T) {
	srv, _ := newTestServer()
	raw, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": "notifications/initialized",
	})
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(raw))
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202 for notification, got %d", w.Code)
	}
}

func TestGETRejected(t *testing.T) {
	srv, _ := newTestServer()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	var resp jsonRPCResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Error == nil || resp.Error.Code != -32000 {
		t.Fatalf("expected -32000 for GET, got %+v", resp.Error)
	}
}
