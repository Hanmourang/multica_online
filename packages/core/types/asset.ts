// 资产管理类型（对标 CoCo /projects/:id/assets；migration 471 project_asset_binding）。
// spec: change_logs/multica/plans/20261024-coco对标-工作流迭代资产/03_资产管理模块.md
//
// 线格式与 server/internal/handler/project_asset.go 的 JSON tag 严格对齐。资产是
// project_resource(065) 之上的「业务目录绑定层」：binding 指向 resource，解绑只删
// binding 永不删 resource。前端 zod .catch 降级防御式读取分页信封。

/** 6 类研发资产分类（对齐 CoCo TCe，落通用枚举）。 */
export type AssetCategory =
  | "code_repository"
  | "application"
  | "package"
  | "knowledge_repo"
  | "knowledge_group"
  | "other";

export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  "code_repository",
  "application",
  "package",
  "knowledge_repo",
  "knowledge_group",
  "other",
];

/** 写入通道：manual = 手填 / 搜索候选绑定；github = 仓库源；其余为预留目录来源。 */
export type AssetSource = string;

/**
 * 生命周期阶段（migration 473/477/500；五阶段唯一映射 plan §5.1，与 Go 端
 * placement 表同取值）。S0 = 需求描述：不对应档案日历阶段 1..5，落
 * (stage NULL, doc_type 'requirement')，供需求 × 阶段矩阵的 S0 列使用。
 */
export type AssetLifecycleStage = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "general";

export const ASSET_LIFECYCLE_STAGES: readonly AssetLifecycleStage[] = [
  "S0",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "general",
];

/** 资产角色：input = 被消费的前置材料；output = 该阶段的交付产物。 */
export type AssetRole = "input" | "output";

/** 资产↔需求/Bug 关联链型（asset_issue_link）。 */
export type AssetLinkType = "depends_on" | "produces" | "resolves";

/** 关联条目（服务端 AssetIssueLink JSON 形态）。 */
export interface AssetIssueLink {
  issue_id: string;
  link_type: AssetLinkType | string;
}

/** 写入态关联条目。 */
export interface AssetIssueLinkRequest {
  issue_id: string;
  link_type?: AssetLinkType;
}

/** binding 自带的外部引用元数据（至少可携带仓库 url）。 */
export interface AssetExternalRef {
  url?: string;
  [key: string]: unknown;
}

/** project_asset_binding 行的 JSON 形态。 */
export interface AssetBinding {
  id: string;
  workspace_id: string;
  project_id: string;
  /** 工作项级绑定非空；项目级为 null。 */
  issue_id?: string | null;
  asset_category: AssetCategory;
  /** 指向 065 物理资源；null = 无指针（仅 external_ref 自描述）。 */
  resource_id?: string | null;
  external_ref: AssetExternalRef;
  asset_name: string;
  asset_subtype?: string | null;
  source: AssetSource;
  recommended: boolean;
  recommend_reason?: string | null;
  /** 473 扩展：阶段 / 输入产物角色 / 标签 / 需求·Bug 关联（旧后端无此字段时 undefined）。 */
  lifecycle_stage?: AssetLifecycleStage | null;
  asset_role?: AssetRole | null;
  tags?: string[];
  /** 仅 overview / meta 回显面携带；分页列表省略。 */
  links?: AssetIssueLink[];
  created_by_type: "member" | "agent";
  created_by_id: string;
  created_at: string;
}

