import type { AgentTask } from "@multica/core/types";

/** 任务详情主栏 Tab。默认动态；`?tab=exec` 打开执行日志。 */
export type IssueDetailTab = "activity" | "exec";

export type ActivityFilterKey = "comment" | "status" | "artifact" | "system";

export type ActivityTimeWindow = "today" | "7days" | "all";

export const DEFAULT_ACTIVITY_FILTERS: ReadonlySet<ActivityFilterKey> = new Set([
  "comment",
  "status",
  "artifact",
]);

const ACTIVE_STATUSES = new Set<AgentTask["status"]>([
  "queued",
  "dispatched",
  "waiting_local_directory",
  "waiting_module_lock",
  "running",
]);

const ARTIFACT_ACTIONS = new Set(["task_completed"]);

/** 系统进展只收 heartbeat / 评估类噪音；失败/取消是默认「状态」流里的可操作事件。 */
const SYSTEM_ACTIONS = new Set(["squad_leader_evaluated"]);

export function parseIssueDetailTab(searchParams: URLSearchParams): IssueDetailTab {
  return searchParams.get("tab") === "exec" ? "exec" : "activity";
}

export function parseIssueDetailRunId(searchParams: URLSearchParams): string | null {
  return searchParams.get("run");
}

/** 从本任务 + 子任务运行里挑默认选中项：深链 run > 失败 > 进行中 > 最近一条。 */
export function pickDefaultRun(
  tasks: AgentTask[],
  preferredId?: string | null,
): AgentTask | null {
  if (tasks.length === 0) return null;
  if (preferredId) {
    const preferred = tasks.find((task) => task.id === preferredId);
    if (preferred) return preferred;
  }
  return (
    tasks.find((task) => task.status === "failed") ??
    tasks.find((task) => ACTIVE_STATUSES.has(task.status)) ??
    tasks[0] ??
    null
  );
}

export function failedRunCount(tasks: AgentTask[]): number {
  return tasks.filter((task) => task.status === "failed").length;
}

export function classifyActivityAction(
  action: string | undefined,
): Exclude<ActivityFilterKey, "comment"> | null {
  if (!action) return "status";
  if (ARTIFACT_ACTIONS.has(action)) return "artifact";
  if (SYSTEM_ACTIONS.has(action)) return "system";
  return "status";
}

export function isWithinTimeWindow(
  iso: string,
  window: ActivityTimeWindow,
  now = Date.now(),
): boolean {
  if (window === "all") return true;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return true;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (window === "today") return ts >= start.getTime();
  return ts >= start.getTime() - 6 * 24 * 60 * 60 * 1000;
}

export function latestFailedTask(tasks: AgentTask[]): AgentTask | null {
  const failed = tasks.filter((task) => task.status === "failed");
  if (failed.length === 0) return null;
  return failed.toSorted((a, b) => {
    const at = new Date(a.completed_at ?? a.created_at).getTime();
    const bt = new Date(b.completed_at ?? b.created_at).getTime();
    return bt - at;
  })[0] ?? null;
}
