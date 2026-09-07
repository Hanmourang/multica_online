"use client";

/**
 * CalendarPage — 工作区级需求日历（spec §2）。
 * 页面负责数据/过滤；CalendarView 纯受控渲染。zoom 存于独立 view store
 * 实例（"calendar-page"），不与 /issues 表面的偏好互相污染。
 */
import { useEffect, useMemo, useState } from "react";
import { useWorkspacePaths } from "@multica/core/paths";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CalendarDays, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import { useWorkspaceId } from "@multica/core/hooks";
import type { Issue, ProjectModule } from "@multica/core/types";
import { calendarIssuesOptions } from "@multica/core/issues/queries";
import { projectListOptions } from "@multica/core/projects/queries";
import { projectModulesOptions } from "@multica/core/modules";
import { useModalStore } from "@multica/core/modals";
import { useActorName } from "@multica/core/workspace/hooks";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { getIssueSurfaceViewStore } from "@multica/core/issues/stores/surface-view-store";
import { PageHeader } from "../layout/page-header";
import { useNavigation } from "../navigation";
import { useT } from "../i18n";
import { CalendarView } from "./calendar-view";
import { RequirementDrawer } from "./requirement-drawer";
import { useRequirementWorkbench } from "./use-requirement-workbench";
import { stageForRequirementStatus } from "./calendar-helpers";
import { isTopLevelRequirement } from "../projects/components/requirements/requirement-helpers";
import type { FlowStage } from "../issues/components/requirement-flow-section";

const PENDING_STATUSES = new Set(["原型待确认", "拆解待确认"]);

function CalendarSurface({
  issues,
  onOpenRequirement,
}: {
  issues: Issue[];
  onOpenRequirement: (id: string) => void;
}) {
  const requirements = useMemo(
    () =>
      issues.filter(
        (i) =>
          !i.parent_issue_id &&
          // 色块仍要求排期；无 start_at/due_date 的待确认需求只进工具栏计数
          // 和项目列表，不进格子。
          Boolean(i.start_at || i.due_date),
      ),
    [issues],
  );
  return (
    <CalendarView issues={requirements} onOpenRequirement={onOpenRequirement} />
  );
}

