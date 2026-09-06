"use client";

/**
 * CalendarPage — 工作区级需求日历（spec §2）。
 * 页面负责数据/过滤；CalendarView 纯受控渲染。zoom 存于独立 view store
 * 实例（"calendar-page"），不与 /issues 表面的偏好互相污染。
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import { useWorkspaceId } from "@multica/core/hooks";
import type { Issue } from "@multica/core/types";
import { issueListOptions } from "@multica/core/issues/queries";
import { projectListOptions } from "@multica/core/projects/queries";
import { openCreateIssueWithPreference } from "@multica/core/issues/stores/create-mode-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { getIssueSurfaceViewStore } from "@multica/core/issues/stores/surface-view-store";
import { PageHeader } from "../layout/page-header";
import { useT } from "../i18n";
import { CalendarView } from "./calendar-view";
import { RequirementDrawer } from "./requirement-drawer";

function CalendarSurface({
  issues,
  projectFilter,
  onOpenRequirement,
}: {
  issues: Issue[];
  projectFilter: string | null;
  onOpenRequirement: (id: string) => void;
}) {
  const requirements = useMemo(
    () =>
      issues.filter(
        (i) =>
          !i.parent_issue_id &&
          // requirement_status 析取项留给二期「待确认聚合 chip」：无排期的
          // 需求能过此过滤，但 CalendarView 的 requirementSpan 仍要求
          // start_at/due_date 才渲染——日历色块的渲染门槛是「必须有排期」。
          (i.start_at || i.due_date || i.requirement_status) &&
          (!projectFilter || i.project_id === projectFilter),
      ),
    [issues, projectFilter],
  );
  return (
    <CalendarView issues={requirements} onOpenRequirement={onOpenRequirement} />
  );
}

export function CalendarPage() {
  const { t } = useT("calendar");
  const wsId = useWorkspaceId();
  const store = useMemo(() => getIssueSurfaceViewStore("calendar-page"), []);
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  // 列表查询提在页面层：过滤后的需求喂 CalendarView，原始列表同时给抽屉
  // 供 statusBadge —— requirement_status 是列表端投影列，GetIssue 不返回
  // （见 RequirementDrawer prop 注释）。
  const {
    data: issues = [],
    isError,
    refetch,
  } = useQuery(issueListOptions(wsId));
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [drawerIssueId, setDrawerIssueId] = useState<string | null>(null);

  // spec §5：列表查询失败 → toast + 页面级重试。失败必须与「真空工作区」
  // 可区分——data=[] 兑底会把查询失败渲染成空日历。
  useEffect(() => {
    if (isError) toast.error(t(($) => $.page.load_failed));
  }, [isError, t]);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageHeader>
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-body font-medium">{t(($) => $.page.title)}</h1>
        <div className="ml-auto flex items-center gap-2">
          {/* 项目过滤 chip：全部 / 各项目（PM/拆解状态过滤与待确认聚合
              为二期增强，先保项目维度——YAGNI） */}
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
          <Button size="sm" onClick={() => openCreateIssueWithPreference()}>
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
          issues={issues}
          projectFilter={projectFilter}
          onOpenRequirement={setDrawerIssueId}
        />
      </ViewStoreProvider>
      <RequirementDrawer
        issueId={drawerIssueId}
        statusBadge={
          issues.find((i) => i.id === drawerIssueId)?.requirement_status
        }
        onOpenChange={(open) => !open && setDrawerIssueId(null)}
      />
    </div>
  );
}
