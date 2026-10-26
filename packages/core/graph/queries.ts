import { queryOptions } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import type {
  BusMatrixAlertsResponse,
  BusMatrixDrilldownResponse,
  BusMatrixResponse,
  BusMatrixTimelineResponse,
  GraphSnapshotSummary,
  Issue,
  ProjectGraphSnapshot,
} from "../types";

/**
 * "还没有图谱快照" is an honest empty state, not a request failure: the
 * server answers 404 (code=graph_snapshot_missing, message fallback kept for
 * older builds) until the CLI projector pushes its first scan. Every
 * snapshot-scoped read below normalizes that 404 to its empty payload so the
 * views land on their ArchiveEmpty frames instead of the red QueryError row —
 * same contract latestGraphSnapshotOptions already honors with `null`.
 */
function isNoSnapshotError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 404 &&
    ((err.body as { code?: unknown } | undefined)?.code ===
      "graph_snapshot_missing" ||
      err.message.includes("no graph snapshot"))
  );
}

function noSnapshotFallback<T>(empty: T): (err: unknown) => T {
  return (err: unknown) => {
    if (isNoSnapshotError(err)) return empty;
    throw err;
  };
}

const EMPTY_SNAPSHOT_DETAIL: ProjectGraphSnapshot = {
  id: "",
  workspace_id: "",
  project_id: "",
  resource_id: "",
  scan_id: "",
  gitnexus_version: "",
  git_sha: "",
  nodes: [],
  edges: [],
  communities: [],
  stats: { node_count: 0, edge_count: 0, community_count: 0 },
  created_at: "",
};

const EMPTY_BUS_MATRIX: BusMatrixResponse = {
  snapshot_id: "",
  scan_id: "",
  git_sha: "",
  bus_matrix: [],
  total: 0,
};

const EMPTY_BUS_DRILLDOWN: BusMatrixDrilldownResponse = {
  cells: [],
  total: 0,
  tables: [],
  detail_available: false,
  columns_available: false,
  tables_truncated: false,
};

const EMPTY_BUS_ALERTS: BusMatrixAlertsResponse = {
  alerts: [],
  total: 0,
  rule_coverage: [],
};

const EMPTY_BUS_TIMELINE: BusMatrixTimelineResponse = {
  snapshot_id: "",
  changes: [],
  total: 0,
};

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
  projectIssues: (wsId: string, projectId: string) =>
    [...graphKeys.project(wsId, projectId), "issues"] as const,
};

const PROJECT_ISSUE_PAGE = 500;
const PROJECT_ISSUE_MAX = 10_000;

/** 功能模块 TAB 聚合用：项目下全部 issue（含任务子项），不限日历/甘特窗口。 */
async function fetchProjectIssuesForModules(projectId: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  let offset = 0;
  while (offset < PROJECT_ISSUE_MAX) {
    const res = await api.listIssues({
      project_id: projectId,
      limit: PROJECT_ISSUE_PAGE,
      offset,
    });
    issues.push(...res.issues);
    if (res.issues.length < PROJECT_ISSUE_PAGE) break;
    if (issues.length >= res.total) break;
    offset += PROJECT_ISSUE_PAGE;
  }
  return issues;
}

export function projectIssuesForModulesOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: graphKeys.projectIssues(wsId, projectId),
    queryFn: () => fetchProjectIssuesForModules(projectId),
    enabled: Boolean(wsId && projectId),
  });
}

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

/** Full snapshot detail (nodes/edges/communities), for the neighborhood
 * fallback. No snapshot → empty detail (see isNoSnapshotError). */
export function graphSnapshotDetailOptions(
  wsId: string,
  projectId: string,
) {
  return queryOptions({
    queryKey: graphKeys.detail(wsId, projectId),
    queryFn: () =>
      api
        .getGraphSnapshotDetail(projectId)
        .catch(noSnapshotFallback(EMPTY_SNAPSHOT_DETAIL)),
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
    queryFn: () => api.getModuleNeighborhood(projectId, nodeId, { depth: 2 }),
    enabled: Boolean(wsId && projectId && nodeId),
  });
}

/** Module × page → table read/write matrix from the latest snapshot. */
export function busMatrixOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: graphKeys.busMatrix(wsId, projectId),
    queryFn: () =>
      api.getBusMatrix(projectId).catch(noSnapshotFallback(EMPTY_BUS_MATRIX)),
    enabled: Boolean(wsId && projectId),
  });
}

export function busMatrixDrilldownOptions(
  wsId: string,
  projectId: string,
  filters: { module_node_id?: string; page_key?: string; process_key?: string; domain?: string },
) {
  return queryOptions({
    queryKey: graphKeys.busMatrixDrilldown(wsId, projectId, filters),
    queryFn: () =>
      api
        .getBusMatrixDrilldown(projectId, filters)
        .catch(noSnapshotFallback(EMPTY_BUS_DRILLDOWN)),
    enabled: Boolean(wsId && projectId),
  });
}

export function busMatrixAlertsOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: graphKeys.busMatrixAlerts(wsId, projectId),
    queryFn: () =>
      api
        .getBusMatrixAlerts(projectId)
        .catch(noSnapshotFallback(EMPTY_BUS_ALERTS)),
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
    queryFn: () =>
      api
        .getBusMatrixTimeline(projectId, limit)
        .catch(noSnapshotFallback(EMPTY_BUS_TIMELINE)),
    enabled: Boolean(wsId && projectId),
  });
}
