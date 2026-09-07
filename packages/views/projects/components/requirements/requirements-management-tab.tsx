"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  CalendarPlus,
  ChevronRight,
  GitBranch,
  Package,
  RotateCcw,
  Workflow,
  Zap,
} from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueStatusCategory } from "@multica/core/issues";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  calendarIssuesOptions,
  childrenByParentsOptions,
  issueKeys,
} from "@multica/core/issues/queries";
import { projectArtifactListOptions } from "@multica/core/artifacts/queries";
import { projectModulesOptions } from "@multica/core/modules";
import { projectResourcesOptions } from "@multica/core/projects";
import { useModalStore } from "@multica/core/modals";
import type { Issue, IssueStatusCategory } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { AppLink } from "../../../navigation";
import { ProgressRing } from "../../../issues/components/progress-ring";
import { useStatusLabel } from "../../../issues/utils/status-label";
import { stageForRequirementStatus } from "../../../calendar/calendar-helpers";
import { StageDots } from "./stage-dots";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../archive/query-states";
import {
  acceptanceVerdict,
  canReflow,
  childProgress,
  formatWindow,
  projectRequirements,
  requirementBucket,
  stageDots,
} from "./requirement-helpers";
import { QuickConfirmButton } from "../../../issues/components/quick-confirm-button";
import { displayTaskTitle, needsQuickConfirm } from "../requirement-drill/requirement-display";
import { repoDisplayName } from "../requirement-drill/requirement-drill-helpers";

type StatusFilter = "all" | "active" | "pending" | "done";

