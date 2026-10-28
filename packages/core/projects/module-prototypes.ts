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
