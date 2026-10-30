// 项目 → 功能模块 的 MCP 工具面（2026-10-30）。
//
// 设计取舍：这里**不复制任何业务 SQL**。每个工具把参数映射成对 multica 自身 REST 的
// 一次调用，并把入站请求的 Authorization 原样透传——权限校验、feature flag 门控、
// 审计与 module_change_event 全部复用既有 handler，所以工具面与界面永远同源。
// 新增端点时只需在 moduleTools 里追加一条映射，不会长出第二套业务口径。
//
// 门控：模块 CRUD 与模块下需求始终可用；spec / 原型版本 / 对账 / 覆盖率四类挂在
// FF_MODULE_SPEC_CENTER 下，开关关闭时 tools/list 不返回、调用返回可读错误。
package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// moduleMaxBody 限制单次上游响应体，避免把大 HTML 注入给模型。
const moduleMaxBody = 4 << 20

// moduleToolset 承载「项目 → 功能模块」工具面。base 是 multica 自身的公网基址
// （MULTICA_PUBLIC_URL），**不从请求头推导**——那样会被 Host 头引成 SSRF。
type moduleToolset struct {
	client     *http.Client
	base       string
	specCenter bool
}

func newModuleToolset(baseURL string, specCenter bool) *moduleToolset {
	return &moduleToolset{
		client:     &http.Client{Timeout: 30 * time.Second},
		base:       strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		specCenter: specCenter,
	}
}

// Tools 返回当前开关状态下应暴露的工具定义。
func (t *moduleToolset) Tools() []toolDef {
	out := make([]toolDef, 0, len(moduleTools))
	for _, tool := range moduleTools {
		if tool.specOnly && !t.specCenter {
			continue
		}
		out = append(out, tool.def)
	}
	return out
}

// ctx 是一次工具调用的转发上下文。
type moduleCtx struct {
	client *http.Client
	base   string
	auth   string
}

// moduleTool 是一条「工具 → REST」映射。
type moduleTool struct {
	def      toolDef
	specOnly bool
	run      func(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError)
}

