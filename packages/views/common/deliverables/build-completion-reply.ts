import type { TimelineEntry } from "@multica/core/types";

/**
 * For every `task_completed` activity in the timeline, the text of the most
 * recent top-level agent comment at or before it — the "completion reply"
 * whose backtick file paths the deliverables wall merges with trace-derived
 * files. Keyed by the activity entry id.
 *
 * Only top-level comments count: a threaded reply is conversation, not the
 * run's completion message. Member comments never count. Coalescing keeps the
 * newest entry per run of identical activities (id included), so the id used
 * here is the one the timeline actually renders.
 */
export function buildCompletionReplyMap(
  timeline: TimelineEntry[],
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  let lastAgentReply: string | null = null;
  for (const entry of timeline) {
    if (
      entry.type === "comment" &&
      entry.actor_type === "agent" &&
      !entry.parent_id
    ) {
      lastAgentReply = entry.content ?? null;
    } else if (entry.type === "activity" && entry.action === "task_completed") {
      map.set(entry.id, lastAgentReply);
    }
  }
  return map;
}
