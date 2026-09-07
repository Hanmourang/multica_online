/** Opaque agent-queue titles like "Task 01a077a8", "#12 Task ab12cd", or bare hex ids. */
const OPAQUE_TASK_TITLE = /^(#\d+\s+)?(task\s+)?[0-9a-f]{6,}$/i;
const ISSUE_NUMBER_ONLY = /^#\d+$/;

export function isOpaqueTaskTitle(title: string | null | undefined): boolean {
  const value = (title ?? "").trim();
  if (!value) return true;
  if (ISSUE_NUMBER_ONLY.test(value)) return true;
  return OPAQUE_TASK_TITLE.test(value);
}

export function truncateLabel(title: string, max: number): string {
  const value = title.trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** Prefer a human title; never surface queue-id fallbacks. */
export function displayTaskTitle(
  title: string | null | undefined,
  fallback: string,
): string {
  const value = (title ?? "").trim();
  if (!value || isOpaqueTaskTitle(value)) return fallback;
  return value;
}

const RUN_STATUS_KEY: Record<string, string> = {
  queued: "queued",
  dispatched: "dispatched",
  running: "running",
  completed: "completed",
  failed: "failed",
  stalled: "stalled",
  cancelled: "cancelled",
  in_review: "in_review",
  in_progress: "in_progress",
  todo: "todo",
  done: "done",
  blocked: "blocked",
};

export function runStatusKey(status: string): string {
  return RUN_STATUS_KEY[status] ?? status;
}

export function needsQuickConfirm(input: {
  status?: string | null;
  statusCategory?: string | null;
  requirementStatus?: string | null;
  inboxType?: string | null;
}): boolean {
  const req = input.requirementStatus ?? "";
  if (req === "拆解待确认" || req === "原型待确认") return true;
  if (input.status === "in_review" || input.statusCategory === "in_review") return true;
  return (
    input.inboxType === "review_requested" ||
    input.inboxType === "task_completed" ||
    input.inboxType === "agent_completed"
  );
}
