"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarDays,
  FolderArchive,
  GitBranch,
  Lock,
  Package,
  ShieldAlert,
  Workflow,
} from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useFeatureEnabled } from "@multica/core/config";
import { ASSET_MODULE_FLAG } from "@multica/core/feature-flags";
import {
  issueDeliverablesOptions,
  issueDynamicsOptions,
} from "@multica/core/agent-runs/queries";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { projectModulesOptions } from "@multica/core/modules";
import { projectResourcesOptions } from "@multica/core/projects";
import { Button } from "@multica/ui/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { useT } from "../../../i18n";
import { AppLink } from "../../../navigation";
import { stageForRequirementStatus } from "../../../calendar/calendar-helpers";
import { RequirementDrawer } from "../../../calendar/requirement-drawer";
import { RequirementDynamics } from "../requirement-drill/requirement-dynamics";
import { ProgressTracker } from "../requirement-drill/progress-tracker";
import { DeliverablesOverview } from "../requirement-drill/deliverables-overview";
import { countEventTypes, repoDisplayName } from "../requirement-drill/requirement-drill-helpers";
import { QueryError, QueryLoading } from "../archive/query-states";
import { formatWindow, stageDots } from "./requirement-helpers";
import { StageDots } from "./stage-dots";
import { QuickConfirmButton } from "../../../issues/components/quick-confirm-button";
import { RequirementConfigEditor } from "../../../issues/components/requirement-config-editor";
import { needsQuickConfirm } from "../requirement-drill/requirement-display";
import { AssetTab } from "../assets";

const DRILLS = ["dynamics", "progress", "deliverables", "basics", "assets"] as const;
type Drill = (typeof DRILLS)[number];

function isDrill(value: string | null): value is Drill {
  return DRILLS.includes(value as Drill);
}

function roleInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

