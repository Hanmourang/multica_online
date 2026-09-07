import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { graphKeys } from "./queries";
import type { GraphSyncPayload } from "../types";

/**
 * POST /projects/{id}/graph/sync — the CLI projector's write endpoint.
 * Upserts by (project_id, scan_id) and trims to the 5 newest snapshots,
 * so on settle every snapshot-derived read under the project prefix is
 * stale: summary, modules, bus matrix, alerts, timeline.
 *
 * Note on the module bridge: graphKeys.modules nests under
 * graphKeys.project(wsId, projectId), so the single prefix invalidation
 * below already covers the f10 left-column module list (incl. the
 * community→module auto-match results the sync response reports). A
 * separate modules-key invalidation would be redundant — do not add one.
 */
export function useSyncGraphSnapshot(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (payload: GraphSyncPayload) =>
      api.syncGraphSnapshot(projectId, payload),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: graphKeys.project(wsId, projectId),
      });
    },
  });
}

/**
 * The sync endpoint also accepts module_summary / bus_matrix as top-level
 * payload fields (server GraphSyncPayload); the TS request type predates
 * them, so the read-back rescan widens locally instead of silently letting
 * the server reset those columns to `[]`.
 */
type GraphResyncPayload = GraphSyncPayload & {
  module_summary?: unknown;
  bus_matrix?: unknown;
};

/**
 * Thrown by useRescanGraphSnapshot when the latest snapshot changes during
 * the read-back window — i.e. the CLI pushed a NEWER scan between our GET
 * and the re-POST. The view layer catches it via `instanceof` and surfaces a
 * "snapshot updated, please retry" toast; core stays free of i18n / toast
 * deps by throwing a typed error instead of a bare Error.
 */
export class GraphSnapshotChangedError extends Error {
  /** scan_id we read back and were about to re-post. */
  readonly attemptedScanId: string;
  /** scan_id of the newer snapshot that superseded it. */
  readonly currentScanId: string;
  constructor(attemptedScanId: string, currentScanId: string) {
    super(
      `graph snapshot changed during resync (attempted ${attemptedScanId}, latest ${currentScanId})`,
    );
    this.name = "GraphSnapshotChangedError";
    this.attemptedScanId = attemptedScanId;
    this.currentScanId = currentScanId;
  }
}

/**
 * f10 「重算模块匹配」— read-back re-sync of the latest snapshot.
 *
 * The server stores snapshots but never scans the filesystem, so there is
 * no recompute-from-source endpoint: a truly new scan must come from the
 * CLI (gitnexus). What the server CAN redo on demand is the module ↔
 * community bridge pass (matchModulesToCommunitiesInTx), which is the part
 * f10 cares about after modules are renamed/added.
 *
 * This mutation therefore reads the latest snapshot back (detail for
 * nodes/edges/communities/stats, summary for the module_summary/bus_matrix
 * columns) and re-posts it under the SAME scan_id. The upsert hits the
 * existing row with identical content — created_at is untouched — and the
 * bridge pass re-runs for real, so the response's matched/updated counts
 * are honest.
 *
 * Sending an empty/minimal payload instead would 400 (scan_id/git_sha/
 * gitnexus_version are required) and, if the identity were faked, OVERWRITE
 * the snapshot with empty nodes/communities — never do that.
 *
 * TODO(project-archive): a real filesystem rescan needs a CLI-side trigger
 * (daemon command → gitnexus run → fresh sync); tracked for a later wave.
 *
 * BODY-SIZE NOTE: this re-uploads the ENTIRE nodes/edges/communities JSONB
 * (measured ≈1.3 MiB for a 2k-node repo, ≈9 MiB at 12k nodes, ≈20 MiB at
 * multica's ~26k-symbol scale) just to re-run the bridge pass. graph/sync
 * has NO application-level body cap (the handler decodes r.Body directly,
 * unlike agent_run.go's 1 MiB MaxBytesReader), so it will not 413 at the Go
 * layer — but an upstream proxy (nginx / cloud LB, commonly 1–10 MiB) could
 * reject the largest snapshots. A dedicated bridge-only endpoint that skips
 * the graph body would remove the re-upload entirely; tracked as a TODO on
 * the toolbar button.
 */
export function useRescanGraphSnapshot(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: async () => {
      // SEQUENTIAL on purpose (was Promise.all): the race guard below needs a
      // defined read order, which a parallel read cannot establish.
      //
      // RACE WINDOW — GET detail → (CLI may push a NEW snapshot here) → GET
      // latest → POST sync. The upsert's conflict key is (project_id, scan_id),
      // so re-posting the stale detail would hit the OLD scan_id row and NOT
      // overwrite the newer one; but the bridge pass would run against stale
      // nodes while the user is already looking at the newer snapshot, and the
      // detail/summary halves could come from two different snapshots (mixed
      // payload). Both are silent, confusing regressions.
      //
      // GUARD — after reading the full detail, re-read the latest summary and
      // compare scan_id. A mismatch means the latest snapshot moved during the
      // read window, so we ABORT before POST and never write stale content
      // back. Residual window: a push landing between this guard read and the
      // POST round-trip is still theoretically possible; closing it completely
      // needs a server-side optimistic lock (an expected-scan_id precondition
      // on graph/sync), which lives in Go and is out of scope for this task.
      const detail = await api.getGraphSnapshotDetail(projectId);
      const summary = await api.getLatestGraphSnapshot(projectId);
      if (summary.scan_id !== detail.scan_id) {
        throw new GraphSnapshotChangedError(detail.scan_id, summary.scan_id);
      }
      const payload: GraphResyncPayload = {
        scan_id: detail.scan_id,
        git_sha: detail.git_sha,
        gitnexus_version: detail.gitnexus_version,
        nodes: detail.nodes,
        edges: detail.edges,
        communities: detail.communities,
        stats: detail.stats,
        // Carry the pre-aggregated projections through so the upsert does
        // not reset those columns (server falls back to `[]` when absent).
        module_summary: summary.module_summary,
        bus_matrix: summary.bus_matrix,
        // Server-side optimistic lock (task 27): the guard read above still
        // leaves a window before the POST round-trip. Sending the scan_id we
        // read lets the server reject the upsert with 409 if a newer snapshot
        // landed in between, closing that residual race atomically.
        expected_scan_id: detail.scan_id,
      };
      return api.syncGraphSnapshot(
        projectId,
        payload as unknown as GraphSyncPayload,
      );
    },
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: graphKeys.project(wsId, projectId),
      });
    },
  });
}

/**
 * f10 「重算模块匹配」— bridge-only re-run (task 27, preferred path).
 *
 * Calls POST /projects/{id}/graph/rebridge: the server re-runs the module ↔
 * community bridge against the latest stored snapshot it reads straight from
 * the DB. Unlike useRescanGraphSnapshot, NOTHING is uploaded — no 9–20 MiB
 * nodes/edges round-trip, and no read-back race to guard, because the server
 * resolves the newest snapshot atomically inside its own transaction.
 *
 * Returns honest matched/updated counts (RebridgeGraphResponse). A project
 * with no snapshot 404s; the toolbar disables the button in that state so the
 * error path is a safety net, not the normal flow.
 *
 * Invalidation reuses the single project prefix (graphKeys.project), which
 * already nests graphKeys.modules — so the f10 module list refreshes from one
 * key, exactly like the sync mutation above.
 */
export function useRebridgeGraphSnapshot(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: () => api.rebridgeGraphSnapshot(projectId),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: graphKeys.project(wsId, projectId),
      });
    },
  });
}
