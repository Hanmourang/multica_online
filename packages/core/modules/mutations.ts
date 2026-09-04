import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { issueKeys } from "../issues/queries";
import { dependencyKeys, moduleKeys } from "./queries";

/**
 * Module mutations. Modules are small and created/renamed infrequently, so we
 * skip optimistic patching and just invalidate on settle — the round-trip is
 * the source of truth (unlike labels, which ride inside every issue payload).
 *
 * Every mutation also invalidates the issues scope: issues embed module_id /
 * avoid_conflict, and a rename/recolor/delete changes what the board cards
 * render for those ids.
 */
export function useCreateProjectModule(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: { name: string; color?: string }) =>
      api.createProjectModule(projectId, data),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: moduleKeys.byProject(wsId, projectId) });
    },
  });
}

export function useUpdateProjectModule(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      moduleId,
      ...data
    }: { moduleId: string; name?: string; color?: string }) =>
      api.updateProjectModule(projectId, moduleId, data),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: moduleKeys.byProject(wsId, projectId) });
      // Cards render the module name/color resolved from this list, so the
      // list refetch is enough for the palette; but a deleted/renamed module
      // also changes nothing on the issue rows themselves — no issue
      // invalidation needed here.
    },
  });
}

export function useDeleteProjectModule(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (moduleId: string) =>
      api.deleteProjectModule(projectId, moduleId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: moduleKeys.byProject(wsId, projectId) });
      // Deleted modules fall back to module_id = null on the server
      // (ON DELETE SET NULL); the affected issue rows keep a stale id until
      // refetched.
      qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
    },
  });
}

/**
 * Replace an issue's dependency set (PUT semantics). No optimistic patch:
 * the server rejects cross-module edges and cycles with 409, so the cheap
 * path is to wait for the authoritative list and refetch on settle.
 */
export function usePutIssueDependencies(issueId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (dependsOn: string[]) =>
      api.putIssueDependencies(issueId, dependsOn),
    onSuccess: (deps) => {
      qc.setQueryData(dependencyKeys.byIssue(wsId, issueId), deps);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: dependencyKeys.byIssue(wsId, issueId) });
    },
  });
}

/**
 * Deferred-id variant mirroring `useAttachLabelToIssue`: the create-issue
 * dialog picks dependencies before the issue exists, so the id arrives at
 * call time, not hook time. No optimistic patch — the dialog closes and the
 * settle-time invalidation surfaces the edges.
 */
export function usePutIssueDependenciesForIssue() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ issueId, dependsOn }: { issueId: string; dependsOn: string[] }) =>
      api.putIssueDependencies(issueId, dependsOn),
    onSettled: (_data, _err, { issueId }) => {
      qc.invalidateQueries({ queryKey: dependencyKeys.byIssue(wsId, issueId) });
    },
  });
}
