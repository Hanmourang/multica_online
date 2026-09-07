import type {
  DynamicsDay,
  DynamicsEvent,
  DynamicsEventType,
  IssueProgressRun,
  IssueProgressTask,
  IssueProgressTodo,
} from "@multica/core/types";

export type TimeWindow = "today" | "7days" | "all";

/** 事件类型 × 子任务 × 时间窗 — 与原型 C6-1 组合过滤一致。 */
export function filterDays(
  days: DynamicsDay[],
  opts: {
    selectedTasks: Set<string>;
    selectedTypes: Set<DynamicsEventType>;
    selectedAgent: string | null;
    timeWindow: TimeWindow;
    taskAgentMap: { id: string; agent: string }[];
    now?: Date;
  },
): DynamicsDay[] {
  const now = opts.now ?? new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  return days
    .map((day) => {
      if (opts.timeWindow === "today" && day.date !== todayStr) return null;
      if (opts.timeWindow === "7days" && day.date < sevenDaysAgo) return null;

      const filtered = day.events.filter((ev) => {
        if (!opts.selectedTypes.has(ev.type)) return false;
        if (opts.selectedTasks.size > 0 && ev.task_id && !opts.selectedTasks.has(ev.task_id)) {
          return false;
        }
        if (opts.selectedTasks.size > 0 && !ev.task_id) return false;
        if (opts.selectedAgent) {
          const taskAgent = ev.task_id
            ? opts.taskAgentMap.find((task) => task.id === ev.task_id)?.agent
            : null;
          if (taskAgent !== opts.selectedAgent && ev.actor_name !== opts.selectedAgent) {
            return false;
          }
        }
        return true;
      });

      if (filtered.length === 0) return null;
      return { ...day, events: filtered };
    })
    .filter((day): day is DynamicsDay => day !== null);
}

export function countEventTypes(
  days: DynamicsDay[],
): Record<DynamicsEventType, number> {
  const counts: Record<DynamicsEventType, number> = {
    conversation: 0,
    progress: 0,
    status: 0,
    artifact: 0,
  };
  for (const day of days) {
    for (const event of day.events) {
      counts[event.type] += 1;
    }
  }
  return counts;
}

export function latestEventTs(days: DynamicsDay[]): string | null {
  let latest: string | null = null;
  for (const day of days) {
    for (const event of day.events) {
      if (!latest || event.ts > latest) latest = event.ts;
    }
  }
  return latest;
}

/** 服务端按时间倒序归并；按 days 顺序扫即可拿到该任务最新一条。 */
export function eventsForTask(
  days: DynamicsDay[],
  taskId: string,
): DynamicsEvent[] {
  return days.flatMap((day) =>
    day.events.filter((event) => event.task_id === taskId),
  );
}

export function taskEventStats(days: DynamicsDay[], taskId: string) {
  const events = eventsForTask(days, taskId);
  return {
    conversation: events.filter((event) => event.type === "conversation").length,
    progress: events.filter((event) => event.type === "progress").length,
    artifact: events.filter((event) => event.type === "artifact").length,
    latest: events[0] ?? null,
  };
}

export type VitalityRow = {
  run: IssueProgressRun;
  taskTitle: string;
};

const VITALITY_RANK: Record<string, number> = {
  running: 0,
  dispatched: 1,
  stalled: 2,
  failed: 3,
  queued: 4,
  completed: 5,
  cancelled: 6,
};

/** 运行存活度条：活体 / 失败优先，完成态靠后。 */
export function vitalityRuns(
  tasks: IssueProgressTask[],
  unmatched: IssueProgressRun[],
): VitalityRow[] {
  const rows: VitalityRow[] = [];
  for (const task of tasks) {
    for (const run of task.runs) {
      rows.push({ run, taskTitle: task.title });
    }
  }
  for (const run of unmatched) {
    rows.push({ run, taskTitle: "" });
  }
  return rows.sort((a, b) => {
    const rankA = VITALITY_RANK[a.run.status] ?? 8;
    const rankB = VITALITY_RANK[b.run.status] ?? 8;
    if (rankA !== rankB) return rankA - rankB;
    return (b.run.last_heartbeat_at ?? b.run.started_at).localeCompare(
      a.run.last_heartbeat_at ?? a.run.started_at,
    );
  });
}

export function isTroubleRun(status: string): boolean {
  return status === "failed" || status === "stalled";
}

/** C6-2 待办 vs A3 工具步：tool_trace 是执行细节，不应当成拆解任务。 */
export function partitionProgressTodos(todos: IssueProgressTodo[]): {
  plan: IssueProgressTodo[];
  steps: IssueProgressTodo[];
} {
  const plan: IssueProgressTodo[] = [];
  const steps: IssueProgressTodo[] = [];
  for (const todo of todos) {
    if (todo.source === "tool_trace") steps.push(todo);
    else plan.push(todo);
  }
  return { plan, steps };
}

export type ToolStepKind = "read" | "shell" | "think" | "other";

export function toolStepKind(title: string): ToolStepKind {
  const normalized = title.trim().toLowerCase();
  if (
    normalized === "read" ||
    normalized.startsWith("read_") ||
    normalized.includes("read_file")
  ) {
    return "read";
  }
  if (
    normalized === "shell" ||
    normalized === "terminal" ||
    normalized === "bash" ||
    normalized.includes("shell")
  ) {
    return "shell";
  }
  if (
    normalized === "think" ||
    normalized.includes("think") ||
    normalized.includes("reason")
  ) {
    return "think";
  }
  return "other";
}

export function repoDisplayName(resource: {
  label?: string | null;
  resource_type: string;
  resource_ref: { url?: unknown; local_path?: unknown };
} | null | undefined): string | null {
  if (!resource) return null;
  if (resource.label?.trim()) return resource.label.trim();
  const ref = resource.resource_ref;
  if (resource.resource_type === "github_repo" && typeof ref.url === "string") {
    const leaf = ref.url.replace(/\.git$/, "").split("/").pop();
    return leaf || ref.url;
  }
  if (resource.resource_type === "local_directory" && typeof ref.local_path === "string") {
    const leaf = ref.local_path.split("/").pop();
    return leaf || ref.local_path;
  }
  return null;
}
