"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  CalendarPlus,
  ChevronRight,
  GitBranch,
  RotateCcw,
  Workflow,
  Zap,
} from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
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
import type { Issue } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { AppLink } from "../../../navigation";
import { ProgressRing } from "../../../issues/components/progress-ring";
import { useStatusLabel } from "../../../issues/utils/status-label";
import { stageForRequirementStatus } from "../../../calendar/calendar-helpers";
import { RequirementDrawer } from "../../../calendar/requirement-drawer";
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
import { needsQuickConfirm } from "../requirement-drill/requirement-display";
import { repoDisplayName } from "../requirement-drill/requirement-drill-helpers";
import { REQ_ROW_GRID, RequirementTaskList } from "./requirement-task-list";

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
  const [benchIssue, setBenchIssue] = useState<Issue | null>(null);

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
        <div className="space-y-2">
          <div
            className={cn(
              REQ_ROW_GRID,
              "hidden px-3 py-0 text-micro text-muted-foreground sm:grid",
            )}
          >
            <span />
            <span />
            <span />
            <span className="text-center">{t(($) => $.req_mgmt.col_stage_h)}</span>
            <span className="text-center">{t(($) => $.req_mgmt.col_tasks_h)}</span>
            <span className="text-center">{t(($) => $.req_mgmt.col_accept_h)}</span>
            <span className="text-center">{t(($) => $.req_mgmt.col_artifacts_h)}</span>
            <span />
          </div>
          <ul className="space-y-2">
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
              requirementHref={paths.projectRequirement(projectId, issue.id)}
              onOpenWorkbench={() => setBenchIssue(issue)}
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
        </div>
      )}
      <RequirementDrawer
        issueId={benchIssue?.id ?? null}
        statusBadge={benchIssue?.requirement_status}
        initialViewedStage={
          benchIssue
            ? stageForRequirementStatus(benchIssue.requirement_status)
            : undefined
        }
        onOpenChange={(open) => {
          if (!open) setBenchIssue(null);
        }}
      />
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
  requirementHref,
  onOpenWorkbench,
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
  requirementHref: string;
  onOpenWorkbench: () => void;
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
    <li
      className={cn(
        "overflow-hidden rounded-lg border border-surface-border bg-surface",
        failed && "border-destructive/40 bg-destructive/5",
      )}
    >
      <div className={REQ_ROW_GRID}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t(($) => $.req_mgmt.collapse_tasks)
              : t(($) => $.req_mgmt.expand_tasks)
          }
          onClick={() => setExpanded((open) => !open)}
          className="mt-0.5 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground sm:mt-0"
          data-testid="requirement-expand"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
          />
        </button>
        <IssueIdLink
          href={requirementHref}
          identifier={issue.identifier}
          ariaLabel={t(($) => $.req_mgmt.open_requirement, { id: issue.identifier })}
          testId="requirement-id-link"
          fill
        />
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
        <MetricCell title={t(($) => $.req_mgmt.col_stage, { stage })}>
          <StageDots states={states} />
        </MetricCell>
        <MetricCell>
          <div className="flex flex-col items-center gap-0.5">
            <span className="inline-flex items-center gap-1">
              {progress ? (
                <ProgressRing done={progress.done} total={progress.total} />
              ) : null}
              <span className="text-micro tabular-nums text-foreground">
                {progress
                  ? `${progress.done}/${progress.total}`
                  : tasks.length}
              </span>
            </span>
            {failedChildren > 0 ? (
              <span className="text-micro text-destructive">
                {t(($) => $.req_mgmt.fail_count, { n: failedChildren })}
              </span>
            ) : null}
          </div>
        </MetricCell>
        <MetricCell>
          <VerdictPill verdict={verdict} />
        </MetricCell>
        <MetricCell>
          <span className="text-caption font-semibold tabular-nums">{artifactCount}</span>
        </MetricCell>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {needsQuickConfirm({
            status: issue.status,
            statusCategory: issue.status_category,
            requirementStatus: issue.requirement_status,
          }) && <QuickConfirmButton issueId={issue.id} onDone={onConfirmed} />}
          <Button
            size="xs"
            variant="ghost"
            data-testid="open-requirement-workbench"
            onClick={onOpenWorkbench}
          >
            <Workflow className="size-3" />
            {t(($) => $.req_mgmt.workbench)}
          </Button>
          {(canReflow(issue) || failed) && (
            <Button size="xs" variant="outline" onClick={onReflow}>
              <RotateCcw className="size-3" />
              {t(($) => $.req_mgmt.reflow)}
            </Button>
          )}
        </div>
      </div>
      {expanded && (
        <RequirementTaskList
          parentId={issue.id}
          tasks={tasks}
          tasksLoading={tasksLoading}
          taskHref={taskHref}
          statusLabelOf={statusLabelOf}
          renderId={(task, href) => (
            <IssueIdLink
              href={href}
              identifier={task.identifier}
              ariaLabel={t(($) => $.req_mgmt.open_task, { id: task.identifier })}
              testId="task-id-link"
              fill={false}
            />
          )}
        />
      )}
    </li>
  );
}

function MetricCell({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <div
      title={title}
      className="hidden min-w-0 flex-col items-center justify-center text-center sm:flex"
    >
      {children}
    </div>
  );
}

/** C5 `.rq-id`：左列 identifier 用 brand 高亮 + 加粗，单行不换行。 */
const ID_LINK_CLASS =
  "block w-full truncate font-mono text-caption font-bold text-brand hover:underline";

function IssueIdLink({
  href,
  identifier,
  ariaLabel,
  testId,
  className,
  fill = true,
}: {
  href: string;
  identifier: string;
  ariaLabel: string;
  testId: string;
  className?: string;
  fill?: boolean;
}) {
  return (
    <AppLink
      href={href}
      newTabTitle={identifier}
      aria-label={ariaLabel}
      title={identifier}
      className={cn(ID_LINK_CLASS, fill ? "block w-full" : "block min-w-0", className)}
      data-testid={testId}
    >
      {identifier}
    </AppLink>
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
