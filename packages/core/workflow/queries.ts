import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type {
  ListWorkflowInstancesParams,
  ListWorkflowInstancesResponse,
  WorkflowGateMessagesResponse,
  WorkflowInstanceDetailResponse,
  WorkflowRecoveryDiagnosisResponse,
  WorkflowStageMessagesResponse,
  WorkflowStageTranscriptResponse,
} from "../types";

/**
 * Query keys + options for the workflow module (plan 20261024 §01 F2).
 *
 * Keys nest under the workspace id (a workspace switch must never serve a
 * stale instance list), then project-scoped templates/instances, then
 * root-scoped instance detail / stage / gate reads. Filters serialize into
 * the key — the list key IS the request URL contract.
 */
export const workflowKeys = {
  all: (wsId: string) => ["workflow", wsId] as const,
  project: (wsId: string, projectId: string) =>
    [...workflowKeys.all(wsId), projectId] as const,
  templates: (wsId: string, projectId: string) =>
    [...workflowKeys.project(wsId, projectId), "templates"] as const,
  instances: (
    wsId: string,
    projectId: string,
    filters?: ListWorkflowInstancesParams,
  ) =>
    [...workflowKeys.project(wsId, projectId), "instances", filters ?? {}] as const,
  instance: (wsId: string, instanceId: string) =>
    [...workflowKeys.all(wsId), "instance", instanceId] as const,
  // 需求抽屉反查切片（计划 §G，对标 CoCo instancesByWorkitem）。
  instancesByIssue: (wsId: string, issueId: string) =>
    [...workflowKeys.all(wsId), "issue", issueId, "instances"] as const,
  recoveryDiagnosis: (wsId: string, instanceId: string) =>
    [...workflowKeys.all(wsId), "instance", instanceId, "recovery-diagnosis"] as const,
  stageTranscript: (wsId: string, stageRunId: string) =>
    [...workflowKeys.all(wsId), "stage", stageRunId, "transcript"] as const,
  stageMessages: (wsId: string, stageRunId: string) =>
    [...workflowKeys.all(wsId), "stage", stageRunId, "messages"] as const,
  gateMessages: (wsId: string, gateRunId: string) =>
    [...workflowKeys.all(wsId), "gate", gateRunId, "messages"] as const,
};

export function workflowTemplatesOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: workflowKeys.templates(wsId, projectId),
    queryFn: () => api.listWorkflowTemplates(projectId),
    enabled: Boolean(wsId && projectId),
  });
}

export function workflowInstancesOptions(
  wsId: string,
  projectId: string,
  filters?: ListWorkflowInstancesParams,
) {
  return queryOptions({
    queryKey: workflowKeys.instances(wsId, projectId, filters),
    queryFn: () => api.listWorkflowInstances(projectId, filters),
    enabled: Boolean(wsId && projectId),
  });
}

export function issueWorkflowInstancesOptions(wsId: string, issueId: string) {
  return queryOptions<ListWorkflowInstancesResponse>({
    queryKey: workflowKeys.instancesByIssue(wsId, issueId),
    queryFn: () => api.listIssueWorkflowInstances(issueId),
    enabled: Boolean(wsId && issueId),
  });
}

export function workflowInstanceDetailOptions(wsId: string, instanceId: string) {
  return queryOptions<WorkflowInstanceDetailResponse>({
    queryKey: workflowKeys.instance(wsId, instanceId),
    queryFn: () => api.getWorkflowInstance(instanceId),
    enabled: Boolean(wsId && instanceId),
  });
}

export function workflowRecoveryDiagnosisOptions(
  wsId: string,
  instanceId: string,
) {
  return queryOptions<WorkflowRecoveryDiagnosisResponse>({
    queryKey: workflowKeys.recoveryDiagnosis(wsId, instanceId),
    queryFn: () => api.getWorkflowRecoveryDiagnosis(instanceId),
    enabled: Boolean(wsId && instanceId),
  });
}

export function workflowStageTranscriptOptions(wsId: string, stageRunId: string) {
  return queryOptions<WorkflowStageTranscriptResponse>({
    queryKey: workflowKeys.stageTranscript(wsId, stageRunId),
    queryFn: () => api.getWorkflowStageTranscript(stageRunId),
    enabled: Boolean(wsId && stageRunId),
  });
}

export function workflowStageMessagesOptions(wsId: string, stageRunId: string) {
  return queryOptions<WorkflowStageMessagesResponse>({
    queryKey: workflowKeys.stageMessages(wsId, stageRunId),
    queryFn: () => api.getWorkflowStageMessages(stageRunId),
    enabled: Boolean(wsId && stageRunId),
  });
}

export function workflowGateMessagesOptions(wsId: string, gateRunId: string) {
  return queryOptions<WorkflowGateMessagesResponse>({
    queryKey: workflowKeys.gateMessages(wsId, gateRunId),
    queryFn: () => api.listWorkflowGateMessages(gateRunId),
    enabled: Boolean(wsId && gateRunId),
  });
}
