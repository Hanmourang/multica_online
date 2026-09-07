// 申报就绪度类型（migration 458 filing_item / filing_check_run / filing_export_log）

/** 清单档位：must = 缺则不予受理；conditional = 权属情形触发；aux = 不影响受理。 */
export type FilingTier = "must" | "conditional" | "aux";

/** 申报轨道：软著 / 专利。 */
export type FilingTrack = "software_copyright" | "patent";

/** 就绪度三态（API 投影；DB 行状态 pending/pass/fail/not_applicable 由 server 聚合映射）。 */
export type FilingStatus = "missing" | "partial" | "ready";

/** 申报清单项（UNIQUE(project_id, track, item_key)；sync 时重算规则）。 */
export interface FilingItem {
  id: string;
  project_id: string;
  workspace_id: string;
  tier: FilingTier;
  track: FilingTrack;
  label: string;
  description: string;
  /** 绑定的档案条目；null = 待补件。 */
  artifact_id?: string | null;
  status: FilingStatus;
  sort_order: number;
  /** 规则引擎求值结果（revived dead column rule_result）。 */
  rule_result?: Record<string, unknown> | null;
  /** 档案相对路径（revived dead column source_path）—— 当前无写入方，始终为空。 */
  source_path?: string;
  /** 规则 DSL kind（如 heading_sequence / max_chars / claim_graph / version_consistency）。 */
  rule_kind?: string;
  created_at: string;
  updated_at: string;
}

/** 清单项最近一次校验投影（页数 / 每页行数 / 页眉一致性等结果）。 */
export interface FilingCheckRun {
  id: string;
  filing_item_id: string;
  rule_result: Record<string, unknown>;
  blocking: boolean;
  checked_at: string;
}

/** 导出类型：full = 申报包；diagnostic = 诊断包（必备未齐被拒时降级导出）。 */
export type FilingExportType = "full" | "diagnostic";

/** 导出历史（filing_export_log）。 */
export interface FilingExportLog {
  id: string;
  project_id: string;
  workspace_id: string;
  track: FilingTrack;
  export_type: FilingExportType;
  artifact_ids: string[];
  created_by?: string | null;
  created_at: string;
}

/** 单轨道就绪度聚合（GET /projects/{id}/filing/readiness 按 track 拆分；
 *  blocking_count > 0 时导出申报包被拒绝，仅允许诊断包）。 */
export interface FilingReadiness {
  track: FilingTrack;
  total_items: number;
  ready_count: number;
  must_ready: number;
  must_total: number;
  blocking_count: number;
  items: FilingItem[];
  /** anno③: 阻塞项优先级面板（P0/P1/P2 排序）。 */
  blocking_items: FilingBlockingItem[];
}

/** anno③: 阻塞项优先级。
 * P0 = must + 无档案（完全缺失，最硬阻塞）
 * P1 = must + 已绑定档案但规则不达标（材料存在但不合规）
 * P2 = conditional/aux 缺失或规则不达标（不阻塞受理） */
export type FilingPriority = "P0" | "P1" | "P2" | "";

export interface FilingBlockingItem {
  item_id: string;
  label: string;
  tier: FilingTier;
  priority: FilingPriority;
  status: FilingStatus;
  reason: string;
}

// --- API 响应 wrapper（字段以 server/internal/handler/project_filing.go 实际 JSON 为准） ---

/** GET /projects/{id}/filing/readiness 响应；无 item 时返回两 track 空聚合。 */
export interface FilingReadinessResponse {
  tracks: FilingReadiness[];
  can_export_filing: boolean;
  blocking_count: number;
}

/** GET /projects/{id}/filing/items 响应（track/tier 筛选）。 */
export interface ListFilingItemsResponse {
  items: FilingItem[];
  total: number;
}

/** 单项校验结果（POST filing/check 响应项）。 */
export interface FilingCheckOutcome {
  item: FilingItem;
  verdict: "pass" | "fail" | "warning" | "pending_cli";
  /** anno③: P0/P1/P2 优先级。 */
  priority?: FilingPriority;
}

/** POST /projects/{id}/filing/check 响应；规则引擎为骨架：artifact 绑定 → pass。 */
export interface FilingCheckResponse {
  checked_count: number;
  pass_count: number;
  fail_count: number;
  items: FilingCheckOutcome[];
}

/** POST /projects/{id}/filing/export 请求；track 缺省 = 全部轨道。 */
export interface FilingExportRequest {
  track?: FilingTrack;
}

/** POST /projects/{id}/filing/export 响应；must 未齐自动降级 diagnostic，
 *  reason 列出缺失 item_key；structure 为包目录描述（实际 zip 组装在 CLI）。
 *  anno⑤: 目录按档位分 A-must / B-conditional / C-aux。 */
export interface FilingExportResponse {
  success: boolean;
  export_type: FilingExportType;
  export_log_id: string;
  reason: string;
  structure: string;
  artifact_ids?: string[];
}

/** PATCH /projects/{id}/filing/items/{itemId} 请求体。
 *  override_reason 必填（原型 :708/:842）—— 暂存于 rule_expr JSONB，
 *  正式落地需新增 override_reason 列（属后续 schema 任务）。 */
export interface FilingItemPatchRequest {
  status?: FilingStatus;
  artifact_id?: string | null;
  override_reason: string;
}
