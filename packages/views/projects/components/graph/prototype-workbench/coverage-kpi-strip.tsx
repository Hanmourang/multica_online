"use client";

import { useT } from "../../../../i18n";
import { cn } from "@multica/ui/lib/utils";
import type { ModuleCoverage, ModuleReconcileState } from "@multica/core/types";
import { formatCoverageRate } from "./lib/state-tone";

// 覆盖率 KPI 条（07 f4 · M-14）：五个数字 + 覆盖率**全部取后端 coverage 字段**，
// 前端不得二次自算（07 §六防漂移）。点某态可驱动矩阵筛选（onFilter 为空则纯展示）。

type KpiState = Exclude<ModuleReconcileState, "deprecated">;

const CLICKABLE: ReadonlySet<string> = new Set<KpiState>([
  "covered",
  "changed",
  "missing",
  "unregistered",
]);

export function CoverageKpiStrip({
  coverage,
  activeState,
  onFilter,
  className,
}: {
  coverage: ModuleCoverage;
  activeState?: ModuleReconcileState | null;
  onFilter?: (state: KpiState) => void;
  className?: string;
}) {
  const { t } = useT("module-prototype");

  // 显式列出每格：既让 selector-API 的类型稳定收窄，也让顺序可控。
  const stats: Array<{ key: string; label: string; value: number }> = [
    { key: "total", label: t(($) => $.coverage.total), value: coverage.total },
    { key: "covered", label: t(($) => $.coverage.covered), value: coverage.covered },
    { key: "changed", label: t(($) => $.coverage.changed), value: coverage.changed },
    { key: "missing", label: t(($) => $.coverage.missing), value: coverage.missing },
    { key: "unregistered", label: t(($) => $.coverage.unregistered), value: coverage.unregistered },
    { key: "deprecated", label: t(($) => $.coverage.deprecated), value: coverage.deprecated },
  ];

  return (
    <div className={cn("flex flex-wrap items-stretch gap-2", className)}>
      {stats.map((s) => {
        const clickable = !!onFilter && CLICKABLE.has(s.key);
        return (
          <button
            key={s.key}
            type="button"
            disabled={!clickable}
            onClick={() => clickable && onFilter?.(s.key as KpiState)}
            className={cn(
              "min-w-[72px] rounded-md border px-2.5 py-1.5 text-left transition",
              clickable ? "cursor-pointer hover:bg-accent" : "cursor-default",
              activeState && activeState === s.key ? "border-primary bg-accent" : "border-border bg-background",
            )}
          >
            <div className="text-[11px] text-muted-foreground">{s.label}</div>
            <div className="text-base font-semibold tabular-nums">{s.value}</div>
          </button>
        );
      })}
      <div className="min-w-[84px] rounded-md border border-border bg-background px-2.5 py-1.5">
        <div className="text-[11px] text-muted-foreground">{t(($) => $.coverage.rate)}</div>
        <div className="text-base font-semibold tabular-nums">
          {formatCoverageRate(coverage)}
          <span className="ml-1 text-[11px] font-normal text-muted-foreground">
            {coverage.covered}/{coverage.denominator}
          </span>
        </div>
      </div>
    </div>
  );
}
