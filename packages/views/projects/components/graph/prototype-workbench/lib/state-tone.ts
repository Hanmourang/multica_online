import type { ModuleCoverage, ModuleReconcileState } from "@multica/core/types";

// 功能模块原型中枢 · 展示层纯函数（plans/20261026 07 · M-11 / M-14）。
//
// 这里只放「状态 → 视觉令牌」与「覆盖率 → 展示」的**无副作用**映射，便于单测锁定，
// 且与后端 service.Reconcile 的状态枚举严格同构。⚠️ 防漂移铁律（07 §六）：
// 四态与覆盖率一律以后端响应为准，本文件**不得**从 rows 重新计算 covered/rate。

/** 后端 ModuleReconcileState 的稳定枚举顺序（矩阵分组 / KPI 展示共用）。 */
export const RECONCILE_STATE_ORDER: ModuleReconcileState[] = [
  "covered",
  "changed",
  "missing",
  "unregistered",
  "deprecated",
];

/** 每个状态固定的强调色令牌（不依赖主题变量命名，避免与 ui 主题耦合）。 */
export const STATE_TONE_CLASS: Record<ModuleReconcileState, string> = {
  covered: "text-emerald-700 bg-emerald-50 border-emerald-200",
  changed: "text-amber-700 bg-amber-50 border-amber-200",
  missing: "text-rose-700 bg-rose-50 border-rose-200",
  unregistered: "text-sky-700 bg-sky-50 border-sky-200",
  deprecated: "text-neutral-500 bg-neutral-100 border-neutral-200",
};

export function stateToneClass(state: ModuleReconcileState): string {
  return STATE_TONE_CLASS[state] ?? STATE_TONE_CLASS.deprecated;
}

/** 覆盖率 0..1 → 百分比字符串；denominator=0（全废弃）诚实显示为 —，不假装 100%。 */
export function formatCoverageRate(cov: Pick<ModuleCoverage, "rate" | "denominator">): string {
  if (cov.denominator <= 0) return "—";
  return `${Math.round(cov.rate * 100)}%`;
}
