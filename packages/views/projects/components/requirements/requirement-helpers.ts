/**
 * Shared classification for C5 需求管理 / C8 验收 / C1 tab badges.
 * All derived from list-projection fields (requirement_status, stage_progress,
 * acceptance_round) — no new API.
 */
import type { Issue, IssueProgressTask, IssueStatusCategory } from "@multica/core/types";
import {
  parseStageProgress,
  stageForRequirementStatus,
  type PipelineStage,
} from "../../../calendar/calendar-helpers";
import { displayTaskTitle, isOpaqueTaskTitle } from "../requirement-drill/requirement-display";

export const PENDING_CONFIRM_STATUSES = new Set(["原型待确认", "拆解待确认"]);
export const IN_PROGRESS_STATUSES = new Set([
  "待触发",
  "执行中",
  "等待模块释放",
  "验收中",
]);
export const DONE_STATUSES = new Set(["已完成", "已取消"]);
export const FAILED_ACCEPTANCE_STATUSES = new Set(["验收失败"]);

export type RequirementBucket = "pending" | "active" | "failed" | "done" | "other";

export function isTopLevelRequirement(issue: Issue): boolean {
  if (issue.parent_issue_id) return false;
  return Boolean(
    issue.requirement_status ||
      issue.start_at ||
      issue.decomposition_confirmed_at ||
      issue.triggered_at ||
      issue.repo_resource_id,
  );
}

export function requirementBucket(issue: Issue): RequirementBucket {
  const status = issue.requirement_status ?? "";
  if (PENDING_CONFIRM_STATUSES.has(status)) return "pending";
  if (FAILED_ACCEPTANCE_STATUSES.has(status)) return "failed";
  if (DONE_STATUSES.has(status)) return "done";
  if (IN_PROGRESS_STATUSES.has(status) || status === "未拆解") return "active";
  return "other";
}

/** Default C5 sort: 待人工处理 > 进行中 > 已完成, then updated_at desc. */
export function compareRequirements(a: Issue, b: Issue): number {
  const rank: Record<RequirementBucket, number> = {
    pending: 0,
    failed: 1,
    active: 2,
    other: 3,
    done: 4,
  };
  const delta = rank[requirementBucket(a)] - rank[requirementBucket(b)];
  if (delta !== 0) return delta;
  return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
}

export function projectRequirements(issues: Issue[], projectId: string): Issue[] {
  return issues
    .filter((issue) => issue.project_id === projectId && isTopLevelRequirement(issue))
    .sort(compareRequirements);
}

export function stageDots(status: string | null | undefined): {
  stage: PipelineStage;
  states: Array<"done" | "on" | "bad" | "todo">;
} {
  const stage = stageForRequirementStatus(status);
  const failed = status === "验收失败";
  const states: Array<"done" | "on" | "bad" | "todo"> = [1, 2, 3, 4].map((n) => {
    if (n < stage) return "done";
    if (n === stage) return failed && n === 4 ? "bad" : "on";
    return "todo";
  });
  return { stage, states };
}

export function childProgress(issue: Issue): { done: number; total: number } | null {
  return parseStageProgress(issue.stage_progress);
}

export function canReflow(issue: Issue): boolean {
  return (
    issue.requirement_status === "验收失败" &&
    (issue.acceptance_round ?? 0) <= 3
  );
}

export function hasAcceptanceScene(issue: Issue): boolean {
  const status = issue.requirement_status ?? "";
  return (
    status === "验收中" ||
    status === "验收失败" ||
    status === "已完成" ||
    (issue.acceptance_round ?? 0) > 0
  );
}

export function acceptanceVerdict(issue: Issue): "pass" | "fail" | "running" | "none" {
  const status = issue.requirement_status ?? "";
  if (status === "已完成") return "pass";
  if (status === "验收失败") return "fail";
  if (status === "验收中") return "running";
  if ((issue.acceptance_round ?? 0) > 0) return "fail";
  return "none";
}

export function formatWindow(issue: Issue): string {
  const start = (issue.start_at ?? issue.start_date ?? "").slice(0, 16).replace("T", " ");
  const end = (issue.due_date ?? "").slice(0, 10);
  if (!start && !end) return "—";
  if (start && end) return `${start} – ${end}`;
  return start || end;
}

/** 展开行标题：不把队列 id / identifier 再当标题重复展示。 */
export function taskRowTitle(task: Issue, untitled: string): string {
  const raw = (task.title ?? "").trim();
  if (raw && !isOpaqueTaskTitle(raw) && raw !== task.identifier) return raw;
  const fallback = displayTaskTitle(raw, "");
  if (fallback && fallback !== task.identifier) return fallback;
  return untitled;
}

/** 子任务进度：优先 stage_progress / 进度树待办，没有数字就不编造分数。 */
export function taskRowProgress(
  task: Issue,
  progress?: IssueProgressTask,
): { done: number; total: number } | null {
  if (progress && progress.todos_progress.total > 0) {
    return {
      done: progress.todos_progress.done,
      total: progress.todos_progress.total,
    };
  }
  return parseStageProgress(task.stage_progress);
}

export function matchChildProgress(
  task: Issue,
  rows: IssueProgressTask[],
): IssueProgressTask | undefined {
  const title = (task.title ?? "").trim().toLowerCase();
  if (!title) return undefined;
  return rows.find((row) => row.title.trim().toLowerCase() === title);
}

/** 没有 N/M 时用状态画条，不显示假分数。 */
export function taskProgressPercent(
  category: IssueStatusCategory | null | undefined,
  fraction: { done: number; total: number } | null,
): number {
  if (fraction && fraction.total > 0) {
    return Math.round((Math.min(fraction.done, fraction.total) / fraction.total) * 100);
  }
  switch (category) {
    case "done":
      return 100;
    case "in_review":
      return 70;
    case "in_progress":
      return 45;
    case "blocked":
      return 20;
    default:
      return 0;
  }
}
