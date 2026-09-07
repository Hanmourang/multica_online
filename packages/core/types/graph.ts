// 图谱快照 / 本体 / 总线矩阵类型（migrations 456 project_graph_snapshot + 457 ontology_*）

/** 图谱节点类型（GitNexus 静态分析产物；Community 为社区超节点）。 */
export type GraphNodeType =
  | "Function"
  | "Component"
  | "Hook"
  | "Route"
  | "Class"
  | "Process"
  | "Community";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  /** 全限定名，如 `src/core/foo.ts#Bar.baz`。 */
  qualified_name?: string;
  file_path?: string;
  /** 所属 Community 节点 ID；缺省 = 未归类。 */
  community_id?: string;
  properties?: Record<string, unknown>;
}

/** 图谱边类型（与本体 link_type 共用同一全集）。 */
export type GraphEdgeType =
  | "CALLS"
  | "MEMBER_OF"
  | "HANDLES_ROUTE"
  | "QUERIES"
  | "ACCESSES"
  | "FETCHES"
  | "STEP_IN_PROCESS";

export interface GraphEdge {
  source: string;
  target: string;
  type: GraphEdgeType;
  properties?: Record<string, unknown>;
}

/** 图谱社区（Community）：GitNexus 检测出的内聚子图。 */
export interface GraphCommunity {
  id: string;
  /** 社区名；模块桥接按同名自动匹配 project_module。 */
  name: string;
  /** 展示别名；缺省回落 name。 */
  label?: string;
  node_ids: string[];
  biz_kind?: string;
}

/** 快照统计（对应 stats JSONB 列）。 */
export interface GraphStats {
  node_count: number;
  edge_count: number;
  community_count: number;
  table_count?: number;
}

/** CLI 提交的图谱快照负载（按 git_sha 判重；亦作为
 *  ArtifactSyncPayload.graph_snapshot 随档案清单同批提交）。 */
export interface GraphSyncPayload {
  scan_id: string;
  git_sha: string;
  gitnexus_version: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunity[];
  stats: GraphStats;
  /**
   * 可选乐观锁前置条件（task 27）：非空时，服务端仅在该项目最新快照的
   * scan_id 仍等于此值时才执行 upsert，否则返回 409（携带 current_scan_id）。
   * 用于消除前端「读回守卫 → POST」之间 CLI 推送新快照的残留竞态。缺省
   * （CLI 全量 sync）行为不变。
   */
  expected_scan_id?: string;
}

/** 完整图谱快照（GET /projects/{id}/graph/latest；含 nodes / edges / communities，
 *  供「产品功能」「数据模型」两 Tab 消费）。 */
export interface ProjectGraphSnapshot {
  id: string;
  workspace_id: string;
  project_id: string;
  resource_id: string;
  scan_id: string;
  gitnexus_version: string;
  git_sha: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunity[];
  stats: GraphStats;
  created_at: string;
}

/** 快照摘要（不含 nodes / edges）：供列表 / 入口查询，避免传输大图。 */
export interface GraphSnapshotSummary {
  id: string;
  project_id: string;
  scan_id: string;
  git_sha: string;
  gitnexus_version: string;
  stats: GraphStats;
  module_summary: ModuleGraphSummary[];
  bus_matrix: BusMatrixCell[];
  created_at: string;
}

/** 模块图谱摘要（模块桥接后的聚合视图，驱动「产品功能」Tab 模块列表）。 */
export interface ModuleGraphSummary {
  node_id: string;
  name: string;
  obj_count: number;
  strategy_count: number;
  edge_stats: {
    calls_internal: number;
    calls_external: number;
  };
  tables_touched: string[];
}

/** 总线矩阵单元格：模块 × 页面 → 表读写（「数据模型」Tab）。
 *
 *  migration 456 把 bus_matrix 存成不透明 JSONB，唯一生产者是 CLI 预聚合：
 *  下面前 10 个字段是服务端 BusMatrixCell 落定的契约（聚合数字，不含表名）。
 *  added / modified / removed 是 CLI *可以*随格子投递的本期变更计数——服务端
 *  原样透传 JSONB，所以字段在就能读到、不在就是 undefined。f11 侧栏据此
 *  决定「本期变更」区块显不显示：缺字段一律不渲染，绝不显示假 0。 */
export interface BusMatrixCell {
  module_name: string;
  module_node_id: string;
  page_name: string;
  page_key: string;
  domain: string;
  table_count: number;
  read_count: number;
  write_count: number;
  is_new_table?: boolean;
  is_cross_domain_write?: boolean;
  /** 本期新增表数；CLI 未投递时为 undefined（≠ 0）。 */
  added?: number;
  /** 本期修改表数；CLI 未投递时为 undefined（≠ 0）。 */
  modified?: number;
  /** 本期移除表数；CLI 未投递时为 undefined（≠ 0）。 */
  removed?: number;
}

