import { describe, expect, it } from "vitest";
import type { AgentTask } from "@multica/core/types/agent";
import type { TimelineEntry } from "@multica/core/types/activity";
import { resolveCompletedTaskId } from "./resolve-completed-task-id";

const T0 = "2026-01-18T00:00:00.000Z";

function entry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    type: "activity",
    id: "act-1",
    actor_type: "agent",
    actor_id: "agent-1",
    action: "task_completed",
    created_at: T0,
    ...overrides,
  };
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-a",
    agent_id: "agent-1",
    runtime_id: "",
    issue_id: "issue-1",
    status: "completed",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: "2026-01-17T23:59:59.000Z",
    result: null,
    error: null,
    created_at: "2026-01-17T23:00:00.000Z",
    ...overrides,
  };
}

describe("resolveCompletedTaskId", () => {
  it("prefers the server-written details.task_id when present", () => {
    const e = entry({ details: { task_id: "task-explicit" } });
    expect(resolveCompletedTaskId(e, [task()])).toBe("task-explicit");
    // ...even when no fallback candidate exists at all.
    expect(resolveCompletedTaskId(e, undefined)).toBe("task-explicit");
  });

  it("falls back to the same agent's latest task completed at or before the activity", () => {
    const e = entry({ details: {} });
    expect(resolveCompletedTaskId(e, [task()])).toBe("task-a");
  });

  it("picks the nearest completion when several tasks qualify", () => {
    const e = entry({ details: {} });
    const older = task({ id: "task-old", completed_at: "2026-01-17T20:00:00.000Z" });
    const nearer = task({ id: "task-near", completed_at: "2026-01-17T23:59:59.500Z" });
    expect(resolveCompletedTaskId(e, [older, nearer])).toBe("task-near");
  });

  it("ignores tasks completed after the activity (clock skew tolerance aside)", () => {
    const e = entry({ details: {} });
    const future = task({ completed_at: "2026-01-18T00:01:00.000Z" });
    expect(resolveCompletedTaskId(e, [future])).toBeUndefined();
  });

  it("tolerates small clock skew — a completion a few seconds after the activity still matches", () => {
    const e = entry({ details: {} });
    const skewed = task({ completed_at: "2026-01-18T00:00:03.000Z" });
    expect(resolveCompletedTaskId(e, [skewed])).toBe("task-a");
  });

  it("ignores other agents' tasks and non-completed tasks", () => {
    const e = entry({ details: {} });
    const otherAgent = task({ agent_id: "agent-2" });
    const failed = task({ status: "failed" });
    const noCompletedAt = task({ completed_at: null });
    expect(resolveCompletedTaskId(e, [otherAgent, failed, noCompletedAt])).toBeUndefined();
  });

  it("returns undefined when the task list is unavailable or empty", () => {
    const e = entry({ details: {} });
    expect(resolveCompletedTaskId(e, undefined)).toBeUndefined();
    expect(resolveCompletedTaskId(e, [])).toBeUndefined();
  });
});
