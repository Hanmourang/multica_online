/**
 * Task statuses that mean "a run is still going".
 *
 * A 200 from POST /api/tasks/{id}/cancel does NOT prove the run stopped:
 * `CancelAgentTaskByUser` only transitions a fixed set (queued, dispatched,
 * running, waiting_local_directory, deferred) and `CancelTaskWithResult`
 * answers with the *untouched* row when nothing matched — e.g.
 * `waiting_module_lock` is outside that set. Every Stop surface therefore has
 * to read the returned status back instead of trusting the HTTP code, or the
 * UI reports a stop that never happened while the pill keeps counting up.
 */
const LIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "dispatched",
  "running",
  "waiting_local_directory",
  "waiting_module_lock",
  "deferred",
]);

export function isLiveTaskStatus(status: string | null | undefined): boolean {
  return !!status && LIVE_TASK_STATUSES.has(status);
}

/**
 * HTTP status of a failed request, or null when the error is not an API error.
 *
 * Read structurally rather than via `instanceof ApiError`: this helper is
 * shared by surfaces whose tests (and embedded hosts) mock `@multica/core/api`
 * with only the members they exercise, and a missing constructor would turn a
 * plain failure into a crash inside the Stop handler.
 */
function apiStatusOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * Whether a failed Stop deserves its own copy. 403 is the only failure the
 * user can act on ("not your task" — the server only lets the creator stop a
 * direct-agent run), so it does not get the generic retry line.
 */
export function isStopForbidden(err: unknown): boolean {
  return apiStatusOf(err) === 403;
}

/**
 * A 404 means the server knows no such task: it already finished, or another
 * surface cancelled it. Restoring the cached pending entry in that case
 * resurrects a Stop pill for a run that no longer exists and wedges the
 * composer until the next poll, so callers drop the entry instead.
 */
export function isTaskGone(err: unknown): boolean {
  return apiStatusOf(err) === 404;
}
