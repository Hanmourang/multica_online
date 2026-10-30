import type { Issue, IssueMetadata, IssueStatus, IssueStatusCategory, IssuePriority, IssueAssigneeType } from "./issue";
import type { PropertyFilterValue } from "./property";
import type { MemberRole } from "./workspace";
import type { Project } from "./project";

// Issue API
export interface CreateIssueRequest {
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee_type?: IssueAssigneeType;
  assignee_id?: string;
  parent_issue_id?: string;
  project_id?: string;
  /** 所属模块；必须属于 issue 所在项目（异项目模块服务端 400）。 */
  module_id?: string;
  /** 跨模块避免冲突：勾选后本任务与异模块任务互斥执行。 */
  avoid_conflict?: boolean;
  /** 所属迭代；必须属于 issue 所在项目且未 completed，否则服务端 404 / 409
   * 拒绝整个创建（CoCo 对标 02 §F）。省略 = 不入迭代（backlog）。 */
  sprint_id?: string;
  /** Ordered stage (>= 1) grouping this sub-issue under its parent. */
  stage?: number;
  start_date?: string;
  due_date?: string;
  attachment_ids?: string[];
  /** Issue-scoped label IDs to attach in the same transaction as the create.
   *  Unknown or non-issue ids are rejected by the server with 400. */
  label_ids?: string[];

  // --- Requirement calendar fields (design §5) ---
  /** 需求目标：pipeline 的提示词上下文。 */
  goal?: string;
  /** 绑定的 git 库资源 id。 */
  repo_resource_id?: string;
  /** 计划开始时间（RFC3339 含分钟精度）；null = 无计划，不自动触发。 */
  start_at?: string;
  /** 拆解模式：auto=全自动 / confirm=拆解+确认（默认）/ manual=纯人工。 */
  decompose_mode?: "auto" | "confirm" | "manual";
  /** 到达 start_at 后自动触发调度。 */
  auto_trigger?: boolean;
}

export interface CreateCommentSubIssueManualRequest {
  mode: "manual";
  capture_token: string;
  issue: CreateIssueRequest;
}

export interface CreateCommentSubIssueAgentRequest {
  mode: "agent";
  capture_token: string;
  quick_create: {
    agent_id?: string;
    squad_id?: string;
    prompt: string;
    priority?: IssuePriority;
    due_date?: string;
    project_id?: string | null;
    attachment_ids?: string[];
  };
}

export type CreateCommentSubIssueRequest =
  | CreateCommentSubIssueManualRequest
  | CreateCommentSubIssueAgentRequest;

/** 项目模块：项目级单选标签，同模块任务靠依赖 DAG 串行，跨模块默认并行。 */
export interface ProjectModule {
  id: string;
  project_id: string;
  workspace_id: string;
  name: string;
  color: string;
  created_at: string;
  /** Only the list endpoint fills this (module management table); absent on
   *  older servers and 0 on create/update responses. */
  task_count?: number;
  /** GitNexus Community 节点 ID；null = 未绑定 */
  graph_node_id?: string | null;
  /** 模块描述 */
  description?: string;
}

/** 依赖边 API 的列表项（GET/PUT /api/issues/:id/dependencies）。 */
export interface IssueDependencyItem {
  issue_id: string;
  title: string;
  status: string;
}

/** 角色班底条目（项目默认 / 需求快照共用形状）。 */
export interface RoleAssignment {
  id: string;
  role: "pm" | "prototyper" | "developer" | "data" | "tester";
  assignee_type: "member" | "agent";
  assignee_id: string;
  enabled: boolean;
  ordinal: number;
}

/** GET role-defaults / roles 端点的响应包。 */
export interface RoleRosterResponse {
  roles: RoleAssignment[];
  total: number;
}

/** 角色执行标准：背景 / 交付标准 / 流程 / 初始化。空字段回落内置。 */
export type RolePlaybookInitMode = "brief" | "checklist";

export interface RolePlaybook {
  role: RoleAssignment["role"];
  background: string;
  standards: string;
  process: string;
  init_mode: RolePlaybookInitMode;
  init_content: string;
  source?: "builtin" | "custom";
}

/** GET/PUT role-playbooks 响应：解析结果 + 原始覆盖 + 内置。 */
export interface RolePlaybookBundle {
  playbooks: Partial<Record<RoleAssignment["role"], RolePlaybook>>;
  overrides: Partial<Record<RoleAssignment["role"], RolePlaybook>>;
  builtins: Partial<Record<RoleAssignment["role"], RolePlaybook>>;
}

// --- Requirement decomposition (requirement-calendar spec §8/§9) ---

