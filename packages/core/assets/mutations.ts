import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { artifactKeys } from "../artifacts/queries";
import { issueArchiveKeys } from "../agent-runs/queries";
import { assetKeys } from "./queries";
import type { BindAssetRequest, UpdateAssetMetaRequest } from "../types";

/**
 * Asset mutations. A bind / unbind writes the binding layer only, so on settle
 * we invalidate the affected scope's asset slice + the search-candidate cache
 * (candidate `already_bound` flags shift with every bind). The underlying
 * project_resource is never touched, so resource queries stay fresh.
 *
 * 五阶段对齐 plan §5.2：知识/文档类资产在服务端同事务 upsert 档案行，前端必须
 * 同时失效档案与 issue 档案聚合；有 projectId 精确失效项目片，否则失效
 * workspace 档案前缀。
 */
function invalidateLinkedArchiveScopes(
  qc: QueryClient,
  workspaceId: string,
  projectId?: string,
) {
  qc.invalidateQueries({
    queryKey: projectId
      ? artifactKeys.project(workspaceId, projectId)
      : artifactKeys.all(workspaceId),
  });
  qc.invalidateQueries({ queryKey: issueArchiveKeys.all(workspaceId) });
}

/** Project-scope bind: POST /api/projects/{id}/assets. */
export function useBindProjectAsset(workspaceId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: BindAssetRequest) =>
      api.bindProjectAsset(projectId, data),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: assetKeys.project(workspaceId, projectId),
      });
      invalidateLinkedArchiveScopes(qc, workspaceId, projectId);
    },
  });
}

/** Project-scope unbind (二次确认后调用): DELETE /api/projects/{id}/assets/{bindingId}. */
export function useUnbindProjectAsset(workspaceId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bindingId: string) =>
      api.unbindProjectAsset(projectId, bindingId),
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: assetKeys.project(workspaceId, projectId),
      });
      // 解绑经 FK 级联清掉资产原生档案行，档案侧同步刷新。
      invalidateLinkedArchiveScopes(qc, workspaceId, projectId);
    },
  });
}

/** Issue-scope bind: POST /api/issues/{id}/assets. */
export function useBindIssueAsset(workspaceId: string, issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: BindAssetRequest) => api.bindIssueAsset(issueId, data),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: assetKeys.issue(workspaceId, issueId) });
      // issue 维度无 projectId 入参，失效 workspace 档案前缀（plan §5.2）。
      invalidateLinkedArchiveScopes(qc, workspaceId);
    },
  });
}

/** Issue-scope unbind: DELETE /api/issues/{id}/assets/{bindingId}. */
export function useUnbindIssueAsset(workspaceId: string, issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bindingId: string) => api.unbindIssueAsset(issueId, bindingId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: assetKeys.issue(workspaceId, issueId) });
      invalidateLinkedArchiveScopes(qc, workspaceId);
    },
  });
}

/**
 * Workspace-scope unbind for the left-sidebar "Assets" module. There is no
 * dedicated workspace DELETE route — every binding row carries its owning
 * project_id, and the unbind SQL matches on (id, workspace_id, project_id)
 * regardless of issue scope, so we reuse the project endpoint. On settle we
 * invalidate the whole workspace asset slice so the aggregate list and the
 * owning project's TAB both refresh together.
 */
export function useUnbindWorkspaceAsset(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { projectId: string; bindingId: string }) =>
      api.unbindProjectAsset(vars.projectId, vars.bindingId),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: assetKeys.all(workspaceId) });
      invalidateLinkedArchiveScopes(qc, workspaceId, vars.projectId);
    },
  });
}

/**
 * 档案 → 资产批量导入（POST /api/projects/{pid}/assets/sync-from-archive）。
 * 导入只写 binding 层（source='archive'），成功后刷新项目资产片与候选缓存
 *（already_bound 标记随之变化）。
 */
export function useSyncAssetsFromArchive(workspaceId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data?: { asset_category?: string }) =>
      api.syncAssetsFromArchive(projectId, data),
    onSettled: () => {
      // 整片 asset 域失效：工作区页的 workspace/overview 键不嵌套在 project 键下，
      // 只 refetch 项目片会留下侧栏计数/列表陈旧。
      qc.invalidateQueries({ queryKey: assetKeys.all(workspaceId) });
      // 档案导入只写 binding 不新建档案，但候选展示/阶statuses 与档案侧相关。
      invalidateLinkedArchiveScopes(qc, workspaceId, projectId);
    },
  });
}

/**
 * 473 meta：阶段/角色/标签/关联保存（PUT /api/projects/{pid}/assets/{id}/meta）。
 * 工作区页与项目 TAB 共用，成功后整片 asset 域失效以同时刷新列表/矩阵/候选。
 */
export function useUpdateAssetMeta(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      projectId: string;
      bindingId: string;
      data: UpdateAssetMetaRequest;
    }) => api.updateAssetMeta(vars.projectId, vars.bindingId, vars.data),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: assetKeys.all(workspaceId) });
      // 阶段/标签同事务回写档案行（plan §4.2），档案侧精确到项目片刷新。
      invalidateLinkedArchiveScopes(qc, workspaceId, vars.projectId);
    },
  });
}

/**
 * 批量打标（POST /api/projects/{pid}/assets/batch-meta）：一次事务改一批 binding。
 * 成功后整片 asset 域失效以同时刷新列表/矩阵/统计条。
 */
export function useBatchUpdateAssetMeta(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      projectId: string;
      data: import("../types").BatchUpdateAssetMetaRequest;
    }) => api.batchUpdateAssetMeta(vars.projectId, vars.data),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: assetKeys.all(workspaceId) });
      invalidateLinkedArchiveScopes(qc, workspaceId, vars.projectId);
    },
  });
}
