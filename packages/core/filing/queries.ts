import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { FilingTier, FilingTrack } from "../types";

/**
 * Query keys + options for the filing readiness store (migration 458).
 *
 * `readiness` already embeds every item in its tracks aggregation, so the
 * checklist reads from the same cache entry — no separate items fetch
 * unless the checklist is filtered client-side.
 */
export const filingKeys = {
  all: (wsId: string) => ["project-filing", wsId] as const,
  project: (wsId: string, projectId: string) =>
    [...filingKeys.all(wsId), projectId] as const,
  readiness: (wsId: string, projectId: string) =>
    [...filingKeys.project(wsId, projectId), "readiness"] as const,
  items: (
    wsId: string,
    projectId: string,
    filters?: { track?: FilingTrack; tier?: FilingTier },
  ) =>
    [...filingKeys.project(wsId, projectId), "items", filters ?? {}] as const,
  /**
   * The comparison spans the whole workspace, but it is keyed under the
   * requesting project so a project switch can never serve another project's
   * cached ranking (and so invalidating one project's filing space refreshes
   * its own comparison too).
   */
  crossProject: (wsId: string, projectId: string) =>
    [...filingKeys.project(wsId, projectId), "cross-project"] as const,
};

/** Per-track must/conditional/aux aggregation + the export gate. */
export function filingReadinessOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: filingKeys.readiness(wsId, projectId),
    queryFn: () => api.getFilingReadiness(projectId),
    enabled: Boolean(wsId && projectId),
  });
}

export function filingItemsOptions(
  wsId: string,
  projectId: string,
  filters?: { track?: FilingTrack; tier?: FilingTier },
) {
  return queryOptions({
    queryKey: filingKeys.items(wsId, projectId, filters),
    queryFn: () => api.listFilingItems(projectId, filters),
    enabled: Boolean(wsId && projectId),
  });
}

/**
 * GET /projects/{id}/filing/cross-project — must-tier readiness for every
 * project in the workspace, one row per project × track, most-ready first.
 * 原型 f12 标注 4：申报期挑必备件已齐的项目先报.
 *
 * Only projects that already carry filing_item rows appear — the checklist is
 * seeded lazily, so a project joins the comparison the first time its own
 * readiness tab is opened. The requested project is always present.
 */
export function filingCrossProjectOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: filingKeys.crossProject(wsId, projectId),
    queryFn: () => api.getFilingCrossProject(projectId),
    enabled: Boolean(wsId && projectId),
  });
}
