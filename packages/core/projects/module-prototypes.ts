import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { projectKeys } from "./queries";
import type {
  ModuleSpec,
  ModuleFeatureDecision,
  ModuleProtoAnchorMap,
} from "../types";

// 功能模块原型中枢 · core 取数层（plans/20261026 07 · M-13）。
//
// 这是「模块 spec / 模块级原型 / 四态对账 / 发布计划」的唯一前端取数入口：
// 07 的 workbench（M-09…M-14）与 06 的聊天侧都 import 这里，禁止各自另起 fetch。
// 关键防漂移（07 §六）：四态与覆盖率一律取后端 reconcile/coverage 响应字段，
// 前端**不得**二次 `covered / features` 自算 —— 列表徽标与详情环同源（getModuleCoverage）。

/** 模块中枢相关端点均受 FF_MODULE_SPEC_CENTER 门控；flag 关闭时后端叶子不注册 → 404。 */
export const modulePrototypeKeys = {
  all: (wsId: string, projectId: string) =>
    [...projectKeys.detail(wsId, projectId), "modules"] as const,
  spec: (wsId: string, projectId: string, moduleId: string) =>
    [...modulePrototypeKeys.all(wsId, projectId), "spec", moduleId] as const,
  versions: (wsId: string, projectId: string, moduleId: string) =>
    [...modulePrototypeKeys.all(wsId, projectId), "versions", moduleId] as const,
  reconcile: (wsId: string, projectId: string, moduleId: string, version: number | undefined) =>
    [...modulePrototypeKeys.all(wsId, projectId), "reconcile", moduleId, version ?? "canonical"] as const,
  coverage: (wsId: string, projectId: string, moduleId: string) =>
    [...modulePrototypeKeys.all(wsId, projectId), "coverage", moduleId] as const,
  plan: (wsId: string, projectId: string, moduleId: string, planId: string) =>
    [...modulePrototypeKeys.all(wsId, projectId), "plan", moduleId, planId] as const,
  workspace: (wsId: string, projectId: string, moduleId: string) =>
    [...modulePrototypeKeys.all(wsId, projectId), "workspace", moduleId] as const,
  releases: (wsId: string, projectId: string, moduleId: string) =>
    [...modulePrototypeKeys.all(wsId, projectId), "releases", moduleId] as const,
};

/** GET /spec —— 模块能力规格 + 版本 + 权威原型指针。 */
export function moduleSpecOptions(wsId: string, projectId: string, moduleId: string | undefined) {
  return queryOptions({
    queryKey: modulePrototypeKeys.spec(wsId, projectId, moduleId ?? ""),
    queryFn: () => api.getModuleSpec(projectId, moduleId!),
    enabled: !!moduleId,
  });
}

/** GET /prototype-versions —— 模块级原型版本序列（无需求模块亦可列=硬伤 3 闭环）。 */
export function modulePrototypeVersionsOptions(
  wsId: string,
  projectId: string,
  moduleId: string | undefined,
  canonicalOnly = false,
) {
  return queryOptions({
    queryKey: [...modulePrototypeKeys.versions(wsId, projectId, moduleId ?? ""), canonicalOnly ? "confirmed" : "all"] as const,
    queryFn: () => api.listModulePrototypeVersions(projectId, moduleId!, canonicalOnly),
    enabled: !!moduleId,
  });
}

/** GET /prototype-reconcile —— 四态矩阵 + 覆盖率（唯一口径来自后端）。 */
export function moduleReconcileOptions(
  wsId: string,
  projectId: string,
  moduleId: string | undefined,
  version?: number,
) {
  return queryOptions({
    queryKey: modulePrototypeKeys.reconcile(wsId, projectId, moduleId ?? "", version),
    queryFn: () => api.getModulePrototypeReconcile(projectId, moduleId!, version),
    enabled: !!moduleId,
  });
}

/** GET /coverage —— 仅覆盖率 KPI（列表徽标与详情环同源）。 */
export function moduleCoverageOptions(wsId: string, projectId: string, moduleId: string | undefined) {
  return queryOptions({
    queryKey: modulePrototypeKeys.coverage(wsId, projectId, moduleId ?? ""),
    queryFn: () => api.getModuleCoverage(projectId, moduleId!),
    enabled: !!moduleId,
  });
}

/** POST /spec/publish —— 事务内版本+1 + 重建投影；expected_version 过期 → 409。 */
export function usePublishModuleSpec(wsId: string, projectId: string, moduleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { spec: ModuleSpec; expected_version?: number }) =>
      api.publishModuleSpec(projectId, moduleId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.spec(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.coverage(wsId, projectId, moduleId) });
      // 右栏「功能点清单」的行来自 spec 投影：发布后必须重取 workspace，
      // 否则新登记的功能点在右栏里看不到、四段详情也无处可写。
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.workspace(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.releases(wsId, projectId, moduleId) });
      qc.invalidateQueries({
        queryKey: [...modulePrototypeKeys.all(wsId, projectId), "reconcile", moduleId],
      });
    },
  });
}

