// 运行投影类型（migration 459 agent_run / agent_run_todo / agent_run_event）
// 会话流（task_message）是事实源，本组类型是单向投影

/** 运行状态。 */
export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "stalled";

/** 待办阶段：开放式字符串（CLI 自定义 phase，如 P0 / 设计 / 实现 / 验收）。 */
export type TodoPhase = string;

/** 待办状态。 */
export type TodoStatus = "pending" | "in_progress" | "done" | "skipped" | "failed";

/** 待办来源：tool_trace = 工具调用轨迹，reply = 回复解析，manual = 人工改判。 */
export type TodoSource = "tool_trace" | "reply" | "manual";

/** 运行事件类型。 */
export type EventType = "heartbeat" | "todo_change" | "rate_limit" | "net_err" | "crash";

/** 单次运行（GET /issues/{id}/runs）。 */
export interface AgentRun {
  id: string;
  task_queue_id: string;
  issue_id: string;
  /** 根需求 ID：子任务运行指向同一根需求；null = 自身为根需求。 */
  root_issue_id?: string | null;
  workspace_id: string;
  agent_id: string;
  model: string;
  cli_kind: string;
  status: RunStatus;
  /** 最近心跳时间；运行刚开始可为 null。 */
  last_heartbeat_at?: string | null;
  /** 卡死 / 等待原因（复用 agent_task_queue 真实等待态，如
   *  rate_limited / network_lost / waiting_module_lock / waiting_local_directory）。 */
  stall_reason?: string | null;
  token_used: number;
  started_at: string;
  /** 运行结束时间；running 中为 null。 */
  finished_at?: string | null;
}

/** 单条待办（todo_key 跨 run 稳定，是合并主键；同 key 多轮执行以
 *  superseded_by 串血缘）。API 契约以 handler 实际 JSON 为准：title 必填
 *  （DB 非空列），phase 可空（CLI 自定义阶段）。 */
export interface AgentRunTodo {
  id: string;
  run_id: string;
  todo_key: string;
  phase?: TodoPhase | null;
  title: string;
  status: TodoStatus;
  seq: number;
  source: TodoSource;
  /** 被哪条更新版待办取代；null = 当前有效版本。 */
  superseded_by?: string | null;
  created_at: string;
  updated_at: string;
}

/** 运行事件（心跳 / 待办变更 / 限流 / 断网 / 崩溃）。 */
export interface AgentRunEvent {
  id: string;
  run_id: string;
  event_type: EventType;
  payload: Record<string, unknown>;
  created_at: string;
}

// --- API 响应 wrapper（字段以 server/internal/handler/agent_run.go 与 issue_archive.go 实际 JSON 为准） ---

/** POST /api/agent-runs 请求（投影器写入口；带 id 幂等）。 */
export interface UpsertAgentRunRequest {
  id?: string;
  task_queue_id?: string;
  issue_id?: string;
  root_issue_id?: string;
  agent_id: string;
  model?: string;
  cli_kind: string;
  status: RunStatus;
  last_heartbeat_at?: string;
  stall_reason?: string;
  token_used?: number;
}

/** GET /api/issues/{id}/agent-runs 响应（含子任务运行经 root_issue_id 汇入）。 */
export interface ListAgentRunsResponse {
  runs: AgentRun[];
  total: number;
}

/** GET /api/agent-runs/{runId}/todos 响应（按 seq 排序）。 */
export interface ListAgentRunTodosResponse {
  todos: AgentRunTodo[];
  total: number;
}

/** GET /api/agent-runs/{runId}/events 响应（limit 1..500，新在前）。 */
export interface ListAgentRunEventsResponse {
  events: AgentRunEvent[];
  total: number;
}

/** 动态流事件四分体系。 */
export type DynamicsEventType = "conversation" | "progress" | "status" | "artifact";

/** 动态流中的单个事件。 */
export interface DynamicsEvent {
  id: string;
  type: DynamicsEventType;
  task_id?: string | null;
  run_id?: string | null;
  actor: string;
  actor_name: string;
  content: string;
  tool_name?: string | null;
  ts: string;
}

/** 按日分组的事件集合。 */
export interface DynamicsDay {
  date: string;
  events: DynamicsEvent[];
}

/** 五指标汇总条。 */
export interface DynamicsSummary {
  task_total: number;
  task_dispatched: number;
  message_count: number;
  progress_event_count: number;
  artifact_count: number;
  artifact_archived_count: number;
}

/** 任务过滤面。 */
export interface DynamicsTaskFacet {
  id: string;
  title: string;
  agent: string;
  status: string;
}

/** 过滤元数据。 */
export interface DynamicsFilters {
  tasks: DynamicsTaskFacet[];
  agents: string[];
  types: DynamicsEventType[];
}

