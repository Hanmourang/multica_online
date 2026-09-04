import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Query keys + options for project modules and issue dependency edges.
 *
 * Modules are project-scoped, so the key nests under the project id; the
 * workspace id stays in the prefix so a workspace switch can't leak a stale
 * project list across workspaces.
 */
export const moduleKeys = {
  all: (wsId: string) => ["project-modules", wsId] as const,
  byProject: (wsId: string, projectId: string) =>
    [...moduleKeys.all(wsId), "project", projectId] as const,
};

export const dependencyKeys = {
  all: (wsId: string) => ["issue-dependencies", wsId] as const,
  byIssue: (wsId: string, issueId: string) =>
    [...dependencyKeys.all(wsId), "issue", issueId] as const,
};

export function projectModulesOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: moduleKeys.byProject(wsId, projectId),
    queryFn: () => api.listProjectModules(projectId),
    enabled: Boolean(projectId),
  });
}

export function issueDependenciesOptions(wsId: string, issueId: string) {
  return queryOptions({
    queryKey: dependencyKeys.byIssue(wsId, issueId),
    queryFn: () => api.getIssueDependencies(issueId),
    enabled: Boolean(issueId),
  });
}