/** 格子下钻的列级明细：仅当 CLI 预聚合投递了 columns 才存在。 */
export interface BusMatrixTableColumn {
  name: string;
  type?: string;
  /** 读写标注（如 read / write / read_write）；CLI 未投递时缺省。 */
  access?: string;
}

/** 格子下钻的表级明细：由 GET .../bus-matrix/drilldown 从命中格子的
 *  `tables` 列表归并而来（同名表跨格子去重，列按名合并）。
 *  契约里没有表名时该数组为空，配合 detail_available=false 诚实降级。 */
export interface BusMatrixTableDetail {
  name: string;
  domain?: string;
  columns: BusMatrixTableColumn[];
  read_count?: number;
  write_count?: number;
  is_new_table?: boolean;
  /** 该表出现过的格子定位符：`module_node_id:page_key:domain`。 */
  source_cells?: string[];
}

export type BusMatrixAlertSeverity = "error" | "warning" | "info";

export type BusMatrixAlertType =
  | "cross_domain_write"
  | "orphan_table"
  | "deprecated_access"
  | "unclassified";

/** 告警定位到的图谱边。GraphEdge 契约本身没有稳定 id，所以 id 取负载里
 *  标注的 `id` / `properties.id`，都没有时回落到该边在快照 edges 数组中的
 *  位置下标（`edges[12]`）—— 客户端可复现的真实定位符，不是编造的。 */
export interface BusMatrixAlertEdgeRef {
  id: string;
  source: string;
  target: string;
  type: string;
}

/** 总线矩阵告警（跨域写 / 孤儿表 / 弃用访问 / 未分类）。
 *
 *  每条告警都带 severity 与真实定位信息：tables（表名）或 edges（边定位符）。
 *  count 是该条聚合的次数——tables / edges 列表服务端有上限（50 / 20），
 *  count 始终是真实总数。module_name / page_name / domain 仅在告警由单个
 *  矩阵格子推出时出现。 */
export interface BusMatrixAlert {
  severity: BusMatrixAlertSeverity;
  type: BusMatrixAlertType;
  description: string;
  tables?: string[];
  edges?: BusMatrixAlertEdgeRef[];
  count: number;
  module_name?: string;
  page_name?: string;
  domain?: string;
  /** 越界格子的写操作次数；仅 cross_domain_write 携带。用 undefined 而非 0
   *  区分「不是格子级告警」与「写次数真的是 0」。 */
  write_count?: number;
}

/** 规则未能运行的机器可读原因码（由客户端本地化，服务端不给文案）。
 *  ok = 规则真的跑过了。 */
export type BusMatrixRuleReason =
  | "ok"
  | "no_bus_matrix"
  | "no_table_names"
  | "no_module_summary"
  | "module_summary_malformed"
  | "edges_unavailable"
  | "no_snapshot_edges"
  | "no_access_edges"
  | "not_implemented";

/** 单条告警规则的覆盖情况：evaluated=false 表示 CLI 预聚合没有投递该规则
 *  所需的输入，因此不产出告警——而不是「没有问题」。少了这一层，空告警列表
 *  会被读成矩阵很干净，那是遗漏造成的假象。 */
export interface BusMatrixRuleCoverage {
  type: BusMatrixAlertType;
  evaluated: boolean;
  reason?: BusMatrixRuleReason;
}

// --- 本体层（migration 457；降级先行：本体抽取就绪前表为空，UI 以图谱层为地基） ---

/** 4E 本体实体分类（对应 DB 列 entity_4e）。 */
export type OntologyEntityType = "code" | "semantic" | "table" | "biz";

export interface OntologyObject {
  id: string;
  entity_type: OntologyEntityType;
  qualified_name: string;
  domain?: string | null;
  lifecycle?: string | null;
  impl_status?: string | null;
  properties?: Record<string, unknown>;
}

export interface OntologyLink {
  id: string;
  source_id: string;
  target_id: string;
  link_type: GraphEdgeType;
  properties?: Record<string, unknown>;
}

/** 本体迭代变更类型。 */
export type OntologyChangeType = "added" | "modified" | "removed" | "status_change";

export interface OntologyChangelog {
  id: string;
  object_name: string;
  change_type: OntologyChangeType;
  details?: Record<string, unknown>;
  created_at: string;
}

/** 本体就绪度：ready = 已抽取；empty = 未抽取（降级展示）；partial = 部分抽取。 */
export type OntologyReadiness = "ready" | "empty" | "partial";

// --- API 响应 wrapper（字段以 server/internal/handler/project_graph.go 实际 JSON 为准） ---

