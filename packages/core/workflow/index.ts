/**
 * Public surface for @multica/core/workflow（CoCo 对标 plan 20261024 §01 F2）。
 *
 * 服务端状态唯一所有权在 React Query（queries/mutations），WS 事件只经
 * ws-updaters patch/invalidate 缓存 —— 本模块不导出任何 Zustand store。
 */
export {
  workflowKeys,
  workflowTemplatesOptions,
  workspaceTemplatesOptions,
  workflowInstancesOptions,
  workflowInstanceDetailOptions,
  workflowRecoveryDiagnosisOptions,
  workflowStageTranscriptOptions,
  workflowStageMessagesOptions,
  workflowGateMessagesOptions,
} from "./queries";
export {
  useCreateWorkflowTemplate,
  useUpdateWorkflowTemplate,
  usePublishWorkflowTemplate,
  useArchiveWorkflowTemplate,
  useDuplicateWorkflowTemplate,
  useShareWorkflowTemplate,
  useUpdateWorkflowTemplateDefinition,
  useSetWorkflowTemplateEnforce,
  useCreateWorkflowInstance,
  useWorkflowInstanceAction,
  useWorkflowStageAction,
  useDecideWorkflowGate,
  usePostWorkflowGateMessage,
  useDryRunWorkflowTemplate,
  workflowTemplateAfterWrite,
} from "./mutations";
export type { StageAction } from "./mutations";
export {
  onWorkflowInstanceState,
  onWorkflowGateDecided,
  onWorkflowTemplateChanged,
  workflowActiveRefetchInterval,
} from "./ws-updaters";