/** 拆解草稿的功能点明细。kind 必填（new=新增 / modify=改造）；"" = 未标注（待确认前补标）。 */
export interface DecomposeFeaturePoint {
  title: string;
  kind: "new" | "modify" | "";
  code_objects?: string[];
  /** 实现细节；确认时原样写入 issue.feature_points JSONB。 */
  detail?: string;
}

/** 拆解草稿 graph_context 的展示形状（缺字段按档案未就绪）。 */
export interface GraphContextView {
  nodes?: Array<string | { id?: string; label?: string }>;
  code_objects?: string[];
  dependencies?: string[];
  impacts?: string[];
  queried_at?: string;
  source_commit?: string;
}

/** 验收规约展示形状（缺字段按档案未就绪）。 */
export interface AcceptanceSpecView {
  path?: string;
  version?: string;
  base_version?: string;
  assertions?: string[];
  cases?: Array<string | { name?: string }>;
  note?: string;
  evidence?: string[];
  coverage?: string[];
  graph?: string[];
}

/** 拆解确认请求体里的子任务草稿。depends_on 元素为同批草稿 temp_id 或已有 issue id。 */
export interface DecomposeDraftTask {
  temp_id: string;
  title: string;
  description?: string;
  /** 3=执行，4=验收。 */
  stage: 3 | 4;
  assignee_type?: "member" | "agent";
  assignee_id?: string;
  /** PM 草稿里的角色指派（developer|data|tester）；面板确认前解析为班底成员。 */
  assignee_role?: string;
  feature_points?: DecomposeFeaturePoint[];
  graph_context?: unknown;
  acceptance_spec?: unknown;
  depends_on?: string[];
}

/** GET /issues/{id}/decomposition 的响应包（spec §9）：plan 正文 + 最新有效草稿块。 */
export interface GetDecompositionResponse {
  plan: string | null;
  drafts: DecomposeDraftTask[];
  source_comment_id: string | null;
}

/** POST /issues/{id}/decomposition/confirm 的响应包。 */
export interface ConfirmDecompositionResponse {
  issues: import("./issue").Issue[];
}

/** POST /issues/{id}/trigger 的响应（spec §7.1 手动触发，与 30s sweep 共用服务）。 */
export interface TriggerRequirementResponse {
  triggered: boolean;
  /** 本次入队 agent_task_queue 的 stage3 子任务数。 */
  enqueued: number;
  issue_id: string;
}

/** POST /issues/{id}/acceptance/verdict 的响应（WS4 / spec §7.5③）。 */
export interface AcceptanceVerdictResponse {
  verdict: "pass" | "fail";
  /** 裁决后的轮次：pass 不变，fail 已 +1。 */
  acceptance_round: number;
  /** pass=true（需求转 done）；fail 未越界=false，越界（>3）由派生态呈现「验收失败」。 */
  terminal: boolean;
  /** 仅 fail 分支：新建的 stage3 修复子任务 id。 */
  repair_issue_id?: string;
}

/** 原型版本上的单项实现细节标记（spec 2026-09-04-requirement-calendar-design.md §5.3）。 */
export interface PrototypeMark {
  detail_id: string;
  /** ok=符合 / no=不符 / pending=待定。 */
  verdict: "ok" | "no" | "pending";
  /** verdict=no 时必填的修正诉求，回流为提示词〔本轮修正〕段。 */
  note: string;
}

/** issue_prototype_version 行的 API 投影。 */
export interface PrototypeVersion {
  id: string;
  issue_id: string;
  version: number;
  html_path: string;
  prompt: string;
  marks: PrototypeMark[];
  status: "pending" | "confirmed" | "superseded";
  created_by_type: string;
  created_by_id: string | null;
  created_at: string;
}

/** POST /issues/{id}/prototype/generate 的请求体。 */
export interface GeneratePrototypeRequest {
  /** 重生成时携带当前 marks，服务端组装〔本轮修正〕段。 */
  marks?: PrototypeMark[];
  prompt_append?: string;
}

// ── 功能模块原型中枢（plans/20261026 07 · M-13）──────────────────────────
// 字段名与 server/internal/handler/module_*.go、service/module_reconcile.go 的
// JSON tag 一一对应；四态与覆盖率唯一口径在后端，前端禁止二次自算（07 §六防漂移）。

/** module_spec/v1 的功能点条目。 */
export interface ModuleSpecFeature {
  code: string;
  title: string;
  kind: "core" | "edge";
  priority?: string;
  /** 右栏「功能点清单」的分组标签（原型区块，如「浏览」「分析」）。 */
  group?: string;
}

