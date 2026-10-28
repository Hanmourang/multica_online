"use client";

// 资产统计概览条：数字卡（总数 / 已标阶段 / 未标阶段 / 未打标签）+ 阶段占比
// 堆叠条。数据来自当前筛选下的全量 items（前端 pageSize 拉全），
// 与列表分页解耦，纯展示无写操作。「分类」字段已按产品要求下线，
// 分布维度改由生命周期阶段驱动。

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
  S1: "bg-violet-500",
  S2: "bg-sky-500",
  S3: "bg-amber-500",
  S4: "bg-emerald-500",
  S5: "bg-teal-500",
  general: "bg-slate-400",
};

function StatTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border border-surface-border bg-card px-3 py-2">
      <span className={`text-body-lg font-semibold tabular-nums ${tone}`}>{value}</span>
      <span className="truncate text-micro text-muted-foreground">{label}</span>
    </div>
  );
}

export function AssetStatsBar({ items }: { items: AssetBinding[] }) {
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

  if (stats.total === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <StatTile label={t(($) => $.stats.total)} value={stats.total} tone="text-foreground" />
        <StatTile label={t(($) => $.stats.staged)} value={stats.staged} tone="text-sky-600 dark:text-sky-400" />
        <StatTile label={t(($) => $.stats.unstaged)} value={stats.unstaged} tone={stats.unstaged > 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"} />
        <StatTile label={t(($) => $.stats.untagged)} value={stats.untagged} tone={stats.untagged > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-surface-border bg-card px-3 py-2">
        {/* 阶段占比堆叠条 + 图例（分类分布已随「分类」字段下线，改按生命周期阶段） */}
        <div className="flex min-w-52 flex-1 flex-col gap-1.5">
          <span className="text-micro text-muted-foreground">
            {t(($) => $.stats.stage_share, { covered: stats.coveredStages })}
          </span>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            {stats.unstaged > 0 ? (
              <span className="bg-slate-300 dark:bg-slate-600" style={{ width: `${(stats.unstaged / stats.total) * 100}%` }} title={`${t(($) => $.stats.unstaged)}: ${stats.unstaged}`} />
            ) : null}
            {[...STAGE_COUNT_KEYS, "general"].map((stage) => {
              const count = stats.stageCount[stage] ?? 0;
              if (!count) return null;
              return (
                <span
                  key={stage}
                  className={STAGE_DOT_CLASS[stage]}
                  style={{ width: `${(count / stats.total) * 100}%` }}
                  title={`${stage}: ${count}`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {stats.unstaged > 0 ? (
              <span className="inline-flex items-center gap-1 text-micro text-muted-foreground">
                <span className="size-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
                {t(($) => $.stats.unstaged)}
                <span className="font-medium tabular-nums">{stats.unstaged}</span>
              </span>
            ) : null}
            {[...STAGE_COUNT_KEYS, "general"].map((stage) => {
              const count = stats.stageCount[stage] ?? 0;
              if (!count) return null;
              return (
                <span key={stage} className="inline-flex items-center gap-1 text-micro text-muted-foreground">
                  <span className={`size-1.5 rounded-full ${STAGE_DOT_CLASS[stage]}`} />
                  {t(($) => $.stages[stage as (typeof ASSET_LIFECYCLE_STAGES)[number]])}
                  <span className="font-medium tabular-nums">{count}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
