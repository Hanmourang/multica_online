"use client";

import { Ban, Check, Loader2, X } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import type { ChatMessageDispatch, GroupPendingAgentTask } from "@multica/core/types";
import { useT } from "../../i18n";

/**
 * A group task is settled once an assistant message already carries its id.
 * The pending cache can still list it as running: a refetch that started
 * before the task finished may land after `chat:done` removed it, and that
 * query never expires. The reply on screen is the newer fact.
 */
export function visibleGroupPendingTasks(
  tasks: GroupPendingAgentTask[] | undefined,
  messages: ReadonlyArray<{ role: string; task_id?: string | null }>,
): GroupPendingAgentTask[] | undefined {
  if (!tasks?.length) return tasks;
  const settled = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.task_id) settled.add(message.task_id);
  }
  if (settled.size === 0) return tasks;
  return tasks.filter((task) => !settled.has(task.task_id));
}

/**
 * Group parallel-dispatch status line (plan 20261025 §6). A group send
 * fans out one independent task per @-mentioned agent and they run
 * concurrently, so the footer pill cannot be the legacy single-task timer —
 * it renders one per-agent stage instead. Labels stay coarse (queued /
 * running / finishing): per-task tool timelines belong to the daemon stream,
 * not this aggregate row, and a fan-out of N live streams would multiply
 * query load for no user-facing signal.
 *
 * `agentNames` resolves an agent id to its display name from the roster
 * (session.participants / chatParticipantsOptions); an id with no name yet
 * (a just-added agent whose roster row hasn't landed) degrades to a generic
 * "Agent" label rather than a raw uuid.
 */
type GroupStage =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "blocked";

const STAGE_KEYS: Record<string, GroupStage> = {
  queued: "queued",
  dispatched: "running",
  running: "running",
  waiting: "waiting",
  waiting_local_directory: "waiting",
  deferred: "queued",
  completed: "completed",
  failed: "failed",
  blocked: "blocked",
};

const DOCK_STYLES: Record<GroupStage, string> = {
  queued: "border-amber-200 bg-amber-50 text-amber-800",
  running: "border-violet-200 bg-violet-50 text-violet-800",
  waiting: "border-slate-200 bg-slate-50 text-slate-700",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  failed: "border-red-200 bg-red-50 text-red-800",
  blocked: "border-slate-300 bg-slate-100 text-slate-700",
};

function StageIcon({ stage }: { stage: GroupStage }) {
  if (stage === "running") return <Loader2 className="size-3 animate-spin" />;
  if (stage === "completed") return <Check className="size-3" />;
  if (stage === "failed") return <X className="size-3" />;
  if (stage === "blocked") return <Ban className="size-3" />;
  return <span className="size-1.5 rounded-full bg-current" />;
}

export function GroupPendingPills({
  tasks,
  agentNames,
  variant = "list",
}: {
  tasks: GroupPendingAgentTask[];
  agentNames?: Map<string, string>;
  /** `dock` sits above the composer; `list` is the older stacked line. */
  variant?: "list" | "dock";
}) {
  const { t } = useT("chat");
  if (tasks.length === 0) return null;
  return (
    <div
      className={
        variant === "dock"
          ? "flex flex-wrap items-center gap-1.5"
          : "flex flex-col gap-1 px-1 text-caption text-muted-foreground"
      }
      aria-live="polite"
    >
      {tasks.map((task) => {
        const stage = STAGE_KEYS[task.status] ?? "queued";
        const name = agentNames?.get(task.agent_id) ?? t(($) => $.status_pill.group.agent_fallback);
        const label = t(($) => $.status_pill.group.stages[stage]);
        if (variant === "dock") {
          return (
            <span
              key={task.task_id}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-micro font-medium",
                DOCK_STYLES[stage],
              )}
            >
              <StageIcon stage={stage} />
              {name} · {label}
            </span>
          );
        }
        return (
          <div key={task.task_id} className="flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="min-w-0 truncate font-medium">{name}</span>
            <span>·</span>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Persisted per-agent fan-out outcomes of a group send.
 *
 * The send response only reports the initial queue/block decision, so the
 * outcome of each dispatched agent lives on the triggering message as a
 * persisted row (server: chat_message_dispatch). Rendering it next to the
 * message keeps the fan-out auditable after the live pill is gone: who
 * answered, who failed, and who was never allowed to run.
 *
 * The row is a plain status pill, not a live task line — a settled outcome
 * must not spin. When the same task is still in flight, the caller hands in
 * the live status instead of the persisted one (the persisted row lags the
 * daemon until the task settles).
 */
export function GroupDispatchPills({
  dispatches,
  agentNames,
}: {
  dispatches: ChatMessageDispatch[];
  agentNames?: Map<string, string>;
}) {
  const { t } = useT("chat");
  if (dispatches.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {dispatches.map((dispatch, index) => {
        const stage = STAGE_KEYS[dispatch.status] ?? "queued";
        const name =
          agentNames?.get(dispatch.agent_id) ??
          t(($) => $.status_pill.group.agent_fallback);
        const label = t(($) => $.status_pill.group.stages[stage]);
        return (
          <span
            key={dispatch.task_id ?? `${dispatch.agent_id}-${index}`}
            title={dispatch.reason ?? undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-micro font-medium",
              DOCK_STYLES[stage],
            )}
          >
            <StageIcon stage={stage} />
            {name} · {label}
          </span>
        );
      })}
    </div>
  );
}
