import { queryOptions } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import type { GraphSnapshotSummary } from "../types";

/**
 * Query keys + options for the project graph snapshot store (migration 456)
 * and the ontology / bus-matrix reads layered on top of it (§5.2/§5.3).
 *
 * Every snapshot-scoped read nests under the snapshot key prefix so a sync
 * (useSyncGraphSnapshot) invalidates them all with one key.
 */
export const graphKeys = {
  all: (wsId: string) => ["project-graph", wsId] as const,
  project: (wsId: string, projectId: string) =>
    [...graphKeys.all(wsId), projectId] as const,
  latest: (wsId: string, projectId: string) =>
    [...graphKeys.project(wsId, projectId), "latest"] as const,
  detail: (wsId: string, projectId: string) =>
    [...graphKeys.project(wsId, projectId), "detail"] as const,
  modules: (wsId: string, projectId: string) =>
    [...graphKeys.project(wsId, projectId), "modules"] as const,
  module: (
    wsId: string,
    projectId: string,
    nodeId: string,
    view: "changes" | "objects" | "strategies" | "neighborhood",
  ) =>
    [...graphKeys.project(wsId, projectId), "module", nodeId, view] as const,
  busMatrix: (wsId: string, projectId: string) =>
    [...graphKeys.project(wsId, projectId), "bus-matrix"] as const,
  busMatrixDrilldown: (
    wsId: string,
    projectId: string,
    filters: { module_node_id?: string; page_key?: string; domain?: string },
  ) =>
    [...graphKeys.busMatrix(wsId, projectId), "drilldown", filters] as const,
  busMatrixAlerts: (wsId: string, projectId: string) =>
    [...graphKeys.busMatrix(wsId, projectId), "alerts"] as const,
  busMatrixTimeline: (wsId: string, projectId: string) =>
    [...graphKeys.busMatrix(wsId, projectId), "timeline"] as const,
};

/**
 * Latest snapshot summary (no nodes/edges payload). A project that has
 * never been scanned legitimately has no snapshot — the server answers
 * 404, which this query normalizes to null so the UI can render the
 * "run a sync first" empty state instead of an error.
 */
export function latestGraphSnapshotOptions(
  wsId: string,
  projectId: string,
) {
  return queryOptions({
    queryKey: graphKeys.latest(wsId, projectId),
    queryFn: (): Promise<GraphSnapshotSummary | null> =>
      api.getLatestGraphSnapshot(projectId).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
    enabled: Boolean(wsId && projectId),
  });
}

/** Full snapshot detail (nodes/edges/communities), for the neighborhood fallback. */
export function graphSnapshotDetailOptions(
  wsId: string,
  projectId: string,
) {
  return queryOptions({
    queryKey: graphKeys.detail(wsId, projectId),
    queryFn: () => api.getGraphSnapshotDetail(projectId),
    enabled: Boolean(wsId && projectId),
  });
}

/** Module bridge list (project_module × graph_node_id × issue counts). */
export function graphModulesOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: graphKeys.modules(wsId, projectId),
    queryFn: () => api.listGraphModules(projectId),
    enabled: Boolean(wsId && projectId),
  });
}

export function moduleChangesOptions(
  wsId: string,
  projectId: string,
  nodeId: string,
) {
  return queryOptions({
    queryKey: graphKeys.module(wsId, projectId, nodeId, "changes"),
    queryFn: () => api.getModuleChanges(projectId, nodeId),
    enabled: Boolean(wsId && projectId && nodeId),
  });
}

export function moduleObjectsOptions(
  wsId: string,
  projectId: string,
  nodeId: string,
) {
  return queryOptions({
    queryKey: graphKeys.module(wsId, projectId, nodeId, "objects"),
    queryFn: () => api.getModuleObjects(projectId, nodeId),
    enabled: Boolean(wsId && projectId && nodeId),
  });
}

export function moduleStrategiesOptions(
  wsId: string,
  projectId: string,
  nodeId: string,
) {
  return queryOptions({
    queryKey: graphKeys.module(wsId, projectId, nodeId, "strategies"),
    queryFn: () => api.getModuleStrategies(projectId, nodeId),
    enabled: Boolean(wsId && projectId && nodeId),
  });
}

export function moduleNeighborhoodOptions(
  wsId: string,
  projectId: string,
  nodeId: string,
) {
  return queryOptions({
    queryKey: graphKeys.module(wsId, projectId, nodeId, "neighborhood"),
    queryFn: () => api.getModuleNeighborhood(projectId, nodeId),
    enabled: Boolean(wsId && projectId && nodeId),
  });
}

/** Module × page → table read/write matrix from the latest snapshot. */
export function busMatrixOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: graphKeys.busMatrix(wsId, projectId),
    queryFn: () => api.getBusMatrix(projectId),
    enabled: Boolean(wsId && projectId),
  });
}

export function busMatrixDrilldownOptions(
  wsId: string,
  projectId: string,
  filters: { module_node_id?: string; page_key?: string; domain?: string },
) {
  return queryOptions({
    queryKey: graphKeys.busMatrixDrilldown(wsId, projectId, filters),
    queryFn: () => api.getBusMatrixDrilldown(projectId, filters),
    enabled:
      Boolean(wsId && projectId) &&
      Boolean(filters.module_node_id || filters.page_key || filters.domain),
  });
}

export function busMatrixAlertsOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: graphKeys.busMatrixAlerts(wsId, projectId),
    queryFn: () => api.getBusMatrixAlerts(projectId),
    enabled: Boolean(wsId && projectId),
  });
}

export function busMatrixTimelineOptions(
  wsId: string,
  projectId: string,
  limit?: number,
) {
  return queryOptions({
    queryKey: [...graphKeys.busMatrixTimeline(wsId, projectId), limit],
    queryFn: () => api.getBusMatrixTimeline(projectId, limit),
    enabled: Boolean(wsId && projectId),
  });
}