/** POST /prototype-versions —— 登记模块级原型（issue_id 可空=无需求；set_canonical 需 confirmed）。 */
export function useRegisterModulePrototype(
  wsId: string,
  projectId: string,
  moduleId: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      version: number;
      html_path: string;
      prompt?: string;
      status?: "pending" | "confirmed" | "superseded";
      issue_id?: string;
      set_canonical?: boolean;
    }) => api.registerModulePrototypeVersion(projectId, moduleId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.versions(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.spec(wsId, projectId, moduleId) });
      // 登记后 canonical 指针变了，右栏的配对条/发布按钮要跟着从「未登记」变成可发布。
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.workspace(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.releases(wsId, projectId, moduleId) });
    },
  });
}

/** POST /prototype-versions/{version}/parse —— 存前端解析 anchors，随后刷新对账。 */
export function useParseModulePrototype(wsId: string, projectId: string, moduleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ version, anchors }: { version: number; anchors: ModuleProtoAnchorMap }) =>
      api.parseModulePrototype(projectId, moduleId, version, anchors),
    onSuccess: (_data, { version }) => {
      qc.invalidateQueries({
        queryKey: modulePrototypeKeys.reconcile(wsId, projectId, moduleId, version),
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.coverage(wsId, projectId, moduleId) });
      qc.invalidateQueries({
        queryKey: [...modulePrototypeKeys.all(wsId, projectId), "reconcile", moduleId],
      });
    },
  });
}

/** POST /prototype-plans —— 建发布计划（draft，不移动权威=07 D-D）。 */
export function useCreateModulePrototypePlan(
  wsId: string,
  projectId: string,
  moduleId: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      candidate_version: number;
      new_spec?: ModuleSpec;
      decisions?: Record<string, ModuleFeatureDecision>;
    }) => api.createModulePrototypePlan(projectId, moduleId, body),
    onSuccess: (plan) => {
      qc.setQueryData(modulePrototypeKeys.plan(wsId, projectId, moduleId, plan.id), plan);
    },
  });
}

/** POST /prototype-plans/{planId}/apply —— 人确认移动 canonical + bump spec + 重建投影。 */
export function useApplyModulePrototypePlan(
  wsId: string,
  projectId: string,
  moduleId: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api.applyModulePrototypePlan(projectId, moduleId, planId),
    onSettled: () => {
      // 权威/规格/投影/对账/覆盖率/版本序列全量刷新（apply 是一次多表面变更）。
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.spec(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.versions(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.coverage(wsId, projectId, moduleId) });
      qc.invalidateQueries({
        queryKey: [...modulePrototypeKeys.all(wsId, projectId), "reconcile", moduleId],
      });
    },
  });
}

// ── 右栏「功能点详解」工作区（原型图 TAB v2 · 画面 3/5/6） ────────────
//
// 说明字段、功能点四段详情与版本记录同源于 module_brief_version：一次 patch 产一个
// 版本，版本记录与功能点填充度同时变化，所以两者一起失效。

/** GET /workspace —— 右栏三段一次取齐（字段字典 + 说明 + 功能点 + 版本 + 发布）。 */
export function moduleWorkspaceOptions(
  wsId: string,
  projectId: string,
  moduleId: string | undefined,
) {
  return queryOptions({
    queryKey: modulePrototypeKeys.workspace(wsId, projectId, moduleId ?? ""),
    queryFn: () => api.getModuleWorkspace(projectId, moduleId!),
    enabled: !!moduleId,
  });
}

/** GET /releases —— 成对发布历史（说明轴 ⨯ 原型轴）。 */
export function moduleReleasesOptions(
  wsId: string,
  projectId: string,
  moduleId: string | undefined,
) {
  return queryOptions({
    queryKey: modulePrototypeKeys.releases(wsId, projectId, moduleId ?? ""),
    queryFn: () => api.listModuleReleases(projectId, moduleId!),
    enabled: !!moduleId,
  });
}

/** 404 = FF_MODULE_SPEC_CENTER 关着；调用方据此隐藏整个工作区。 */
export function isModuleWorkspaceGated(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: number }).status;
  return status === 404;
}

/** POST /workspace/patch —— 逐字段写说明（base_version 乐观锁）。 */
export function usePatchModuleWorkspace(wsId: string, projectId: string, moduleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      base_version: number;
      fields: Record<string, unknown>;
      source?: "manual" | "agent" | "mcp" | "extract" | "rollback";
      note?: string;
    }) => api.patchModuleWorkspace(projectId, moduleId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.workspace(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.releases(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.coverage(wsId, projectId, moduleId) });
    },
  });
}

/** POST /releases —— 成对发布（仅人；agent 调用后端 403 agent_cannot_release）。 */
export function usePublishModuleRelease(wsId: string, projectId: string, moduleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { brief_version?: number; prototype_version?: number; note?: string }) =>
      api.publishModuleRelease(projectId, moduleId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.workspace(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.releases(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.spec(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.versions(wsId, projectId, moduleId) });
    },
  });
}

/** POST /releases/{version}/rollback —— 以旧版为基发新版（历史行一律不动）。 */
export function useRollbackModuleRelease(wsId: string, projectId: string, moduleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => api.rollbackModuleRelease(projectId, moduleId, version),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.workspace(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.releases(wsId, projectId, moduleId) });
      qc.invalidateQueries({ queryKey: modulePrototypeKeys.versions(wsId, projectId, moduleId) });
    },
  });
}