/** project_module.spec 的反序列化形态（唯一真源，schema=module_spec/v1）。 */
export interface ModuleSpec {
  schema: string;
  summary?: string;
  features: ModuleSpecFeature[];
}

/** GET /modules/{moduleId}/spec 响应。 */
export interface ModuleSpecResponse {
  module_id: string;
  name: string;
  color: string;
  spec: ModuleSpec | null;
  spec_version: number;
  canonical_prototype_version: number | null;
  feature_count: number;
  spec_updated_at: string;
}

/** POST /spec/publish 与 apply 返回的发布回执。 */
export interface ModuleSpecPublishResponse {
  module_id: string;
  spec_version: number;
  feature_count: number;
}

/** 模块级原型版本行（issue_prototype_version 的模块投影；Register 回执仅含子集字段）。 */
export interface ModulePrototypeVersion {
  id: string;
  version: number;
  html_path: string;
  prompt: string;
  status: "pending" | "confirmed" | "superseded";
  /** 无需求原型为 null（硬伤 3 闭环）。 */
  issue_id: string | null;
  created_at: string;
  module_id?: string;
}

/** GET /modules/{moduleId}/prototype-versions 响应。 */
export interface ModulePrototypeVersionListResponse {
  module_id: string;
  canonical_prototype_version: number | null;
  versions: ModulePrototypeVersion[];
  total: number;
}

/** 四态 + 独立 deprecated（与后端 ReconcileState 同构）。 */
export type ModuleReconcileState =
  | "covered"
  | "changed"
  | "missing"
  | "unregistered"
  | "deprecated";

/** 功能点处置（与后端 Decision 同构）。 */
export type ModuleFeatureDecision = "keep" | "override" | "deprecate" | "add" | "skip";

/** 对账矩阵的一行。 */
export interface ModuleReconcileRowItem {
  code: string;
  title: string;
  specTitle?: string;
  kind: string;
  state: ModuleReconcileState;
  prototypeAnchor?: number;
  requirementId?: string;
  owner?: string;
  decision?: ModuleFeatureDecision;
}

/** f4 五个 KPI 聚合（唯一口径）。 */
export interface ModuleCoverage {
  total: number;
  deprecated: number;
  covered: number;
  changed: number;
  missing: number;
  unregistered: number;
  denominator: number;
  rate: number;
}

/** GET /modules/{moduleId}/prototype-reconcile 响应。 */
export interface ModuleReconcileResponse {
  module_id: string;
  version: number;
  coverage: ModuleCoverage;
  rows: ModuleReconcileRowItem[];
}

/** 解析缓存 anchors（前端解析 data-fp 后回传）。 */
export type ModuleProtoAnchorMap = Record<string, { count: number; title?: string }>;

/** module_prototype_plan 状态机（07 §2.5）。 */
export type ModulePrototypePlanStatus =
  | "draft"
  | "applying"
  | "applied"
  | "failed"
  | "expired";

/** 计划快照。 */
export interface ModulePrototypePlanSnapshot {
  newSpec?: ModuleSpec;
  decisions?: Record<string, ModuleFeatureDecision>;
}

/** POST /prototype-plans 与 GET /prototype-plans/{planId} 响应。 */
export interface ModulePrototypePlan {
  id: string;
  module_id: string;
  status: ModulePrototypePlanStatus;
  candidate_version: number;
  base_version: number | null;
  spec_version: number;
  plan: ModulePrototypePlanSnapshot;
  error?: string;
  created_at: string;
  updated_at: string;
}

/** POST /prototype-plans/{planId}/apply 成功回执。 */
export interface ModulePrototypePlanApplyResponse {
  plan_id: string;
  module_id: string;
  status: "applied";
  canonical_prototype_version: number;
  spec_version: number;
  feature_count: number;
}

// ── 右栏「功能点详解」工作区（原型图 TAB v2 · 画面 3/5/6） ──────────────

/** module_field_def 一行：右栏字段字典（key / scope / label / kind / owner）。 */
export interface ModuleFieldDef {
  key: string;
  scope: "module" | "feature_point";
  label: string;
  ord: number;
  kind: "text" | "longtext" | "list" | "refs" | "acceptance";
  /** system = 只读（版本号、覆盖率、功能点编号与进退场），写它们 422。 */
  owner: "system" | "user";
  writable_by: string[];
  versioned: boolean;
}

/** 单个字段值的版本元信息：fields jsonb 每个 key 自带 {v, by, at, actor}。 */
export interface ModuleFieldValue {
  value: unknown;
  v: number;
  by: "human" | "agent";
  at: string;
  actor?: string;
}

