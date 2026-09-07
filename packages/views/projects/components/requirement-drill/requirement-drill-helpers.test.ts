import { describe, expect, it } from "vitest";
import type {
  DynamicsDay,
  DynamicsEvent,
  IssueProgressRun,
  IssueProgressTask,
  IssueProgressTodo,
} from "@multica/core/types";
import {
  countEventTypes,
  eventsForTask,
  filterDays,
  isTroubleRun,
  latestEventTs,
  partitionProgressTodos,
  repoDisplayName,
  taskEventStats,
  toolStepKind,
  vitalityRuns,
} from "./requirement-drill-helpers";

function event(overrides: Partial<DynamicsEvent> = {}): DynamicsEvent {
  return {
    id: overrides.id ?? "e1",
    type: overrides.type ?? "conversation",
    task_id: overrides.task_id ?? "t1",
    run_id: overrides.run_id ?? null,
    actor: overrides.actor ?? "agent",
    actor_name: overrides.actor_name ?? "Orion",
    content: overrides.content ?? "hello",
    ts: overrides.ts ?? "2026-09-06T12:00:00Z",
  };
}

function day(date: string, events: DynamicsEvent[]): DynamicsDay {
  return { date, events };
}

describe("filterDays", () => {
  const days = [
    day("2026-09-06", [
      event({ id: "a", type: "conversation", task_id: "t1" }),
      event({ id: "b", type: "status", task_id: "t3", ts: "2026-09-06T18:00:00Z" }),
      event({ id: "c", type: "artifact", task_id: null, ts: "2026-09-06T10:00:00Z" }),
    ]),
    day("2026-09-01", [event({ id: "d", type: "progress", task_id: "t2", ts: "2026-09-01T08:00:00Z" })]),
  ];
  const types = new Set(["conversation", "progress", "status", "artifact"] as const);
  const now = new Date("2026-09-06T20:00:00Z");

  it("focuses one task and drops events without task_id", () => {
    const filtered = filterDays(days, {
      selectedTasks: new Set(["t3"]),
      selectedTypes: types,
      selectedAgent: null,
      timeWindow: "all",
      taskAgentMap: [
        { id: "t1", agent: "Orion" },
        { id: "t3", agent: "Orion" },
      ],
      now,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.events.map((row) => row.id)).toEqual(["b"]);
  });

  it("applies type × window together", () => {
    const filtered = filterDays(days, {
      selectedTasks: new Set(),
      selectedTypes: new Set(["progress"]),
      selectedAgent: null,
      timeWindow: "today",
      taskAgentMap: [],
      now,
    });
    expect(filtered).toEqual([]);
  });
});

describe("event aggregates", () => {
  const days = [
    day("2026-09-06", [
      event({ id: "a", type: "conversation", task_id: "t3", content: "timeout", ts: "2026-09-06T18:12:00Z" }),
      event({ id: "b", type: "status", task_id: "t3", ts: "2026-09-06T17:00:00Z" }),
    ]),
    day("2026-09-05", [event({ id: "c", type: "artifact", task_id: "t1" })]),
  ];

  it("counts types and latest timestamp", () => {
    expect(countEventTypes(days)).toEqual({
      conversation: 1,
      progress: 0,
      status: 1,
      artifact: 1,
    });
    expect(latestEventTs(days)).toBe("2026-09-06T18:12:00Z");
  });

  it("builds per-task stats from the merged stream", () => {
    const stats = taskEventStats(days, "t3");
    expect(stats.conversation).toBe(1);
    expect(stats.progress).toBe(0);
    expect(stats.artifact).toBe(0);
    expect(stats.latest?.id).toBe("a");
    expect(eventsForTask(days, "t1")).toHaveLength(1);
  });
});

describe("vitalityRuns", () => {
  function run(id: string, status: string): IssueProgressRun {
    return {
      id,
      agent_id: "ag-1",
      cli_kind: "cli",
      status: status as IssueProgressRun["status"],
      token_used: 10,
      started_at: "2026-09-06T10:00:00Z",
      last_heartbeat_at: "2026-09-06T12:00:00Z",
      todos: [],
      todos_progress: { done: 1, total: 3 },
    };
  }

  it("surfaces live and failed runs before completed ones", () => {
    const tasks: IssueProgressTask[] = [
      {
        id: "q1",
        title: "T1 done",
        status: "completed",
        agent_id: "ag-1",
        created_at: "2026-09-01T00:00:00Z",
        runs: [run("r-done", "completed")],
        todos_progress: { done: 5, total: 5 },
      },
      {
        id: "q2",
        title: "T3 stalled",
        status: "failed",
        agent_id: "ag-1",
        created_at: "2026-09-01T00:00:00Z",
        runs: [run("r-stall", "stalled")],
        todos_progress: { done: 1, total: 3 },
      },
    ];
    const rows = vitalityRuns(tasks, [run("r-live", "running")]);
    expect(rows.map((row) => row.run.id)).toEqual(["r-live", "r-stall", "r-done"]);
    expect(isTroubleRun("stalled")).toBe(true);
    expect(isTroubleRun("completed")).toBe(false);
  });
});

describe("partitionProgressTodos", () => {
  function todo(
    overrides: Partial<IssueProgressTodo> & Pick<IssueProgressTodo, "todo_key" | "source">,
  ): IssueProgressTodo {
    return {
      title: overrides.title ?? overrides.todo_key,
      status: overrides.status ?? "done",
      seq: overrides.seq ?? 0,
      phase: overrides.phase ?? null,
      ...overrides,
    };
  }

  it("keeps plan todos and splits tool_trace into A3 steps", () => {
    const { plan, steps } = partitionProgressTodos([
      todo({ todo_key: "P2-T8", source: "reply", title: "时间线组件" }),
      todo({ todo_key: "call-1", source: "tool_trace", title: "read" }),
      todo({ todo_key: "P2-T9", source: "manual", title: "联调" }),
    ]);
    expect(plan.map((item) => item.todo_key)).toEqual(["P2-T8", "P2-T9"]);
    expect(steps.map((item) => item.title)).toEqual(["read"]);
  });
});

describe("toolStepKind", () => {
  it("maps CLI tool names onto A3 step icons", () => {
    expect(toolStepKind("read")).toBe("read");
    expect(toolStepKind("read_file")).toBe("read");
    expect(toolStepKind("shell")).toBe("shell");
    expect(toolStepKind("terminal")).toBe("shell");
    expect(toolStepKind("think")).toBe("think");
    expect(toolStepKind("TodoWrite")).toBe("other");
  });
});

describe("repoDisplayName", () => {
  it("prefers label, then git leaf, then local path leaf", () => {
    expect(
      repoDisplayName({
        label: "payments",
        resource_type: "github_repo",
        resource_ref: { url: "https://git.example/pay.git" },
      }),
    ).toBe("payments");
    expect(
      repoDisplayName({
        label: null,
        resource_type: "github_repo",
        resource_ref: { url: "https://git.example/pay.git" },
      }),
    ).toBe("pay");
    expect(
      repoDisplayName({
        label: null,
        resource_type: "local_directory",
        resource_ref: { local_path: "/tmp/work/app" },
      }),
    ).toBe("app");
  });
});