export function RequirementDetailView({
  projectId,
  issueId,
  drill,
  onDrillChange,
  onBack,
  onOpenAcceptance,
}: {
  projectId: string;
  issueId: string;
  drill: string | null;
  onDrillChange: (drill: Drill) => void;
  onBack: () => void;
  onOpenAcceptance: () => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  // 资产 drill 双层门控：与项目级 TAB 同源 flag，flag off 时 drill 不可见。
  const assetsEnabled = useFeatureEnabled(ASSET_MODULE_FLAG, false);
  const active: Drill = isDrill(drill) ? drill : "dynamics";
  const [benchOpen, setBenchOpen] = useState(false);

  const issueQuery = useQuery(issueDetailOptions(wsId, issueId));
  const modulesQuery = useQuery(projectModulesOptions(wsId, projectId));
  const deliverablesQuery = useQuery(issueDeliverablesOptions(wsId, issueId));
  const dynamicsQuery = useQuery(issueDynamicsOptions(wsId, issueId));
  const resourcesQuery = useQuery(projectResourcesOptions(wsId, projectId));

  if (issueQuery.isPending) return <QueryLoading rows={8} />;
  if (issueQuery.isError || !issueQuery.data) {
    return <QueryError onRetry={() => void issueQuery.refetch()} />;
  }

  const issue = issueQuery.data;
  const module = modulesQuery.data?.find((item) => item.id === issue.module_id);
  const { states } = stageDots(issue.requirement_status);
  const failed = issue.requirement_status === "验收失败";
  const workbenchStage = stageForRequirementStatus(issue.requirement_status);
  const roster = deliverablesQuery.data?.role_assignments ?? [];
  const lock = deliverablesQuery.data?.module_lock;
  const artifactTotal = deliverablesQuery.data?.artifacts.total ?? 0;
  const eventTotal = dynamicsQuery.data
    ? Object.values(countEventTypes(dynamicsQuery.data.days)).reduce((sum, n) => sum + n, 0)
    : 0;
  const repo = repoDisplayName(
    resourcesQuery.data?.find((resource) => resource.id === issue.repo_resource_id) ??
      resourcesQuery.data?.find((resource) => resource.resource_type === "github_repo") ??
      resourcesQuery.data?.[0],
  );
  const mutexLabel = !lock
    ? t(($) => $.req_detail.mutex_none)
    : lock.waiting_count > 0
      ? t(($) => $.req_detail.mutex_waiting)
      : lock.active_count > 0
        ? t(($) => $.req_detail.mutex_held)
        : t(($) => $.req_detail.mutex_none);

  return (
    <div className="space-y-3" data-testid="requirement-detail">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          {t(($) => $.req_detail.back)}
        </Button>
        <span className="font-mono text-caption text-muted-foreground">
          {issue.identifier}
        </span>
        {issue.requirement_status && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-micro">
            {issue.requirement_status}
          </span>
        )}
        <StageDots states={states} />
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {needsQuickConfirm({
            status: issue.status,
            statusCategory: issue.status_category,
            requirementStatus: issue.requirement_status,
          }) && (
            <QuickConfirmButton
              issueId={issue.id}
              onDone={() => void issueQuery.refetch()}
            />
          )}
          <Button
            size="xs"
            variant="outline"
            data-testid="open-requirement-workbench"
            onClick={() => setBenchOpen(true)}
          >
            <Workflow className="size-3.5" />
            {t(($) => $.req_detail.open_workbench)}
          </Button>
          <AppLink href={paths.calendarRequirement(issue.id)}>
            <Button size="xs" variant="ghost">
              <CalendarDays className="size-3.5" />
              {t(($) => $.req_detail.calendar_locate)}
            </Button>
          </AppLink>
        </div>
      </div>

      {failed && (
        <div className="flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-caption text-destructive">
          <span>{t(($) => $.req_detail.failed_banner)}</span>
          <Button size="xs" variant="outline" onClick={onOpenAcceptance}>
            {t(($) => $.req_detail.go_reflow)}
          </Button>
        </div>
      )}

      <Tabs value={active} onValueChange={(next) => onDrillChange(next as Drill)}>
        <TabsList variant="line" className="w-full flex-wrap">
          <TabsTrigger value="dynamics">
            {t(($) => $.tabs.dynamics)}
            {eventTotal > 0 && (
              <span className="ml-1 tabular-nums text-micro text-muted-foreground">
                {eventTotal}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="progress">{t(($) => $.tabs.progress)}</TabsTrigger>
          <TabsTrigger value="deliverables">
            {t(($) => $.tabs.deliverables)}
            {artifactTotal > 0 && (
              <span className="ml-1 tabular-nums text-micro text-muted-foreground">
                {artifactTotal}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="basics">{t(($) => $.tabs.basics)}</TabsTrigger>
          {assetsEnabled && (
            <TabsTrigger value="assets">{t(($) => $.tabs.assets)}</TabsTrigger>
          )}
          <span className="ml-auto hidden text-micro text-muted-foreground lg:inline">
            {t(($) => $.req_detail.tab_source)}
          </span>
        </TabsList>
        <TabsContent value="dynamics" className="mt-3">
          <RequirementDynamics
            issueId={issueId}
            projectId={projectId}
            onOpenAcceptance={onOpenAcceptance}
          />
        </TabsContent>
        <TabsContent value="progress" className="mt-3">
          <ProgressTracker issueId={issueId} issue={issue} />
        </TabsContent>
        <TabsContent value="deliverables" className="mt-3">
          <DeliverablesOverview issueId={issueId} projectId={projectId} />
        </TabsContent>
        <TabsContent value="basics" className="mt-3">
          <div className="rounded-lg border border-surface-border bg-surface px-4 py-3">
            <RequirementConfigEditor issue={issue} showTitle />
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-micro text-muted-foreground">
              {module && (
                <span className="inline-flex items-center gap-1">
                  <i
                    className="size-2 rounded-full"
                    style={{ backgroundColor: module.color }}
                  />
                  {module.name}
                </span>
              )}
              <span className="font-mono">{formatWindow(issue)}</span>
              <span className="inline-flex items-center gap-1 font-mono">
                <GitBranch className="size-3" />
                {repo ?? t(($) => $.req_detail.repo_missing)}
              </span>
              <span className="inline-flex items-center gap-1">
                <Lock className="size-3" />
                {mutexLabel}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {roster.length === 0 ? (
                <span className="text-micro text-muted-foreground">
                  {t(($) => $.req_detail.roster_empty)}
                </span>
              ) : (
                roster.map((role) => {
                  const name = role.assignee_name || role.assignee_id.slice(0, 8);
                  return (
                    <span
                      key={`${role.role}:${role.ordinal}:${role.assignee_id}`}
                      className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-micro"
                      title={`${role.role} · ${name}`}
                    >
                      <span className="flex size-4 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                        {roleInitial(name)}
                      </span>
                      {name}
                    </span>
                  );
                })
              )}
              <div className="ml-auto flex flex-wrap gap-1">
                <AppLink href={paths.projectView(projectId, "archive")}>
                  <Button size="xs" variant="ghost">
                    <FolderArchive className="size-3.5" />
                    {t(($) => $.req_detail.to_archive)}
                  </Button>
                </AppLink>
                <AppLink href={paths.projectView(projectId, "deliverables")}>
                  <Button size="xs" variant="ghost">
                    <Package className="size-3.5" />
                    {t(($) => $.req_detail.to_deliverables)}
                  </Button>
                </AppLink>
                <Button size="xs" variant="ghost" onClick={onOpenAcceptance}>
                  <ShieldAlert className="size-3.5" />
                  {t(($) => $.req_detail.to_acceptance)}
                </Button>
              </div>
            </div>
          </div>
        </TabsContent>
        {assetsEnabled && (
          <TabsContent value="assets" className="mt-3">
            <AssetTab projectId={projectId} issueId={issueId} />
          </TabsContent>
        )}
      </Tabs>
      <RequirementDrawer
        issueId={benchOpen ? issue.id : null}
        statusBadge={issue.requirement_status}
        initialViewedStage={workbenchStage}
        onOpenChange={(open) => setBenchOpen(open)}
      />
    </div>
  );
}