/** GET /api/issues/{id}/dynamics 响应：需求动态时间归并流。 */
export interface IssueDynamicsResponse {
  issue: {
    id: string;
    title: string;
    status: string;
  };
  days: DynamicsDay[];
  summary: DynamicsSummary;
  filters: DynamicsFilters;
}

/** 需求派生状态的稳定 ASCII 枚举（9 规则投影 → i18n key）。
 *  `unknown` = 服务端 issue.sql 长出了 handler 尚未映射的字面量，
 *  此时前端回落到 `requirement_status` 原文而不是编一个标签。 */
export type DerivedStatusKey =
  | "not_decomposed"
  | "prototype_pending"
  | "decomposition_pending"
  | "pending_trigger"
  | "executing"
  | "waiting_module_lock"
  | "accepting"
  /** 验收失败终态：acceptance_round>3，转人工仲裁（后端 statusKey="acceptance_failed"）。 */
  | "acceptance_failed"
  | "completed"
  | "cancelled"
  | "unknown";

/** 派生状态隐含的「下一动作」枚举；`none` = 无需动作。
 *  全部由 9 规则投影推导；与阶段门（stage_gate_rule，migration 460）互为补充而非替代。 */
export type DerivedNextActionKey =
  | "confirm_prototype"
  | "confirm_decomposition"
  | "decompose"
  | "trigger"
  | "wait_module_lock"
  | "finish_execution"
  | "finish_acceptance"
  | "none";

/** issue 的 project_module 指针 —— daemon 侧 ModuleLocker 取锁用的键。 */
export interface DeliverablesModuleRef {
  id: string;
  name: string;
  color: string;
}

/** 卡片 ① 派生状态：9 规则投影（不落列，永远与事实一致）。 */
export interface DeliverablesDerivedStatus {
  /** ListIssues 同源的中文字面量，与 issue.requirement_status 契约一致。 */
  requirement_status: string;
  status_key: DerivedStatusKey;
  next_action_key: DerivedNextActionKey;
  /** 阶段 3 的 "N/M"（无 stage-3 子任务时为 null），与 ListIssues 同契约。 */
  stage_progress?: string | null;
  /** 当前阶段（1..4）的子任务完成计数 —— 「执行中 S3 · 3/5」的那个 3/5。 */
  stage_done: number;
  stage_total: number;
  /** 阶段带 `cur` 指针（1..4）。 */
  current_stage: 1 | 2 | 3 | 4;
}

/** 泊在模块锁上的单个任务。reason 是 daemon 写入的 wait_reason 原文
 *  （内含持有者模块名），属数据而非 UI 文案，与 stall_distribution 同样直出。 */
export interface DeliverablesWaitEntry {
  task_id: string;
  reason?: string | null;
}

/** 卡片 ② 调度与互斥。服务端能看到的是 agent_task_queue 的落库事实：
 *  ModuleLocker 的持有者表是 daemon 进程内存态，全局锁视图不可得。 */
export interface DeliverablesModuleLock {
  module: DeliverablesModuleRef;
  /** issue.avoid_conflict —— 勾选即排他。 */
  avoid_conflict: boolean;
  /** 同模块并发活跃任务数（含自身）；同模块之间永不互斥 → 「同组并发」。 */
  same_module_active: number;
  /** 本需求自身 dispatched/running 的任务数。 */
  active_count: number;
  /** 本需求泊在 waiting_module_lock 的任务数 → 「跨组串行」。 */
  waiting_count: number;
  waiting: DeliverablesWaitEntry[];
}

/** 卡片 ③ 角色班底条目（issue_role_assignment + 服务端解析的显示名）。 */
export interface DeliverablesRoleAssignment {
  role: "pm" | "prototyper" | "developer" | "data" | "tester";
  assignee_type: "member" | "agent";
  assignee_id: string;
  /** 解析不到（agent 硬删 / member 移除）时为空串，前端回落截断 UUID。 */
  assignee_name: string;
  enabled: boolean;
  ordinal: number;
}

/** 阶段带节点。state 对应原型的 done / cur / 普通三态。 */
export interface DeliverablesStageNode {
  stage: 1 | 2 | 3 | 4;
  state: "done" | "cur" | "todo";
  artifact_count: number;
  task_done: number;
  task_total: number;
}

/** 卡片 ④ 缺件项。kind=`empty_stage` 表示已进入阶段的档案架完全为空；
 *  kind=`missing_doc_type` 表示 stage_gate_rule（migration 460）要求的具体 blocking
 *  文档缺失，带 required_doc_type + stage，前端据此给出两个修复入口。 */
export interface DeliverablesMissingItem {
  stage: 1 | 2 | 3 | 4;
  kind: "empty_stage" | "missing_doc_type";
  /** 仅 kind === "missing_doc_type" 时存在。 */
  required_doc_type?: string;
}