export type ModuleBriefFields = Record<string, ModuleFieldValue>;

export type ModuleBriefSource = "manual" | "agent" | "mcp" | "extract" | "rollback";
export type ModuleBriefStatus = "draft" | "published" | "superseded";

/** 一条字段级差异（版本记录的 +/−）。 */
export interface ModuleBriefDiffEntry {
  key: string;
  label: string;
  scope: "module" | "feature_point";
  op: "set" | "clear";
  from: unknown;
  to: unknown;
}

/** 说明版本的一行（append-only）。 */
export interface ModuleBrief {
  version: number;
  base_version: number | null;
  fields: ModuleBriefFields;
  status: ModuleBriefStatus;
  source: ModuleBriefSource;
  diff_summary: string;
  changes: ModuleBriefDiffEntry[];
  created_by_type: string;
  created_at: string;
}

/** 版本记录里的一行（不含整份 fields，只有差异摘要）。 */
export interface ModuleBriefVersionSummary {
  version: number;
  base_version: number | null;
  status: ModuleBriefStatus;
  source: ModuleBriefSource;
  diff_summary: string;
  changes: ModuleBriefDiffEntry[];
  created_by_type: string;
  created_at: string;
}

/** 验收标准一条：✓/○ 由 ok 决定。 */
export interface ModuleAcceptanceItem {
  text?: string;
  ok?: boolean;
}

/** 功能点四段详情（1 描述/定位 · 2 细节要求 · 3 交互/依赖 · 4 验收）。
 *  req / acceptance 保存的是写入时的原始 JSON，历史数据可能是裸字符串。 */
export interface ModuleFeatureDetail {
  desc?: string;
  loc?: string;
  req?: string[];
  interaction?: string;
  deps?: string;
  acceptance?: Array<ModuleAcceptanceItem | string>;
}

/** 功能点清单的一行：规格投影 + 四段填充度。 */
export interface ModuleWorkspaceFeature {
  code: string;
  title: string;
  kind: string;
  priority?: string;
  group?: string;
  spec_version: number;
  detail: ModuleFeatureDetail;
  /** ◍filled/total：四段里有几段写了内容。 */
  filled: number;
  total: number;
  acceptance_ok: number;
  acceptance_total: number;
}

/** 成对发布的一行：说明版本 ⨯ 原型版本。 */
export interface ModuleRelease {
  version: number;
  brief_version: number;
  prototype_version: number;
  diff: unknown;
  released_by: string;
  created_at: string;
}

/** GET /modules/{moduleId}/workspace —— 右栏三段一次取齐。 */
export interface ModuleWorkspace {
  module_id: string;
  name: string;
  color: string;
  spec_version: number;
  canonical_prototype_version: number | null;
  brief_version: number | null;
  release_version: number | null;
  brief: ModuleBrief;
  field_defs: ModuleFieldDef[];
  features: ModuleWorkspaceFeature[];
  versions: ModuleBriefVersionSummary[];
  releases: ModuleRelease[];
  feature_count: number;
}

/** POST /workspace/patch 回执：version/prev/diff，同值幂等返回 noop。 */
export interface ModuleWorkspacePatchResponse {
  module_id: string;
  version: number;
  prev: number;
  noop: boolean;
  diff: ModuleBriefDiffEntry[];
  brief: ModuleBrief;
}

/** GET /modules/{moduleId}/releases 响应。 */
export interface ModuleReleasesResponse {
  module_id: string;
  brief_version: number | null;
  release_version: number | null;
  canonical_prototype_version: number | null;
  releases: ModuleRelease[];
}

/** POST /releases 与 /releases/{version}/rollback 回执。 */
export interface ModuleReleasePublishResponse {
  module_id: string;
  release: ModuleRelease;
  brief_version?: number;
}

/** POST /issues/{id}/prototype/generate 的响应包：新版本行 + stage-1 子任务。 */
export interface GeneratePrototypeResponse {
  version: PrototypeVersion;
  task: import("./issue").Issue;
}

/** POST /issues/{id}/prototypes · PATCH /issues/{id}/prototypes/{version} */
export interface RegisterPrototypeRequest {
  html_path: string;
  prompt?: string;
}

