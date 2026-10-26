import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { issueKeys } from "../issues/queries";
import { sprintKeys } from "./queries";
import type { CreateSprintRequest, UpdateSprintRequest } from "../types";

/**
 * Sprint mutations (plan 20261024 §02). Every write settles into the same
 * project-scoped cache slice: the sprint list carries issue_count (a LEFT
 * JOIN over issue.sprint_id), so membership changes must refresh the list
 * too, plus the issue caches that embed sprint_id on their rows.
 *
 * State-machine transitions (start/complete/reopen) are CAS server-side:
 * a 409 means someone else moved the sprint first — the invalidate makes
 * the UI converge on the winner's state.
 */

/** 列表 + 派生进度一起失效（issue_count / done 计数都随成员变化）。 */
function invalidateSprintSlice(
  qc: ReturnType<typeof useQueryClient>,
  wsId: string,
  projectId: string,
) {
  qc.invalidateQueries({ queryKey: sprintKeys.project(wsId, projectId) });
  // issue 行内嵌 sprint_id（列表/看板/日历渲染归属徽标）。
  qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
}

export function useCreateSprint(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateSprintRequest) =>
      api.createProjectSprint(projectId, data),
    onSettled: () => invalidateSprintSlice(qc, wsId, projectId),
  });
}

export function useUpdateSprint(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      sprintId,
      ...data
    }: UpdateSprintRequest & { sprintId: string }) =>
      api.updateProjectSprint(projectId, sprintId, data),
    onSettled: () => invalidateSprintSlice(qc, wsId, projectId),
  });
}

export function useDeleteSprint(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (sprintId: string) =>
      api.deleteProjectSprint(projectId, sprintId),
    onSettled: () => invalidateSprintSlice(qc, wsId, projectId),
  });
}

/** planned→active。409 sprint_not_planned = 并发/非法迁移。 */
export function useStartSprint(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (sprintId: string) =>
      api.startProjectSprint(projectId, sprintId),
    onSettled: () => invalidateSprintSlice(qc, wsId, projectId),
  });
}

/** active→completed（归档时间盒）。409 sprint_not_active。 */
export function useCompleteSprint(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (sprintId: string) =>
      api.completeProjectSprint(projectId, sprintId),
    onSettled: () => invalidateSprintSlice(qc, wsId, projectId),
  });
}

/** completed→active（重开）。409 sprint_not_completed。 */
export function useReopenSprint(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (sprintId: string) =>
      api.reopenProjectSprint(projectId, sprintId),
    onSettled: () => invalidateSprintSlice(qc, wsId, projectId),
  });
}

/** 批量纳入：任一批内 issue 跨租户 → 整单 404，无部分生效。 */
export function useAssignSprintIssues(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      sprintId,
      issueIds,
    }: {
      sprintId: string;
      issueIds: string[];
    }) => api.assignSprintIssues(projectId, sprintId, issueIds),
    onSettled: () => invalidateSprintSlice(qc, wsId, projectId),
  });
}

/** 批量移出（回落 backlog）：任意状态可用，含 completed 的纠错性移出。 */
export function useRemoveSprintIssues(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      sprintId,
      issueIds,
    }: {
      sprintId: string;
      issueIds: string[];
    }) => api.removeSprintIssues(projectId, sprintId, issueIds),
    onSettled: () => invalidateSprintSlice(qc, wsId, projectId),
  });
}