/** POST /projects/{id}/graph/sync 响应。 */
export interface GraphSyncResponse {
  snapshot_id: string;
  inserted: boolean;
  cleaned_up: number;
  /** module ↔ community 桥接统计（服务端 SyncGraphSnapshotResponse 实际返回）。 */
  matched_modules: number;
  updated_modules: number;
  unmatched_communities: string[];
}

/**
 * POST /projects/{id}/graph/rebridge 响应（task 27）：仅重跑 module ↔ community
 * 桥接、不回传图体。服务端从 DB 读取最新快照的 communities 就地重算，因此
 * 无需前端把 9–20 MiB 的 nodes/edges 读回再上传。node_count 用于回显被桥接的
 * 快照规模。无最新快照时服务端返回 404（诚实空态，不伪造 matched 数）。
 */
export interface RebridgeGraphResponse {
  scan_id: string;
  node_count: number;
  matched_modules: number;
  updated_modules: number;
  unmatched_communities: string[];
}

/** 模块桥接列表行：project_module + issue 计数 + graph_node_id 桥接状态。 */
export interface GraphModuleItem {
  id: string;
  name: string;
  color: string;
  /** 桥接到的 Community 节点 ID；null = 未绑定。 */
  graph_node_id?: string | null;
  issue_count: number;
}

/** GET /projects/{id}/graph/modules 响应。 */
export interface ListGraphModulesResponse {
  modules: GraphModuleItem[];
  total: number;
}

/** 模块变更聚合行：该模块下的 issue 摘要。 */
export interface ModuleIssueSummary {
  id: string;
  title: string;
  status: string;
  updated_at: string;
}

/** GET .../graph/modules/{nodeId}/changes 响应。 */
export interface ModuleChangesResponse {
  module_id: string;
  node_id: string;
  name: string;
  issues: ModuleIssueSummary[];
  total: number;
}

/** GET .../graph/modules/{nodeId}/objects 响应：本体层对象列表，本体未就绪时
 *  回落 module_summary 投影填 obj_count/tables_touched，objects 为空数组。 */
export interface ModuleObjectsResponse {
  module_id: string;
  node_id: string;
  name: string;
  obj_count: number;
  tables_touched: string[];
  objects: OntologyObject[];
}

/** 策略 kv 投影行（本体层对象 properties 展平）。 */
export interface ModuleStrategyItem {
  key: string;
  value: string;
  source: string;
  status: string;
}

/** GET .../graph/modules/{nodeId}/strategies 响应；ontology_ready="empty" 时
 *  strategies 为空数组（降级先行）。 */
export interface ModuleStrategiesResponse {
  module_id: string;
  node_id: string;
  name: string;
  ontology_ready: OntologyReadiness;
  strategies: ModuleStrategyItem[];
  total: number;
}

/** GET .../graph/modules/{nodeId}/neighborhood 响应；服务端 BFS 提取未实现，
 *  nodes/edges 恒为空数组（真实空态，不伪造）。 */
export interface ModuleNeighborhoodResponse {
  snapshot_id: string;
  scan_id: string;
  git_sha: string;
  stats: GraphStats | Record<string, unknown>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  module_id: string;
  module_name: string;
}

/** GET /projects/{id}/graph/bus-matrix 响应。 */
export interface BusMatrixResponse {
  snapshot_id: string;
  scan_id: string;
  git_sha: string;
  bus_matrix: BusMatrixCell[];
  total: number;
}

/** GET .../graph/bus-matrix/drilldown 响应（filters: module_node_id/page_key/domain）。
 *
 *  cells / total 是命中的聚合格子（始终可得）。tables 是表级明细，只有当
 *  CLI 预聚合随格子投递了 `tables` 列表才非空 —— 此时 detail_available=true；
 *  columns_available 进一步区分「有表名但没列名」。两个标记都为 false 时前端
 *  诚实降级说明缺口，不伪造表名。tables_truncated 表示明细被 200 张上限截断。 */
export interface BusMatrixDrilldownResponse {
  cells: BusMatrixCell[];
  total: number;
  tables: BusMatrixTableDetail[];
  detail_available: boolean;
  columns_available: boolean;
  tables_truncated: boolean;
}

/** GET .../graph/bus-matrix/alerts 响应。rule_coverage 覆盖全部四类规则，
 *  顺序稳定：cross_domain_write / orphan_table / deprecated_access /
 *  unclassified。 */
export interface BusMatrixAlertsResponse {
  alerts: BusMatrixAlert[];
  total: number;
  rule_coverage: BusMatrixRuleCoverage[];
}

/** GET .../graph/bus-matrix/timeline 响应；本体 changelog 暂空时 changes 为空数组。 */
export interface BusMatrixTimelineResponse {
  snapshot_id: string;
  changes: OntologyChangelog[];
  total: number;
}