export interface UpdateIssueRequest {
  /** Legacy aggregate compare-and-swap token. New text editors use field
   * baselines so unrelated issue activity does not reject their edits. */
  expected_revision?: number;
  title?: string;
  /** Authoritative title the editor adopted before producing this update. */
  title_base?: string;
  description?: string;
  /** Authoritative description the editor had adopted before producing this
   * update. The server uses it to merge channel media that landed meanwhile. */
  description_base?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee_type?: IssueAssigneeType | null;
  assignee_id?: string | null;
  position?: number;
  start_date?: string | null;
  due_date?: string | null;
  /** 需求开始时间（分钟粒度 RFC3339）；null 显式清空。已触发需求改期服务端 409。 */
  start_at?: string | null;
  /** 需求/任务目标；null 或空串清空。 */
  goal?: string | null;
  /** 绑定的项目 git 资源；null 清空。 */
  repo_resource_id?: string | null;
  /** 拆解模式。 */
  decompose_mode?: "auto" | "confirm" | "manual";
  /** 到点是否自动触发执行。 */
  auto_trigger?: boolean;
  parent_issue_id?: string | null;
  project_id?: string | null;
  /** 所属模块；null 显式清空。异项目模块服务端 409；未显式给出时随
   *  project_id 变更自动清空。 */
  module_id?: string | null;
  /** 跨模块避免冲突：勾选后本任务与异模块任务互斥执行。 */
  avoid_conflict?: boolean;
  /** 所属迭代；null 显式移出（回 backlog）。异项目迭代服务端 404、
   * completed 迭代 409；未显式给出时随 project_id 变更自动清空。
   * （CoCo 对标 02 §F：迭代是项目作用域，与 module_id 同款不变式） */
  sprint_id?: string | null;
  /** Ordered stage (>= 1); null clears it (unstaged). */
  stage?: number | null;
  /** Attachment IDs to bind to this issue alongside the description update.
   *  Used by the description editor to register newly uploaded files so they
   *  surface in `issueAttachments` and keep their preview Eye on refresh. */
  attachment_ids?: string[];
  /** Skip starting the agent run this write would trigger ("暂时不启动",
   *  MUL-3375). The assignee/status change still applies. Control field —
   *  strip from optimistic cache patches; never written onto the Issue. */
  suppress_run?: boolean;
  /** When a status change hands the issue off to a workflow step's handler,
   *  also stop the active runs of the agent it was taken from (MUL-7420).
   *  Control field — strip from optimistic cache patches. */
  stop_previous_assignee_runs?: boolean;
  /** With a project move: enter the destination workflow's column the issue
   *  lands on, handing it off like a status change (MUL-7420). Without it a
   *  project move is administrative. Control field — strip from optimistic
   *  cache patches. */
  enter_workflow_step?: boolean;
}

/**
 * Server-owned drag intent. The client may use a provisional position for its
 * optimistic animation, but the canonical position is derived from these
 * workspace-scoped neighbors by `POST /api/issues/:id/move`.
 */
export interface MoveIssueRequest
  extends Pick<
    UpdateIssueRequest,
    | "status"
    | "assignee_type"
    | "assignee_id"
    | "parent_issue_id"
    | "project_id"
    | "stop_previous_assignee_runs"
  > {
  before_id: string | null;
  after_id: string | null;
}

/** Inputs to `POST /api/issues/preview-trigger`. A nil prospective field means
 *  "leave unchanged"; `isCreate` previews a not-yet-persisted issue. */
export interface IssueTriggerPreviewParams {
  issueIds?: string[];
  isCreate?: boolean;
  assigneeType?: IssueAssigneeType | null;
  assigneeId?: string | null;
  status?: IssueStatus;
}

/** One issue that WILL start a run under the prospective write. `agent_id` is
 *  the runnable agent (squad leader for squads). */
export interface IssueTriggerPreviewItem {
  issue_id: string;
  agent_id: string;
  source: string;
}

export interface IssueTriggerPreview {
  triggers: IssueTriggerPreviewItem[];
  total_count: number;
}

