import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { ListSprintsResponse, Sprint, SprintProgress } from "../types";

/**
 * Query keys + options for the Sprint iteration module (migration 470,
 * plan 20261024 §02). Keys nest under the workspace id so a workspace switch
 * can never serve a stale sprint list, then under the project id — sprints are
 * project-scoped rows. Sprint membership lists reuse /api/issues?sprint_id
 * (issueKeys), so nothing here duplicates the issue cache.
 */
export const sprintKeys = {
  all: (wsId: string) => ["sprints", wsId] as const,
  project: (wsId: string, projectId: string) =>
    [...sprintKeys.all(wsId), projectId] as const,
  list: (wsId: string, projectId: string, status?: string) =>
    [...sprintKeys.project(wsId, projectId), "list", status ?? "all"] as const,
  detail: (wsId: string, projectId: string, sprintId: string) =>
    [...sprintKeys.project(wsId, projectId), "detail", sprintId] as const,
  progress: (wsId: string, projectId: string, sprintId: string) =>
    [...sprintKeys.project(wsId, projectId), "progress", sprintId] as const,
};

/** 项目迭代列表（可选状态过滤）。IssueCount 由后端 LEFT JOIN 聚合直出。 */
export function projectSprintsOptions(wsId: string, projectId: string, status?: string) {
  return queryOptions({
    queryKey: sprintKeys.list(wsId, projectId, status),
    queryFn: (): Promise<ListSprintsResponse> =>
      api.listProjectSprints(projectId, status),
    enabled: Boolean(wsId && projectId),
  });
}

export function sprintListSelect(data: ListSprintsResponse): Sprint[] {
  return data.sprints;
}

/** 单迭代详情（PATCH 后由 WS/后端响应回填时使用）。 */
export function sprintDetailOptions(
  wsId: string,
  projectId: string,
  sprintId: string,
) {
  return queryOptions({
    queryKey: sprintKeys.detail(wsId, projectId, sprintId),
    queryFn: () => api.getProjectSprint(projectId, sprintId),
    enabled: Boolean(projectId && sprintId),
  });
}

/** 燃尽/完成度派生聚合（GET /progress，不落列）。 */
export function sprintProgressOptions(
  wsId: string,
  projectId: string,
  sprintId: string,
) {
  return queryOptions({
    queryKey: sprintKeys.progress(wsId, projectId, sprintId),
    queryFn: (): Promise<SprintProgress> =>
      api.getSprintProgress(projectId, sprintId),
    enabled: Boolean(projectId && sprintId),
  });
}
