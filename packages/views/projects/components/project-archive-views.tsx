"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { cn } from "@multica/ui/lib/utils";
import { useWorkspaceId } from "@multica/core/hooks";
import { useFeatureEnabled } from "@multica/core/config";
import { ASSET_MODULE_FLAG, SPRINT_MODULE_FLAG } from "@multica/core/feature-flags";
import { calendarIssuesOptions } from "@multica/core/issues/queries";
import { projectArtifactListOptions } from "@multica/core/artifacts/queries";
import { graphModulesOptions } from "@multica/core/graph/queries";
import { filingReadinessOptions } from "@multica/core/filing/queries";
import {
  PROJECT_VIEWS,
  type ProjectView,
  viewsForProjectTemplate,
} from "@multica/core/projects";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";
import { ArchiveTab } from "./archive";
import { AssetTab } from "./assets";
import { SprintTab } from "./sprints";
import { WorkflowTab } from "./workflows";
import { BusMatrixTab, GraphDataProvider, ProductFeaturesTab } from "./graph";
import { FilingReadinessTab } from "./filing";
import { RequirementsManagementTab } from "./requirements/requirements-management-tab";
import { RequirementDetailView } from "./requirements/requirement-detail-view";
import { AcceptanceTab } from "./acceptance/acceptance-tab";
import { ProjectDeliverablesTab } from "./deliverables/project-deliverables-tab";
import { TaskTrackingToolbar } from "./tasks/task-tracking-tab";
import { ProjectTaskTrackingProvider } from "../../issues/components/project-task-tracking-context";
import {
  projectRequirements,
  requirementBucket,
} from "./requirements/requirement-helpers";

/**
 * C1 项目详情八 TAB 定序：
 * ① 项目档案 → ② 功能模块 → ③ 数据模型 → ④ 需求管理 →
 * ⑤ 任务追踪 → ⑥ 验收详情 → ⑦ 交付物 → ⑧ 申报
 *
 * 原「看板/列表/甘特/日历」收进任务追踪。?view= 仍 replace 不 push。
 * 旧 ?view=overview 兼容映射到 tasks。
 */

const VIEW_QUERY_KEY = "view";
const REQ_QUERY_KEY = "req";
const DRILL_QUERY_KEY = "drill";
const ACCEPT_QUERY_KEY = "acc";
// 迭代 master-detail 的选中项深链（?view=sprints&sprint=<id>），对标 CoCo
// /projects/{id}/sprints/{sprint} 的可分享链接形态。
const SPRINT_QUERY_KEY = "sprint";

function isProjectView(value: string | null): value is ProjectView {
  if (value === "overview" || !value) return false;
  return (PROJECT_VIEWS as readonly string[]).includes(value);
}

function normalizeView(
  value: string | null,
  allowed: readonly ProjectView[],
): ProjectView {
  const next = value === "overview" ? "tasks" : isProjectView(value) ? value : "archive";
  return allowed.includes(next) ? next : (allowed[0] ?? "archive");
}

const GRAPH_VIEWS = ["features", "data-model"] as const;
type GraphView = (typeof GRAPH_VIEWS)[number];

function isGraphView(value: ProjectView): value is GraphView {
  return (GRAPH_VIEWS as readonly string[]).includes(value);
}

function GraphViewStack({
  projectId,
  activeView,
}: {
  projectId: string;
  activeView: ProjectView;
}) {
  const active = isGraphView(activeView) ? activeView : null;
  const [visited, setVisited] = useState<GraphView[]>(() =>
    active ? [active] : [],
  );

  useEffect(() => {
    if (!active) return;
    setVisited((prev) => (prev.includes(active) ? prev : [...prev, active]));
  }, [active]);

  const mounted: GraphView[] =
    active && !visited.includes(active) ? [...visited, active] : visited;

  if (mounted.length === 0) return null;

  return (
    <div className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <GraphDataProvider projectId={projectId}>
        {mounted.includes("features") && (
          <div className={active === "features" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <ProductFeaturesTab />
          </div>
        )}
        {mounted.includes("data-model") && (
          <div className={active === "data-model" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <BusMatrixTab />
          </div>
        )}
      </GraphDataProvider>
    </div>
  );
}

function TabBadge({
  count,
  tone = "muted",
}: {
  count: number;
  tone?: "muted" | "alert";
}) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "ml-1 rounded-full px-1.5 py-0 text-micro tabular-nums",
        tone === "alert"
          ? "bg-destructive/15 text-destructive"
          : "bg-muted text-muted-foreground",
      )}
    >
      {count}
    </span>
  );
}

