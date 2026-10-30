// multica 资产管理 MCP 只读门面（plan 101 P2）。
//
// 目的：让执行 agent 经 MCP **按需拉取**资产内容（原型图/架构/验收标准/spec），替代
// 每次批量塞进 prompt。红线：这是**只读消费门面**——只包装既有 project_asset_binding
// 读路径，不写主数据、不改变 multica 与引擎的主通道；与 WeKnora「MCP 非主通道」决策一致。
//
// 实现：Model Context Protocol 的 tools 面 = JSON-RPC 2.0 over HTTP（仅 stdlib，无新依赖）。
// 支持 initialize / tools/list / tools/call / ping。鉴权由挂载它的中间件把「本次 run 的可见
// 资产作用域」写入 context（见 ScopeFromContext），本模块自身不产密钥、不做 RBAC 判定。
package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// 协议版本：与主流 MCP 客户端对齐的稳定标识。
const protocolVersion = "2025-06-18"

// Scope 是一次资产读请求的可见作用域（由鉴权中间件注入）。
type Scope struct {
	WorkspaceID string `json:"workspace_id"`
	ProjectID   string `json:"project_id,omitempty"`
	IssueID     string `json:"issue_id,omitempty"`
}

// AssetView 是资产目录的一条轻量投影（列表/检索返回）。
type AssetView struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Category       string   `json:"asset_category"`
	LifecycleStage string   `json:"lifecycle_stage,omitempty"`
	AssetRole      string   `json:"asset_role,omitempty"`
	Tags           []string `json:"tags,omitempty"`
}

// AssetDetail 在 AssetView 之上带正文指针（get_content 返回）。
type AssetDetail struct {
	AssetView
	ExternalRef   json.RawMessage `json:"external_ref,omitempty"`
	ContentSource string          `json:"content_source,omitempty"`
	Content       string          `json:"content,omitempty"`
}

// Store 是只读资产数据源。生产实现走 project_asset_binding（见 store_db.go）；
// 单测用内存实现，锁死协议行为而不依赖 DB。
type Store interface {
	ListAssets(ctx context.Context, scope Scope) ([]AssetView, error)
	SearchAssets(ctx context.Context, scope Scope, query string) ([]AssetView, error)
	GetAsset(ctx context.Context, scope Scope, bindingID string) (AssetDetail, error)
}

// scopeKey 是注入/读取 Scope 的 context key。
type scopeKey struct{}

// authKey 携带入站请求的 Authorization 头，供 modules_* 工具原样透传。
type authKey struct{}

// WithAuthorization 由 HTTP 入口把调用方凭据放入 context。
func WithAuthorization(ctx context.Context, value string) context.Context {
	return context.WithValue(ctx, authKey{}, value)
}

func authorizationFromContext(ctx context.Context) string {
	value, _ := ctx.Value(authKey{}).(string)
	return value
}

// WithScope 供鉴权中间件把本次请求的可见作用域放入 context。
func WithScope(ctx context.Context, s Scope) context.Context {
	return context.WithValue(ctx, scopeKey{}, s)
}

// ScopeFromContext 读取作用域；缺失即未鉴权，调用方应拒绝请求。
func ScopeFromContext(ctx context.Context) (Scope, bool) {
	s, ok := ctx.Value(scopeKey{}).(Scope)
	return s, ok
}

// Server 把 Store 暴露为 MCP tools over JSON-RPC。
type Server struct {
	store   Store
	tools   []toolDef
	modules *moduleToolset
}

type toolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// New 构造 MCP 门面服务器并注册三个只读工具。
func New(store Store) *Server {
	return &Server{
		store: store,
		tools: []toolDef{
			{Name: "assets_list", Description: "列出当前作用域内已绑定的资产（需求/项目/工作区）", InputSchema: json.RawMessage(`{"type":"object","properties":{"scope":{"type":"string","enum":["issue","project","workspace"]}},"additionalProperties":false}`)},
			{Name: "assets_search", Description: "按名称/关键词检索候选资产", InputSchema: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}`)},
			{Name: "assets_get_content", Description: "按 bindingId 取资产正文/内容指针（原型图、架构 spec、验收标准等）", InputSchema: json.RawMessage(`{"type":"object","properties":{"bindingId":{"type":"string"}},"required":["bindingId"],"additionalProperties":false}`)},
		},
	}
}

// NewModuleFacade 构造只带「项目 → 功能模块」工具面的服务器（不暴露资产工具，
// 因此也不需要资产读作用域）。调用方把它的 Handler() 挂在已鉴权的路由组下。
func NewModuleFacade(baseURL string, specCenter bool) *Server {
	s := &Server{tools: []toolDef{}}
	s.modules = newModuleToolset(baseURL, specCenter)
	return s
}

// WithModuleTools 打开「项目 → 功能模块」工具面。baseURL 是 multica 自身的公网
// 基址（MULTICA_PUBLIC_URL）；空串时工具仍会列出，但调用会返回可读的配置错误。
// specCenter 与后端 FF_MODULE_SPEC_CENTER 同步：关闭时 spec/原型/对账工具不列出。
func (s *Server) WithModuleTools(baseURL string, specCenter bool) *Server {
	s.modules = newModuleToolset(baseURL, specCenter)
	return s
}

// jsonRPCRequest/Response 是 JSON-RPC 2.0 的最小信封。
type jsonRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"msg"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

// Handler 返回 http.Handler：POST 承载 JSON-RPC（Streamable HTTP 的单请求一响应形态）。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handle)
	return mux
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, nil, -32000, "method must be POST")
		return
	}
	var req jsonRPCRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, nil, -32700, "parse error")
		return
	}
	// 通知（无 id，如 notifications/initialized）不回体。
	isNotification := len(req.ID) == 0 || string(req.ID) == "null"
	ctx := WithAuthorization(r.Context(), r.Header.Get("Authorization"))
	result, jerr := s.dispatch(ctx, req)
	if isNotification {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if jerr != nil {
		writeErr(w, req.ID, jerr.Code, jerr.Message)
		return
	}
	writeJSON(w, jsonRPCResponse{JSONRPC: "2.0", ID: req.ID, Result: result})
}

func (s *Server) dispatch(ctx context.Context, req jsonRPCRequest) (any, *jsonRPCError) {
	switch req.Method {
	case "initialize":
		return map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "multica-assets", "version": "1"},
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		tools := s.tools
		if s.modules != nil {
			tools = append(append([]toolDef{}, tools...), s.modules.Tools()...)
		}
		return map[string]any{"tools": tools}, nil
	case "tools/call":
		return s.callTool(ctx, req.Params)
	default:
		return nil, &jsonRPCError{Code: -32601, Message: "method not found: " + req.Method}
	}
}

type toolCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

func (s *Server) callTool(ctx context.Context, raw json.RawMessage) (any, *jsonRPCError) {
	var p toolCallParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &jsonRPCError{Code: -32602, Message: "invalid params"}
	}
	var data any
	var terr *jsonRPCError
	if s.modules != nil && strings.HasPrefix(p.Name, "modules_") {
		// 模块工具面走「工具 → REST」转发，鉴权由被调用的 handler 重做，
		// 因此不要求资产读作用域。
		data, terr = s.modules.Call(ctx, p.Name, p.Arguments)
	} else {
		scope, ok := ScopeFromContext(ctx)
		if !ok {
			return nil, &jsonRPCError{Code: -32001, Message: "unauthorized: no asset scope"}
		}
		data, terr = s.execTool(ctx, scope, p.Name, p.Arguments)
	}
	text, _ := json.Marshal(data)
	if terr != nil {
		return map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": terr.Message}}}, nil
	}
	return map[string]any{"content": []map[string]any{{"type": "text", "text": string(text)}}}, nil
}

func (s *Server) execTool(ctx context.Context, scope Scope, name string, args json.RawMessage) (any, *jsonRPCError) {
	switch name {
	case "assets_list":
		data, err := s.store.ListAssets(ctx, scope)
		if err != nil {
			return nil, &jsonRPCError{Code: -32000, Message: err.Error()}
		}
		return data, nil
	case "assets_search":
		var a struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal(args, &a)
		data, err := s.store.SearchAssets(ctx, scope, a.Query)
		if err != nil {
			return nil, &jsonRPCError{Code: -32000, Message: err.Error()}
		}
		return data, nil
	case "assets_get_content":
		var a struct {
			BindingID string `json:"bindingId"`
		}
		if err := json.Unmarshal(args, &a); err != nil || a.BindingID == "" {
			return nil, &jsonRPCError{Code: -32602, Message: "bindingId required"}
		}
		data, err := s.store.GetAsset(ctx, scope, a.BindingID)
		if err != nil {
			return nil, &jsonRPCError{Code: -32000, Message: err.Error()}
		}
		return data, nil
	default:
		return nil, &jsonRPCError{Code: -32601, Message: "unknown tool: " + name}
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, id json.RawMessage, code int, msg string) {
	writeJSON(w, jsonRPCResponse{JSONRPC: "2.0", ID: id, Error: &jsonRPCError{Code: code, Message: msg}})
}
