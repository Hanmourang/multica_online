"use client";

import { useDeferredValue, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@multica/ui/components/ui/tabs";
import { useWorkspaceId } from "@multica/core/hooks";
import { useFeatureEnabled } from "@multica/core/config";
import { MODULE_SPEC_CENTER_FLAG } from "@multica/core/feature-flags";
import {
  graphModulesOptions,
  projectIssuesForModulesOptions,
} from "@multica/core/graph/queries";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import { issuesForModule, moduleRequirements, moduleTasks, summaryForModule } from "./module-feature-stats";
import { ArchiveEmpty } from "../archive/query-states";
import { ChangeOverviewTab } from "./sub-tabs/change-overview";
import { ModuleObjectsTab } from "./sub-tabs/module-objects";
import { ModuleStrategiesTab } from "./sub-tabs/module-strategies";
import { GraphNeighborhoodTab } from "./sub-tabs/graph-neighborhood";
import { ModulePrototypesTab } from "./sub-tabs/module-prototypes";
import { PrototypeWorkbench } from "./prototype-workbench";

type FeatureSubTab = "prototypes" | "changes" | "objects" | "strategies" | "neighborhood" | "reconcile";

/**
 * f10 右栏 · 模块详情（4 个子 Tab，原型标注 4：原型平铺、实现为切换式）。
 *
 * The sub-tab value persists across module switches on purpose — comparing
 * the same facet between modules is the primary workflow.
 * Only the active panel mounts (Base UI keepMounted=false); badge counts
 * come from the snapshot / issue cache so switching does not prefetch
 * objects, strategies, neighborhood, or prototype HTML.
 */
export function ModuleDetailPanel() {
  const { t } = useT("archive");
  const { t: tt } = useT("module-prototype");
  const wsId = useWorkspaceId();
  // 结构对账子 TAB 与后端中枢同受 FF_MODULE_SPEC_CENTER 门控：关闭时 TAB 隐藏，
  // 且后端叶子未注册（双层门控，记忆「flag 双层门控」）。
  const specCenterEnabled = useFeatureEnabled(MODULE_SPEC_CENTER_FLAG, false);
  const { projectId, snapshot, selectedNodeId } = useGraphData();
  const deferredNodeId = useDeferredValue(selectedNodeId);
  const [tab, setTab] = useState<FeatureSubTab>("prototypes");
  const modulesQuery = useQuery({
    ...graphModulesOptions(wsId, projectId),
    enabled: Boolean(deferredNodeId),
  });
  const issuesQuery = useQuery({
    ...projectIssuesForModulesOptions(wsId, projectId),
    enabled: Boolean(deferredNodeId),
  });
  const selectedModule = (modulesQuery.data?.modules ?? []).find(
    (row) => row.graph_node_id === deferredNodeId,
  );
  const moduleIssues = selectedModule
    ? issuesForModule(issuesQuery.data ?? [], projectId, selectedModule.id)
    : [];
  const summary = summaryForModule(
    snapshot?.module_summary ?? [],
    deferredNodeId,
    selectedModule?.name ?? "",
  );

  if (!selectedNodeId) {
    return (
      <ArchiveEmpty
        icon={<Boxes className="size-5" />}
        title={t(($) => $.features.select_module)}
        description={t(($) => $.features.no_modules_hint)}
        className="h-full min-h-0 border-0 bg-transparent"
      />
    );
  }

  const reqCount = moduleRequirements(moduleIssues).length;
  const taskCount = moduleTasks(moduleIssues).length;
  const objectCount = summary?.obj_count ?? 0;
  const strategyCount = summary?.strategy_count ?? 0;
  const activeNodeId = deferredNodeId ?? selectedNodeId;

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (
          value === "prototypes" ||
          value === "changes" ||
          value === "objects" ||
          value === "strategies" ||
          value === "neighborhood" ||
          value === "reconcile"
        ) {
          setTab(value);
        }
      }}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <TabsList
        variant="line"
        className="h-auto w-full shrink-0 justify-start gap-0.5 rounded-none border-b border-surface-border bg-transparent p-0"
      >
        <TabsTrigger
          value="prototypes"
          className="rounded-none border-b-2 border-transparent px-3 py-2 text-[11.5px] font-semibold data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
        >
          {t(($) => $.features.sub_prototypes)}
        </TabsTrigger>
        <TabsTrigger
          value="changes"
          className="rounded-none border-b-2 border-transparent px-3 py-2 text-[11.5px] font-semibold data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
        >
          {t(($) => $.features.sub_change_overview)}
          <span className="ml-1 rounded-full bg-muted px-1.5 text-[9px] font-bold tabular-nums text-muted-foreground">
            {t(($) => $.features.sub_change_count, { req: reqCount, task: taskCount })}
          </span>
        </TabsTrigger>
        <TabsTrigger
          value="objects"
          className="rounded-none border-b-2 border-transparent px-3 py-2 text-[11.5px] font-semibold data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
        >
          {t(($) => $.features.sub_objects)}
          <span className="ml-1 rounded-full bg-muted px-1.5 text-[9px] tabular-nums text-muted-foreground">
            {objectCount}
          </span>
        </TabsTrigger>
        <TabsTrigger
          value="strategies"
          className="rounded-none border-b-2 border-transparent px-3 py-2 text-[11.5px] font-semibold data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
        >
          {t(($) => $.features.sub_strategies)}
          <span className="ml-1 rounded-full bg-muted px-1.5 text-[9px] tabular-nums text-muted-foreground">
            {strategyCount}
          </span>
        </TabsTrigger>
        <TabsTrigger
          value="neighborhood"
          className="rounded-none border-b-2 border-transparent px-3 py-2 text-[11.5px] font-semibold data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
        >
          {t(($) => $.features.sub_neighborhood)}
        </TabsTrigger>
        {specCenterEnabled && selectedModule ? (
          <TabsTrigger
            value="reconcile"
            className="rounded-none border-b-2 border-transparent px-3 py-2 text-[11.5px] font-semibold data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            {tt(($) => $.coverage.title)}
          </TabsTrigger>
        ) : null}
      </TabsList>
      <TabsContent value="prototypes" className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === "prototypes" ? (
          <ModulePrototypesTab key={activeNodeId} nodeId={activeNodeId} />
        ) : null}
      </TabsContent>
      <TabsContent value="changes" className="mt-3 min-h-0 flex-1 overflow-auto">
        {tab === "changes" ? <ChangeOverviewTab nodeId={activeNodeId} /> : null}
      </TabsContent>
      <TabsContent value="objects" className="mt-3 min-h-0 flex-1 overflow-auto">
        {tab === "objects" ? <ModuleObjectsTab nodeId={activeNodeId} /> : null}
      </TabsContent>
      <TabsContent value="strategies" className="mt-3 min-h-0 flex-1 overflow-auto">
        {tab === "strategies" ? <ModuleStrategiesTab nodeId={activeNodeId} /> : null}
      </TabsContent>
      <TabsContent value="neighborhood" className="mt-3 min-h-0 flex-1 overflow-auto">
        {tab === "neighborhood" ? <GraphNeighborhoodTab nodeId={activeNodeId} /> : null}
      </TabsContent>
      {specCenterEnabled && selectedModule ? (
        <TabsContent value="reconcile" className="mt-3 min-h-0 flex-1 overflow-auto">
          {tab === "reconcile" ? (
            <PrototypeWorkbench
              key={selectedModule.id}
              wsId={wsId}
              projectId={projectId}
              moduleId={selectedModule.id}
            />
          ) : null}
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
