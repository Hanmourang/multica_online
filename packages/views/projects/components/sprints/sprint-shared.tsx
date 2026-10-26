"use client";

import type { Sprint, SprintStatus } from "@multica/core/types";
import { useT } from "../../../i18n";

/**
 * 迭代视图的共享件：状态徽标样式、日期区间格式化、后端错误码 → 文案映射。
 * 侧边栏卡片 / 详情头部 / 泳道 / 编排层都读这一份，避免同一状态色板
 * 在双栏布局里长第二套。
 */

/** 后端 409 code → 已解析的本地化文案；未识别 code 走 fallback。 */
export function sprintErrorText(
  code: string | undefined,
  opts: { fallback: string; invalidState: string; nameExists?: string },
): string {
  if (code === "sprint_name_exists") return opts.nameExists ?? opts.fallback;
  if (
    code === "sprint_not_planned" ||
    code === "sprint_not_active" ||
    code === "sprint_not_completed" ||
    code === "sprint_completed"
  ) {
    return opts.invalidState;
  }
  return opts.fallback;
}

export const statusStyles: Record<SprintStatus, string> = {
  planned: "bg-muted text-muted-foreground",
  active: "bg-primary/15 text-primary",
  completed: "bg-success/15 text-success",
};

export function SprintStatusBadge({ sprint }: { sprint: Sprint }) {
  const { t } = useT("sprints");
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-micro ${statusStyles[sprint.status]}`}
    >
      {t(($) => $.status[sprint.status])}
    </span>
  );
}

/** 单边缺失也画可得部分（"…" 占位），两端都空返回 null 由调用方给占位文案。 */
export function formatRange(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  return `${start ?? "…"} → ${end ?? "…"}`;
}