export function ProjectArchiveViews({
  projectId,
  template,
  children,
}: {
  projectId: string;
  template?: string | null;
  children: ReactNode;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  // 资产管理 TAB 双层门控：feature-flag on 才展示（server 同时门控路由注册）。
  const assetsEnabled = useFeatureEnabled(ASSET_MODULE_FLAG, false);
  // 迭代 TAB 同构门控（plan 20261024 §02）：sprint_module flag off 时不留死 TAB。
  const sprintsEnabled = useFeatureEnabled(SPRINT_MODULE_FLAG, false);
  // 工作流 TAB 暂时不展示。数据与路由保留，入口先从项目里拿掉。
  const workflowsEnabled = false;
  const navigation = useNavigation();
  const urlView = navigation.searchParams.get(VIEW_QUERY_KEY);
  const urlReq = navigation.searchParams.get(REQ_QUERY_KEY);
  const urlDrill = navigation.searchParams.get(DRILL_QUERY_KEY);
  const urlAcc = navigation.searchParams.get(ACCEPT_QUERY_KEY);
  const urlSprint = navigation.searchParams.get(SPRINT_QUERY_KEY);
  const allowedViews = viewsForProjectTemplate(template);

  const [activeView, setActiveView] = useState<ProjectView>(() =>
    normalizeView(urlView, allowedViews),
  );
  const lastUrlViewRef = useRef(urlView);

  useEffect(() => {
    if (urlView === lastUrlViewRef.current) return;
    lastUrlViewRef.current = urlView;
    setActiveView(normalizeView(urlView, allowedViews));
  }, [urlView, allowedViews]);

  useEffect(() => {
    setActiveView((current) =>
      allowedViews.includes(current) ? current : normalizeView(urlView, allowedViews),
    );
  }, [allowedViews, urlView]);

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(navigation.searchParams);
      mutate(params);
      const query = params.toString();
      navigation.replace(`${navigation.pathname}${query ? `?${query}` : ""}`);
    },
    [navigation],
  );

  const selectView = useCallback(
    (next: string) => {
      const view = normalizeView(next, allowedViews);
      setActiveView(view);
      replaceParams((params) => {
        if (view === "archive") params.delete(VIEW_QUERY_KEY);
        else params.set(VIEW_QUERY_KEY, view);
        if (view !== "requirements") {
          params.delete(REQ_QUERY_KEY);
          params.delete(DRILL_QUERY_KEY);
        }
        if (view !== "acceptance") params.delete(ACCEPT_QUERY_KEY);
        if (view !== "sprints") params.delete(SPRINT_QUERY_KEY);
      });
    },
    [allowedViews, replaceParams],
  );

  useEffect(() => {
    if (workflowsEnabled || activeView !== "workflows") return;
    selectView("archive");
  }, [activeView, selectView]);

  const openRequirement = useCallback(
    (issueId: string, drill?: string) => {
      setActiveView("requirements");
      replaceParams((params) => {
        params.set(VIEW_QUERY_KEY, "requirements");
        params.set(REQ_QUERY_KEY, issueId);
        if (drill) params.set(DRILL_QUERY_KEY, drill);
        else params.delete(DRILL_QUERY_KEY);
        params.delete(ACCEPT_QUERY_KEY);
        params.delete(SPRINT_QUERY_KEY);
      });
    },
    [replaceParams],
  );

  const openAcceptance = useCallback(
    (issueId?: string) => {
      if (!allowedViews.includes("acceptance")) return;
      setActiveView("acceptance");
      replaceParams((params) => {
        params.set(VIEW_QUERY_KEY, "acceptance");
        if (issueId) params.set(ACCEPT_QUERY_KEY, issueId);
        else params.delete(ACCEPT_QUERY_KEY);
        params.delete(REQ_QUERY_KEY);
        params.delete(DRILL_QUERY_KEY);
        params.delete(SPRINT_QUERY_KEY);
      });
    },
    [allowedViews, replaceParams],
  );

  const issuesQuery = useQuery(calendarIssuesOptions(wsId));
  const artifactsQuery = useQuery(projectArtifactListOptions(wsId, projectId));
  const modulesQuery = useQuery(graphModulesOptions(wsId, projectId));
  const filingQuery = useQuery(filingReadinessOptions(wsId, projectId));

  const badges = useMemo(() => {
    const requirements = projectRequirements(issuesQuery.data ?? [], projectId);
    const pending = requirements.filter((r) => requirementBucket(r) === "pending").length;
    const failedAcc = requirements.filter((r) => requirementBucket(r) === "failed").length;
    const unbound = (artifactsQuery.data?.artifacts ?? []).filter(
      (a) => a.scope === "requirement" && !a.issue_id,
    ).length;
    const unboundModules = (modulesQuery.data?.modules ?? []).filter(
      (m) => !m.graph_node_id,
    ).length;
    return {
      archive: unbound,
      features: unboundModules,
      requirements: pending,
      acceptance: failedAcc,
      deliverables: artifactsQuery.data?.total ?? 0,
      filing: filingQuery.data?.blocking_count ?? 0,
    };
  }, [issuesQuery.data, artifactsQuery.data, modulesQuery.data, filingQuery.data, projectId]);

  const allViews: Array<{ value: ProjectView; label: string; badge?: number; alert?: boolean }> = [
    { value: "archive", label: t(($) => $.views.archive), badge: badges.archive, alert: badges.archive > 0 },
    { value: "assets", label: t(($) => $.views.assets) },
    { value: "sprints", label: t(($) => $.views.sprints) },
    { value: "features", label: t(($) => $.views.features), badge: modulesQuery.data?.total },
    { value: "data-model", label: t(($) => $.views.data_model) },
    {
      value: "requirements",
      label: t(($) => $.views.requirements),
      badge: badges.requirements,
      alert: badges.requirements > 0,
    },
    { value: "tasks", label: t(($) => $.views.tasks) },
    {
      value: "acceptance",
      label: t(($) => $.views.acceptance),
      badge: badges.acceptance,
      alert: badges.acceptance > 0,
    },
    { value: "deliverables", label: t(($) => $.views.deliverables), badge: badges.deliverables },
    {
      value: "filing",
      label: t(($) => $.views.filing),
      badge: badges.filing,
      alert: badges.filing > 0,
    },
    { value: "workflows", label: t(($) => $.views.workflows) },
  ];

  // Template allowed-views × asset feature-flag gate. The asset TAB is hidden
  // unless `asset_module` is on (server also gates route registration), so a
  // flag-off rollout leaves no dead TAB behind. Workflow follows the same
  // double-gate with `workflow_module` (plan 20261024 Agent-W); the sprint
  // TAB follows the same shape with `sprint_module` (plan 20261024 §02).
  const views = allViews.filter(
    (view) =>
      allowedViews.includes(view.value) &&
      (view.value !== "assets" || assetsEnabled) &&
      (view.value !== "workflows" || workflowsEnabled) &&
      (view.value !== "sprints" || sprintsEnabled),
  );

  const showRequirementDetail =
    activeView === "requirements" && Boolean(urlReq);
  // 迭代 TAB 是双栏 master-detail，自己持有两列的滚动；容器侧改成满高不滚，
  // 与 graph 视图同一套 flex 布局前提（侧栏 overflow-y-auto 需父级有界高度）。
  const isSplitOptions = activeView === "sprints";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-surface-border px-4">
        <Tabs value={activeView} onValueChange={selectView}>
          <TabsList variant="line">
            {views.map((view) => (
              <TabsTrigger key={view.value} value={view.value}>
                {view.label}
                {view.badge != null && (
                  <TabBadge count={view.badge} tone={view.alert ? "alert" : "muted"} />
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {activeView === "tasks" ? (
        <ProjectTaskTrackingProvider projectId={projectId}>
          <div className="flex min-h-0 flex-1 flex-col">
            <TaskTrackingToolbar />
            {children}
          </div>
        </ProjectTaskTrackingProvider>
      ) : (
        <div
          className={cn(
            "min-h-0 flex-1",
            isGraphView(activeView) || isSplitOptions
              ? "flex flex-col overflow-hidden"
              : "overflow-y-auto",
          )}
        >
          <div
            className={cn(
              "w-full",
              isGraphView(activeView) || isSplitOptions
                ? "flex min-h-0 flex-1 flex-col px-4 py-3"
                : "space-y-4 px-4 py-4",
            )}
          >
            {activeView === "archive" && (
              <ArchiveTab
                projectId={projectId}
                onOpenRequirement={openRequirement}
                onExportFiling={() => {
                  if (allowedViews.includes("filing")) selectView("filing");
                }}
              />
            )}
            {activeView === "assets" && <AssetTab projectId={projectId} />}
            {activeView === "sprints" && (
              <SprintTab
                projectId={projectId}
                selectedSprintId={urlSprint}
                onSelectSprint={(sprintId) =>
                  replaceParams((params) => params.set(SPRINT_QUERY_KEY, sprintId))
                }
              />
            )}
            {activeView === "workflows" && workflowsEnabled && <WorkflowTab projectId={projectId} />}
            <GraphViewStack projectId={projectId} activeView={activeView} />
            {activeView === "requirements" &&
              (showRequirementDetail && urlReq ? (
                <RequirementDetailView
                  projectId={projectId}
                  issueId={urlReq}
                  drill={urlDrill}
                  onDrillChange={(drill) =>
                    replaceParams((params) => params.set(DRILL_QUERY_KEY, drill))
                  }
                  onBack={() =>
                    replaceParams((params) => {
                      params.delete(REQ_QUERY_KEY);
                      params.delete(DRILL_QUERY_KEY);
                    })
                  }
                  onOpenAcceptance={() => openAcceptance(urlReq)}
                />
              ) : (
                <RequirementsManagementTab
                  projectId={projectId}
                  onOpenRequirement={openRequirement}
                  onOpenAcceptance={openAcceptance}
                />
              ))}
            {activeView === "acceptance" && (
              <AcceptanceTab
                projectId={projectId}
                focusIssueId={urlAcc}
                onOpenRequirement={openRequirement}
              />
            )}
            {activeView === "deliverables" && (
              <ProjectDeliverablesTab
                projectId={projectId}
                onOpenRequirement={openRequirement}
                onOpenAcceptance={openAcceptance}
              />
            )}
            {activeView === "filing" && (
              <FilingReadinessTab projectId={projectId} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