/** 单个阶段的阶段门判定（stage_gate_rule LEFT JOIN project_artifact，只算 blocking）。
 *  gate_defined=false 表示该阶段在已解析的规则集里没有规则，不设门。 */
export interface DeliverablesStageGate {
  stage: 1 | 2 | 3 | 4;
  gate_defined: boolean;
  /** 仅统计 blocking=true 的规则项（anno②「环只算必备件」）。 */
  required_total: number;
  required_ready: number;
  gate_closed: boolean;
  /** 「S{n} 门未闭合 → 阻止进 S{n+1}」：门开 且 该阶段是当前前沿（cur）且 n<4。 */
  blocking_next_stage: boolean;
  /** 缺失的 blocking doc_type，按规则 sort_order 排列。 */
  missing_doc_types: string[];
}

/** 卡片 ④ 档案完整度计数。gate_defined=false 时 required_* 为 0，
 *  前端退回 stages_with_artifact / stages_total 的旧环而不是除以零。 */
export interface DeliverablesCompleteness {
  artifact_total: number;
  stages_with_artifact: number;
  stages_total: number;
  missing_count: number;
  /** 是否解析到任何 stage_gate_rule 规则。 */
  gate_defined: boolean;
  /** 完整度环分母 / 分子（仅 blocking 必备件）。 */
  required_total: number;
  required_ready: number;
}

/** GET /api/issues/{id}/deliverables-overview 响应：档案交付物聚合 + f8 四状态卡。
 *  issue_id / artifacts / todos 是既有契约（保持不变），其余为 f8 追加。
 *  module_lock 为 null 表示「不适用」—— 需求未挂模块，ModuleLocker 直接跳过。 */
export interface IssueDeliverablesOverviewResponse {
  issue_id: string;
  artifacts: {
    total: number;
    by_scope: Record<string, number>;
    by_stage: Record<string, number>;
  };
  todos: {
    total: number;
    by_status: Record<string, number>;
  };
  issue: {
    id: string;
    title: string;
    status: string;
    module?: DeliverablesModuleRef | null;
    avoid_conflict: boolean;
  };
  derived_status: DeliverablesDerivedStatus;
  module_lock?: DeliverablesModuleLock | null;
  role_assignments: DeliverablesRoleAssignment[];
  stage_flow: DeliverablesStageNode[];
  missing_items: DeliverablesMissingItem[];
  /** 四个阶段的阶段门判定（stage 1..4，恒定 4 条）。 */
  stage_gates: DeliverablesStageGate[];
  /** 门未闭合、阻止进入下一阶段的前沿阶段号；0 = 无阻断。 */
  blocking_stage: number;
  completeness: DeliverablesCompleteness;
}

/** 进度追踪待办叶子（agent_run_todo 投影，仅渲染相关列；内嵌于 run）。 */
export interface IssueProgressTodo {
  todo_key: string;
  phase?: TodoPhase | null;
  title: string;
  status: TodoStatus;
  seq: number;
  source: TodoSource;
}

/** 进度追踪运行行（第三层）：待办内嵌，无需再懒加载 per-run todos。
 *  started_at/finished_at 由 created_at/updated_at 投影（见 agent_run.go）。 */
export interface IssueProgressRun {
  id: string;
  agent_id: string;
  model?: string | null;
  cli_kind: string;
  status: RunStatus;
  token_used: number;
  stall_reason?: string | null;
  last_heartbeat_at?: string | null;
  started_at: string;
  finished_at?: string | null;
  todos: IssueProgressTodo[];
  todos_progress: {
    done: number;
    total: number;
  };
}

/** 进度追踪任务行（第二层）：agent_task_queue 摘要 + 其下 runs 嵌套。
 *  title 优先用归属 issue.title（中文需求/子任务名），再回落到 trigger_summary。 */
export interface IssueProgressTask {
  id: string;
  title: string;
  status: string;
  agent_id: string;
  created_at: string;
  runs: IssueProgressRun[];
  todos_progress: {
    done: number;
    total: number;
  };
}

/** GET /api/issues/{id}/progress 响应：需求→任务→运行→待办三层树。
 *  runs 经 task_queue_id JOIN 到 task 下；无匹配的（子需求经 root_issue_id
 *  汇入但任务归属其他 issue）落入 unmatched_runs。加权分/血缘链/孤儿检测
 *  仍为服务端 TODO。 */
export interface IssueProgressResponse {
  issue: {
    id: string;
    title: string;
    status: string;
    rollup: {
      tasks_done: number;
      tasks_total: number;
      todos_done: number;
      todos_total: number;
      runs_active: number;
      runs_stalled: number;
    };
  };
  tasks: IssueProgressTask[];
  unmatched_runs: IssueProgressRun[];
  stall_distribution: Record<string, number>;
}
