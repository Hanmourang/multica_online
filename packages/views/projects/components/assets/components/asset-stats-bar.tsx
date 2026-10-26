"use client";

// 资产统计概览条：数字卡（总数 / 知识文档 / 已标阶段 / 未打标签）+ 分类占比
// 堆叠条 + 阶段覆盖点。数据来自当前筛选下的全量 items（前端 pageSize 拉全），
// 与列表分页解耦，纯展示无写操作。

import { useMemo } from "react";
import type { AssetBinding, AssetCategory, AssetLifecycleStage } from "@multica/core/types";
import { ASSET_CATEGORIES, ASSET_LIFECYCLE_STAGES } from "@multica/core/types";
import { useT } from "../../../../i18n";
import { CATEGORY_VISUALS } from "./asset-visuals";

const KNOWLEDGE_CATEGORIES: AssetCategory[] = ["knowledge_repo", "knowledge_group", "other"];

// 阶段计数键从 Core 共享五阶段数组派生（五阶段对齐 plan §6.2）；
// general/NULL 计入已标阶段但不计入覆盖分母。
const STAGE_COUNT_KEYS = ASSET_LIFECYCLE_STAGES.filter(
  (stage): stage is Exclude<AssetLifecycleStage, "general"> => stage !== "general",
);

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
    const byCategory = new Map<AssetCategory, number>();
    let knowledge = 0;
    let staged = 0;
    let untagged = 0;
    const stageCount: Record<string, number> = Object.fromEntries(
      STAGE_COUNT_KEYS.map((stage) => [stage, 0]),
    );
    for (const item of items) {
      byCategory.set(
        item.asset_category,
        (byCategory.get(item.asset_category) ?? 0) + 1,
      );
      if (KNOWLEDGE_CATEGORIES.includes(item.asset_category)) knowledge += 1;
      const stage = item.lifecycle_stage;
      if (stage && stage in stageCount) {
        staged += 1;
        stageCount[stage] = (stageCount[stage] ?? 0) + 1;
      } else if (stage === "general") {
        staged += 1;
      }
      if (!item.tags?.length) untagged += 1;
    }
    const coveredStages = STAGE_COUNT_KEYS.filter((stage) => (stageCount[stage] ?? 0) > 0).length;
    return { total, byCategory, knowledge, staged, untagged, stageCount, coveredStages };
  }, [items]);

  if (stats.total === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <StatTile label={t(($) => $.stats.total)} value={stats.total} tone="text-foreground" />
        <StatTile label={t(($) => $.stats.knowledge)} value={stats.knowledge} tone="text-emerald-600 dark:text-emerald-400" />
        <StatTile label={t(($) => $.stats.staged)} value={stats.staged} tone="text-sky-600 dark:text-sky-400" />
        <StatTile label={t(($) => $.stats.untagged)} value={stats.untagged} tone={stats.untagged > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-surface-border bg-card px-3 py-2">
        {/* 分类占比堆叠条 + 图例 */}
        <div className="flex min-w-52 flex-1 flex-col gap-1.5">
          <span className="text-micro text-muted-foreground">{t(($) => $.stats.share)}</span>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            {ASSET_CATEGORIES.map((cat) => {
              const count = stats.byCategory.get(cat) ?? 0;
              if (!count) return null;
              return (
                <span
                  key={cat}
                  className={CATEGORY_VISUALS[cat]?.dot ?? "bg-slate-500"}
                  style={{ width: `${(count / stats.total) * 100}%` }}
                  title={`${cat}: ${count}`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {ASSET_CATEGORIES.map((cat) => {
              const count = stats.byCategory.get(cat) ?? 0;
              if (!count) return null;
              return (
                <span key={cat} className="inline-flex items-center gap-1 text-micro text-muted-foreground">
                  <span className={`size-1.5 rounded-full ${CATEGORY_VISUALS[cat]?.dot ?? "bg-slate-500"}`} />
                  {t(($) => $.categories[cat])}
                  <span className="font-medium tabular-nums">{count}</span>
                </span>
              );
            })}
          </div>
        </div>

        {/* 阶段覆盖：五阶段计数点 */}
        <div className="flex shrink-0 flex-col gap-1.5">
          <span className="text-micro text-muted-foreground">
            {t(($) => $.stats.coverage, { covered: stats.coveredStages })}
          </span>
          <div className="flex items-center gap-1.5">
            {STAGE_COUNT_KEYS.map((stage) => {
              const count = stats.stageCount[stage] ?? 0;
              return (
                <span
                  key={stage}
                  title={`${stage}: ${count}`}
                  className={`flex h-5 min-w-9 items-center justify-center gap-0.5 rounded-md px-1 text-[10px] font-semibold tabular-nums ${
                    count
                      ? "bg-violet-500/10 text-violet-700 dark:text-violet-300"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {stage}
                  <span className="font-normal">{count}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
