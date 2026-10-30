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
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/prototypeimport"
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
			Name:        "modules_requirements_attach",
			Description: "把一条需求（或任务）挂到模块下：只改 issue.module_id，可选 feature_code 同时绑到一个功能点。这是精细化迭代的粒度（一个 issue 对应一个功能点）。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"issue_id":{"type":"string"},"feature_code":{"type":"string","description":"可选；必须是该模块已有的功能点编号"}},"required":["project_id","module_id","issue_id"],"additionalProperties":false}`),
		},
		run: runModulesRequirementsAttach,
	},
	{
		def: toolDef{
			Name:        "modules_requirements_detach",
			Description: "把一条需求从模块上摘下来（issue.module_id = null）。功能点归属由服务端级联清空；需求本身不删。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string","description":"归属校验用，可选"},"issue_id":{"type":"string"}},"required":["project_id","issue_id"],"additionalProperties":false}`),
		},
		run: runModulesRequirementsDetach,
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
			Name:        "modules_spec_feature_add",
			Description: "给 spec 追加一个功能点（单条读改写：只动这一行，其余原样往返）。code 必须新；默认发布（spec_version+1、重建投影），draft=true 只存草稿。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"code":{"type":"string","description":"功能点编号，例如 FP-05"},"title":{"type":"string"},"kind":{"type":"string","enum":["core","edge"],"description":"默认 core"},"priority":{"type":"string"},"group":{"type":"string","description":"分组名，与原型 h2 区块同名最省事"},"draft":{"type":"boolean"},"expected_version":{"type":"integer","description":"可选乐观锁；不传则用刚读到的 spec_version"}},"required":["project_id","module_id","code","title"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesSpecFeatureAdd,
	},
	{
		def: toolDef{
			Name:        "modules_spec_feature_update",
			Description: "修改一个功能点的 title / kind / priority / group，或用 code_new 改编号（原型锚点也要一起改，否则对账会读成「删除+新增」）。至少传一个字段。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"code":{"type":"string","description":"要改的功能点编号"},"code_new":{"type":"string"},"title":{"type":"string"},"kind":{"type":"string","enum":["core","edge"]},"priority":{"type":"string"},"group":{"type":"string"},"draft":{"type":"boolean"},"expected_version":{"type":"integer"}},"required":["project_id","module_id","code"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesSpecFeatureUpdate,
	},
	{
		def: toolDef{
			Name:        "modules_spec_feature_remove",
			Description: "从 spec 删掉一个功能点（按 code 精确匹配）。四段详情（fp.<code>.*）留在说明版本里但不再渲染；删除前先跟用户确认是否真的要删。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"code":{"type":"string"},"draft":{"type":"boolean"},"expected_version":{"type":"integer"}},"required":["project_id","module_id","code"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesSpecFeatureRemove,
	},
	{
		def: toolDef{
			Name:        "modules_spec_import",
			Description: "「从原型导入」：把原型里真实画出来的东西变成功能点——优先 data-fp 锚点（保留原型自己声明的编号，reconcile 按 code 匹配），没有锚点才退到 h2/h3 区块标题并按 FP-nn 续号。已在 spec 里的编号/标题跳过，所以重跑不会翻倍。HTML 必须内联传入（服务端读不到你机器上的文件）。dry_run=true 只回报不写入。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string","description":"项目 UUID"},"module_id":{"type":"string","description":"模块 UUID"},"html":{"type":"string","description":"原型的 HTML 正文（不是路径）"},"dry_run":{"type":"boolean","description":"只回报会新增什么，不写入"},"draft":{"type":"boolean","description":"存为草稿，spec_version 不变"},"expected_version":{"type":"integer","description":"可选乐观锁：当前 spec_version 不等于该值则 409"},"fill_brief":{"type":"boolean","description":"用原型的区块名/导航顺序补空着的 brief.scope / brief.flow，默认 true"},"prototype_version":{"type":"integer","description":"把 data-fp 锚点缓存上传到这个原型版本号；不传则 reconcile / coverage 看不到新功能点"}},"required":["project_id","module_id","html"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesSpecImport,
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
			Name:        "modules_prototype_update",
			Description: "修正一个模块自有版本的 html_path / prompt / status（只提交出现的字段）。用于修正登记错误；新一版内容用 register 新版本号。权威版本不允许离开 confirmed，需求名下版本一律拒绝。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"version":{"type":"integer"},"html_path":{"type":"string"},"prompt":{"type":"string"},"status":{"type":"string","enum":["pending","confirmed","superseded"]}},"required":["project_id","module_id","version"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesPrototypeUpdate,
	},
	{
		def: toolDef{
			Name:        "modules_prototype_confirm",
			Description: "把一个模块自有版本标为 confirmed；set_canonical=true 时同时移动权威指针并把上一版置为 superseded。不升 spec、不重建投影（那是 plan apply）。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"version":{"type":"integer"},"set_canonical":{"type":"boolean"}},"required":["project_id","module_id","version"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesPrototypeConfirm,
	},
	{
		def: toolDef{
			Name:        "modules_prototype_delete",
			Description: "删除一个模块自有原型版本（同时清掉它的锚点缓存）。破坏性动作：必须传 confirm=true。权威版本与被发布引用过的版本会被服务端拒绝。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"version":{"type":"integer"},"confirm":{"type":"boolean","description":"必须为 true 才执行删除"}},"required":["project_id","module_id","version","confirm"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesPrototypeDelete,
	},
	{
		def: toolDef{
			Name:        "modules_prototype_parse",
			Description: "上传某版本的 data-fp 锚点解析结果（code → {count,title}）。reconcile / coverage 读的是这张缓存：不调它，对账会把每个功能点都判为空位。原型 HTML 里的标记形如 data-fp=\"fp.xxx\" data-title=\"标题\"。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"module_id":{"type":"string"},"version":{"type":"integer"},"anchors":{"type":"object","description":"code → {count,title}"}},"required":["project_id","module_id","version","anchors"],"additionalProperties":false}`),
		},
		specOnly: true,
		run:      runModulesPrototypeParse,
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
	// 图谱桥接读（2026-10-30）：左栏的「对象 / 策略」计数、图谱视图与变更概览都
	// 来自这几条只读端点。CLI 是 multica graph modules|objects|strategies|neighborhood|changes，
	// 这里给出等价工具，让只有 MCP 的运行时读到同一份数字。写入口 graph/rebridge 仍然
	// 不给 agent：它一次重连全项目的模块↔对象映射，是人的决定。
	{
		def: toolDef{
			Name:        "modules_graph_bridges",
			Description: "列出功能模块与图谱节点的桥接状态（module id / graph_node_id / 对象数 / 策略数）。页面左栏的「对象」「策略」计数与「仅看未绑定」筛选读的就是它。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"}},"required":["project_id"],"additionalProperties":false}`),
		},
		run: runModulesGraphBridges,
	},
	{
		def: toolDef{
			Name:        "modules_graph_objects",
			Description: "列出桥接到某图谱节点的模块里的业务对象（表 / 页面 / 接口等）。graph_node_id 取 modules_graph_bridges 返回的 graph_node_id，不是 module_id；未桥接的模块没有这个值。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"graph_node_id":{"type":"string"}},"required":["project_id","graph_node_id"],"additionalProperties":false}`),
		},
		run: runModulesGraphObjects,
	},
	{
		def: toolDef{
			Name:        "modules_graph_strategies",
			Description: "列出该模块从本体对象投影出的策略。只读；与左栏「策略」计数同源。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"graph_node_id":{"type":"string"}},"required":["project_id","graph_node_id"],"additionalProperties":false}`),
		},
		run: runModulesGraphStrategies,
	},
	{
		def: toolDef{
			Name:        "modules_graph_neighborhood",
			Description: "取一个模块在图谱里的自我中心网络（节点 + 边）。depth 取 1..3，默认 1。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"graph_node_id":{"type":"string"},"depth":{"type":"integer","minimum":1,"maximum":3}},"required":["project_id","graph_node_id"],"additionalProperties":false}`),
		},
		run: runModulesGraphNeighborhood,
	},
	{
		def: toolDef{
			Name:        "modules_graph_changes",
			Description: "列出挂在该模块下的工作项（最新 50 条）。变更概览里「这版改了什么」的需求侧数据就是它。",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"project_id":{"type":"string"},"graph_node_id":{"type":"string"}},"required":["project_id","graph_node_id"],"additionalProperties":false}`),
		},
		run: runModulesGraphChanges,
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

// graphModulePath 组装 /api/projects/{p}/graph/modules[/{nodeId}<suffix>]。
func graphModulePath(projectID, nodeID, suffix string) string {
	if nodeID == "" {
		return "/api/projects/" + projectID + "/graph/modules" + suffix
	}
	return "/api/projects/" + projectID + "/graph/modules/" + nodeID + suffix
}

// graphNodeArg 取出并校验图谱节点 id。它来自扫描产物，不保证是 UUID：
// 只允许字母、数字与 -_.: 且长度 ≤128，避免参数变成路径穿越或多出查询串。
func graphNodeArg(a moduleArgs) (string, *jsonRPCError) {
	if a.GraphNodeID == nil {
		return "", &jsonRPCError{Code: -32602, Message: "graph_node_id required: read modules_graph_bridges first"}
	}
	value := strings.TrimSpace(*a.GraphNodeID)
	if value == "" {
		return "", &jsonRPCError{Code: -32602, Message: "graph_node_id required: read modules_graph_bridges first"}
	}
	if len(value) > 128 {
		return "", &jsonRPCError{Code: -32602, Message: "graph_node_id is too long"}
	}
	for _, c := range value {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '-', c == '_', c == '.', c == ':':
		default:
			return "", &jsonRPCError{Code: -32602, Message: "graph_node_id contains unsupported characters"}
		}
	}
	return value, nil
}

type moduleArgs struct {
	ProjectID     string          `json:"project_id"`
	ModuleID      string          `json:"module_id"`
	Name          string          `json:"name"`
	Color         string          `json:"color"`
	GraphNodeID   *string         `json:"graph_node_id"`
	Depth         *int32          `json:"depth"`
	Confirm       bool            `json:"confirm"`
	Kind          string          `json:"kind"`
	Code          string          `json:"code"`
	CodeNew       string          `json:"code_new"`
	Title         string          `json:"title"`
	Priority      string          `json:"priority"`
	Group         string          `json:"group"`
	Draft         bool            `json:"draft"`
	FeatureCode   string          `json:"feature_code"`
	Spec          json.RawMessage `json:"spec"`
	Expected      *int32          `json:"expected_version"`
	CanonicalOnly bool            `json:"canonical_only"`
	Version       *int32          `json:"version"`
	HTMLPath      string          `json:"html_path"`
	HTML          string          `json:"html"`
	DryRun        bool            `json:"dry_run"`
	FillBrief     *bool           `json:"fill_brief"`
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
	Anchors          json.RawMessage `json:"anchors"`
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

// ── 单条功能点的读改写 ─────────────────────────────────────────────────
//
// 界面与 CLI 改一个功能点都是「读整份 → 只改这一行 → publish」。MCP 侧必须同形，
// 否则只接 MCP 的 agent 会去整份覆盖，少写一行就是一次静默删除。

func runModulesSpecFeatureAdd(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	code := strings.TrimSpace(a.Code)
	if code == "" {
		return nil, &jsonRPCError{Code: -32602, Message: "code required (e.g. FP-05)"}
	}
	title := strings.TrimSpace(a.Title)
	if title == "" {
		return nil, &jsonRPCError{Code: -32602, Message: "title required"}
	}
	kind := strings.TrimSpace(a.Kind)
	if kind == "" {
		kind = "core"
	}
	if kind != "core" && kind != "edge" {
		return nil, &jsonRPCError{Code: -32602, Message: "kind must be core or edge"}
	}

	spec, version, jerr := loadSpecForEdit(ctx, rt, a.ProjectID, a.ModuleID)
	if jerr != nil {
		return nil, jerr
	}
	features := specFeatures(spec)
	if specFeatureIndex(features, code) >= 0 {
		return nil, &jsonRPCError{Code: -32005, Message: "feature " + code + " already exists; use modules_spec_feature_update"}
	}
	feature := map[string]any{"code": code, "title": title, "kind": kind}
	if priority := strings.TrimSpace(a.Priority); priority != "" {
		feature["priority"] = priority
	}
	if group := strings.TrimSpace(a.Group); group != "" {
		feature["group"] = group
	}
	spec["features"] = append(features, feature)
	return writeSpecForEdit(ctx, rt, a, spec, version, "add", code)
}

func runModulesSpecFeatureUpdate(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	code := strings.TrimSpace(a.Code)
	if code == "" {
		return nil, &jsonRPCError{Code: -32602, Message: "code required"}
	}
	codeNew := strings.TrimSpace(a.CodeNew)
	title := strings.TrimSpace(a.Title)
	kind := strings.TrimSpace(a.Kind)
	priority := strings.TrimSpace(a.Priority)
	group := strings.TrimSpace(a.Group)
	if title == "" && kind == "" && priority == "" && group == "" && codeNew == "" {
		return nil, &jsonRPCError{Code: -32602, Message: "nothing to update: pass title, kind, priority, group or code_new"}
	}
	if kind != "" && kind != "core" && kind != "edge" {
		return nil, &jsonRPCError{Code: -32602, Message: "kind must be core or edge"}
	}

	spec, version, jerr := loadSpecForEdit(ctx, rt, a.ProjectID, a.ModuleID)
	if jerr != nil {
		return nil, jerr
	}
	features := specFeatures(spec)
	index := specFeatureIndex(features, code)
	if index < 0 {
		return nil, &jsonRPCError{Code: -32004, Message: "feature not found in spec: " + code}
	}
	feature, ok := features[index].(map[string]any)
	if !ok {
		return nil, &jsonRPCError{Code: -32000, Message: "spec row " + code + " is not an object; fix it with modules_spec_publish"}
	}
	if title != "" {
		feature["title"] = title
	}
	if kind != "" {
		feature["kind"] = kind
	}
	if priority != "" {
		feature["priority"] = priority
	}
	if group != "" {
		feature["group"] = group
	}
	if codeNew != "" && codeNew != code {
		if specFeatureIndex(features, codeNew) >= 0 {
			return nil, &jsonRPCError{Code: -32005, Message: "feature " + codeNew + " already exists; pick another code_new"}
		}
		feature["code"] = codeNew
		code = codeNew
	}
	spec["features"] = features
	return writeSpecForEdit(ctx, rt, a, spec, version, "update", code)
}

func runModulesSpecFeatureRemove(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	code := strings.TrimSpace(a.Code)
	if code == "" {
		return nil, &jsonRPCError{Code: -32602, Message: "code required"}
	}

	spec, version, jerr := loadSpecForEdit(ctx, rt, a.ProjectID, a.ModuleID)
	if jerr != nil {
		return nil, jerr
	}
	features := specFeatures(spec)
	index := specFeatureIndex(features, code)
	if index < 0 {
		return nil, &jsonRPCError{Code: -32004, Message: "feature not found in spec: " + code}
	}
	spec["features"] = append(append([]any{}, features[:index]...), features[index+1:]...)
	return writeSpecForEdit(ctx, rt, a, spec, version, "remove", code)
}

// loadSpecForEdit 读回整份已发布 spec（保留未知字段），并拿出 spec_version 做乐观锁。
func loadSpecForEdit(ctx context.Context, rt moduleCtx, projectID, moduleID string) (map[string]any, int32, *jsonRPCError) {
	data, jerr := rt.do(ctx, http.MethodGet, modulePath(projectID, moduleID, "/spec"), nil)
	if jerr != nil {
		return nil, 0, jerr
	}
	envelope, ok := data.(map[string]any)
	if !ok {
		return nil, 0, &jsonRPCError{Code: -32000, Message: "unexpected spec response"}
	}
	spec, _ := envelope["spec"].(map[string]any)
	if spec == nil {
		spec = map[string]any{}
	}
	if schema, _ := spec["schema"].(string); strings.TrimSpace(schema) == "" {
		spec["schema"] = "module_spec/v1"
	}
	if _, ok := spec["features"].([]any); !ok {
		spec["features"] = []any{}
	}
	version := int32(0)
	if value, ok := envelope["spec_version"].(float64); ok {
		version = int32(value)
	}
	return spec, version, nil
}

func specFeatures(spec map[string]any) []any {
	features, _ := spec["features"].([]any)
	if features == nil {
		return []any{}
	}
	return features
}

func specFeatureIndex(features []any, code string) int {
	for index, row := range features {
		feature, ok := row.(map[string]any)
		if !ok {
			continue
		}
		value, _ := feature["code"].(string)
		if strings.TrimSpace(value) == code {
			return index
		}
	}
	return -1
}

// writeSpecForEdit 写回：默认 publish（带乐观锁），draft=true 只存草稿。
func writeSpecForEdit(ctx context.Context, rt moduleCtx, a moduleArgs, spec map[string]any, version int32, action, code string) (any, *jsonRPCError) {
	out, jerr := publishSpec(ctx, rt, a, spec, version)
	if jerr != nil {
		return nil, jerr
	}
	return map[string]any{
		"action":        action,
		"code":          code,
		"draft":         a.Draft,
		"feature_count": len(specFeatures(spec)),
		"result":        out,
	}, nil
}

// publishSpec 把整份 spec 发回服务端：draft 不涨 spec_version，发布走乐观锁
// （不传 expected_version 就用刚读到的那个）。
func publishSpec(ctx context.Context, rt moduleCtx, a moduleArgs, spec map[string]any, version int32) (any, *jsonRPCError) {
	body := map[string]any{"spec": spec}
	path := modulePath(a.ProjectID, a.ModuleID, "/spec/publish")
	if a.Draft {
		path = modulePath(a.ProjectID, a.ModuleID, "/spec/draft")
	} else {
		expected := version
		if a.Expected != nil {
			expected = *a.Expected
		}
		body["expected_version"] = expected
	}
	return rt.do(ctx, http.MethodPost, path, body)
}

// ── 从原型导入 ────────────────────────────────────────────────
//
// 界面上的「从原型导入」是浏览器读 HTML 后局部合并（见 prototype-inspector 的
// useImportFromPrototype）；MCP 侧也必须同形，否则 agent 会去整份覆盖 spec。解析
// 与合并的纯函数在 internal/prototypeimport，与 CLI `module spec import` 共用。
//
// 与服务端的「不解析 HTML」约定不矛盾：锚点缓存仍由调用方上传，这里只是把同一
// 份 HTML 里能读出的结构算成候选，不落任何解析结果到别的表。
const moduleImportMaxHTML = 2 << 20

func runModulesSpecImport(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	html := a.HTML
	if strings.TrimSpace(html) == "" {
		return nil, &jsonRPCError{Code: -32602, Message: "html required: pass the prototype's HTML body (the server cannot read a file path on your machine; use `multica module spec import --html-path` if the file is local)"}
	}
	if len(html) > moduleImportMaxHTML {
		return nil, &jsonRPCError{Code: -32602, Message: fmt.Sprintf("html is larger than %d bytes: register the file as a prototype version and import the blocks you need", moduleImportMaxHTML)}
	}
	if a.PrototypeVersion != nil && *a.PrototypeVersion <= 0 {
		return nil, &jsonRPCError{Code: -32602, Message: "prototype_version must be a positive version number"}
	}
	candidates := prototypeimport.Candidates(html)
	if len(candidates) == 0 {
		return nil, &jsonRPCError{Code: -32602, Message: `no data-fp anchor and no h2/h3 heading in html: nothing to import (add data-fp="FP-01" to the blocks you want as feature points)`}
	}

	spec, version, jerr := loadSpecForEdit(ctx, rt, a.ProjectID, a.ModuleID)
	if jerr != nil {
		return nil, jerr
	}
	features := specFeatures(spec)
	added, skipped := prototypeimport.Merge(features, candidates)

	report := map[string]any{
		"action":               "import",
		"dry_run":              a.DryRun,
		"draft":                a.Draft,
		"added":                added,
		"skipped":              skipped,
		"spec_version_before":  version,
		"feature_count_before": len(features),
		"written":              false,
	}

	// brief 只补空着的字段：导入不该覆盖人写过的说明。
	if a.FillBrief == nil || *a.FillBrief {
		fields, briefVersion, jerr := importBriefFields(ctx, rt, a.ProjectID, a.ModuleID, html)
		if jerr != nil {
			return nil, jerr
		}
		report["brief_fields"] = fields
		report["brief_version"] = briefVersion
	}

	// 一条新功能点都没有，或只是 dry-run：不写入，直接回报。（重跑同一份原型走这里）
	if a.DryRun || len(added) == 0 {
		report["feature_count"] = len(features) + len(added)
		return report, nil
	}

	// features 是 []any（保留 spec 里未知字段），added 是 []map[string]any，逐条转。
	merged := make([]any, 0, len(features)+len(added))
	merged = append(merged, features...)
	for _, feature := range added {
		merged = append(merged, feature)
	}
	spec["features"] = merged
	published, jerr := publishSpec(ctx, rt, a, spec, version)
	if jerr != nil {
		return nil, jerr
	}
	report["written"] = true
	report["feature_count"] = len(specFeatures(spec))
	report["result"] = published
	// 以服务端回的 spec_version 为准：草稿不涨、发布 +1，拿不到才自己推。
	nextVersion := version
	if !a.Draft {
		if value, ok := specVersionFrom(published); ok {
			nextVersion = value
		} else {
			nextVersion = version + 1
		}
	}
	report["spec_version"] = nextVersion

	// 下面两步失败不把整个导入判失败：功能点已经写进去了，缺的只是周边缓存，
	// 但要如实回报，否则 reconcile 的空位会被当成「导入没生效」。
	if fields, ok := report["brief_fields"].(map[string]any); ok && len(fields) > 0 {
		if briefVersion, ok := report["brief_version"].(int); ok && briefVersion >= 0 {
			body := map[string]any{
				"base_version": briefVersion,
				"fields":       fields,
				"source":       "extract",
				"note":         "从原型导入",
			}
			if _, jerr := rt.do(ctx, http.MethodPost, modulePath(a.ProjectID, a.ModuleID, "/workspace/patch"), body); jerr != nil {
				report["brief_warning"] = "brief patch failed, spec is already written: " + jerr.Message
			} else {
				report["brief_patched"] = true
			}
		}
	}

	if a.PrototypeVersion != nil {
		anchors := prototypeimport.Anchors(html)
		if len(anchors) > 0 {
			path := modulePath(a.ProjectID, a.ModuleID, fmt.Sprintf("/prototype-versions/%d/parse", *a.PrototypeVersion))
			if _, jerr := rt.do(ctx, http.MethodPost, path, map[string]any{"anchors": anchors}); jerr != nil {
				report["anchors_warning"] = "anchor cache upload failed, reconcile stays empty: " + jerr.Message
			} else {
				report["anchors_uploaded"] = len(anchors)
			}
		}
	}
	return report, nil
}

// importBriefFields 读右栏工作区，只在字段还空着时提出 brief.scope / brief.flow。
// 返回 briefVersion = -1 表示没有可补的（原型只有一个区块、或已有人写过）。
func importBriefFields(ctx context.Context, rt moduleCtx, projectID, moduleID, html string) (map[string]any, int, *jsonRPCError) {
	sections := prototypeimport.SectionTitles(html)
	flow := prototypeimport.NavFlow(html)
	if len(sections) <= 1 && len(flow) <= 1 {
		return map[string]any{}, -1, nil
	}
	data, jerr := rt.do(ctx, http.MethodGet, modulePath(projectID, moduleID, "/workspace"), nil)
	if jerr != nil {
		return nil, -1, jerr
	}
	envelope, ok := data.(map[string]any)
	if !ok {
		// 形状读不懂就不补，别挡导入本身。
		return map[string]any{}, -1, nil
	}
	brief, _ := envelope["brief"].(map[string]any)
	fields, _ := brief["fields"].(map[string]any)
	current := make(map[string]string, len(fields))
	for key, raw := range fields {
		entry, _ := raw.(map[string]any)
		current[key] = prototypeimport.RenderScalar(entry["value"])
	}
	version := -1
	if value, ok := brief["version"].(float64); ok {
		version = int(value)
	}
	return prototypeimport.BriefFields(sections, flow, current), version, nil
}

// specVersionFrom 从 publish 的响应里取 spec_version；取不到就由调用方自己推。
func specVersionFrom(result any) (int32, bool) {
	envelope, ok := result.(map[string]any)
	if !ok {
		return 0, false
	}
	switch value := envelope["spec_version"].(type) {
	case float64:
		return int32(value), true
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
			return int32(n), true
		}
	}
	return 0, false
}

func runModulesRequirementsAttach(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("issue_id", a.IssueID); jerr != nil {
		return nil, jerr
	}
	body := map[string]any{"module_id": a.ModuleID}
	if feature := strings.TrimSpace(a.FeatureCode); feature != "" {
		// 服务端会校验编号属于该模块（不属于则 404），这里不先查一遍。
		body["feature_code"] = feature
	}
	return rt.do(ctx, http.MethodPut, "/api/issues/"+a.IssueID, body)
}

func runModulesRequirementsDetach(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	if _, jerr := uuidPath("issue_id", a.IssueID); jerr != nil {
		return nil, jerr
	}
	if a.ModuleID != "" {
		if _, jerr := uuidPath("module_id", a.ModuleID); jerr != nil {
			return nil, jerr
		}
	}
	// null 才是「摘除」；空串会被服务端当成无效 UUID。
	return rt.do(ctx, http.MethodPut, "/api/issues/"+a.IssueID, map[string]any{"module_id": nil})
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
		// handler 读的是 canonical=1（不是 canonical_only）。
		suffix += "?canonical=1"
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

func runModulesPrototypeUpdate(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
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
	// 只转发「出现的」字段：PATCH 的语义就是不动没提到的列，
	// 而 prompt/status 的空串是合法值，不能靠零值判断。
	var present map[string]any
	if err := json.Unmarshal(args, &present); err != nil {
		return nil, &jsonRPCError{Code: -32602, Message: "invalid arguments: " + err.Error()}
	}
	body := map[string]any{}
	if _, ok := present["html_path"]; ok {
		body["html_path"] = a.HTMLPath
	}
	if _, ok := present["prompt"]; ok {
		body["prompt"] = a.Prompt
	}
	if _, ok := present["status"]; ok {
		body["status"] = a.Status
	}
	if len(body) == 0 {
		return nil, &jsonRPCError{Code: -32602, Message: "nothing to update: pass html_path, prompt or status"}
	}
	path := modulePath(a.ProjectID, a.ModuleID, "/prototype-versions/"+strconv.Itoa(int(*a.Version)))
	return rt.do(ctx, http.MethodPatch, path, body)
}

func runModulesPrototypeConfirm(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
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
	var body any
	if a.SetCanonical {
		body = map[string]any{"set_canonical": true}
	}
	path := modulePath(a.ProjectID, a.ModuleID, "/prototype-versions/"+strconv.Itoa(int(*a.Version))+"/confirm")
	return rt.do(ctx, http.MethodPost, path, body)
}

func runModulesPrototypeDelete(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
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
	if !a.Confirm {
		return nil, &jsonRPCError{
			Code:    -32003,
			Message: "destructive action refused: pass confirm=true. The version and its parsed anchors are removed; the canonical version and any version referenced by a release are refused server-side.",
		}
	}
	path := modulePath(a.ProjectID, a.ModuleID, "/prototype-versions/"+strconv.Itoa(int(*a.Version)))
	return rt.do(ctx, http.MethodDelete, path, nil)
}

func runModulesPrototypeParse(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
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
	anchors := bytes.TrimSpace(a.Anchors)
	if len(anchors) == 0 || string(anchors) == "null" {
		return nil, &jsonRPCError{Code: -32602, Message: "anchors required: map of feature code → {count, title}, e.g. {\"fp.chat.group\": {\"count\": 1, \"title\": \"群设置\"}}"}
	}
	path := modulePath(a.ProjectID, a.ModuleID, "/prototype-versions/"+strconv.Itoa(int(*a.Version))+"/parse")
	return rt.do(ctx, http.MethodPost, path, map[string]any{"anchors": json.RawMessage(anchors)})
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

// ── 图谱桥接读 ────────────────────────────────────────────────

func runModulesGraphBridges(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	return rt.do(ctx, http.MethodGet, graphModulePath(a.ProjectID, "", ""), nil)
}

func runModulesGraphObjects(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	return runModulesGraphRead(ctx, rt, args, "/objects", "")
}

func runModulesGraphStrategies(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	return runModulesGraphRead(ctx, rt, args, "/strategies", "")
}

func runModulesGraphChanges(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	return runModulesGraphRead(ctx, rt, args, "/changes", "")
}

func runModulesGraphNeighborhood(ctx context.Context, rt moduleCtx, args json.RawMessage) (any, *jsonRPCError) {
	query := ""
	if a, jerr := parseArgs(args); jerr == nil && a.Depth != nil {
		depth := *a.Depth
		if depth < 1 || depth > 3 {
			return nil, &jsonRPCError{Code: -32602, Message: "depth must be 1..3"}
		}
		query = fmt.Sprintf("?depth=%d", depth)
	}
	return runModulesGraphRead(ctx, rt, args, "/neighborhood", query)
}

// runModulesGraphRead 是四条 per-node 读的公用体：参数校验一致，只有尾段不同。
func runModulesGraphRead(ctx context.Context, rt moduleCtx, args json.RawMessage, suffix, query string) (any, *jsonRPCError) {
	a, jerr := parseArgs(args)
	if jerr != nil {
		return nil, jerr
	}
	nodeID, jerr := graphNodeArg(a)
	if jerr != nil {
		return nil, jerr
	}
	return rt.do(ctx, http.MethodGet, graphModulePath(a.ProjectID, nodeID, suffix)+query, nil)
}
