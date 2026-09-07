"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  Clock,
  Cpu,
  Link2Off,
  ListTodo,
  Minus,
  Play,
  Terminal,
  Ticket,
  XCircle,
  Zap,
} from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueProgressOptions } from "@multica/core/agent-runs/queries";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import type {
  Issue,
  IssueProgressRun,
  IssueProgressTask,
  IssueProgressTodo,
} from "@multica/core/types";
import { QuickConfirmButton } from "../../../issues/components/quick-confirm-button";
import {
  displayTaskTitle,
  needsQuickConfirm,
  runStatusKey,
} from "./requirement-display";
import { Badge } from "@multica/ui/components/ui/badge";
import { cn } from "@multica/ui/lib/utils";
import { useT, useTimeAgo } from "../../../i18n";
import { AppLink } from "../../../navigation";
import {
  ArchiveEmpty,
  formatTimestamp,
  QueryError,
  QueryLoading,
} from "../archive/query-states";
import {
  isTroubleRun,
  partitionProgressTodos,
  toolStepKind,
  vitalityRuns,
} from "./requirement-drill-helpers";

/**
 * f9 进度追踪（issue-detail「进度追踪」Tab）。
 *
 * The backend now returns a real three-layer tree — requirement → tasks →
 * runs → todos — joined server-side on agent_run.task_queue_id, with each
 * run's todos embedded (no lazy per-run fetch). This component renders that
 * tree as nested collapsibles:
 *
 *   L1  requirement header + rollup stat strip + overall todo bar
 *   L2  task rows (agent chip · title · status pill · todos n/m · run count),
 *       collapsed when the task is settled (completed/cancelled), expanded
 *       when it is live or in trouble so problems surface first
 *   L3  run cards nested under a dashed tree connector; expanding a run
 *       reveals its meta strip (model/cli/token/heartbeat/stall) + todo list
 *       with three-state glyphs (done ✓ · in_progress ● · pending ○ · failed ✕)
 *
 * Runs that rolled up from a child requirement but whose task lives on another
 * issue arrive in `unmatched_runs` and render in a detached section at the
 * bottom. The stall distribution is real; the weighted score / todo lineage /
 * orphan detection stay honest server-side TODOs (surfaced, never faked).
 */

/** Status → pill tone. Covers both agent_task_queue and agent_run enums. */
const STATUS_TONE: Record<string, string> = {
  queued: "border-border/60 bg-muted/50 text-muted-foreground",
  dispatched: "border-info/30 bg-info/10 text-info",
  running: "border-info/30 bg-info/10 text-info",
  completed: "border-success/30 bg-success/10 text-success",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  stalled: "border-warning/40 bg-warning/10 text-warning",
  cancelled: "border-border/60 bg-muted/50 text-muted-foreground",
};

/** Status → 2px left accent strip on a task card, for at-a-glance scanning. */
const STATUS_ACCENT: Record<string, string> = {
  queued: "border-l-muted-foreground/30",
  dispatched: "border-l-info",
  running: "border-l-info",
  completed: "border-l-success",
  failed: "border-l-destructive",
  stalled: "border-l-warning",
  cancelled: "border-l-muted-foreground/30",
};

const NEUTRAL_PILL = "border-border/60 bg-muted/50 text-muted-foreground";

/** A task/run is "settled" (auto-collapsed) once it can no longer change. */
function isSettled(status: string): boolean {
  return status === "completed" || status === "cancelled";
}

