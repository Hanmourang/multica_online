"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { issueStatusCategory } from "@multica/core/issues";
import { issueProgressOptions } from "@multica/core/agent-runs/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import type { Issue, IssueProgressTask, IssueStatusCategory } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { AppLink } from "../../../navigation";
import { ActorAvatar } from "../../../common/actor-avatar";
import { ProgressRing } from "../../../issues/components/progress-ring";
import {
  matchChildProgress,
  taskProgressPercent,
  taskRowProgress,
  taskRowTitle,
} from "./requirement-helpers";
import { QueryLoading } from "../archive/query-states";

/** 与需求行同一套定宽栅格，展开后阶段 / 进度 / 状态对齐表头。 */
export const REQ_ROW_GRID =
  "grid grid-cols-[28px_5.5rem_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5 sm:grid-cols-[28px_5.5rem_minmax(0,1fr)_5.75rem_5.75rem_5.75rem_3.5rem_9rem] sm:items-center";

export function RequirementTaskList({
  parentId,
  tasks,
  tasksLoading,
  taskHref,
  statusLabelOf,
  renderId,
}: {
  parentId: string;
  tasks: Issue[];
  tasksLoading: boolean;
  taskHref: (taskId: string) => string;
  statusLabelOf: (statusKey: string) => string;
  renderId: (task: Issue, href: string) => ReactNode;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const progressQuery = useQuery({
    ...issueProgressOptions(wsId, parentId),
    enabled: Boolean(parentId),
  });
  const progressTasks = progressQuery.data?.tasks ?? [];
  const rollup = progressQuery.data?.issue.rollup;

  if (tasksLoading) {
    return (
      <div className="px-3 py-2" data-testid="requirement-task-list">
        <QueryLoading rows={2} />
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <p className="px-3 py-2 text-micro text-muted-foreground" data-testid="requirement-task-list">
        {t(($) => $.req_mgmt.tasks_empty)}
      </p>
    );
  }

  return (
    <div className="border-t border-surface-border/70 bg-muted/15" data-testid="requirement-task-list">
      {rollup && (rollup.todos_total > 0 || rollup.tasks_total > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-surface-border/60 px-3 py-1.5 text-micro text-muted-foreground">
          <span className="font-medium text-foreground">
            {t(($) => $.progress.rollup_tasks, {
              done: rollup.tasks_done,
              total: rollup.tasks_total,
            })}
          </span>
          {rollup.todos_total > 0 && (
            <span>
              {t(($) => $.progress.todos_progress, {
                done: rollup.todos_done,
                total: rollup.todos_total,
              })}
            </span>
          )}
          {rollup.runs_active > 0 && (
            <span>{t(($) => $.progress.rollup_active, { n: rollup.runs_active })}</span>
          )}
          {rollup.runs_stalled > 0 && (
            <span className="text-destructive">
              {t(($) => $.progress.rollup_stalled, { n: rollup.runs_stalled })}
            </span>
          )}
        </div>
      )}
      <div
        className={cn(
          REQ_ROW_GRID,
          "hidden py-1 text-micro text-muted-foreground sm:grid",
        )}
      >
        <span />
        <span />
        <span>{t(($) => $.req_mgmt.col_task_h)}</span>
        <span className="text-center">{t(($) => $.req_mgmt.col_stage_h)}</span>
        <span className="text-center">{t(($) => $.req_mgmt.col_progress_h)}</span>
        <span className="text-center">{t(($) => $.req_mgmt.col_status_h)}</span>
        <span />
        <span />
      </div>
      <ul>
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            href={taskHref(task.id)}
            progress={matchChildProgress(task, progressTasks)}
            statusLabel={statusLabelOf(task.status)}
            untitled={t(($) => $.req_mgmt.task_untitled)}
            renderId={renderId}
          />
        ))}
      </ul>
    </div>
  );
}

function TaskRow({
  task,
  href,
  progress,
  statusLabel,
  untitled,
  renderId,
}: {
  task: Issue;
  href: string;
  progress?: IssueProgressTask;
  statusLabel: string;
  untitled: string;
  renderId: (task: Issue, href: string) => ReactNode;
}) {
  const category = issueStatusCategory(task);
  const title = taskRowTitle(task, untitled);
  const fraction = taskRowProgress(task, progress);
  const latestRun = progress?.runs[0];

  return (
    <li className="border-t border-surface-border/50 first:border-t-0">
      <div className={cn(REQ_ROW_GRID, "py-2 hover:bg-accent/40")}>
        <span />
        {renderId(task, href)}
        <AppLink href={href} newTabTitle={task.identifier} className="min-w-0 text-left">
          <div className="flex min-w-0 items-center gap-1.5">
            {task.assignee_type && task.assignee_id ? (
              <ActorAvatar
                actorType={task.assignee_type}
                actorId={task.assignee_id}
                size="xs"
              />
            ) : null}
            <span className="truncate text-caption font-medium text-foreground">{title}</span>
          </div>
          {latestRun ? (
            <p className="mt-0.5 truncate font-mono text-micro text-muted-foreground">
              {latestRun.status}
              {latestRun.cli_kind ? ` · ${latestRun.cli_kind}` : ""}
            </p>
          ) : null}
        </AppLink>
        <div className="hidden justify-center text-micro tabular-nums text-muted-foreground sm:flex">
          {task.stage != null ? `S${task.stage}` : "—"}
        </div>
        <div className="hidden min-w-0 sm:block">
          <TaskProgressMeter category={category} fraction={fraction} />
        </div>
        <div className="hidden justify-center sm:flex">
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-micro",
              childStatusTone(category),
            )}
          >
            {statusLabel}
          </span>
        </div>
        <span />
        <span />
      </div>
    </li>
  );
}

function TaskProgressMeter({
  category,
  fraction,
}: {
  category: IssueStatusCategory | null | undefined;
  fraction: { done: number; total: number } | null;
}) {
  const pct = taskProgressPercent(category, fraction);
  const tone =
    category === "blocked"
      ? "bg-destructive"
      : category === "done"
        ? "bg-success"
        : category === "in_review"
          ? "bg-warning"
          : "bg-primary";
  return (
    <div className="flex w-full flex-col items-center gap-0.5" data-testid="task-progress">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
      {fraction ? (
        <span className="inline-flex items-center gap-1 text-micro tabular-nums text-foreground">
          <ProgressRing done={fraction.done} total={fraction.total} />
          {fraction.done}/{fraction.total}
        </span>
      ) : null}
    </div>
  );
}

function childStatusTone(category: IssueStatusCategory | null | undefined): string {
  switch (category) {
    case "done":
      return "bg-success/15 text-success";
    case "in_progress":
      return "bg-primary/10 text-primary";
    case "in_review":
      return "bg-warning/15 text-warning";
    case "blocked":
      return "bg-destructive/10 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}
