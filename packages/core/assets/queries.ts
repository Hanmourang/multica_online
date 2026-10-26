import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type {
  AssetPage,
  AssetBinding,
  WorkspaceAssetPage,
  WorkspaceAssetBinding,
  ListAssetsParams,
  SearchAssetCandidatesParams,
  AssetCandidatesResponse,
  AssetOverviewResponse,
} from "../types";

/**
 * Query keys + options for the asset binding layer (migration 471).
 *
 * Keys nest under the workspace id so a workspace switch can never serve a
 * stale asset list, then under the project id (or the issue id for the
 * work-item scope). Filters ride the request URL, so they belong in the key.
 */
export const assetKeys = {
  all: (wsId: string) => ["assets", wsId] as const,
  project: (wsId: string, projectId: string) =>
    [...assetKeys.all(wsId), projectId] as const,
  list: (wsId: string, projectId: string, filters?: ListAssetsParams) =>
    [...assetKeys.project(wsId, projectId), "list", filters ?? {}] as const,
  candidates: (
    wsId: string,
    projectId: string,
    params?: SearchAssetCandidatesParams,
  ) =>
    [...assetKeys.project(wsId, projectId), "candidates", params ?? {}] as const,
  issue: (wsId: string, issueId: string) =>
    [...assetKeys.all(wsId), "issue", issueId] as const,
  issueList: (wsId: string, issueId: string, filters?: ListAssetsParams) =>
    [...assetKeys.issue(wsId, issueId), "list", filters ?? {}] as const,
  // Workspace-wide aggregate (left-sidebar "Assets" module). Nested under
  // `all(wsId)` so an `asset:*` WS event (which invalidates `all`) refreshes it.
  workspace: (wsId: string) => [...assetKeys.all(wsId), "workspace"] as const,
  workspaceList: (wsId: string, filters?: Omit<ListAssetsParams, "issueId">) =>
    [...assetKeys.workspace(wsId), "list", filters ?? {}] as const,
  // 阶段矩阵 / 需求×资产聚合面（473）；projectId 空串 = 全域。
  overview: (wsId: string, projectId?: string) =>
    [...assetKeys.all(wsId), "overview", projectId ?? ""] as const,
};

const EMPTY_PAGE: AssetPage = {
  items: [],
  page: 1,
  pageSize: 20,
  totalCount: 0,
  totalPages: 0,
};

/**
 * Defensive normalization: the server always returns the full envelope, but a
 * partial / older response shape (or a degraded 200) must never crash the
 * table. Coerce every field to its safe default instead of trusting the wire.
 */
export function normalizeAssetPage(raw: unknown): AssetPage {
  if (!raw || typeof raw !== "object") return EMPTY_PAGE;
  const r = raw as Partial<AssetPage>;
  const items = Array.isArray(r.items) ? (r.items as AssetBinding[]) : [];
  const pageSize = typeof r.pageSize === "number" && r.pageSize > 0 ? r.pageSize : 20;
  const totalCount = typeof r.totalCount === "number" && r.totalCount >= 0 ? r.totalCount : items.length;
  const page = typeof r.page === "number" && r.page > 0 ? r.page : 1;
  const totalPages =
    typeof r.totalPages === "number" && r.totalPages >= 0
      ? r.totalPages
      : Math.ceil(totalCount / pageSize);
  return { items, page, pageSize, totalCount, totalPages };
}

/** Project-scope paged asset list. */
export function projectAssetsOptions(
  wsId: string,
  projectId: string,
  filters?: ListAssetsParams,
) {
  return queryOptions({
    queryKey: assetKeys.list(wsId, projectId, filters),
    queryFn: () =>
      api
        .listProjectAssets(projectId, filters)
        .then(normalizeAssetPage)
        .catch(() => EMPTY_PAGE),
    enabled: Boolean(wsId && projectId),
  });
}

/** Search candidates with intelligent recommendation (CoCo ECe). */
export function assetCandidatesOptions(
  wsId: string,
  projectId: string,
  params?: SearchAssetCandidatesParams,
) {
  return queryOptions<AssetCandidatesResponse>({
    queryKey: assetKeys.candidates(wsId, projectId, params),
    queryFn: () =>
      api
        .searchAssetCandidates(projectId, params)
        .catch(() => ({ candidates: [] }) satisfies AssetCandidatesResponse),
    enabled: Boolean(wsId && projectId),
  });
}