export function ProgressTracker({
  issueId,
  issue,
}: {
  issueId: string;
  issue?: Issue;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();

  const detailQuery = useQuery({
    ...issueDetailOptions(wsId, issueId),
    enabled: !issue,
  });
  const confirmIssue = issue ?? detailQuery.data ?? null;
  const progressQuery = useQuery(issueProgressOptions(wsId, issueId));

  if (progressQuery.isPending) {
    return <QueryLoading rows={4} />;
  }
  if (progressQuery.isError) {
    return (
      <QueryError
        onRetry={() => progressQuery.refetch()}
        message={progressQuery.error.message}
      />
    );
  }

  const {
    issue: progressIssue,
    tasks,
    unmatched_runs: unmatchedRuns,
    stall_distribution: stalls,
  } = progressQuery.data;
  const rollup = progressIssue.rollup;
  const stallEntries = Object.entries(stalls);
  const stallMax = Math.max(1, ...stallEntries.map(([, count]) => count));

  if (tasks.length === 0 && unmatchedRuns.length === 0) {
    return (
      <ArchiveEmpty
        title={t(($) => $.progress.title)}
        description={t(($) => $.progress.tasks_empty)}
        icon={<ListTodo className="size-5" />}
      />
    );
  }

  const overallPct =
    rollup.todos_total > 0
      ? Math.round((rollup.todos_done / rollup.todos_total) * 100)
      : 0;

  return (
    <div className="space-y-4">
      {/* ── L1 · requirement header ─────────────────────────────────── */}
      <div className="rounded-lg border bg-card/30 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body font-semibold">
            {progressIssue.title}
          </span>
          <Badge variant="outline">
            <StatusLabel status={progressIssue.status} />
          </Badge>
          {confirmIssue &&
            needsQuickConfirm({
              status: confirmIssue.status,
              statusCategory: confirmIssue.status_category,
              requirementStatus: confirmIssue.requirement_status,
            }) && (
              <QuickConfirmButton
                issueId={confirmIssue.id}
                onDone={() => void progressQuery.refetch()}
              />
            )}
        </div>

        {/* rollup stat strip — honest sums straight from the server rollup */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
          <StatChip
            icon={<Ticket className="size-3.5" />}
            label={t(($) => $.progress.rollup_tasks, {
              done: rollup.tasks_done,
              total: rollup.tasks_total,
            })}
          />
          <StatChip
            icon={<ListTodo className="size-3.5" />}
            label={t(($) => $.progress.todos_progress, {
              done: rollup.todos_done,
              total: rollup.todos_total,
            })}
          />
          <StatChip
            icon={<Play className="size-3.5" />}
            label={t(($) => $.progress.rollup_active, { n: rollup.runs_active })}
            tone={rollup.runs_active > 0 ? "text-info" : undefined}
          />
          <StatChip
            icon={<AlertTriangle className="size-3.5" />}
            label={t(($) => $.progress.rollup_stalled, {
              n: rollup.runs_stalled,
            })}
            tone={rollup.runs_stalled > 0 ? "text-warning" : undefined}
          />
        </div>

        {/* overall todo completion bar across every run of the requirement */}
        <div className="mt-3 flex items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-success transition-[width] duration-500"
              style={{ width: `${overallPct}%` }}
            />
          </div>
          <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
            {overallPct}%
          </span>
        </div>
      </div>

      <VitalityStrip
        issueId={issueId}
        tasks={tasks}
        unmatched={unmatchedRuns}
        fallbackTitle={progressIssue.title}
      />

      {/* ── L2 · task tree ──────────────────────────────────────────── */}
      <section>
        <SectionLabel icon={<Ticket className="size-3.5" />} count={tasks.length}>
          {t(($) => $.progress.tasks_title)}
        </SectionLabel>
        {tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-caption text-muted-foreground">
            {t(($) => $.progress.tasks_empty)}
          </p>
        ) : (
          <div className="space-y-2">
            {tasks.map((task) => (
              <TaskNode
                key={task.id}
                issueId={issueId}
                task={task}
                fallbackTitle={progressIssue.title}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── detached runs (rolled up but task lives on another issue) ── */}
      {unmatchedRuns.length > 0 && (
        <UnmatchedRuns issueId={issueId} runs={unmatchedRuns} />
      )}

      {/* ── bottom panels: stall distribution (real) + lineage note ─── */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border bg-card/30 px-3 py-2.5">
          <div className="mb-2 flex items-center gap-1.5 text-caption font-medium">
            <CircleDot className="size-3.5 text-muted-foreground" />
            {t(($) => $.progress.stall_title)}
          </div>
          {stallEntries.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.progress.stall_empty)}
            </p>
          ) : (
            <div className="space-y-1.5">
              {stallEntries.map(([reason, count]) => (
                <div key={reason} className="flex items-center gap-2">
                  <span className="w-36 shrink-0 truncate font-mono text-micro text-muted-foreground">
                    {reason}
                  </span>
                  <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-destructive"
                      style={{ width: `${(count / stallMax) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right text-caption tabular-nums">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-dashed px-3 py-2.5">
          <div className="mb-1.5 text-caption font-medium">
            {t(($) => $.progress.lineage_title)}
          </div>
          <p className="text-caption leading-relaxed text-muted-foreground">
            {t(($) => $.progress.lineage_hint)}
          </p>
        </div>
      </div>
    </div>
  );
}

function VitalityStrip({
  issueId,
  tasks,
  unmatched,
  fallbackTitle,
}: {
  issueId: string;
  tasks: IssueProgressTask[];
  unmatched: IssueProgressRun[];
  fallbackTitle: string;
}) {
  const { t } = useT("archive");
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const rows = vitalityRuns(tasks, unmatched).slice(0, 6);
  if (rows.length === 0) return null;

  return (
    <section data-testid="progress-vitality">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-caption font-medium">
          {t(($) => $.progress.vitality)}
        </span>
        <span className="text-micro text-muted-foreground">
          {t(($) => $.progress.vitality_hint)}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map(({ run, taskTitle }) => {
          const pct =
            run.todos_progress.total > 0
              ? Math.round((run.todos_progress.done / run.todos_progress.total) * 100)
              : 0;
          const trouble = isTroubleRun(run.status);
          return (
            <AppLink
              key={run.id}
              href={paths.issueExecLog(issueId, run.id)}
              className={cn(
                "block rounded-lg border bg-card/30 px-2.5 py-2",
                trouble && "border-destructive/40",
                run.status === "completed" && "opacity-70",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-micro font-semibold">
                  {displayTaskTitle(
                    taskTitle,
                    fallbackTitle || t(($) => $.progress.run_label),
                  )}
                </span>
                {run.status === "running" ? (
                  <span className="inline-flex items-center gap-1 text-micro text-info">
                    <span className="size-1.5 rounded-full bg-info animate-pulse" />
                    {run.last_heartbeat_at ? timeAgo(run.last_heartbeat_at) : "—"}
                  </span>
                ) : trouble ? (
                  <span className="text-micro text-destructive">
                    {run.stall_reason || run.status}
                  </span>
                ) : (
                  <StatusPill status={run.status} />
                )}
              </div>
              <div className="mt-1 truncate text-micro text-muted-foreground">
                <AgentName agentId={run.agent_id} />
                <span className="ml-1 tabular-nums">
                  · {t(($) => $.dynamics.token_used, { count: run.token_used })}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      trouble ? "bg-destructive" : "bg-primary",
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-micro tabular-nums text-muted-foreground">
                  {run.todos_progress.done}/{run.todos_progress.total}
                </span>
              </div>
            </AppLink>
          );
        })}
      </div>
    </section>
  );
}

/** Compact rollup stat: icon + label, tinted when the metric needs attention. */
function StatChip({
  icon,
  label,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  tone?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-background/40 px-2 py-1 text-micro font-medium tabular-nums",
        tone ?? "text-muted-foreground",
      )}
    >
      {icon}
      {label}
    </span>
  );
}

/** Section heading with an optional trailing count. */
function SectionLabel({
  icon,
  count,
  children,
}: {
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-caption font-medium text-foreground">
      <span className="text-muted-foreground">{icon}</span>
      {children}
      {count !== undefined && (
        <span className="text-micro tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </div>
  );
}

/**
 * L2 · one task row. Collapsible gate to its runs. Settled tasks start
 * collapsed; live / failed tasks start expanded so trouble surfaces first.
 */
function TaskNode({
  issueId,
  task,
  fallbackTitle,
}: {
  issueId: string;
  task: IssueProgressTask;
  fallbackTitle: string;
}) {
  const { t } = useT("archive");
  const paths = useWorkspacePaths();
  const [expanded, setExpanded] = useState(() => !isSettled(task.status));
  const title = displayTaskTitle(
    task.title,
    fallbackTitle || t(($) => $.progress.tasks_title),
  );

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-l-2 bg-card/30",
        STATUS_ACCENT[task.status] ?? "border-l-muted-foreground/30",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/40"
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            !expanded && "-rotate-90",
          )}
        />
        <StatusPill status={task.status} />
        <AgentChip agentId={task.agent_id} />
        <span
          className="min-w-0 flex-1 truncate text-caption font-medium"
          title={title}
        >
          {title}
        </span>
        <span
          className="hidden shrink-0 items-center gap-1 text-micro tabular-nums text-muted-foreground sm:flex"
          title={t(($) => $.progress.todos_progress, {
            done: task.todos_progress.done,
            total: task.todos_progress.total,
          })}
        >
          <ListTodo className="size-3" />
          {task.todos_progress.done}/{task.todos_progress.total}
        </span>
        <span
          className="flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-1.5 py-0.5 text-micro tabular-nums text-muted-foreground"
          title={t(($) => $.progress.task_runs, { n: task.runs.length })}
        >
          <Play className="size-3" />
          {task.runs.length}
        </span>
        {isTroubleRun(task.status) && task.runs[0] && (
          <AppLink
            href={paths.issueExecLog(issueId, task.runs[0].id)}
            onClick={(event) => event.stopPropagation()}
          >
            <span className="shrink-0 text-micro text-destructive hover:underline">
              {t(($) => $.progress.retry_reassign)}
            </span>
          </AppLink>
        )}
      </button>

      {expanded && (
        <div className="animate-in fade-in slide-in-from-top-1 border-t bg-background/20 px-3 py-2.5 duration-200">
          {task.runs.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.progress.task_no_runs)}
            </p>
          ) : (
            /* dashed left connector reinforces the task → run tree edge */
            <div className="space-y-2 border-l border-dashed border-border/60 pl-3">
              {task.runs.map((run) => (
                <RunCard key={run.id} issueId={issueId} run={run} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AgentName({ agentId }: { agentId: string }) {
  const { getActorName } = useActorName();
  const name = agentId ? getActorName("agent", agentId) : "";
  return <span className="truncate">{name || "—"}</span>;
}

/** Small agent identity chip; uses the workspace actor name, never a raw UUID. */
function AgentChip({ agentId }: { agentId: string }) {
  const { getActorName } = useActorName();
  const name = agentId ? getActorName("agent", agentId) : "";
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-micro text-muted-foreground"
      title={name || agentId}
    >
      <Bot className="size-3" />
      <span className="max-w-24 truncate">{name || "—"}</span>
    </span>
  );
}

function StatusLabel({ status }: { status: string }) {
  const { t } = useT("archive");
  switch (runStatusKey(status)) {
    case "queued":
      return t(($) => $.progress.status_queued);
    case "dispatched":
      return t(($) => $.progress.status_dispatched);
    case "running":
      return t(($) => $.progress.status_running);
    case "completed":
      return t(($) => $.progress.status_completed);
    case "failed":
      return t(($) => $.progress.status_failed);
    case "stalled":
      return t(($) => $.progress.status_stalled);
    case "cancelled":
      return t(($) => $.progress.status_cancelled);
    case "in_review":
      return t(($) => $.progress.status_in_review);
    case "in_progress":
      return t(($) => $.progress.status_in_progress);
    case "todo":
      return t(($) => $.progress.status_todo);
    case "done":
      return t(($) => $.progress.status_done);
    case "blocked":
      return t(($) => $.progress.status_blocked);
    default:
      return status;
  }
}

/** Rounded status pill, tinted by the shared STATUS_TONE map. */
function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-micro font-medium",
        STATUS_TONE[status] ?? NEUTRAL_PILL,
      )}
    >
      <StatusLabel status={status} />
    </span>
  );
}

/**
 * L3 · one run card nested under a task. Collapsed shows the identity line;
 * expanding reveals the meta strip (model/cli/token/heartbeat/stall) and the
 * three-state todo list. Non-settled runs start expanded.
 */
function RunCard({
  issueId,
  run,
}: {
  issueId: string;
  run: IssueProgressRun;
}) {
  const { t } = useT("archive");
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const [expanded, setExpanded] = useState(() => !isSettled(run.status));

  const toneBorder =
    run.status === "failed"
      ? "border-destructive/30"
      : run.status === "stalled"
        ? "border-warning/40"
        : run.status === "running"
          ? "border-info/30"
          : "border-border";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-card/40",
        toneBorder,
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/40"
      >
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
            !expanded && "-rotate-90",
          )}
        />
        {run.status === "running" && (
          <span className="size-1.5 shrink-0 rounded-full bg-info animate-pulse" />
        )}
        <span className="shrink-0 text-micro font-semibold text-muted-foreground">
          {t(($) => $.progress.run_label)}
        </span>
        <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
          <AgentName agentId={run.agent_id} />
        </span>
        <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
          {run.todos_progress.done}/{run.todos_progress.total}
        </span>
        <StatusPill status={run.status} />
        <AppLink
          href={paths.issueExecLog(issueId, run.id)}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="shrink-0 text-micro text-primary hover:underline">
            {t(($) => $.progress.open_exec)}
          </span>
        </AppLink>
      </button>

      {expanded && (
        <div className="animate-in fade-in slide-in-from-top-1 duration-200">
          {/* meta strip */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-dashed px-2.5 py-1.5 text-micro text-muted-foreground">
            <MetaItem icon={<Cpu className="size-3" />}>
              {run.model ?? "—"}
            </MetaItem>
            <MetaItem icon={<Terminal className="size-3" />}>
              {run.cli_kind}
            </MetaItem>
            <MetaItem icon={<Zap className="size-3" />}>
              {t(($) => $.dynamics.token_used, { count: run.token_used })}
            </MetaItem>
            <MetaItem
              icon={
                <Activity
                  className={cn(
                    "size-3",
                    run.status === "running" && "text-info",
                  )}
                />
              }
            >
              {run.last_heartbeat_at
                ? timeAgo(run.last_heartbeat_at)
                : t(($) => $.dynamics.no_heartbeat)}
            </MetaItem>
            <MetaItem icon={<Clock className="size-3" />}>
              {formatTimestamp(run.started_at)}
            </MetaItem>
            {run.stall_reason && (
              <span className="inline-flex items-center gap-1 font-medium text-warning">
                <AlertTriangle className="size-3" />
                {t(($) => $.dynamics.stalled, { reason: run.stall_reason })}
              </span>
            )}
            {isTroubleRun(run.status) && (
              <AppLink href={paths.issueExecLog(issueId, run.id)}>
                <span className="text-micro text-destructive hover:underline">
                  {t(($) => $.progress.retry_hint)}
                </span>
              </AppLink>
            )}
          </div>
          <div className="border-t px-2.5 py-2">
            <RunBreakdown todos={run.todos} />
          </div>
        </div>
      )}
    </div>
  );
}

/** One icon + text pair in a run's meta strip. */
function MetaItem({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="shrink-0 text-muted-foreground/70">{icon}</span>
      <span className="truncate">{children}</span>
    </span>
  );
}

/** C6-2 计划待办 + A3 工具步。tool_trace 不再冒充拆解任务。 */
function RunBreakdown({ todos }: { todos: IssueProgressTodo[] }) {
  const { t } = useT("archive");
  const { plan, steps } = partitionProgressTodos(todos);

  if (plan.length === 0 && steps.length === 0) {
    return (
      <p className="text-caption text-muted-foreground">
        {t(($) => $.progress.no_todos)}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {plan.length > 0 && (
        <TodoList
          todos={plan}
          label={t(($) => $.progress.plan_todos)}
        />
      )}
      {steps.length > 0 && <ToolStepList steps={steps} />}
    </div>
  );
}

/** C6-2 待办行：todo_key + 标题 + 三态，完成项默认可读。 */
function TodoList({
  todos,
  label,
}: {
  todos: IssueProgressTodo[];
  label: string;
}) {
  const done = todos.filter((todo) => todo.status === "done").length;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-micro font-medium text-muted-foreground">{label}</span>
        <span className="text-micro tabular-nums text-muted-foreground">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-1">
        {todos.map((todo) => (
          <li key={todo.todo_key} className="flex items-center gap-2 text-caption">
            <TodoStateIcon status={todo.status} />
            <span className="shrink-0 font-mono text-micro text-muted-foreground">
              {todo.todo_key}
            </span>
            <span className="min-w-0 flex-1 truncate" title={todo.title}>
              {todo.phase && (
                <span className="text-muted-foreground">{todo.phase} · </span>
              )}
              <span
                className={cn(
                  todo.status === "done" && "text-muted-foreground",
                  todo.status === "skipped" &&
                    "text-muted-foreground line-through",
                  todo.status === "failed" && "text-destructive",
                )}
              >
                {todo.title}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A3 步骤轨：读 / 令 / 思；完成步默认折叠，避免 read/shell 刷屏。 */
function ToolStepList({ steps }: { steps: IssueProgressTodo[] }) {
  const { t } = useT("archive");
  const live = steps.filter((step) => step.status !== "done" && step.status !== "skipped");
  const done = steps.filter((step) => step.status === "done" || step.status === "skipped");
  const [showDone, setShowDone] = useState(live.length === 0);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-micro font-medium text-muted-foreground">
          {t(($) => $.progress.tool_steps)}
        </span>
        <span className="text-micro tabular-nums text-muted-foreground">
          {done.length}/{steps.length}
        </span>
      </div>
      <ul className="space-y-1">
        {(showDone ? steps : live).map((step) => (
          <ToolStepRow key={step.todo_key} step={step} />
        ))}
      </ul>
      {done.length > 0 && live.length > 0 && (
        <button
          type="button"
          className="mt-1.5 text-micro text-muted-foreground hover:text-foreground"
          onClick={() => setShowDone((value) => !value)}
        >
          {showDone
            ? t(($) => $.progress.tool_steps_collapse, { n: done.length })
            : t(($) => $.progress.tool_steps_folded, { n: done.length })}
        </button>
      )}
    </div>
  );
}

function ToolStepRow({ step }: { step: IssueProgressTodo }) {
  const kind = toolStepKind(step.title);
  const icon =
    kind === "read" ? "读" : kind === "shell" ? "令" : kind === "think" ? "思" : "工";
  return (
    <li className="flex items-center gap-2 text-caption">
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold",
          kind === "read" && "bg-sky-500/15 text-sky-700 dark:text-sky-300",
          kind === "shell" && "bg-amber-500/15 text-amber-700 dark:text-amber-300",
          kind === "think" && "bg-violet-500/15 text-violet-700 dark:text-violet-300",
          kind === "other" && "bg-muted text-muted-foreground",
          step.status === "failed" && "bg-destructive/15 text-destructive",
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono",
          step.status === "done" && "text-muted-foreground",
          step.status === "failed" && "text-destructive",
        )}
        title={step.title}
      >
        {step.title}
      </span>
      <span className="shrink-0 font-mono text-micro text-muted-foreground/50">
        {step.todo_key.length > 10 ? `${step.todo_key.slice(0, 10)}…` : step.todo_key}
      </span>
    </li>
  );
}

/** Three-state (plus skipped/failed) todo glyph with an a11y label. */
function TodoStateIcon({ status }: { status: IssueProgressTodo["status"] }) {
  const { t } = useT("archive");
  const cls = "size-3.5 shrink-0";
  switch (status) {
    case "done":
      return (
        <CheckCircle2
          role="img"
          aria-label={t(($) => $.progress.todo_status_done)}
          className={cn(cls, "text-success")}
        />
      );
    case "in_progress":
      return (
        <CircleDot
          role="img"
          aria-label={t(($) => $.progress.todo_status_in_progress)}
          className={cn(cls, "animate-pulse text-info")}
        />
      );
    case "failed":
      return (
        <XCircle
          role="img"
          aria-label={t(($) => $.progress.todo_status_failed)}
          className={cn(cls, "text-destructive")}
        />
      );
    case "skipped":
      return (
        <Minus
          role="img"
          aria-label={t(($) => $.progress.todo_status_skipped)}
          className={cn(cls, "text-muted-foreground/60")}
        />
      );
    case "pending":
    default:
      return (
        <Circle
          role="img"
          aria-label={t(($) => $.progress.todo_status_pending)}
          className={cn(cls, "text-muted-foreground/40")}
        />
      );
  }
}

/** Detached runs: rolled up via root_issue_id, task belongs to another issue. */
function UnmatchedRuns({
  issueId,
  runs,
}: {
  issueId: string;
  runs: IssueProgressRun[];
}) {
  const { t } = useT("archive");
  const [expanded, setExpanded] = useState(false);

  return (
    <section>
      <SectionLabel icon={<Link2Off className="size-3.5" />} count={runs.length}>
        {t(($) => $.progress.unmatched_title)}
      </SectionLabel>
      <div className="overflow-hidden rounded-lg border border-dashed bg-card/20">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/40"
        >
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
              !expanded && "-rotate-90",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
            {t(($) => $.progress.unmatched_hint)}
          </span>
          <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
            {runs.length}
          </span>
        </button>
        {expanded && (
          <div className="animate-in fade-in slide-in-from-top-1 space-y-2 border-t px-3 py-2.5 duration-200">
            {runs.map((run) => (
              <RunCard key={run.id} issueId={issueId} run={run} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
