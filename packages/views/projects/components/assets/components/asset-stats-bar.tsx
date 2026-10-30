"use client";

// 资产统计概览条：单行紧凑条（总数 / 已标阶段 / 未标阶段 / 未打标签 + 阶段占比
// 堆叠条）。数据来自当前筛选下的全量 items（前端 pageSize 拉全），
// 与列表分页解耦，纯展示无写操作。「分类」字段已按产品要求下线，
// 分布维度改由生命周期阶段驱动。
// 版式：原先两行卡片（实测 131px）把列表首屏挤掉一半，现压成一行
// （≈38px）；明细图例只在 @4xl 以上容器里补齐，窄面板靠 tooltip。

import { useMemo } from "react";
import type { AssetBinding, AssetLifecycleStage } from "@multica/core/types";
import { ASSET_LIFECYCLE_STAGES } from "@multica/core/types";
import { useT } from "../../../../i18n";

// 阶段计数键从 Core 共享五阶段数组派生（五阶段对齐 plan §6.2）；
// general/NULL 计入已标阶段但不计入堆叠条的五段展示（单独归入未标段）。
const STAGE_COUNT_KEYS = ASSET_LIFECYCLE_STAGES.filter(
  (stage): stage is Exclude<AssetLifecycleStage, "general"> => stage !== "general",
);

// 堆叠条/图例实心色相与表格阶段徽标 STAGE_TONES 同源（violet/sky/amber/emerald/teal）。
const STAGE_DOT_CLASS: Record<string, string> = {
  S0: "bg-fuchsia-500",
  S1: "bg-violet-500",
  S2: "bg-sky-500",
  S3: "bg-amber-500",
  S4: "bg-emerald-500",
  S5: "bg-teal-500",
  general: "bg-slate-400",
};

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`text-label font-semibold tabular-nums ${tone}`}>{value}</span>
      <span className="text-micro text-muted-foreground">{label}</span>
    </span>
  );
}

const STATS_BAR_CLASS =
  "@container flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-surface-border bg-card px-3 py-2";

export function AssetStatsBar({
  items,
  pending = false,
}: {
  items: AssetBinding[];
  /** 全量数据尚未到达。此时占位同高度的骨架而不是直接不渲染：统计条一旦
   *  塔陷，下方的表格盒子就会临时变高，「排满一页」的首测会多算一行。 */
  pending?: boolean;
}) {
  const { t } = useT("assets");

  const stats = useMemo(() => {
    const total = items.length;
    let staged = 0;
    let untagged = 0;
    const stageCount: Record<string, number> = Object.fromEntries(
      [...STAGE_COUNT_KEYS, "general"].map((stage) => [stage, 0]),
    );
    for (const item of items) {
      const stage = item.lifecycle_stage;
      if (stage && stage in stageCount) {
        staged += 1;
        stageCount[stage] = (stageCount[stage] ?? 0) + 1;
      }
      if (!item.tags?.length) untagged += 1;
    }
    const coveredStages = STAGE_COUNT_KEYS.filter((stage) => (stageCount[stage] ?? 0) > 0).length;
    return { total, unstaged: total - staged, staged, untagged, stageCount, coveredStages };
  }, [items]);

  if (stats.total === 0) {
    if (!pending) return null;
    // 与真实条目同一套字号 / 间距，只把内容设为不可见，高度就会一致。
    return (
      <div className={STATS_BAR_CLASS} data-testid="asset-stats-bar-skeleton" aria-hidden>
        <div className="invisible flex flex-wrap items-center gap-x-4 gap-y-1">
          <Metric label={t(($) => $.stats.total)} value={0} tone="text-foreground" />
          <Metric label={t(($) => $.stats.staged)} value={0} tone="text-sky-600" />
          <Metric label={t(($) => $.stats.unstaged)} value={0} tone="text-rose-600" />
          <Metric label={t(($) => $.stats.untagged)} value={0} tone="text-amber-600" />
        </div>
        <div className="invisible flex min-w-40 flex-1 items-center gap-2">
          <span className="shrink-0 text-micro text-muted-foreground">
            {t(($) => $.stats.stage_share, { covered: 0 })}
          </span>
          <div className="h-1.5 min-w-16 flex-1 rounded-full bg-muted" />
        </div>
        <div className="invisible hidden items-center gap-x-3 @4xl:flex">
          <span className="text-micro text-muted-foreground">--</span>
        </div>
      </div>
    );
  }

  const segments: Array<{ key: string; label: string; count: number; dot: string }> = [
    { key: "unstaged", label: t(($) => $.stats.unstaged), count: stats.unstaged, dot: "bg-slate-300 dark:bg-slate-600" },
    ...[...STAGE_COUNT_KEYS, "general"].map((stage) => ({
      key: stage,
      label: t(($) => $.stages[stage as (typeof ASSET_LIFECYCLE_STAGES)[number]]),
      count: stats.stageCount[stage] ?? 0,
      dot: STAGE_DOT_CLASS[stage] ?? "bg-slate-400",
    })),
  ].filter((segment) => segment.count > 0);

  return (
    <div
      className={STATS_BAR_CLASS}
      data-testid="asset-stats-bar"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Metric label={t(($) => $.stats.total)} value={stats.total} tone="text-foreground" />
        <Metric
          label={t(($) => $.stats.staged)}
          value={stats.staged}
          tone="text-sky-600 dark:text-sky-400"
        />
        <Metric
          label={t(($) => $.stats.unstaged)}
          value={stats.unstaged}
          tone={stats.unstaged > 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}
        />
        <Metric
          label={t(($) => $.stats.untagged)}
          value={stats.untagged}
          tone={stats.untagged > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}
        />
      </div>

      {/* 阶段占比堆叠条：窄面板只留条形 + 覆盖度，@4xl 起补明细图例。 */}
      <div className="flex min-w-40 flex-1 items-center gap-2">
        <span className="shrink-0 text-micro text-muted-foreground">
          {t(($) => $.stats.stage_share, { covered: stats.coveredStages })}
        </span>
        <div className="flex h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-muted">
          {segments.map((segment) => (
            <span
              key={segment.key}
              className={segment.dot}
              style={{ width: `${(segment.count / stats.total) * 100}%` }}
              title={`${segment.label}: ${segment.count}`}
            />
          ))}
        </div>
      </div>

      <div className="hidden items-center gap-x-3 gap-y-1 @4xl:flex @4xl:flex-wrap">
        {segments.map((segment) => (
          <span
            key={segment.key}
            className="inline-flex items-center gap-1 text-micro text-muted-foreground"
          >
            <span className={`size-1.5 rounded-full ${segment.dot}`} />
            {segment.label}
            <span className="font-medium tabular-nums">{segment.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