export interface ListIssuesParams {
  limit?: number;
  offset?: number;
  workspace_id?: string;
  /** Flat-table quick search. Matches issue title words or an exact issue number. */
  q?: string;
  status?: IssueStatus;
  /** Multi-value table facet. OR within the field. */
  statuses?: IssueStatus[];
  /**
   * Filter by status CATEGORY rather than by exact key, so one bucket holds a
   * category's canonical status plus every custom status that inherits it.
   * This is what keeps the board's fan-out fixed at 7 requests however many
   * custom statuses a workspace defines. (MUL-6243)
   */
  status_category?: IssueStatusCategory;
  /** Multi-value form of `status_category`. OR within the field. */
  status_categories?: IssueStatusCategory[];
  priority?: IssuePriority;
  /** Multi-value table facet. OR within the field. */
  priorities?: IssuePriority[];
  assignee_id?: string;
  assignee_ids?: string[];
  /**
   * Narrow to issues assigned to the given actor kinds (member / agent /
   * squad). Same semantics as `ListGroupedIssuesParams.assignee_types` —
   * powers the workspace Members/Agents tabs server-side.
   */
  assignee_types?: IssueAssigneeType[];
  creator_id?: string;
  project_id?: string;
  /**
   * 按迭代归属过滤（CoCo 对标 02_迭代模块 §E2：迭代内 issue 列表复用
   * /api/issues，不新造端点）。backlog（sprint_id IS NULL）由前端在 project
   * 级结果集内客户端过滤。
   */
  sprint_id?: string;
  /** Actor-aware table facets. OR within each field. */
  assignee_filters?: IssueActorRef[];
  include_no_assignee?: boolean;
  creator_filters?: IssueActorRef[];
  project_ids?: string[];
  include_no_project?: boolean;
  label_ids?: string[];
  /** Restrict the window to root issues instead of filtering loaded pages. */
  top_level_only?: boolean;
  /**
   * Separate requirements from tasks. `requirement` = top-level issues with
   * calendar/pipeline fields (`start_at` / confirm / trigger / repo).
   * `task` = everything else (standalone tasks and child issues).
   */
  kind?: "requirement" | "task";
  /**
   * Hard restriction of the window to the given issue ids (the table's
   * agents-working facet sends the live running-issue set). An EMPTY array is
   * meaningful and yields an EMPTY window — omit the field entirely for "no
   * restriction".
   */
  ids?: string[];
  /**
   * Widen the assignee filter to issues where the user is the *indirect*
   * assignee — assignee is one of the user's owned agents, or a squad that
   * involves the user (human member / leader-via-owned-agent / agent member
   * owned by the user). Direct member assignment is intentionally excluded:
   * `involves_user_id` and `assignee_id=<user>` (tab "Assigned to me") produce
   * disjoint result sets by construction.
   */
  involves_user_id?: string;
  /** JSONB containment filter on `issue.metadata`. AND across keys. */
  metadata?: IssueMetadata;
  /** Custom-property filter: definition id → accepted values (option ids or
   *  "true"/"false" for checkbox; a plain string is exact equality, an
   *  operator object narrows it). OR within a definition, AND across. */
  properties?: Record<string, PropertyFilterValue[]>;
  open_only?: boolean;
  /**
   * Restrict the result to issues with at least one of `start_date` /
   * `due_date` set. Used by the Project Gantt view so it doesn't have to
   * page through every issue on the project just to discard the unscheduled
   * majority on the client.
   */
  scheduled?: boolean;
  date_field?: "created_at" | "updated_at";
  date_start?: string;
  date_end?: string;
  sort_by?:
    | "position"
    | "status"
    | "priority"
    | "title"
    | "created_at"
    | "updated_at"
    | "last_activity"
    | "start_date"
    | "due_date"
    | `property:${string}`;
  sort_direction?: "asc" | "desc";
}

export interface IssueActorRef {
  type: IssueAssigneeType;
  id: string;
}

export interface ListGroupedIssuesParams {
  group_by: "assignee";
  limit?: number;
  offset?: number;
  workspace_id?: string;
  statuses?: IssueStatus[];
  priorities?: IssuePriority[];
  assignee_types?: IssueAssigneeType[];
  assignee_id?: string;
  assignee_ids?: string[];
  creator_id?: string;
  project_id?: string;
  /** See `ListIssuesParams.involves_user_id` — same semantics. */
  involves_user_id?: string;
  /** JSONB containment filter on `issue.metadata`. AND across keys. */
  metadata?: IssueMetadata;
  /** Custom-property filter: definition id → accepted values (option ids or
   *  "true"/"false" for checkbox; a plain string is exact equality, an
   *  operator object narrows it). OR within a definition, AND across. */
  properties?: Record<string, PropertyFilterValue[]>;
  assignee_filters?: IssueActorRef[];
  include_no_assignee?: boolean;
  creator_filters?: IssueActorRef[];
  project_ids?: string[];
  include_no_project?: boolean;
  label_ids?: string[];
  group_assignee_type?: IssueAssigneeType | "none";
  group_assignee_id?: string;
  date_field?: "created_at" | "updated_at";
  date_start?: string;
  date_end?: string;
  sort_by?:
    | "position"
    | "status"
    | "priority"
    | "title"
    | "created_at"
    | "updated_at"
    | "last_activity"
    | "start_date"
    | "due_date"
    | `property:${string}`;
  sort_direction?: "asc" | "desc";
}