export function CalendarPage() {
  const { t } = useT("calendar");
  const wsId = useWorkspaceId();
  const { searchParams } = useNavigation();
  const paths = useWorkspacePaths();
  const {
    issueId: drawerIssueId,
    open: openWorkbench,
    close: closeDrawer,
  } = useRequirementWorkbench();
  const { getActorName } = useActorName();
  const store = useMemo(() => getIssueSurfaceViewStore("calendar-page"), []);
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const {
    data: issues = [],
    isError,
    refetch,
  } = useQuery(calendarIssuesOptions(wsId));
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [pmFilter, setPmFilter] = useState<string | null>(null);
  const [moduleFilter, setModuleFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [pendingOnly, setPendingOnly] = useState(false);
  const stageFromUrl = parseStageParam(searchParams.get("stage"));

  const modules = useQueries({
    queries: projects.map((p) => projectModulesOptions(wsId, p.id)),
    combine: (results) => {
      const map = new Map<string, { id: string; name: string }>();
      for (const query of results) {
        for (const mod of (query.data ?? []) as ProjectModule[]) {
          if (!map.has(mod.id)) map.set(mod.id, { id: mod.id, name: mod.name });
        }
      }
      return [...map.values()];
    },
  });

  useEffect(() => {
    if (isError) toast.error(t(($) => $.page.load_failed));
  }, [isError, t]);

  const scoped = useMemo(
    () =>
      issues.filter(
        (i) =>
          isTopLevelRequirement(i) &&
          (i.start_at || i.due_date || i.requirement_status) &&
          (!projectFilter || i.project_id === projectFilter) &&
          (!moduleFilter || i.module_id === moduleFilter),
      ),
    [issues, projectFilter, moduleFilter],
  );

  const pendingCount = useMemo(
    () =>
      scoped.filter((i) =>
        i.requirement_status ? PENDING_STATUSES.has(i.requirement_status) : false,
      ).length,
    [scoped],
  );

  const pmOptions = useMemo(() => {
    const seen = new Map<string, { type: string; id: string }>();
    for (const i of scoped) {
      if (i.assignee_id && i.assignee_type && !seen.has(i.assignee_id)) {
        seen.set(i.assignee_id, { type: i.assignee_type, id: i.assignee_id });
      }
    }
    return [...seen.values()];
  }, [scoped]);

  const statusOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of scoped) {
      if (i.requirement_status) set.add(i.requirement_status);
    }
    return [...set].sort();
  }, [scoped]);

  const filtered = useMemo(
    () =>
      scoped.filter((i) => {
        if (pmFilter && i.assignee_id !== pmFilter) return false;
        if (pendingOnly) {
          return i.requirement_status
            ? PENDING_STATUSES.has(i.requirement_status)
            : false;
        }
        if (statusFilter && i.requirement_status !== statusFilter) return false;
        return true;
      }),
    [scoped, pmFilter, statusFilter, pendingOnly],
  );

  const openRequirement = (id: string) => {
    openWorkbench(
      id,
      stageForRequirementStatus(
        issues.find((i) => i.id === id)?.requirement_status,
      ),
    );
  };

  const closeWorkbench = () => {
    const current = issues.find((i) => i.id === drawerIssueId);
    closeDrawer({
      issue: drawerIssueId ? paths.issueDetail(drawerIssueId) : undefined,
      project:
        current?.project_id && drawerIssueId
          ? paths.projectRequirement(current.project_id, drawerIssueId)
          : undefined,
    });
  };

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageHeader>
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-body font-medium">{t(($) => $.page.title)}</h1>
        <div className="ml-auto flex items-center gap-2">
          <select
            aria-label={t(($) => $.page.project_filter)}
            className="h-7 rounded-md border border-surface-border bg-transparent px-2 text-caption"
            value={projectFilter ?? ""}
            onChange={(e) => setProjectFilter(e.target.value || null)}
          >
            <option value="">{t(($) => $.page.all_projects)}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <select
            aria-label={t(($) => $.page.module_filter)}
            className="h-7 rounded-md border border-surface-border bg-transparent px-2 text-caption"
            value={moduleFilter ?? ""}
            onChange={(e) => setModuleFilter(e.target.value || null)}
          >
            <option value="">{t(($) => $.page.all_modules)}</option>
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select
            aria-label={t(($) => $.page.pm_filter)}
            className="h-7 rounded-md border border-surface-border bg-transparent px-2 text-caption"
            value={pmFilter ?? ""}
            onChange={(e) => setPmFilter(e.target.value || null)}
          >
            <option value="">{t(($) => $.page.all_pms)}</option>
            {pmOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {getActorName(a.type, a.id)}
              </option>
            ))}
          </select>
          <select
            aria-label={t(($) => $.page.status_filter)}
            className="h-7 rounded-md border border-surface-border bg-transparent px-2 text-caption"
            value={pendingOnly ? "" : (statusFilter ?? "")}
            onChange={(e) => {
              setPendingOnly(false);
              setStatusFilter(e.target.value || null);
            }}
          >
            <option value="">{t(($) => $.page.all_statuses)}</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-pressed={pendingOnly}
            aria-label={t(($) => $.page.pending_chip, { count: pendingCount })}
            onClick={() => {
              const next = !pendingOnly;
              setPendingOnly(next);
              if (!next) return;
              setStatusFilter(null);
              const first = scoped
                .filter((i) =>
                  i.requirement_status
                    ? PENDING_STATUSES.has(i.requirement_status)
                    : false,
                )
                .toSorted((a, b) =>
                  (a.start_at ?? "").localeCompare(b.start_at ?? ""),
                )[0];
              if (!first) return;
              openWorkbench(
                first.id,
                stageForRequirementStatus(first.requirement_status),
              );
            }}
            className={`h-7 rounded-md border px-2 text-caption ${
              pendingOnly
                ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "border-surface-border text-muted-foreground"
            }`}
          >
            {t(($) => $.page.pending_chip, { count: pendingCount })}
          </button>
          <Button
            size="sm"
            onClick={() =>
              useModalStore.getState().open("create-issue", {
                project_id: projectFilter,
                source: "calendar",
              })
            }
          >
            <Plus className="h-3.5 w-3.5" /> {t(($) => $.page.new_requirement)}
          </Button>
        </div>
      </PageHeader>
      {isError && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-surface-border px-4 py-2 text-caption text-destructive"
        >
          <span className="flex-1">{t(($) => $.page.load_failed)}</span>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            {t(($) => $.page.retry)}
          </Button>
        </div>
      )}
      <ViewStoreProvider store={store}>
        <CalendarSurface
          issues={filtered}
          onOpenRequirement={openRequirement}
        />
      </ViewStoreProvider>
      <RequirementDrawer
        issueId={drawerIssueId}
        statusBadge={
          issues.find((i) => i.id === drawerIssueId)?.requirement_status
        }
        initialViewedStage={
          stageFromUrl ??
          stageForRequirementStatus(
            issues.find((i) => i.id === drawerIssueId)?.requirement_status,
          )
        }
        onOpenChange={(isOpen) => {
          if (!isOpen) closeWorkbench();
        }}
      />
    </div>
  );
}

function parseStageParam(raw: string | null): FlowStage | null {
  if (raw === "1" || raw === "2" || raw === "3" || raw === "4") {
    return Number(raw) as FlowStage;
  }
  return null;
}
