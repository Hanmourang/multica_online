"use client";

import { ListTodo, Plus } from "lucide-react";
import { useModalStore } from "@multica/core/modals";
import { Button } from "@multica/ui/components/ui/button";
import type {
  Issue,
  IssueTableFacetSpec,
  IssueTableFacetsResponse,
  WorkingAgentSummary,
} from "@multica/core/types";
import { useIssuesScope } from "@multica/core/issues/stores/issues-scope-store";
import { useViewStore } from "@multica/core/issues/stores/view-store-context";
import { PageHeader } from "../../layout/page-header";
import { useT } from "../../i18n";
import { IssueSurface } from "../surface/issue-surface";
import { IssuesHeader } from "./issues-header";
import type { IssueCreateDefaults } from "../surface/types";

const TASK_CREATE_DEFAULTS: IssueCreateDefaults = { create_kind: "task" };

function openNewTask() {
  useModalStore.getState().open("create-issue", TASK_CREATE_DEFAULTS);
}

function IssuesSurfaceHeader({
  issues,
  workingAgents,
  allowCalendar,
  isRefreshing,
  facetCountsExact,
  tableFacetCounts,
  onTableFacetChange,
}: {
  issues: Issue[];
  workingAgents: WorkingAgentSummary[] | undefined;
  allowCalendar: boolean;
  isRefreshing: boolean;
  facetCountsExact: boolean;
  tableFacetCounts?: IssueTableFacetsResponse;
  onTableFacetChange: (facet: IssueTableFacetSpec | null) => void;
}) {
  const dateFilter = useViewStore((s) => s.dateFilter);
  const setDateFilter = useViewStore((s) => s.setDateFilter);

  return (
    <IssuesHeader
      scopedIssues={issues}
      workingAgents={workingAgents}
      allowCalendar={allowCalendar}
      dateFilter={dateFilter}
      onDateFilterChange={setDateFilter}
      isRefreshing={isRefreshing}
      facetCountsExact={facetCountsExact}
      tableFacetCounts={tableFacetCounts}
      onTableFacetChange={onTableFacetChange}
    />
  );
}

export function IssuesPage() {
  const { t } = useT("issues");
  const scope = useIssuesScope("issues");

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageHeader>
        <ListTodo className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-body font-medium">{t(($) => $.page.breadcrumb_title)}</h1>
        <Button
          size="sm"
          className="ml-auto"
          data-testid="issues-new-task"
          onClick={openNewTask}
        >
          <Plus className="h-3.5 w-3.5" /> {t(($) => $.page.new_issue)}
        </Button>
      </PageHeader>

      <IssueSurface
        scope={{ type: "workspace", actorKind: scope }}
        createDefaults={TASK_CREATE_DEFAULTS}
        // 日历已提升为一级模块（侧边栏 /calendar），任务子视图不再提供日历 tab。
        modes={["board", "list", "table", "swimlane"]}
        batchToolbar="list"
        renderHeader={({ controller }) => (
          <IssuesSurfaceHeader
            issues={controller.surfaceIssues}
            workingAgents={controller.workingAgents}
            allowCalendar={controller.allowCalendar}
            isRefreshing={controller.isRefreshing}
            facetCountsExact={controller.facetCountsExact}
            tableFacetCounts={controller.tableFacetCounts}
            onTableFacetChange={controller.setActiveTableFacet}
          />
        )}
        renderEmpty={() => (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-2 text-muted-foreground">
            <ListTodo className="h-10 w-10 text-faint-foreground" />
            <p className="text-body">{t(($) => $.page.empty_title)}</p>
            <p className="text-caption">{t(($) => $.page.empty_hint)}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-1"
              data-testid="issues-empty-new-task"
              onClick={openNewTask}
            >
              <Plus className="size-3.5 mr-1.5" />
              {t(($) => $.page.new_issue)}
            </Button>
          </div>
        )}
      />
    </div>
  );
}
