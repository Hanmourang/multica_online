import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { issueArchiveKeys } from "../agent-runs/queries";
import { assetKeys } from "../assets/queries";
import { artifactKeys } from "./queries";
import type {
  ArchiveDeliverableRequest,
  ArtifactSyncPayload,
  CreateProjectArtifactRequest,
  PatchProjectArtifactRequest,
  PutArchiveSyncConfigRequest,
} from "../types";

/**
 * Artifact mutations. Both endpoints write the archive store directly, so
 * on settle we invalidate the whole project slice — the list, the matrix
 * aggregate, and any detail/content entries all derive from the same rows.
 *
 * Every mutation here ALSO invalidates issueArchiveKeys.all: the f8 交付概览
 * / f9 进度追踪 aggregates are server-side projections over the same artifact
 * rows, so without this cross-key invalidation those views keep showing
 * stale counts after an archive action until a manual refresh.
 *
 * 五阶段对齐 plan §5.2：档案写路径（PATCH / 归档重分类 / manifest 同步）在服务端
 * 同事务回写关联资产 lifecycle，前端必须同时失效 assetKeys，否则另一侧展示旧阶段。
 */
export function useSyncProjectArtifacts(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (payload: ArtifactSyncPayload) =>
      api.syncProjectArtifacts(projectId, payload),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: artifactKeys.project(wsId, projectId),
      });
      // f8/f9 issue-level aggregates project the same artifact rows.
      qc.invalidateQueries({ queryKey: issueArchiveKeys.all(wsId) });
      // manifest 同步会在事务内回写关联资产 placement（plan §4.3-7）。
      qc.invalidateQueries({ queryKey: assetKeys.all(wsId) });
    },
  });
}

/**
 * f6 归档动作：re-file a deliverable (scope / stage / doc_type, optional
 * issue binding). The server records the new classification with
 * source="agent"; the CLI round-trip (writing the file into the archive
 * directory) is a server-side TODO surfaced by the UI as a hint.
 */
export function useArchiveDeliverable(projectId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      artifactId,
      ...data
    }: ArchiveDeliverableRequest & { artifactId: string }) =>
      api.archiveProjectDeliverable(projectId, artifactId, data),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: artifactKeys.project(wsId, projectId),
      });
      // f6 归档动作 re-files a deliverable → f8 交付概览 / f9 进度追踪 must
      // refresh, they aggregate the same rows server-side.
      qc.invalidateQueries({ queryKey: issueArchiveKeys.all(wsId) });
      // 可重分类资产关联行 → 同事务反写资产 lifecycle，资产侧同步刷新（plan §5.2）。
      qc.invalidateQueries({ queryKey: assetKeys.all(wsId) });
    },
  });
}

/**
 * PATCH /artifacts/{id}: partial reclassification (scope / stage / doc_type /
 * issue binding). Only the keys present in `patch` are written; the server
 * stamps source="manual" and returns the full updated artifact. Invalidates
 * the whole project artifact slice on settle — list / matrix / detail all
 * derive from the same rows.
 */
export function usePatchArtifact(workspaceId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      artifactId,
      patch,
    }: {
      artifactId: string;
      patch: PatchProjectArtifactRequest;
    }) => api.patchProjectArtifact(projectId, artifactId, patch),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: artifactKeys.project(workspaceId, projectId),
      });
      // Reclassification changes the f8/f9 aggregates (scope/stage buckets).
      qc.invalidateQueries({ queryKey: issueArchiveKeys.all(workspaceId) });
      // 资产关联行的 stage/doc_type 联动回写 binding.lifecycle_stage（plan §4.3），
      // 正文/模块编辑也刷新资产，保证关联展示不陈旧（plan §5.2）。
      qc.invalidateQueries({ queryKey: assetKeys.all(workspaceId) });
    },
  });
}

/**
 * POST /artifacts/{id}/bind: attach an unbound artifact to a requirement in
 * the same project (存量回填). The server validates both the artifact and the
 * issue, then stamps source="manual". Invalidates the project artifact slice
 * on settle so the unbound queue and matrix refresh together.
 */
export function useBindArtifact(workspaceId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      artifactId,
      issueId,
    }: {
      artifactId: string;
      issueId: string;
    }) => api.bindProjectArtifact(projectId, artifactId, issueId),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: artifactKeys.project(workspaceId, projectId),
      });
      // Binding moves the artifact into an issue's f8 deliverables aggregate.
      qc.invalidateQueries({ queryKey: issueArchiveKeys.all(workspaceId) });
    },
  });
}

export function useCreateArtifact(workspaceId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProjectArtifactRequest) =>
      api.createProjectArtifact(projectId, data),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: artifactKeys.project(workspaceId, projectId),
      });
      qc.invalidateQueries({ queryKey: issueArchiveKeys.all(workspaceId) });
    },
  });
}

export function usePutArchiveSyncConfig(workspaceId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: PutArchiveSyncConfigRequest) =>
      api.putArchiveSyncConfig(projectId, data),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: artifactKeys.syncConfig(workspaceId, projectId),
      });
    },
  });
}

export function useDeleteArtifact(workspaceId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (artifactId: string) =>
      api.deleteProjectArtifact(projectId, artifactId),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: artifactKeys.project(workspaceId, projectId),
      });
      qc.invalidateQueries({ queryKey: issueArchiveKeys.all(workspaceId) });
    },
  });
}