/** 分页信封（对齐 CoCo 面 C {items,totalCount,page,pageSize,totalPages}）。 */
export interface AssetPage {
  items: AssetBinding[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

/**
 * 工作区级聚合行（GET /api/assets/page）：在 binding 之上附带归属项目 / 工作项
 * 标题，供左侧栏「资产管理」页直接展示并生成跳转链接（串联 项目/需求/任务 动线）。
 * 标题为后端 LEFT JOIN 得出，孤儿 binding 或后端较旧时为 null → 前端降级用 id 展示。
 */
export interface WorkspaceAssetBinding extends AssetBinding {
  project_title?: string | null;
  issue_title?: string | null;
}

/** 工作区级分页信封（与 server WorkspaceAssetPage 对齐）。 */
export interface WorkspaceAssetPage {
  items: WorkspaceAssetBinding[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

/** 「未分阶 / 未定对象」筛选值：服务端把它翻成 IS NULL OR '' 的条件。 */
export type AssetUnsetFilter = "none";

/** GET /assets/page 查询参数。issueId 非空把作用域降到某工作项。 */
export interface ListAssetsParams {
  page?: number;
  pageSize?: number;
  category?: AssetCategory;
  name?: string;
  issueId?: string;
  /** 仅工作区级 GET /api/assets/page 消费（侧栏项目下拉过滤）；项目/工作项级
   *  endpoint 的作用域由路径参数决定，服务端忽略此字段。 */
  projectId?: string;
  /** 仅工作区级 GET /api/assets/page 消费：阶段过滤在服务端完成，这样分页的
   *  totalCount / totalPages 与筛选结果一致（前端页内二次过滤会让末页留白）。 */
  stage?: AssetLifecycleStage | AssetUnsetFilter;
  /** 同上，限定输入 / 输出对象。 */
  role?: AssetRole | AssetUnsetFilter;
}

/** POST /assets 请求体。 */
export interface BindAssetRequest {
  asset_category: AssetCategory;
  asset_name: string;
  asset_subtype?: string | null;
  source?: string;
  external_ref?: AssetExternalRef;
  resource_id?: string;
  /** 项目级 endpoint 允许 body 带 issue_id 直接落工作项作用域。 */
  issue_id?: string;
  recommended?: boolean;
  recommend_reason?: string | null;
  /** 473：绑定时同步打标与关联。 */
  lifecycle_stage?: AssetLifecycleStage | "";
  asset_role?: AssetRole | "";
  tags?: string[];
  links?: AssetIssueLinkRequest[];
}

/**
 * PUT /assets/{bindingId}/meta 请求体（patch 语义）：字段缺省 = 不动；
 * "" = 清除打标；null 不会被发送（links 传数组 = 全量替换）。
 */
export interface UpdateAssetMetaRequest {
  lifecycle_stage?: AssetLifecycleStage | "";
  asset_role?: AssetRole | "";
  asset_category?: AssetCategory;
  tags?: string[];
  links?: AssetIssueLinkRequest[];
}

/**
 * POST /assets/batch-meta 请求体：对一批 binding 应用同一套 patch。
 * 字段缺省 = 不动；stage/role 传 "" = 清除；category 只能设为枚举值。
 * tags_mode 控制标签写法：replace 覆盖 / add 追加去重 / remove 删除命中项。
 */
export interface BatchUpdateAssetMetaRequest {
  binding_ids: string[];
  lifecycle_stage?: AssetLifecycleStage | "";
  asset_role?: AssetRole | "";
  asset_category?: AssetCategory;
  tags?: string[];
  tags_mode?: "replace" | "add" | "remove";
}

/** batch-meta 响应：命中并更新的条数 + 更新后的 binding 快照。 */
export interface BatchUpdateAssetMetaResponse {
  updated: number;
  bindings: AssetBinding[];
}

/** overview 面的工作项条目：multica 里需求与任务同为 issue，is_requirement =
 * 顶层（无父项）；任务（有父项）为 false。候选为全量下发（含已关闭）。 */
export interface AssetOverviewIssue {
  id: string;
  title: string;
  status: string;
  project_id?: string | null;
  is_requirement?: boolean;
}

/** GET /api/assets/overview 响应：全量 binding（含 links，不分页）+ 全量候选工作项
 *（需求与任务各按 is_requirement 分区）。 */
export interface AssetOverviewResponse {
  bindings: AssetBinding[];
  issues: AssetOverviewIssue[];
}

/** 搜索候选条目（对标 CoCo ECe，带智能推荐）。 */
export interface AssetCandidate {
  asset_category: AssetCategory;
  asset_name: string;
  subtype?: string;
  source: AssetSource;
  resource_id?: string | null;
  external_ref: AssetExternalRef;
  already_bound: boolean;
  recommended: boolean;
  recommend_reason: string;
  score: number;
}

/** GET /assets/search-candidates 查询参数。 */
export interface SearchAssetCandidatesParams {
  category?: AssetCategory;
  q?: string;
  relatedToMe?: boolean;
}

/** search-candidates 响应。 */
export interface AssetCandidatesResponse {
  candidates: AssetCandidate[];
}

/** 推荐理由键（后端 scoreAssetCandidate 主导因子）→ i18n 文案映射用。 */
export type AssetRecommendReason = "" | "recent" | "joint" | "hot";
