import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { artifactKeys } from "../artifacts/queries";
import { useWorkspaceId } from "../hooks";
import { filingKeys } from "./queries";
import type { FilingExportSelectionRequest } from "./types";
import type { FilingItemPatchRequest } from "../types";

/**
 * POST /projects/{id}/filing/check — recompute every item's status and
 * record a filing_check_run per item. On settle the readiness aggregate
 * and any filtered item lists are refetched.
 */
export function useRunFilingCheck(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: () => api.runFilingCheck(projectId),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: filingKeys.project(wsId, projectId),
      });
      qc.invalidateQueries({
        queryKey: artifactKeys.project(wsId, projectId),
      });
    },
  });
}

/**
 * POST /projects/{id}/filing/export — must items unmet → the server
 * downgrades to a diagnostic package and explains why in `reason`; the
 * response carries the package structure either way. The caller decides
 * how to surface the downgrade.
 *
 * `data.artifact_ids` is the ticked export checklist (原型 f12 标注 5：勾选
 * 决定哪些档案进包). Omitting it — or sending an empty list — means "no
 * selection", which the server records as `selected_all` and packages
 * everything bound, so pre-checklist callers behave exactly as before.
 */
export function useExportFilingPackage(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data?: FilingExportSelectionRequest) =>
      api.exportFilingPackage(projectId, data),
    onSettled: () => {
      // An export records a filing_export_log; readiness itself is
      // unchanged, but refetching keeps the UI honest about state.
      qc.invalidateQueries({
        queryKey: filingKeys.project(wsId, projectId),
      });
    },
  });
}

/**
 * POST /projects/{id}/filing/writeback — upsert the readiness summary into
 * `project_artifact` as `filing/READINESS.md` (doc_type `readiness`,
 * scope `project`, source `server`). Idempotent: the server UPDATEs the
 * existing row instead of INSERTing a second one.
 *
 * The writeback lands in the artifact store, so BOTH caches go stale — the
 * filing space (the readiness aggregate the markdown was rendered from) and
 * the artifact space (a new/updated row now shows up in the archive browser
 * and in f6's deliverable matrix). Invalidating only one would leave the
 * other serving a snapshot from before the write.
 *
 * `commit_sha` comes back empty by design: the server never touches the
 * filesystem, the CLI owns the git write.
 */
export function useWritebackFilingReadiness(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: () => api.writebackFilingReadiness(projectId),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: artifactKeys.project(wsId, projectId),
      });
      qc.invalidateQueries({
        queryKey: filingKeys.project(wsId, projectId),
      });
    },
  });
}

/**
 * PATCH /projects/{id}/filing/items/{itemId} — manual override (anno⑤ escape
 * hatch). override_reason is REQUIRED. Invalidates the filing key space so the
 * readiness aggregate and checklist refetch.
 */
export function usePatchFilingItem(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ itemId, data }: { itemId: string; data: FilingItemPatchRequest }) =>
      api.patchFilingItem(projectId, itemId, data),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: filingKeys.project(wsId, projectId),
      });
    },
  });
}
