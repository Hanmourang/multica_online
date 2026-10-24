/**
 * 工作流模块类型（CoCo 对标 plan 20261024 §01 F1，Agent-W）。
 *
 * 命名约定与 artifacts/asset 一致：API 层 snake_case 透传（Go handler json
 * tag 即契约），不做 camelCase 归一——归一只会把漂移藏进适配层。
 */

export type WorkflowInstanceStatus =
  | "waiting"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export type WorkflowTemplateStatus = "draft" | "published" | "archived";

export type StageMode = "auto" | "human";

export type StageRunState =
  | "pending"
  | "running"
  | "waiting_gate"
  | "done"
  | "failed"
  | "skipped";

export type GateState = "pending" | "running" | "waiting" | "decided" | "cancelled";

export type GateDecision = "" | "loop" | "exit";

/** workflow_template.nodes JSONB 元素（与 Go service.WorkflowNode 同形）。 */
export interface WorkflowNode {
  id: string;
  name: string;
  mode: StageMode;
  stage: number;
  agent_ref?: string;
  prompt?: string;
  next: string[];
  gate_doc_types: string[];
  inputs?: unknown[];
  outputs?: unknown[];
}

export interface WorkflowTemplate {
  id: string;
  workspace_id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  status: WorkflowTemplateStatus;
  version: number;
  nodes: WorkflowNode[];
  official: boolean;
  source_project_id: string | null;
  created_by_type: string;
  created_by_id: string;
  published_at: string;
  archived_at: string;
  created_at: string;
  updated_at: string;
  shared_project_ids: string[];
}

export interface ListWorkflowTemplatesResponse {
  templates: WorkflowTemplate[];
  total: number;
}

export interface CreateWorkflowTemplateRequest {
  name: string;
  description?: string | null;
  nodes: WorkflowNode[];
  workspace_official?: boolean;
}

export interface UpdateWorkflowTemplateRequest {
  name: string;
  description?: string | null;
  nodes: WorkflowNode[];
}

export interface WorkflowInstance {
  id: string;
  workspace_id: string;
  project_id: string;
  template_id: string;
  template_version: number;
  root_issue_id: string | null;
  sprint_id: string | null;
  workitem_snapshot: Record<string, unknown>;
  status: WorkflowInstanceStatus;
  started_by_type: string;
  started_by_id: string;
  triggered_at: string;
  completed_at: string;
  created_at: string;
  updated_at: string;
}

export interface ListWorkflowInstancesParams {
  scope?: "mine" | "all";
  status?: WorkflowInstanceStatus[];
  limit?: number;
}

export interface ListWorkflowInstancesResponse {
  instances: WorkflowInstance[];
  total: number;
  status_counts: Partial<Record<WorkflowInstanceStatus, number>>;
}

export interface CreateWorkflowInstanceRequest {
  template_id: string;
  issue_id?: string | null;
  workitem_snapshot?: Record<string, unknown>;
}

export interface WorkflowStageRun {
  id: string;
  instance_id: string;
  seq: number;
  node_id: string;
  name: string;
  mode: StageMode;
  agent_id: string | null;
  prompt: string | null;
  task_id: string | null;
  state: StageRunState;
  inputs: unknown;
  outputs: unknown;
  created_at: string;
  updated_at: string;
}

export interface WorkflowGateRun {
  id: string;
  instance_id: string;
  stage_run_id: string;
  round: number;
  mode: string;
  state: GateState;
  decision: GateDecision;
  generation: number;
  parent_id: string | null;
  decided_by_type: string | null;
  decided_by_id: string | null;
  created_at: string;
  decided_at: string;
}

export interface WorkflowInstanceDetailResponse {
  instance: WorkflowInstance;
  stages: WorkflowStageRun[];
  gates: WorkflowGateRun[];
}

/** POST .../decide 与 stage approve/loop-back 的统一响应形状。 */
export interface DecideGateResponse {
  gate: WorkflowGateRun;
  instance: WorkflowInstance;
}

export interface WorkflowStageTranscriptMessage {
  id: string;
  seq: number;
  type: string;
  tool: string | null;
  content: string | null;
  input: unknown;
  output: string | null;
  created_at: string;
}

export interface WorkflowStageTranscriptResponse {
  stage_run_id: string;
  task_id: string | null;
  messages: WorkflowStageTranscriptMessage[];
}

export interface WorkflowStageMessagesResponse {
  stage_run_id: string;
  messages: import("./comment").Comment[];
}

export interface WorkflowGateMessagesResponse {
  gate_run_id: string;
  messages: import("./comment").Comment[];
}

export interface WorkflowRecoverySuggestion {
  stage_run_id: string;
  name: string;
  mode: StageMode;
  state: StageRunState;
  task_id: string | null;
  task_status?: string;
  recommendation: string;
}

export interface WorkflowRecoveryDiagnosisResponse {
  instance_id: string;
  instance_status: WorkflowInstanceStatus;
  can_recover: boolean;
  suggestions: WorkflowRecoverySuggestion[];
}

/** WS workflow:instance_state 载荷（service.publishInstanceState 形状）。 */
export interface WorkflowInstanceStatePayload {
  instance_id: string;
  status: WorkflowInstanceStatus;
  source: string;
}

/** WS workflow:gate_decided 载荷（service.publishGateDecided 形状）。 */
export interface WorkflowGateDecidedPayload {
  gate_id: string;
  instance_id: string;
  stage_run_id: string;
  decision: GateDecision;
  round: number;
  generation: number;
  status: WorkflowInstanceStatus;
}