var moduleTools = []moduleTool{
	{
		def: toolDef{
			Name:        "modules_list",
			Description: "列出项目下的功能模块（id / name / color / graph_node_id / 需求数）。可用 search 按名称过滤。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string","description":"项目 UUID"},"search":{"type":"string","description":"按名称模糊过滤"}},"required":["project_id"],"additionalProperties":false}`),
		},
		run: runModulesList,
	},
	{
		def: toolDef{
			Name:        "modules_get",
			Description: "按 id 取单个功能模块的详情（从列表投影中筛出）。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"}},"required":["project_id","module_id"],"additionalProperties":false}`),
		},
		run: runModulesGet,
	},
	{
		def: toolDef{
			Name:        "modules_create",
			Description: "在项目下新建功能模块。名称项目内唯一，重名返回 409。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"name":{"type":"string"},"color":{"type":"string","description":"十六进制颜色，可省略"},"graph_node_id":{"type":"string","description":"绑定的图谱社区节点，可省略"}},"required":["project_id","name"],"additionalProperties":false}`),
		},
		run: runModulesCreate,
	},
	{
		def: toolDef{
			Name:        "modules_update",
			Description: "改名 / 改色 / 绑定或解绑图谱节点。只提交出现的字段；graph_node_id 传空串表示解绑。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"name":{"type":"string"},"color":{"type":"string"},"graph_node_id":{"type":"string"}},"required":["project_id","module_id"],"additionalProperties":false}`),
		},
		run: runModulesUpdate,
	},
	{
		def: toolDef{
			Name:        "modules_delete",
			Description: "删除功能模块。破坏性动作：必须显式传 confirm=true。模块下的需求不会被删除，只是变为无模块（FK ON DELETE SET NULL）。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"confirm":{"type":"boolean","description":"必须为 true 才执行删除"}},"required":["project_id","module_id","confirm"],"additionalProperties":false}`),
		},
		run: runModulesDelete,
	},
	{
		def: toolDef{
			Name:        "modules_requirements",
			Description: "列出模块下的工作项（默认全部，可用 kind=requirement/task 过滤），带状态与阶段。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"kind":{"type":"string","enum":["requirement","task"],"description":"可省略"}},"required":["project_id","module_id"],"additionalProperties":false}`),
		},
		run: runModulesRequirements,
	},
	{
		def: toolDef{
			Name:        "modules_spec_get",
			Description: "读取模块能力规格（module_spec/v1：summary + features[]）与 spec_version、权威原型版本号。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"}},"required":["project_id","module_id"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesSpecGet,
	},
	{
		def: toolDef{
			Name:        "modules_spec_draft",
			Description: "把整份 spec 存为草案（不升版本、不动投影）。人确认后再调 modules_spec_publish。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"spec":{"type":"object","description":"module_spec/v1：{schema,summary?,features:[{code,title,kind,priority?}]}"}},"required":["project_id","module_id","spec"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesSpecDraft,
	},
	{
		def: toolDef{
			Name:        "modules_spec_publish",
			Description: "发布 spec：事务内 spec_version+1、重建功能点投影并记事件。expected_version 与当前不符返回 409（并发保护）。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"spec":{"type":"object"},"expected_version":{"type":"integer","description":"可选，乐观锁"}},"required":["project_id","module_id","spec"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesSpecPublish,
	},
	{
		def: toolDef{
			Name:        "modules_prototype_versions",
			Description: "列出模块的原型版本（version / html_path / status / issue_id）。canonical_only=true 只看已确认版本。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"canonical_only":{"type":"boolean"}},"required":["project_id","module_id"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesPrototypeVersions,
	},
	{
		def: toolDef{
			Name:        "modules_prototype_register",
			Description: "登记一个模块级原型版本（无需求模块也可登记）。set_canonical 需要该版本为 confirmed。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"version":{"type":"integer"},"html_path":{"type":"string"},"prompt":{"type":"string"},"status":{"type":"string","enum":["pending","confirmed","superseded"]},"issue_id":{"type":"string"},"set_canonical":{"type":"boolean"}},"required":["project_id","module_id","version","html_path"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesPrototypeRegister,
	},
	{
		def: toolDef{
			Name:        "modules_prototype_plan_create",
			Description: "把「候选版本 + 新 spec + 功能点处置」快照成一条 draft 发布计划；不动任何权威指针，等用户确认后再 apply。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"candidate_version":{"type":"integer","description":"要上位的原型版本号"},"new_spec":{"type":"object","description":"可选，缺省沿用已发布 spec"},"decisions":{"type":"object","description":"可选，功能点 → 处置映射（keep/update/add/remove）"}},"required":["project_id","module_id","candidate_version"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesPlanCreate,
	},
	{
		def: toolDef{
			Name:        "modules_prototype_plan_get",
			Description: "读取一条发布计划的状态（draft/applying/applied/failed/expired）与快照。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"plan_id":{"type":"string"}},"required":["project_id","module_id","plan_id"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesPlanGet,
	},
	{
		def: toolDef{
			Name:        "modules_prototype_plan_apply",
			Description: "执行发布计划：同一事务内移动权威原型版本、升 spec 版本、重建功能点投影。人的动作——先确认计划无误再调用。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"plan_id":{"type":"string"}},"required":["project_id","module_id","plan_id"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesPlanApply,
	},
	{
		def: toolDef{
			Name:        "modules_reconcile",
			Description: "读取 spec 功能点 × 原型锚点的四态对账矩阵与覆盖率（唯一口径在后端，勿自行计算）。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"version":{"type":"integer","description":"可省略，默认权威版本"}},"required":["project_id","module_id"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesReconcile,
	},
	{
		def: toolDef{
			Name:        "modules_coverage",
			Description: "只读覆盖率 KPI（与列表徽标同源）。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"}},"required":["project_id","module_id"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesCoverage,
	},
	{
		def: toolDef{
			Name:        "modules_workspace_get",
			Description: "读取右栏「功能点详解」工作区：字段字典 + 模块说明（逐字段带版本/作者）+ 功能点四段详情 + 说明版本记录 + 成对发布记录。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"}},"required":["project_id","module_id"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesWorkspaceGet,
	},
	{
		def: toolDef{
			Name:        "modules_brief_patch",
			Description: "逐字段写模块说明或功能点四段详情（brief.* / fp.<code>.*），追加一条说明版本。base_version 陈旧返回 409 base_stale，只读字段返回 422 read_only_field，引用不存在的功能点返回 422 feature_not_found。先调 modules_workspace_get 拿当前版本号。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"base_version":{"type":"integer","description":"当前说明版本号，来自 modules_workspace_get"},"fields":{"type":"object","description":"key → 新值；brief.goal / brief.scope / fp.FP-01.desc / fp.FP-01.acceptance 等"},"source":{"type":"string","enum":["manual","agent","mcp","extract","rollback"]},"note":{"type":"string","description":"可选，版本记录里的一句话说明"}},"required":["project_id","module_id","base_version","fields"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesBriefPatch,
	},
	{
		def: toolDef{
			Name:        "modules_releases_list",
			Description: "列出成对发布记录（说明版本 ⨯ 原型版本）与当前两条时间轴的指针。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"}},"required":["project_id","module_id"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesReleasesList,
	},
	{
		def: toolDef{
			Name:        "modules_release_publish",
			Description: "把「说明 vN ⨯ 原型 vM」成对发布，同时推进两个指针。人的动作——agent 调用会 403；agent 应该只产出说明版本（modules_brief_patch）等用户发布。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"brief_version":{"type":"integer","description":"可省略，默认当前说明版本"},"prototype_version":{"type":"integer","description":"可省略，默认权威原型版本"},"note":{"type":"string"}},"required":["project_id","module_id"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesReleasePublish,
	},
	{
		def: toolDef{
			Name:        "modules_release_rollback",
			Description: "回滚 = 以旧版本为基发一个新版本（不改任何历史行）。人的动作——agent 调用会 403。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"release_version":{"type":"integer","description":"要回滚到的发布序号"}},"required":["project_id","module_id","release_version"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesReleaseRollback,
	},
}

// Call 分派一次 modules_* 调用。base 用配置的自有地址，auth 透传入站请求。
func (t *moduleToolset) Call(ctx context.Context, name string, args json.RawMessage) (any, *jsonRPCError) {
	var tool *moduleTool
	for i := range moduleTools {
		if moduleTools[i].def.Name == name {
			tool = &moduleTools[i]
			break
		}
	}
	if tool == nil {
		return nil, &jsonRPCError{Code: -32601, Message: "unknown tool: " + name}
	}
	if tool.specOnly && !t.specCenter {
		return nil, &jsonRPCError{Code: -32002, Message: "module_spec_center is disabled: spec / prototype / reconcile tools need FF_MODULE_SPEC_CENTER=true"}
	}
	if t.base == "" {
		return nil, &jsonRPCError{Code: -32000, Message: "module tools need MULTICA_PUBLIC_URL so the facade can call its own API"}
	}
	auth := authorizationFromContext(ctx)
	if strings.TrimSpace(auth) == "" {
		return nil, &jsonRPCError{Code: -32001, Message: "unauthorized: modules_* tools forward the caller Authorization header"}
	}
	return tool.run(ctx, moduleCtx{client: t.client, base: t.base, auth: auth}, args)
}

// ── 转发 ────────────────────────────────────────────────────────────────

func (rt moduleCtx) do(ctx context.Context, method, path string, body any) (any, *jsonRPCError) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, &jsonRPCError{Code: -32602, Message: "invalid arguments"}
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, rt.base+path, reader)
	if err != nil {
		return nil, &jsonRPCError{Code: -32000, Message: "cannot build upstream request: " + err.Error()}
	}
	req.Header.Set("Authorization", rt.auth)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := rt.client.Do(req)
	if err != nil {
		return nil, &jsonRPCError{Code: -32000, Message: "upstream request failed: " + err.Error()}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, moduleMaxBody))
	if err != nil {
		return nil, &jsonRPCError{Code: -32000, Message: "cannot read upstream response: " + err.Error()}
	}
	if resp.StatusCode >= 400 {
		return nil, &jsonRPCError{
			Code:    -32000,
			Message: fmt.Sprintf("%s %s → HTTP %d: %s", method, path, resp.StatusCode, compactJSON(raw)),
		}
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return map[string]any{"ok": true}, nil
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		// 非 JSON（例如原型 HTML）按文本返回，交由调用方处理。
		return string(raw), nil
	}
	return out, nil
}

func compactJSON(raw []byte) string {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) > 800 {
		trimmed = trimmed[:800] + "…"
	}
	return trimmed
}

// ── 参数与路径 ───────────────────────────────────────────────────────────

// uuidPath 校验 UUID 形状再拼进路径，避免参数变成路径穿越/额外查询串。
func uuidPath(name, value string) (string, *jsonRPCError) {
	if !isUUID(value) {
		return "", &jsonRPCError{Code: -32602, Message: name + " must be a UUID"}
	}
	return value, nil
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
			if !isHex {
				return false
			}
		}
	}
	return true
}

// modulePath 组装 /api/projects/{p}/modules/{m}<suffix>。
func modulePath(projectID, moduleID, suffix string) string {
	if moduleID == "" {
		return "/api/projects/" + projectID + "/modules" + suffix
	}
	return "/api/projects/" + projectID + "/modules/" + moduleID + suffix
}

type moduleArgs struct {
	ProjectID     string          `json:"project_id"`
	ModuleID      string          `json:"module_id"`
	Name          string          `json:"name"`
	Color         string          `json:"color"`
	GraphNodeID   *string         `json:"graph_node_id"`
	Confirm       bool            `json:"confirm"`
	Kind          string          `json:"kind"`
	Spec          json.RawMessage `json:"spec"`
	Expected      *int32          `json:"expected_version"`
	CanonicalOnly bool            `json:"canonical_only"`
	Version       *int32          `json:"version"`
	HTMLPath      string          `json:"html_path"`
	Prompt        string          `json:"prompt"`
	Status        string          `json:"status"`
	IssueID       string          `json:"issue_id"`
	SetCanonical  bool            `json:"set_canonical"`
	Search        string          `json:"search"`

	CandidateVersion *int32          `json:"candidate_version"`
	NewSpec          json.RawMessage `json:"new_spec"`
	Decisions        json.RawMessage `json:"decisions"`
	PlanID           string          `json:"plan_id"`

	BaseVersion      *int32          `json:"base_version"`
	Fields           json.RawMessage `json:"fields"`
	Source           string          `json:"source"`
	Note             string          `json:"note"`
	BriefVersion     *int32          `json:"brief_version"`
	PrototypeVersion *int32          `json:"prototype_version"`
	ReleaseVersion   *int32          `json:"release_version"`
}

func parseArgs(raw json.RawMessage) (moduleArgs, *jsonRPCError) {
	var a moduleArgs
	if len(bytes.TrimSpace(raw)) == 0 {
		return a, &jsonRPCError{Code: -32602, Message: "arguments required"}
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return a, &jsonRPCError{Code: -32602, Message: "invalid arguments: " + err.Error()}
	}
	if a.ProjectID == "" {
		return a, &jsonRPCError{Code: -32602, Message: "project_id required"}
	}
	if _, err := uuidPath("project_id", a.ProjectID); err != nil {
		return a, err
	}
	return a, nil
}

// objectArg 把一个必填的 JSON 对象参数解成 map，空对象直接拒绝（避免无意义写空版本）。
func objectArg(name string, raw json.RawMessage) (map[string]any, *jsonRPCError) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, &jsonRPCError{Code: -32602, Message: name + " required"}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, &jsonRPCError{Code: -32602, Message: name + " must be a JSON object: " + err.Error()}
	}
	if len(out) == 0 {
		return nil, &jsonRPCError{Code: -32602, Message: name + " must not be empty"}
	}
	return out, nil
}

// ── 工具实现 ─────────────────────────────────────────────────────────────

func runModulesList(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	data, jerr := rt.do(ctx, http.MethodGet, modulePath(a.ProjectID, "", ""), nil)
	if jerr != nil {
		return nil, jerr
	}
	if a.Search == "" {
		return data, nil
	}
	return filterModules(data, func(row map[string]any) bool {
		name, _ := row["name"].(string)
		return strings.Contains(strings.ToLower(name), strings.ToLower(a.Search))
	}), nil
}

func runModulesGet(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	data, jerr := rt.do(ctx, http.MethodGet, modulePath(a.ProjectID, "", ""), nil)
	if jerr != nil {
		return nil, jerr
	}
	found := filterModules(data, func(row map[string]any) bool {
		rowID, _ := row["id"].(string)
		return rowID == a.ModuleID
	})
	rows, _ := found.(map[string]any)["modules"].([]any)
	if len(rows) == 0 {
		return nil, &jsonRPCError{Code: -32004, Message: "module not found in this project: " + a.ModuleID}
	}
	return map[string]any{"module": rows[0]}, nil
}

func filterModules(data any, keep func(map[string]any) bool) any {
	envelope, ok := data.(map[string]any)
	if !ok {
		return data
	}
	rawRows, ok := envelope["modules"].([]any)
	if !ok {
		return data
	}
	kept := make([]any, 0, len(rawRows))
	for _, item := range rawRows {
		row, ok := item.(map[string]any)
		if !ok || !keep(row) {
			continue
		}
		kept = append(kept, row)
	}
	envelope["modules"] = kept
	envelope["total"] = len(kept)
	return envelope
}

func runModulesCreate(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if strings.TrimSpace(a.Name) == "" {
		return nil, &jsonRPCError{Code: -32602, Message: "name required"}
	}
	body := map[string]any{"name": strings.TrimSpace(a.Name)}
	if a.Color != "" {
		body["color"] = a.Color
	}
	if a.GraphNodeID != nil {
		body["graph_node_id"] = *a.GraphNodeID
	}
	return rt.do(ctx, http.MethodPost, modulePath(a.ProjectID, "", ""), body)
}

func runModulesUpdate(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	// 只转发真正出现的字段：PATCH 语义下缺席 = 不改。
	var present map[string]json.RawMessage
	if err := json.Unmarshal(args, &present); err != nil {
		return nil, &jsonRPCError{Code: -32602, Message: "invalid arguments"}
	}
	body := map[string]any{}
	if _, ok := present["name"]; ok {
		body["name"] = a.Name
	}
	if _, ok := present["color"]; ok {
		body["color"] = a.Color
	}
	if _, ok := present["graph_node_id"]; ok {
		if a.GraphNodeID == nil {
			body["graph_node_id"] = ""
		} else {
			body["graph_node_id"] = *a.GraphNodeID
		}
	}
	if len(body) == 0 {
		return nil, &jsonRPCError{Code: -32602, Message: "nothing to update: pass name, color or graph_node_id"}
	}
	return rt.do(ctx, http.MethodPatch, modulePath(a.ProjectID, a.ModuleID, ""), body)
}

func runModulesDelete(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	if !a.Confirm {
		return nil, &jsonRPCError{
			Code:    -32003,
			Message: "destructive action refused: pass confirm=true. The module's requirements survive (they become module-less); prototypes and archive documents are untouched.",
		}
	}
	return rt.do(ctx, http.MethodDelete, modulePath(a.ProjectID, a.ModuleID, ""), nil)
}

func runModulesRequirements(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	path := "/api/issues?project_id=" + a.ProjectID + "&module_id=" + a.ModuleID
	if a.Kind != "" {
		path += "&kind=" + a.Kind
	}
	return rt.do(ctx, http.MethodGet, path, nil)
}

func runModulesSpecGet(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	return rt.do(ctx, http.MethodGet, modulePath(a.ProjectID, a.ModuleID, "/spec"), nil)
}

func runModulesSpecDraft(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	if len(a.Spec) == 0 {
		return nil, &jsonRPCError{Code: -32602, Message: "spec required"}
	}
	return rt.do(ctx, http.MethodPost, modulePath(a.ProjectID, a.ModuleID, "/spec/draft"),
		map[string]any{"spec": a.Spec})
}

func runModulesSpecPublish(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	if len(a.Spec) == 0 {
		return nil, &jsonRPCError{Code: -32602, Message: "spec required"}
	}
	body := map[string]any{"spec": a.Spec}
	if a.Expected != nil {
		body["expected_version"] = *a.Expected
	}
	return rt.do(ctx, http.MethodPost, modulePath(a.ProjectID, a.ModuleID, "/spec/publish"), body)
}

func runModulesPrototypeVersions(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	suffix := "/prototype-versions"
	if a.CanonicalOnly {
		suffix += "?canonical_only=true"
	}
	return rt.do(ctx, http.MethodGet, modulePath(a.ProjectID, a.ModuleID, suffix), nil)
}

func runModulesPrototypeRegister(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	if a.Version == nil {
		return nil, &jsonRPCError{Code: -32602, Message: "version required"}
	}
	if strings.TrimSpace(a.HTMLPath) == "" {
		return nil, &jsonRPCError{Code: -32602, Message: "html_path required"}
	}
	body := map[string]any{"version": *a.Version, "html_path": a.HTMLPath}
	if a.Prompt != "" {
		body["prompt"] = a.Prompt
	}
	if a.Status != "" {
		body["status"] = a.Status
	}
	if a.IssueID != "" {
		if _, jerr := uuidPath("issue_id", a.IssueID); jerr != nil {
			return nil, jerr
		}
		body["issue_id"] = a.IssueID
	}
	if a.SetCanonical {
		body["set_canonical"] = true
	}
	return rt.do(ctx, http.MethodPost, modulePath(a.ProjectID, a.ModuleID, "/prototype-versions"), body)
}

func runModulesPlanCreate(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	if a.CandidateVersion == nil {
		return nil, &jsonRPCError{Code: -32602, Message: "candidate_version required (register the prototype version first)"}
	}
	body := map[string]any{"candidate_version": *a.CandidateVersion}
	if len(a.NewSpec) > 0 {
		body["new_spec"] = a.NewSpec
	}
	if len(a.Decisions) > 0 {
		body["decisions"] = a.Decisions
	}
	return rt.do(ctx, http.MethodPost, modulePath(a.ProjectID, a.ModuleID, "/prototype-plans"), body)
}

func runModulesPlanGet(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("plan_id", a.PlanID); jerr != nil {
		return nil, jerr
	}
	return rt.do(ctx, http.MethodGet,
		modulePath(a.ProjectID, a.ModuleID, "/prototype-plans/"+a.PlanID), nil)
}

func runModulesPlanApply(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("plan_id", a.PlanID); jerr != nil {
		return nil, jerr
	}
	return rt.do(ctx, http.MethodPost,
		modulePath(a.ProjectID, a.ModuleID, "/prototype-plans/"+a.PlanID+"/apply"), nil)
}

func runModulesReconcile(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	suffix := "/prototype-reconcile"
	if a.Version != nil {
		suffix += fmt.Sprintf("?version=%d", *a.Version)
	}
	return rt.do(ctx, http.MethodGet, modulePath(a.ProjectID, a.ModuleID, suffix), nil)
}

func runModulesCoverage(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	return rt.do(ctx, http.MethodGet, modulePath(a.ProjectID, a.ModuleID, "/coverage"), nil)
}

func runModulesWorkspaceGet(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	return rt.do(ctx, http.MethodGet, modulePath(a.ProjectID, a.ModuleID, "/workspace"), nil)
}

func runModulesBriefPatch(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	if a.BaseVersion == nil {
		return nil, &jsonRPCError{Code: -32602, Message: "base_version is required: read it from modules_workspace_get first"}
	}
	fields, jerr := objectArg("fields", a.Fields)
	if jerr != nil {
		return nil, jerr
	}
	body := map[string]any{"base_version": *a.BaseVersion, "fields": fields}
	if strings.TrimSpace(a.Source) != "" {
		body["source"] = a.Source
	}
	if strings.TrimSpace(a.Note) != "" {
		body["note"] = a.Note
	}
	return rt.do(ctx, http.MethodPost, modulePath(a.ProjectID, a.ModuleID, "/workspace/patch"), body)
}

func runModulesReleasesList(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	return rt.do(ctx, http.MethodGet, modulePath(a.ProjectID, a.ModuleID, "/releases"), nil)
}

func runModulesReleasePublish(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	body := map[string]any{}
	if a.BriefVersion != nil {
		body["brief_version"] = *a.BriefVersion
	}
	if a.PrototypeVersion != nil {
		body["prototype_version"] = *a.PrototypeVersion
	}
	if strings.TrimSpace(a.Note) != "" {
		body["note"] = a.Note
	}
	return rt.do(ctx, http.MethodPost, modulePath(a.ProjectID, a.ModuleID, "/releases"), body)
}

func runModulesReleaseRollback(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	if a.ReleaseVersion == nil {
		return nil, &jsonRPCError{Code: -32602, Message: "release_version is required"}
	}
	suffix := fmt.Sprintf("/releases/%d/rollback", *a.ReleaseVersion)
	return rt.do(ctx, http.MethodPost, modulePath(a.ProjectID, a.ModuleID, suffix), nil)
}
