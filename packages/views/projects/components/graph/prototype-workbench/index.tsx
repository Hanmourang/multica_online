"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useT } from "../../../../i18n";
import { cn } from "@multica/ui/lib/utils";
import type { ModuleReconcileRowItem, ModuleReconcileState } from "@multica/core/types";
import {
  moduleCoverageOptions,
  moduleReconcileOptions,
} from "@multica/core/projects";
import { CoverageKpiStrip } from "./coverage-kpi-strip";
import { ReconcileMatrix } from "./reconcile-matrix";

// 结构对账工作台容器（07 §2.2 / M-09）。数据**只经 M-13 hook**取后端唯一口径：
// coverage 来自 /coverage，矩阵来自 /prototype-reconcile，二者同源，前端零自算。
// 本目录是 M-09 唯一所有者，聊天侧（06）只 import、不改。

export function PrototypeWorkbench({
  wsId,
  projectId,
  moduleId,
  version,
  className,
}: {
  wsId: string;
  projectId: string;
  moduleId: string;
  /** 缺省对账 canonical 版本；显式传则对账该版本。 */
  version?: number;
  className?: string;
}) {
  const { t } = useT("module-prototype");
  const [activeState, setActiveState] = useState<ModuleReconcileState | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  const reconcileQuery = useQuery(moduleReconcileOptions(wsId, projectId, moduleId, version));
  const coverageQuery = useQuery(moduleCoverageOptions(wsId, projectId, moduleId));

  // 覆盖率优先取 /coverage（列表徽标同源）；未就绪时回退 reconcile 内的同源 coverage。
  const coverage = coverageQuery.data?.coverage ?? reconcileQuery.data?.coverage;

  if (reconcileQuery.isPending) {
    return (
      <div className={cn("p-6 text-sm text-muted-foreground", className)}>
        {t(($) => $.matrix.title)}…
      </div>
    );
  }
  if (reconcileQuery.isError || !reconcileQuery.data || !coverage) {
    return (
      <div className={cn("p-6 text-sm text-rose-600", className)}>
        {t(($) => $.matrix.empty)}
      </div>
    );
  }

  const rows: ModuleReconcileRowItem[] = reconcileQuery.data.rows;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <CoverageKpiStrip
        coverage={coverage}
        activeState={activeState}
        onFilter={(state) => setActiveState((prev) => (prev === state ? null : state))}
      />
      <ReconcileMatrix
        rows={rows}
        activeState={activeState}
        selectedCode={selectedCode}
        onSelectRow={(row) => setSelectedCode(row.code)}
      />
    </div>
  );
}

export { CoverageKpiStrip } from "./coverage-kpi-strip";
export { ReconcileMatrix } from "./reconcile-matrix";
export {
  formatCoverageRate,
  stateToneClass,
  RECONCILE_STATE_ORDER,
} from "./lib/state-tone";
