/**
 * Calendar C2 helpers — module occupancy, role derivation, trigger labels.
 * Pure functions so calendar-view and schedule-panel share one implementation.
 */
import type { Issue } from "@multica/core/types";
import { dateOnlyToUTCDate } from "@multica/core/issues/date";

export const MODULE_OCCUPYING_STATUSES = new Set(["执行中", "等待模块释放"]);

export type PipelineRole = "pm" | "prototyper" | "developer" | "tester";

/** Current-stage role for the block avatar (prototype f1 anno③). */
export function roleForRequirementStatus(status: string): PipelineRole | null {
  if (status === "原型待确认") return "prototyper";
  if (status === "验收中" || status === "验收失败") return "tester";
  if (status === "执行中" || status === "等待模块释放") return "developer";
  if (status === "未拆解" || status === "拆解待确认" || status === "待触发") return "pm";
  return null;
}

/** Same-module occupier that is not `issue` itself. First match; no daemon scan. */
export function findModuleHolder(issues: Issue[], issue: Issue): Issue | null {
  if (!issue.module_id) return null;
  return (
    issues.find(
      (other) =>
        other.id !== issue.id &&
        !other.parent_issue_id &&
        other.module_id === issue.module_id &&
        Boolean(other.requirement_status) &&
        MODULE_OCCUPYING_STATUSES.has(other.requirement_status!),
    ) ?? null
  );
}

/** 把截止日期对齐到起始日，保留原截止时刻。用于创建表单默认不跨天。 */
export function alignDueToStartDay(startLocal: string, dueLocal: string): string {
  const startDay = startLocal.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay)) return dueLocal;
  const sep = dueLocal.indexOf("T");
  const time = (sep >= 0 ? dueLocal.slice(sep + 1) : "") || "18:00";
  return `${startDay}T${time}`;
}

export function requirementWindow(issue: Issue): { start: Date; end: Date } | null {
  const day = dateOnlyToUTCDate(
    issue.start_at ?? issue.start_date ?? issue.due_date ?? null,
  );
  if (!day) return null;
  return { start: day, end: day };
}

export function windowsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart.getTime() <= bEnd.getTime() && bStart.getTime() <= aEnd.getTime();
}

/** Occupier on the same module whose window overlaps the proposed dates. */
export function findRescheduleConflict(
  issues: Issue[],
  issue: Issue,
  nextStart: Date,
  nextEnd: Date,
): Issue | null {
  if (!issue.module_id) return null;
  for (const other of issues) {
    if (other.id === issue.id || other.parent_issue_id) continue;
    if (other.module_id !== issue.module_id) continue;
    if (
      !other.requirement_status ||
      !MODULE_OCCUPYING_STATUSES.has(other.requirement_status)
    ) {
      continue;
    }
    const win = requirementWindow(other);
    if (win && windowsOverlap(nextStart, nextEnd, win.start, win.end)) return other;
  }
  return null;
}

/** `9/12 09:00` from an RFC3339 start_at (UTC), for the auto-trigger badge. */
export function formatTriggerLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `stage_progress` is the server projection `"N/M"` (stage-3 done/total). */
export function parseStageProgress(
  value: string | null | undefined,
): { done: number; total: number } | null {
  if (!value) return null;
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim());
  if (!match) return null;
  const done = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return { done, total };
}

export function showsTriggerLabel(issue: Issue): boolean {
  if (issue.triggered_at) return false;
  const status = issue.requirement_status ?? "";
  if (status === "待触发") return true;
  return Boolean(issue.decomposition_confirmed_at) && status !== "执行中";
}

/** 10 态 → 工作台四阶段（B1 点色块 / 待确认 chip 定面板）。 */
export type PipelineStage = 1 | 2 | 3 | 4;

export function stageForRequirementStatus(
  status: string | null | undefined,
): PipelineStage {
  switch (status) {
    case "原型待确认":
      return 1;
    case "未拆解":
    case "拆解待确认":
      return 2;
    case "待触发":
    case "执行中":
    case "等待模块释放":
      return 3;
    case "验收中":
    case "验收失败":
    case "已完成":
    case "已取消":
      return 4;
    default:
      return 2;
  }
}

/** B3 创建后第一落点：启用原型师 → S1，否则 S2。 */
export function firstWorkbenchStage(prototyperEnabled: boolean): PipelineStage {
  return prototyperEnabled ? 1 : 2;
}

/** B1 底栏状态点图例（与色块 STATUS_ICON 同源）。 */
export const PIPELINE_STATUS_LEGEND = [
  "未拆解",
  "原型待确认",
  "拆解待确认",
  "待触发",
  "执行中",
  "验收中",
  "等待模块释放",
  "已完成",
] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 同模块占用方结束后的第一天空窗，给改期拒绝 toast 一个可落区间。
 * 窗长沿用 spanDays（同日改期传 0）。
 */
export function suggestFreeWindow(
  issues: Issue[],
  issue: Issue,
  spanDays: number,
): { start: Date; end: Date } | null {
  if (!issue.module_id) return null;
  let latest = 0;
  for (const other of issues) {
    if (other.id === issue.id || other.parent_issue_id) continue;
    if (other.module_id !== issue.module_id) continue;
    if (
      !other.requirement_status ||
      !MODULE_OCCUPYING_STATUSES.has(other.requirement_status)
    ) {
      continue;
    }
    const win = requirementWindow(other);
    if (win && win.end.getTime() > latest) latest = win.end.getTime();
  }
  if (!latest) return null;
  const start = new Date(latest + MS_PER_DAY);
  const length = Math.max(0, spanDays);
  const end = new Date(start.getTime() + length * MS_PER_DAY);
  return { start, end };
}
