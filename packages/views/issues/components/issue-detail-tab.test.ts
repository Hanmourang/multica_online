import { describe, expect, it } from "vitest";
import type { AgentTask } from "@multica/core/types";
import {
  classifyActivityAction,
  failedRunCount,
  isWithinTimeWindow,
  latestFailedTask,
  parseIssueDetailRunId,
  parseIssueDetailTab,
  pickDefaultRun,
} from "./issue-detail-tab";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "completed",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: "2026-09-06T10:00:00Z",
    result: null,
    error: null,
    created_at: "2026-09-06T09:00:00Z",
    ...overrides,
  };
}

describe("issue-detail-tab", () => {
  it("reads tab=exec and run from the query string", () => {
    expect(parseIssueDetailTab(new URLSearchParams())).toBe("activity");
    expect(parseIssueDetailTab(new URLSearchParams("tab=exec"))).toBe("exec");
    expect(parseIssueDetailRunId(new URLSearchParams("tab=exec&run=r1"))).toBe("r1");
  });

  it("prefers the deep-linked run, then a failed run, then an active run", () => {
    const tasks = [
      task({ id: "done", status: "completed" }),
      task({ id: "live", status: "running" }),
      task({ id: "bad", status: "failed" }),
    ];
    expect(pickDefaultRun(tasks, "done")?.id).toBe("done");
    expect(pickDefaultRun(tasks)?.id).toBe("bad");
    expect(pickDefaultRun(tasks.filter((t) => t.id !== "bad"))?.id).toBe("live");
    expect(pickDefaultRun([])).toBeNull();
  });

  it("counts failed runs and picks the newest failure", () => {
    const tasks = [
      task({ id: "old", status: "failed", completed_at: "2026-09-01T00:00:00Z" }),
      task({ id: "new", status: "failed", completed_at: "2026-09-06T00:00:00Z" }),
    ];
    expect(failedRunCount(tasks)).toBe(2);
    expect(latestFailedTask(tasks)?.id).toBe("new");
  });

  it("classifies activity actions for the A2 filter chips", () => {
    expect(classifyActivityAction("status_changed")).toBe("status");
    expect(classifyActivityAction("task_completed")).toBe("artifact");
    expect(classifyActivityAction("task_failed")).toBe("status");
    expect(classifyActivityAction("task_cancelled")).toBe("status");
    expect(classifyActivityAction("squad_leader_evaluated")).toBe("system");
  });

  it("applies the activity time window", () => {
    const now = new Date(2026, 8, 6, 18).getTime();
    expect(isWithinTimeWindow(new Date(2026, 8, 6, 10).toISOString(), "today", now)).toBe(true);
    expect(isWithinTimeWindow(new Date(2026, 8, 1, 10).toISOString(), "today", now)).toBe(false);
    expect(isWithinTimeWindow(new Date(2026, 8, 1, 10).toISOString(), "7days", now)).toBe(true);
    expect(isWithinTimeWindow(new Date(2026, 7, 1, 10).toISOString(), "all", now)).toBe(true);
  });
});