/** Issue-scope paged asset list (work-item 「绑定资产」 Tab). */
export function issueAssetsOptions(
  wsId: string,
  issueId: string,
  filters?: ListAssetsParams,
) {
  return queryOptions({
    queryKey: assetKeys.issueList(wsId, issueId, filters),
    queryFn: () =>
      api
        .listIssueAssets(issueId, filters)
        .then(normalizeAssetPage)
        .catch(() => EMPTY_PAGE),
    enabled: Boolean(wsId && issueId),
  });
}

/**
 * Scope-agnostic paged asset list for a component that serves both the project
 * TAB and the work-item 「绑定资产」 drill (CoCo 双形态). Passing `issueId`
 * switches to the issue endpoint + key; otherwise it is the project scope.
 * Returning ONE options object (rather than a union of two) keeps `useQuery`
 * overload inference intact at the call site.
 */
export function assetListOptions(
  wsId: string,
  projectId: string,
  filters?: ListAssetsParams,
  issueId?: string,
) {
  return queryOptions<AssetPage, Error, AssetPage, ReturnType<typeof assetKeys.list>>({
    queryKey: (issueId
      ? assetKeys.issueList(wsId, issueId, filters)
      : assetKeys.list(wsId, projectId, filters)) as ReturnType<
      typeof assetKeys.list
    >,
    queryFn: () =>
      (issueId
        ? api.listIssueAssets(issueId, filters)
        : api.listProjectAssets(projectId, filters)
      )
        .then(normalizeAssetPage)
        .catch(() => EMPTY_PAGE),
    enabled: Boolean(wsId && (issueId || projectId)),
  });
}

const EMPTY_WS_PAGE: WorkspaceAssetPage = {
  items: [],
  page: 1,
  pageSize: 20,
  totalCount: 0,
  totalPages: 0,
};

/** Defensive normalization for the workspace aggregate envelope. */
export function normalizeWorkspaceAssetPage(raw: unknown): WorkspaceAssetPage {
  if (!raw || typeof raw !== "object") return EMPTY_WS_PAGE;
  const r = raw as Partial<WorkspaceAssetPage>;
  const items = Array.isArray(r.items) ? (r.items as WorkspaceAssetBinding[]) : [];
  const pageSize = typeof r.pageSize === "number" && r.pageSize > 0 ? r.pageSize : 20;
  const totalCount = typeof r.totalCount === "number" && r.totalCount >= 0 ? r.totalCount : items.length;
  const page = typeof r.page === "number" && r.page > 0 ? r.page : 1;
  const totalPages =
    typeof r.totalPages === "number" && r.totalPages >= 0
      ? r.totalPages
      : Math.ceil(totalCount / pageSize);
  return { items, page, pageSize, totalCount, totalPages };
}

/**
 * Workspace-wide paged asset list for the left-sidebar "Assets" module. Gated on
 * `wsId` only (no project). Server filters by workspace so it never leaks across
 * tenants; rows carry project_title / issue_title for cross-linking.
 */
export function workspaceAssetsOptions(
  wsId: string,
  filters?: Omit<ListAssetsParams, "issueId">,
) {
  return queryOptions<WorkspaceAssetPage>({
    queryKey: assetKeys.workspaceList(wsId, filters),
    queryFn: () =>
      api
        .listWorkspaceAssets(filters)
        .then(normalizeWorkspaceAssetPage)
        .catch(() => EMPTY_WS_PAGE),
    enabled: Boolean(wsId),
  });
}

const EMPTY_OVERVIEW: AssetOverviewResponse = { bindings: [], issues: [] };

/**
 * 阶段矩阵 / 需求×资产视图的聚合面（GET /api/assets/overview，473）：全量 binding
 * 含 links 不分页 + 候选工作项。矩阵在前端内存分组；降级空面不阻断页面。
 */
export function workspaceOverviewOptions(wsId: string, projectId?: string) {
  return queryOptions<AssetOverviewResponse>({
    queryKey: assetKeys.overview(wsId, projectId),
    queryFn: () =>
      api
        .getAssetOverview(projectId)
        .catch(() => EMPTY_OVERVIEW satisfies AssetOverviewResponse),
    enabled: Boolean(wsId),
  });
}
