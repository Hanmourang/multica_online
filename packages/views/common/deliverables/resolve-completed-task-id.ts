import type { AgentTask } from "@multica/core/types/agent";
import type { TimelineEntry } from "@multica/core/types/activity";

/**
 * The activity writer and the task-status updater run on different clocks,
 * and the activity row is inserted in the same breath as the task flips to
 * completed — a few seconds of slack absorbs that ordering without letting
 * a genuinely later run match.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

/**
 * Which run does a `task_completed` activity refer to? New servers write
 * `details.task_id` and that always wins. Historical rows predate that
 * field (their details are `{}`), so fall back to the issue's task list:
 * the same agent's most recently completed task whose completion is not
 * (meaningfully) after the activity. Returns undefined when nothing
 * qualifies — the wall simply doesn't render, exactly as before.
 */
export function resolveCompletedTaskId(
  entry: Pick<TimelineEntry, "details" | "actor_id" | "created_at">,
  tasks: readonly AgentTask[] | undefined,
): string | undefined {
  const explicit = entry.details?.task_id;
  if (typeof explicit === "string" && explicit !== "") return explicit;
  if (!tasks || tasks.length === 0) return undefined;

  const activityAt = Date.parse(entry.created_at);
  if (Number.isNaN(activityAt)) return undefined;
  const deadline = activityAt + CLOCK_SKEW_TOLERANCE_MS;

  let best: AgentTask | undefined;
  let bestAt = -Infinity;
  for (const t of tasks) {
    if (t.agent_id !== entry.actor_id) continue;
    if (t.status !== "completed" || t.completed_at == null) continue;
    const completedAt = Date.parse(t.completed_at);
    if (Number.isNaN(completedAt) || completedAt > deadline) continue;
    if (completedAt > bestAt) {
      best = t;
      bestAt = completedAt;
    }
  }
  return best?.id;
}