/** Raw backend response shape for `GET /api/issues`. */
export interface ListIssuesResponse {
  issues: Issue[];
  total: number;
}

export interface IssueAssigneeGroup {
  id: string;
  assignee_type: IssueAssigneeType | null;
  assignee_id: string | null;
  issues: Issue[];
  total: number;
}

/** Raw backend response shape for `GET /api/issues/grouped?group_by=assignee`. */
export interface GroupedIssuesResponse {
  groups: IssueAssigneeGroup[];
}

// Server-authoritative Table query contract. Membership, grouping and counts
// are evaluated against the complete result set; the browser only owns view
// state such as collapsed groups/parents.
export type IssueTableScope =
  | { kind: "workspace"; assignee_types?: IssueAssigneeType[] }
  | { kind: "project"; project_id: string; assignee_types?: IssueAssigneeType[] }
  | { kind: "assignee"; actor: IssueActorRef }
  | { kind: "creator"; actor: IssueActorRef }
  | { kind: "my"; relation: "assigned" | "created" | "involved" | "any" };

export interface IssueTableFilters {
  statuses?: IssueStatus[];
  priorities?: IssuePriority[];
  assignees?: IssueActorRef[];
  include_no_assignee?: boolean;
  creators?: IssueActorRef[];
  project_ids?: string[];
  include_no_project?: boolean;
  label_ids?: string[];
  /** Same shape as `ListIssuesParams.properties`: bare strings are exact
   *  equality / "No value", operator objects narrow scalar matches. */
  properties?: Record<string, PropertyFilterValue[]>;
  date?: {
    field: "created_at" | "updated_at";
    start: string;
    end: string;
  };
  working_only?: boolean;
  /** Match the running-task issue projection returned by
   *  `/api/working-agents`. An explicit empty list matches nothing. */
  working_issue_ids?: string[];
  include_sub_issues?: boolean;
  /** Same contract as `ListIssuesParams.kind`. */
  issue_kind?: "requirement" | "task";
}

export type IssueTableSortField =
  | "position"
  | "status"
  | "priority"
  | "title"
  | "created_at"
  | "updated_at"
  | "last_activity"
  | "start_date"
  | "due_date"
  | `property:${string}`;

export interface IssueTableQuerySpec {
  scope: IssueTableScope;
  filters: IssueTableFilters;
  search?: string;
  sort: {
    field: IssueTableSortField;
    direction: "asc" | "desc";
  };
}

export type IssueTableGroupSpec =
  | { kind: "none" }
  | { kind: "status" }
  /**
   * Group by the CATEGORY a status behaves as, not by the status key.
   *
   * Board columns, list sections and swimlane cells are categories, so a custom
   * status folds into the column it behaves as instead of getting one of its
   * own — which is what keeps the surface's fan-out pinned at 7 no matter how
   * many statuses a workspace defines. The descriptor still reports
   * `value.kind === "status"` because a category's value IS its canonical
   * status key; the group KEY is what distinguishes the two contracts.
   * (MUL-6243)
   */
  | { kind: "status_category" }
  | { kind: "assignee" }
  | { kind: "project" }
  | { kind: "parent" }
  | {
      kind: "compound";
      primary: "assignee" | "project" | "parent";
      /** `status_category` folds custom statuses into their category's cell. */
      secondary: "status" | "status_category";
      /** Optional visible secondary buckets. When present, the server pages
       * only primary groups that contain at least one matching card and
       * returns `total` for that complete visible result set. */
      secondary_values?: IssueStatus[] | IssueStatusCategory[];
    }
  | { kind: "property"; property_id: string; include_empty?: boolean };

/** Response-side actor reference. Kept open for forward compatibility: an
 * installed desktop client may receive a new actor kind from a newer server. */
export interface IssueTableActorRef {
  type: string;
  id: string;
}

export interface IssueTableParentRef {
  id: string;
  number: number;
  identifier: string;
  title: string;
  status: string;
}

export type IssueTableGroupValue =
  | { kind: "status"; status: string }
  | { kind: "assignee"; actor: IssueTableActorRef | null }
  | { kind: "project"; project_id: string | null }
  | {
      kind: "parent";
      parent_id: string | null;
      parent: IssueTableParentRef | null;
      value_state: "value" | "unavailable" | "unset";
    }
  | {
      kind: "property";
      property_id: string;
      value?: string | boolean | null;
      value_state: "value" | "unavailable" | "unset";
    };

export interface IssueTableGroupDescriptor {
  key: string;
  value: IssueTableGroupValue;
  count: number;
  /** Present for compound groups. These opaque keys can be passed straight
   * back to `/table/rows`; clients must not reconstruct them. */
  secondary_groups?: IssueTableGroupDescriptor[];
}

