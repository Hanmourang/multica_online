import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Query keys + options for agent runs and the issue-level archive
 * aggregates (migration 459; spec §5.5).
 *
 * Runs are issue-scoped reads (child-task runs roll up via root_issue_id);
 * todos/events are run-scoped and only fetched when a run is expanded in
 * the progress tracker / dynamics timeline.
 */
export const agentRunKeys = {
  all: (wsId: string) => ["agent-runs", wsId] as const,
  byIssue: (wsId: string, issueId: string) =>
    [...agentRunKeys.all(wsId), "issue", issueId] as const,
  todos: (wsId: string, runId: string) =>
    [...agentRunKeys.all(wsId), "run", runId, "todos"] as const,
  events: (wsId: string, runId: string) =>
    [...agentRunKeys.all(wsId), "run", runId, "events"] as const,
};

export const issueArchiveKeys = {
  all: (wsId: string) => ["issue-archive", wsId] as const,
  issue: (wsId: string, issueId: string) =>
    [...issueArchiveKeys.all(wsId), issueId] as const,
  dynamics: (wsId: string, issueId: string) =>
    [...issueArchiveKeys.issue(wsId, issueId), "dynamics"] as const,
  deliverables: (wsId: string, issueId: string) =>
    [...issueArchiveKeys.issue(wsId, issueId), "deliverables"] as const,
  progress: (wsId: string, issueId: string) =>
    [...issueArchiveKeys.issue(wsId, issueId), "progress"] as const,
};

/** Every run recorded under the requirement (incl. child-task rollups). */
export function agentRunsForIssueOptions(
  wsId: string,
  issueId: string,
) {
  return queryOptions({
    queryKey: agentRunKeys.byIssue(wsId, issueId),
    queryFn: () => api.listAgentRunsForIssue(issueId),
    enabled: Boolean(wsId && issueId),
  });
}

export function agentRunTodosOptions(wsId: string, runId: string) {
  return queryOptions({
    queryKey: agentRunKeys.todos(wsId, runId),
    queryFn: () => api.listAgentRunTodos(runId),
    enabled: Boolean(wsId && runId),
  });
}

export function agentRunEventsOptions(
  wsId: string,
  runId: string,
  limit?: number,
) {
  return queryOptions({
    queryKey: [...agentRunKeys.events(wsId, runId), limit],
    queryFn: () => api.listAgentRunEvents(runId, limit),
    enabled: Boolean(wsId && runId),
  });
}

/** f7 需求动态：comment/run 聚合脉搏 + last activity。 */
export function issueDynamicsOptions(wsId: string, issueId: string) {
  return queryOptions({
    queryKey: issueArchiveKeys.dynamics(wsId, issueId),
    queryFn: () => api.getIssueDynamics(issueId),
    enabled: Boolean(wsId && issueId),
  });
}

/** f8 交付概览：scope/stage artifact 聚合 + todo 完成度。 */
export function issueDeliverablesOptions(wsId: string, issueId: string) {
  return queryOptions({
    queryKey: issueArchiveKeys.deliverables(wsId, issueId),
    queryFn: () => api.getIssueDeliverablesOverview(issueId),
    enabled: Boolean(wsId && issueId),
  });
}

/** f9 进度追踪：需求→任务→运行三层 rollup（骨架范围）。 */
export function issueProgressOptions(wsId: string, issueId: string) {
  return queryOptions({
    queryKey: issueArchiveKeys.progress(wsId, issueId),
    queryFn: () => api.getIssueProgress(issueId),
    enabled: Boolean(wsId && issueId),
  });
}
