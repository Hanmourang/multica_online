import { queryOptions } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import type {
  GetArtifactContentResponse,
  ListArtifactsParams,
  ListProjectArtifactsResponse,
  ProjectArtifact,
} from "../types";

/**
 * Query keys + options for the project archive artifact store (migration 455).
 *
 * Keys nest under the workspace id so a workspace switch can never serve a
 * stale artifact list, then under the project id — artifacts are
 * project-scoped rows in the archive resource.
 */
export const artifactKeys = {
  all: (wsId: string) => ["project-artifacts", wsId] as const,
  project: (wsId: string, projectId: string) =>
    [...artifactKeys.all(wsId), projectId] as const,
  list: (wsId: string, projectId: string, filters?: ListArtifactsParams) =>
    [...artifactKeys.project(wsId, projectId), "list", filters ?? {}] as const,
  diagnostics: (wsId: string, projectId: string) =>
    [...artifactKeys.project(wsId, projectId), "diagnostics"] as const,
  detail: (wsId: string, projectId: string, artifactId: string) =>
    [...artifactKeys.project(wsId, projectId), "detail", artifactId] as const,
  content: (wsId: string, projectId: string, artifactId: string) =>
    [
      ...artifactKeys.project(wsId, projectId),
      "content",
      artifactId,
    ] as const,
  matrix: (wsId: string, projectId: string) =>
    [...artifactKeys.project(wsId, projectId), "matrix"] as const,
  syncConfig: (wsId: string, projectId: string) =>
    [...artifactKeys.project(wsId, projectId), "sync-config"] as const,
};

/** Filters are part of the request URL, so they belong in the key. */
function artifactListQuery(
  wsId: string,
  projectId: string,
  filters?: ListArtifactsParams,
) {
  return queryOptions({
    queryKey: artifactKeys.list(wsId, projectId, filters),
    queryFn: () => api.listProjectArtifacts(projectId, filters),
    enabled: Boolean(wsId && projectId),
  });
}

/** Artifacts only, for consumers that just need the rows. */
export function projectArtifactsOptions(
  wsId: string,
  projectId: string,
  filters?: ListArtifactsParams,
) {
  return queryOptions({
    queryKey: artifactKeys.list(wsId, projectId, filters),
    queryFn: () => api.listProjectArtifacts(projectId, filters),
    enabled: Boolean(wsId && projectId),
    select: (data: ListProjectArtifactsResponse) => data.artifacts,
  });
}

/** The full list with counts, for the sync console and matrix view. */
export function projectArtifactListOptions(
  wsId: string,
  projectId: string,
  filters?: ListArtifactsParams,
) {
  return artifactListQuery(wsId, projectId, filters);
}

export function projectArtifactDetailOptions(
  wsId: string,
  projectId: string,
  artifactId: string,
) {
  return queryOptions({
    queryKey: artifactKeys.detail(wsId, projectId, artifactId),
    queryFn: () => api.getProjectArtifact(projectId, artifactId),
    enabled: Boolean(projectId && artifactId),
  });
}

/**
 * Artifact content preview. The server returns `content_unavailable: true`
 * when no rendered snapshot attachment exists — that is a *structured*
 * answer, not an error, so the query resolves and the UI decides how to
 * degrade (show rel_path + git pointer instead of a body).
 */
export function projectArtifactContentOptions(
  wsId: string,
  projectId: string,
  artifactId: string,
) {
  return queryOptions({
    queryKey: artifactKeys.content(wsId, projectId, artifactId),
    queryFn: (): Promise<GetArtifactContentResponse | null> =>
      api
        .getProjectArtifactContent(projectId, artifactId)
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) return null;
          throw err;
        }),
    enabled: Boolean(projectId && artifactId),
  });
}

/** issue × stage aggregate counts (GET /artifacts/matrix). */
export function projectArtifactMatrixOptions(
  wsId: string,
  projectId: string,
) {
  return queryOptions({
    queryKey: artifactKeys.matrix(wsId, projectId),
    queryFn: () => api.getProjectArtifactMatrix(projectId),
    enabled: Boolean(wsId && projectId),
  });
}

/**
 * The sync console's "unbound queue": requirement-scope artifacts whose
 * issue binding is still null. Derived from the unfiltered list — the API
 * contract has no dedicated unbound/bind endpoint yet, so this selects from
 * the same cache entry the browser list uses.
 */
export function archiveSyncDiagnosticsOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: artifactKeys.diagnostics(wsId, projectId),
    queryFn: () =>
      api.listArchiveSyncDiagnostics(projectId, {
        limit: 50,
      }),
    enabled: Boolean(wsId && projectId),
    select: (data) => data.diagnostics ?? [],
  });
}

export function archiveSyncConfigOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: artifactKeys.syncConfig(wsId, projectId),
    queryFn: () => api.getArchiveSyncConfig(projectId),
    enabled: Boolean(wsId && projectId),
  });
}

export function unboundArtifactsOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: artifactKeys.list(wsId, projectId),
    queryFn: () => api.listProjectArtifacts(projectId),
    enabled: Boolean(wsId && projectId),
    select: (data: ListProjectArtifactsResponse) =>
      data.artifacts.filter(
        (a: ProjectArtifact) => a.scope === "requirement" && !a.issue_id,
      ),
  });
}