export interface IssueTablePageRequest {
  limit?: number;
  cursor?: string | null;
}

export interface IssueTableGroupsRequest {
  query: IssueTableQuerySpec;
  group: Exclude<IssueTableGroupSpec, { kind: "none" }>;
  page?: IssueTablePageRequest;
}

export interface IssueTableGroupsResponse {
  query_fingerprint: string;
  total: number;
  groups: IssueTableGroupDescriptor[];
  next_cursor: string | null;
}

export interface IssueTableRowsRequest {
  query: IssueTableQuerySpec;
  group: IssueTableGroupSpec;
  group_key: string | null;
  hierarchy: { enabled: boolean };
  parent_id: string | null;
  page?: IssueTablePageRequest;
}

export interface IssueTableRow {
  issue: Issue;
  direct_child_count: number;
}

export interface IssueTableRowsResponse {
  query_fingerprint: string;
  group_key: string | null;
  parent_id: string | null;
  total: number;
  rows: IssueTableRow[];
  branch_total: number;
  next_cursor: string | null;
}

export type IssueTableFacetSpec =
  | { kind: "status" }
  | { kind: "priority" }
  | { kind: "assignee" }
  | { kind: "creator" }
  | { kind: "project" }
  | { kind: "label" }
  | { kind: "property"; property_id: string }
  /** Agents running issue work inside this surface. `key` is the agent id,
   *  `count` its running-task count. Evaluated against the surface's own scope
   *  and filters, so the header chip counts the same rows the list shows. */
  | { kind: "working_agents" };

export interface IssueTableFacetsRequest {
  query: IssueTableQuerySpec;
  facets: IssueTableFacetSpec[];
  /** Existing callers default to true. Count-only UIs can skip the extra scan. */
  include_total?: boolean;
}

export interface IssueTableFacetValue {
  key: string;
  count: number;
}

export interface IssueTableFacet {
  kind: IssueTableFacetSpec["kind"];
  property_id?: string;
  values: IssueTableFacetValue[];
}

export interface IssueTableFacetsResponse {
  query_fingerprint: string;
  total: number;
  facets: IssueTableFacet[];
}

/** One agent running issue work inside a single issue surface. Projected from
 *  the `working_agents` facet, so the count is already narrowed by that
 *  surface's scope and every active filter. Name/avatar are resolved from the
 *  workspace agent directory, not carried here. */
export interface WorkingAgentSummary {
  id: string;
  running_task_count: number;
}

/** Per-status bucket in the paginated issue cache. `total` is the server count (all pages), not the length of `issues`. */
export interface IssueStatusBucket {
  issues: Issue[];
  total: number;
}

/**
 * Frontend cache shape for the issue list. Data is bucketed by status so
 * each column can paginate independently. Assembled from per-status
 * `api.listIssues` responses by the query functions in `issues/queries.ts`.
 */
export interface ListIssuesCache {
  /** Bucketed by status CATEGORY — see PAGINATED_CATEGORIES. (MUL-6243) */
  byStatus: Partial<Record<IssueStatusCategory, IssueStatusBucket>>;
}

export interface SearchIssueResult extends Issue {
  match_source: "title" | "description" | "comment";
  matched_snippet?: string;
  matched_description_snippet?: string;
  matched_comment_snippet?: string;
}

export interface SearchIssuesResponse {
  issues: SearchIssueResult[];
  total: number;
}

export interface SearchProjectResult extends Project {
  match_source: "title" | "description";
  matched_snippet?: string;
}

export interface SearchProjectsResponse {
  projects: SearchProjectResult[];
  total: number;
}

export interface UpdateMeRequest {
  name?: string;
  avatar_url?: string;
  language?: string;
  /** Free-form self-description (max 2000 chars). Pass "" to clear. */
  profile_description?: string;
  /** IANA tz to pin; "" clears back to browser-tz; undefined leaves untouched. */
  timezone?: string;
}

export interface CreateMemberRequest {
  email: string;
  role?: MemberRole;
}

export interface UpdateMemberRequest {
  role: MemberRole;
}

// Personal Access Tokens
export interface PersonalAccessToken {
  id: string;
  name: string;
  token_prefix: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface CreatePersonalAccessTokenRequest {
  name: string;
  expires_in_days?: number;
}

export interface CreatePersonalAccessTokenResponse extends PersonalAccessToken {
  token: string;
}

// Pagination
export interface PaginationParams {
  limit?: number;
  offset?: number;
}
