import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "@multica/core/types";
import { buildCompletionReplyMap } from "./build-completion-reply";

function agentComment(
  id: string,
  content: string,
  created_at: string,
  parent_id: string | null = null,
): TimelineEntry {
  return {
    type: "comment",
    id,
    actor_type: "agent",
    actor_id: "agent-1",
    content,
    parent_id,
    created_at,
  };
}

function completed(id: string, created_at: string): TimelineEntry {
  return {
    type: "activity",
    id,
    actor_type: "agent",
    actor_id: "agent-1",
    action: "task_completed",
    created_at,
  };
}

describe("buildCompletionReplyMap", () => {
  it("maps each task_completed to the latest preceding agent top-level comment", () => {
    const map = buildCompletionReplyMap([
      agentComment("c1", "first reply", "2026-01-01T00:00:00Z"),
      completed("a1", "2026-01-01T01:00:00Z"),
      agentComment("c2", "second reply", "2026-01-01T02:00:00Z"),
      completed("a2", "2026-01-01T03:00:00Z"),
    ]);
    expect(map.get("a1")).toBe("first reply");
    expect(map.get("a2")).toBe("second reply");
  });

  it("records null when no agent comment precedes the completion", () => {
    const map = buildCompletionReplyMap([completed("a1", "2026-01-01T01:00:00Z")]);
    expect(map.get("a1")).toBeNull();
  });

  it("ignores member comments and agent thread replies", () => {
    const map = buildCompletionReplyMap([
      {
        type: "comment",
        id: "m1",
        actor_type: "member",
        actor_id: "user-1",
        content: "member words",
        parent_id: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      agentComment("c1", "agent root", "2026-01-01T00:30:00Z"),
      agentComment("c2", "agent reply in thread", "2026-01-01T00:45:00Z", "c1"),
      completed("a1", "2026-01-01T01:00:00Z"),
    ]);
    expect(map.get("a1")).toBe("agent root");
  });

  it("ignores non-completion activities entirely", () => {
    const map = buildCompletionReplyMap([
      agentComment("c1", "x", "2026-01-01T00:00:00Z"),
      {
        type: "activity",
        id: "s1",
        actor_type: "member",
        actor_id: "user-1",
        action: "status_changed",
        created_at: "2026-01-01T00:30:00Z",
      },
    ]);
    expect(map.size).toBe(0);
  });
});
