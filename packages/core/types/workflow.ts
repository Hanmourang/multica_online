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
  | "skipped"
  // 资产准入未过（缺必备输入 / 上游产物未就绪）：禁止进入 running，等补齐后由编排器重新派发。
  | "blocked";

export type GateState = "pending" | "running" | "waiting" | "decided" | "cancelled";

export type GateDecision = "" | "loop" | "exit";

/**
 * 阶段 spec（plan 20261025 §B1）：authoring 的目标/判定/输入输出模板经 Flatten
 * 编译后的快照形状，与 Go service.StageSpec 同形；gate 节点只带 loopLabel/exitLabel。
 */
export interface StageSpec {
  goal?: string;
  criteria?: string;
  inputTpl?: string;
  outputTpl?: string;
  loopLabel?: string;
  exitLabel?: string;
}

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
  spec?: StageSpec;
}

/**
 * CoCo 嵌套 authoring schema（workflow_template.definition JSONB）。
 * 与 Go service.WorkflowDefinition / DefinitionNode 同形；运行时引擎只消费
 * 展平后的 nodes，definition 仅供编辑器/导入/流程图读取。
 */
export interface WorkflowDefinition {
  schemaVersion: number;
  kind: string;
  name: string;
  description: string;
  nodes: DefinitionNode[];
  roleNames?: Record<string, string>;
}

export type DefinitionNodeKind = "stage" | "iteration" | "parallel" | "branch";
export type DefinitionNodeMode = "auto" | "human_loop";

export interface DefinitionNode {
  kind: DefinitionNodeKind;
  id: string;
  name: string;
  mode?: DefinitionNodeMode;
  roleId?: string;
  prompt?: string;
  children?: DefinitionNode[];
  gate?: DefinitionGate | null;
  inputs?: DefinitionInput[];
  outputs?: DefinitionOutput[];
  // 阶段目标管理（plan 101 C4）：goal=本阶段要达成什么，criteria=达成判定口径。
  goal?: string;
  criteria?: string;
  // 阶段输入/输出模板（plan 101 C3）：带占位符的正文骨架，执行时按上游产物渲染。
  inputTpl?: string;
  outputTpl?: string;
}

export interface DefinitionGate {
  id: string;
  mode?: DefinitionNodeMode;
  loopLabel?: string;
  exitLabel?: string;
}

export interface DefinitionInput {
  fromStageId?: string;
  outputId?: string;
  outputName?: string;
  // 资产准入（plan 101 C5）：in=外部/上游必备输入，out=本阶段自产。
  assetRole?: "in" | "out";
  // required=true 的执行前必检项——映射到引擎 WorkflowNode.gate_doc_types。
  required?: boolean;
}

export interface DefinitionOutput {
  id: string;
  name: string;
  type?: string;
  description?: string;
}

/** 画廊卡片的阶段 chip（server 从扁平 nodes 派生）。 */
export interface StageFlowItem {
  id: string;
  name: string;
  mode: StageMode;
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
  definition: WorkflowDefinition | Record<string, never>;
  enforce: boolean;
  official: boolean;
  source_project_id: string | null;
  created_by_type: string;
  created_by_id: string;
  published_at: string;
  archived_at: string;
  created_at: string;
  updated_at: string;
  shared_project_ids: string[];
  stage_flow: StageFlowItem[];
}

export interface ListWorkflowTemplatesResponse {
  templates: WorkflowTemplate[];
  total: number;
}

/** 工作区级画廊响应（GET /api/workflow/templates）。 */
export interface ListWorkspaceWorkflowTemplatesResponse {
  templates: WorkflowTemplate[];
  total: number;
  status_counts: Record<"all" | "published" | "draft" | "archived", number>;
}

export interface ListWorkspaceWorkflowTemplatesParams {
  status?: WorkflowTemplateStatus | "all";
  scope?: "mine";
  project_id?: string;
}

export interface CreateWorkflowTemplateRequest {
  name: string;
  description?: string | null;
  nodes: WorkflowNode[];
  definition?: WorkflowDefinition;
  workspace_official?: boolean;
  enforce?: boolean;
}

export interface UpdateWorkflowTemplateRequest {
  name: string;
  description?: string | null;
  nodes: WorkflowNode[];
}

/** 编辑器 JSON 保存（PUT /api/workflow/templates/{tid}/definition）。 */
export interface UpdateWorkflowTemplateDefinitionRequest {
  definition: WorkflowDefinition;
  name?: string;
  description?: string | null;
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
  // 创建实例时从模板 definition 编译的快照（§B1）；旧实例为 null。
  spec?: StageSpec | null;
  // 仅 blocked 阶段附带：当前仍缺失的必检资产名（§A1.4）。
  admission_missing?: string[];
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

/** POST /api/workflow/templates/{tid}/dry-run 请求体（§C7，零副作用渲染预览）。 */
export interface WorkflowTemplateDryRunRequest {
  node_id?: string;
  workitem?: Record<string, string>;
}

export interface WorkflowTemplateDryRunResponse {
  node_id: string;
  node_name: string;
  mode: StageMode;
  agent_ref?: string;
  prompt: string;
  warnings: string[];
  spec?: StageSpec | null;
  node_count: number;
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