export function RequirementsManagementTab({
  projectId,
  onOpenRequirement,
  onOpenAcceptance,
}: {
  projectId: string;
  onOpenRequirement: (issueId: string, drill?: string) => void;
  onOpenAcceptance: (issueId?: string) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [stageFilter, setStageFilter] = useState<Set<number>>(
    () => new Set([1, 2, 3, 4]),
  );
  const [moduleId, setModuleId] = useState<string | null>(null);

  const issuesQuery = useQuery(calendarIssuesOptions(wsId));
  const modulesQuery = useQuery(projectModulesOptions(wsId, projectId));
  const artifactsQuery = useQuery(projectArtifactListOptions(wsId, projectId));
  const resourcesQuery = useQuery(projectResourcesOptions(wsId, projectId));
  const statusLabelOf = useStatusLabel(wsId);

  const requirements = useMemo(
    () => projectRequirements(issuesQuery.data ?? [], projectId),
    [issuesQuery.data, projectId],
  );

  const parentIds = useMemo(
    () => [...requirements.map((r) => r.id)].sort(),
    [requirements],
  );
  const childrenQuery = useQuery({
    ...childrenByParentsOptions(wsId, parentIds, qc),
    enabled: parentIds.length > 0,
  });

  const artifactCountByIssue = useMemo(() => {
    const map = new Map<string, number>();
    for (const artifact of artifactsQuery.data?.artifacts ?? []) {
      if (!artifact.issue_id) continue;
      map.set(artifact.issue_id, (map.get(artifact.issue_id) ?? 0) + 1);
    }
    return map;
  }, [artifactsQuery.data]);

  const failedChildCount = useMemo(() => {
    const map = new Map<string, number>();
    const grouped = childrenQuery.data;
    if (!grouped) return map;
    for (const [parentId, children] of grouped) {
      map.set(
        parentId,
        children.filter(
          (c) => c.status_category === "blocked" || String(c.status) === "failed",
        ).length,
      );
    }
    return map;
  }, [childrenQuery.data]);

  const repoNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const resource of resourcesQuery.data ?? []) {
      const name = repoDisplayName(resource);
      if (name) map.set(resource.id, name);
    }
    return map;
  }, [resourcesQuery.data]);

  const stats = useMemo(() => {
    const pending = requirements.filter((r) => requirementBucket(r) === "pending");
    const active = requirements.filter((r) => requirementBucket(r) === "active");
    const failed = requirements.filter((r) => requirementBucket(r) === "failed");
    const done = requirements.filter((r) => requirementBucket(r) === "done");
    const accepted = requirements.filter((r) => r.requirement_status === "已完成");
    const judged = accepted.length + failed.length;
    const passRate = judged === 0 ? null : Math.round((accepted.length / judged) * 100);
    return {
      total: requirements.length,
      pending: pending.length,
      pendingPrototype: pending.filter((r) => r.requirement_status === "原型待确认").length,
      pendingDecompose: pending.filter((r) => r.requirement_status === "拆解待确认").length,
      active: active.length,
      failed: failed.length,
      done: done.length,
      passRate,
    };
  }, [requirements]);

  const filtered = useMemo(() => {
    return requirements.filter((issue) => {
      const bucket = requirementBucket(issue);
      if (statusFilter === "pending" && bucket !== "pending") return false;
      if (statusFilter === "active" && bucket !== "active" && bucket !== "failed") return false;
      if (statusFilter === "done" && bucket !== "done") return false;
      const { stage } = stageDots(issue.requirement_status);
      if (!stageFilter.has(stage)) return false;
      if (moduleId && issue.module_id !== moduleId) return false;
      return true;
    });
  }, [requirements, statusFilter, stageFilter, moduleId]);

  if (issuesQuery.isPending) return <QueryLoading rows={6} />;
  if (issuesQuery.isError) {
    return <QueryError onRetry={() => void issuesQuery.refetch()} />;
  }

  return (
    <div className="space-y-3" data-testid="requirements-management">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <StatCard value={stats.total} label={t(($) => $.req_mgmt.stat_total)} />
        <StatCard value={stats.active} label={t(($) => $.req_mgmt.stat_active)} accent="text-primary" />
        <StatCard
          value={stats.pending}
          label={t(($) => $.req_mgmt.stat_pending, {
            proto: stats.pendingPrototype,
            decomp: stats.pendingDecompose,
          })}
          accent="text-warning"
        />
        <StatCard
          value={stats.failed}
          label={t(($) => $.req_mgmt.stat_failed)}
          accent="text-destructive"
        />
        <StatCard
          value={stats.passRate == null ? "—" : `${stats.passRate}%`}
          label={t(($) => $.req_mgmt.stat_pass_rate)}
          accent="text-success"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["all", stats.total],
            ["active", stats.active],
            ["pending", stats.pending],
            ["done", stats.done],
          ] as const
        ).map(([key, count]) => (
          <button
            key={key}
            type="button"
            aria-pressed={statusFilter === key}
            onClick={() => setStatusFilter(key)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-micro font-medium",
              statusFilter === key
                ? "border-primary/40 bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            {t(($) => $.req_mgmt[`filter_${key}`])} {count}
          </button>
        ))}
        {[1, 2, 3, 4].map((stage) => (
          <button
            key={stage}
            type="button"
            aria-pressed={stageFilter.has(stage)}
            onClick={() =>
              setStageFilter((prev) => {
                const next = new Set(prev);
                if (next.has(stage)) next.delete(stage);
                else next.add(stage);
                if (next.size === 0) return new Set([1, 2, 3, 4]);
                return next;
              })
            }
            className={cn(
              "rounded-full border px-2 py-1 text-micro",
              stageFilter.has(stage)
                ? "border-primary/40 bg-primary/10 text-primary"
                : "text-muted-foreground",
            )}
          >
            S{stage}
          </button>
        ))}
        <select
          className="h-7 rounded-md border border-surface-border bg-surface px-2 text-micro"
          value={moduleId ?? ""}
          aria-label={t(($) => $.req_mgmt.filter_module)}
          onChange={(e) => setModuleId(e.target.value || null)}
        >
          <option value="">{t(($) => $.req_mgmt.filter_module_all)}</option>
          {(modulesQuery.data ?? []).map((mod) => (
            <option key={mod.id} value={mod.id}>
              {mod.name}
            </option>
          ))}
        </select>
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          onClick={() =>
            useModalStore.getState().open("create-issue", {
              project_id: projectId,
              source: "calendar",
            })
          }
        >
          <CalendarPlus className="size-3.5" />
          {t(($) => $.req_mgmt.new_via_calendar)}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <ArchiveEmpty
          title={t(($) => $.req_mgmt.empty)}
          description={t(($) => $.req_mgmt.empty_hint)}
        />
      ) : (
        <ul className="divide-y divide-surface-border overflow-hidden rounded-lg border border-surface-border">
          {filtered.map((issue) => (
            <RequirementRow
              key={issue.id}
              issue={issue}
              moduleName={
                modulesQuery.data?.find((m) => m.id === issue.module_id)?.name
              }
              moduleColor={
                modulesQuery.data?.find((m) => m.id === issue.module_id)?.color
              }
              repoName={
                issue.repo_resource_id
                  ? repoNameById.get(issue.repo_resource_id)
                  : undefined
              }
              tasks={[...(childrenQuery.data?.get(issue.id) ?? [])].sort(sortChildTasks)}
              tasksLoading={childrenQuery.isPending}
              artifactCount={artifactCountByIssue.get(issue.id) ?? 0}
              failedChildren={failedChildCount.get(issue.id) ?? 0}
              benchHref={paths.calendarRequirement(
                issue.id,
                stageForRequirementStatus(issue.requirement_status),
                "project",
              )}
              taskHref={(taskId) => paths.issueDetail(taskId)}
              statusLabelOf={statusLabelOf}
              onOpen={() => onOpenRequirement(issue.id)}
              onReflow={() => onOpenAcceptance(issue.id)}
              onConfirmed={() =>
                void qc.invalidateQueries({ queryKey: issueKeys.all(wsId) })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function StatCard({
  value,
  label,
  accent,
}: {
  value: number | string;
  label: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface px-3 py-2">
      <div className={cn("text-title-sm font-semibold tabular-nums", accent)}>{value}</div>
      <div className="text-micro text-muted-foreground">{label}</div>
    </div>
  );
}

function sortChildTasks(a: Issue, b: Issue): number {
  const stageA = a.stage ?? Number.MAX_SAFE_INTEGER;
  const stageB = b.stage ?? Number.MAX_SAFE_INTEGER;
  if (stageA !== stageB) return stageA - stageB;
  if (a.position !== b.position) return a.position - b.position;
  return a.identifier.localeCompare(b.identifier);
}

function decomposeModeKey(
  mode: Issue["decompose_mode"],
): "mode_auto" | "mode_confirm" | "mode_manual" | null {
  if (mode === "auto") return "mode_auto";
  if (mode === "confirm") return "mode_confirm";
  if (mode === "manual") return "mode_manual";
  return null;
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

function MetaChip({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 text-micro text-muted-foreground"
    >
      {children}
    </span>
  );
}

function RequirementRow({
  issue,
  moduleName,
  moduleColor,
  repoName,
  tasks,
  tasksLoading,
  artifactCount,
  failedChildren,
  benchHref,
  taskHref,
  statusLabelOf,
  onOpen,
  onReflow,
  onConfirmed,
}: {
  issue: Issue;
  moduleName?: string;
  moduleColor?: string;
  repoName?: string;
  tasks: Issue[];
  tasksLoading: boolean;
  artifactCount: number;
  failedChildren: number;
  benchHref: string;
  taskHref: (taskId: string) => string;
  statusLabelOf: (statusKey: string) => string;
  onOpen: () => void;
  onReflow: () => void;
  onConfirmed: () => void;
}) {
  const { t } = useT("archive");
  const [expanded, setExpanded] = useState(false);
  const { stage, states } = stageDots(issue.requirement_status);
  const progress = childProgress(issue);
  const verdict = acceptanceVerdict(issue);
  const failed = requirementBucket(issue) === "failed";
  const pending = requirementBucket(issue) === "pending";
  const modeKey = decomposeModeKey(issue.decompose_mode);
  const windowLabel = formatWindow(issue);
  const goal = issue.goal?.trim();

  return (
    <li className={cn(failed && "bg-destructive/5")}>
      <div className="grid grid-cols-[28px_64px_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 px-3 py-3 sm:grid-cols-[28px_72px_minmax(0,1fr)_72px_96px_64px_72px_auto] sm:items-center">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t(($) => $.req_mgmt.collapse_tasks)
              : t(($) => $.req_mgmt.expand_tasks)
          }
          onClick={() => setExpanded((open) => !open)}
          className="mt-0.5 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          data-testid="requirement-expand"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
          />
        </button>
        <button
          type="button"
          onClick={onOpen}
          className="pt-0.5 text-left font-mono text-caption text-primary hover:underline"
        >
          {issue.identifier}
        </button>
        <button type="button" onClick={onOpen} className="min-w-0 text-left">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: moduleColor || "transparent" }}
            />
            <span className="truncate text-body font-medium">{issue.title}</span>
            {failed && (
              <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 text-micro text-destructive">
                {issue.requirement_status}
              </span>
            )}
            {pending && (
              <span className="shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-micro text-warning">
                {issue.requirement_status}
              </span>
            )}
          </div>
          {goal && (
            <p className="mt-1 line-clamp-1 text-micro text-muted-foreground">{goal}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {moduleName && <MetaChip>{moduleName}</MetaChip>}
            {windowLabel !== "—" && (
              <MetaChip>
                <CalendarDays className="size-3 shrink-0" />
                <span className="font-mono">{windowLabel}</span>
              </MetaChip>
            )}
            {repoName && (
              <MetaChip>
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{repoName}</span>
              </MetaChip>
            )}
            {modeKey && (
              <MetaChip>{t(($) => $.req_mgmt[modeKey])}</MetaChip>
            )}
            {issue.auto_trigger && (
              <MetaChip>
                <Zap className="size-3 shrink-0" />
                {t(($) => $.req_mgmt.auto_trigger_on)}
              </MetaChip>
            )}
          </div>
        </button>
        <div
          className="hidden sm:flex"
          title={t(($) => $.req_mgmt.col_stage, { stage })}
        >
          <StageDots states={states} />
        </div>
        <div className="hidden items-center gap-1.5 sm:flex">
          {progress ? (
            <>
              <ProgressRing done={progress.done} total={progress.total} />
              <span className="text-micro tabular-nums text-muted-foreground">
                {progress.done}/{progress.total}
                {failedChildren > 0
                  ? ` · ${t(($) => $.req_mgmt.fail_count, { n: failedChildren })}`
                  : ""}
              </span>
            </>
          ) : (
            <span className="text-micro text-muted-foreground">
              {t(($) => $.req_mgmt.task_count, { n: tasks.length })}
            </span>
          )}
        </div>
        <div className="hidden sm:block">
          <VerdictPill verdict={verdict} />
        </div>
        <div className="hidden items-center gap-1 text-micro tabular-nums text-muted-foreground sm:flex">
          <Package className="size-3" />
          {artifactCount}
        </div>
        <div className="flex items-center justify-end gap-1">
          {needsQuickConfirm({
            status: issue.status,
            statusCategory: issue.status_category,
            requirementStatus: issue.requirement_status,
          }) && <QuickConfirmButton issueId={issue.id} onDone={onConfirmed} />}
          <AppLink href={benchHref}>
            <Button size="xs" variant="ghost">
              <Workflow className="size-3" />
              {t(($) => $.req_mgmt.workbench)}
            </Button>
          </AppLink>
          {(canReflow(issue) || failed) && (
            <Button size="xs" variant="outline" onClick={onReflow}>
              <RotateCcw className="size-3" />
              {t(($) => $.req_mgmt.reflow)}
            </Button>
          )}
        </div>
      </div>
      {expanded && (
        <ul
          className="space-y-1 border-t border-surface-border/70 bg-muted/20 px-3 py-2 pl-11"
          data-testid="requirement-task-list"
        >
          {tasksLoading ? (
            <li className="px-2 py-1.5 text-micro text-muted-foreground">
              {t(($) => $.common.loading)}
            </li>
          ) : tasks.length === 0 ? (
            <li className="px-2 py-1.5 text-micro text-muted-foreground">
              {t(($) => $.req_mgmt.tasks_empty)}
            </li>
          ) : (
            tasks.map((task) => {
              const category = issueStatusCategory(task);
              return (
                <li key={task.id}>
                  <AppLink
                    href={taskHref(task.id)}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60"
                  >
                    <span className="w-16 shrink-0 font-mono text-micro text-muted-foreground">
                      {task.identifier}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-caption">
                      {displayTaskTitle(task.title, task.identifier)}
                    </span>
                    {task.stage != null && (
                      <span className="hidden shrink-0 text-micro text-muted-foreground sm:inline">
                        S{task.stage}
                      </span>
                    )}
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-1.5 py-0.5 text-micro",
                        childStatusTone(category),
                      )}
                    >
                      {statusLabelOf(task.status)}
                    </span>
                  </AppLink>
                </li>
              );
            })
          )}
        </ul>
      )}
    </li>
  );
}

function VerdictPill({ verdict }: { verdict: ReturnType<typeof acceptanceVerdict> }) {
  const { t } = useT("archive");
  if (verdict === "none") {
    return <span className="text-micro text-muted-foreground">—</span>;
  }
  const cls =
    verdict === "pass"
      ? "bg-success/15 text-success"
      : verdict === "fail"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <span className={cn("rounded-full px-1.5 py-0.5 text-micro", cls)}>
      {t(($) => $.req_mgmt[`verdict_${verdict}`])}
    </span>
  );
}
