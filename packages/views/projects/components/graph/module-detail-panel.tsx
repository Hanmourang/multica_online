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
import { issuesForModule, moduleRequirements, moduleTasks } from "./module-feature-stats";
import { ArchiveEmpty, QueryLoading } from "../archive/query-states";
import { ChangeOverviewTab } from "./sub-tabs/change-overview";
import { ModulePrototypesTab } from "./sub-tabs/module-prototypes";
import { PrototypeWorkbench } from "./prototype-workbench";

type FeatureSubTab = "prototypes" | "changes" | "reconcile";

/**
 * f10 右栏 · 模块详情（原型图 / 变更概览 / 验收与覆盖）。
 *
 * 2026-10-30 收敛：模块对象、模块策略、图谱邻域三个子 TAB 删除。
 * 它们不是独立的产品概念，而是功能点的「实现证据」——数据仍作为原型对比的
 * 图层（objects/nodes）参与渲染，但不再占一个顶层入口。
 *
 * The sub-tab value persists across module switches on purpose — comparing
 * the same facet between modules is the primary workflow.
 * Only the active panel mounts (Base UI keepMounted=false).
 */
export function ModuleDetailPanel() {
  const { t } = useT("archive");
  const { t: tt } = useT("module-prototype");
  const wsId = useWorkspaceId();
  // 结构对账子 TAB 与后端中枢同受 FF_MODULE_SPEC_CENTER 门控：关闭时 TAB 隐藏，
  // 且后端叶子未注册（双层门控，记忆「flag 双层门控」）。
  const specCenterEnabled = useFeatureEnabled(MODULE_SPEC_CENTER_FLAG, false);
  const { projectId, selectedNodeId, selectedModuleId } = useGraphData();
  const deferredNodeId = useDeferredValue(selectedNodeId);
  const deferredModuleId = useDeferredValue(selectedModuleId);
  const [tab, setTab] = useState<FeatureSubTab>("prototypes");
  // 模块列表不再按 graph_node_id 选中：未绑定图谱的模块一样能进详情写原型。
  const modulesQuery = useQuery(graphModulesOptions(wsId, projectId));
  const modules = modulesQuery.data?.modules ?? [];
  const selectedModule =
    modules.find((row) => row.id === deferredModuleId) ??
    (deferredNodeId
      ? modules.find((row) => row.graph_node_id === deferredNodeId)
      : undefined);
  const issuesQuery = useQuery({
    ...projectIssuesForModulesOptions(wsId, projectId),
    enabled: Boolean(selectedModule),
  });
  const moduleIssues = selectedModule
    ? issuesForModule(issuesQuery.data ?? [], projectId, selectedModule.id)
    : [];

  if (!selectedModule) {
    if (modulesQuery.isPending) return <QueryLoading rows={5} />;
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
  const moduleNodeId = selectedModule.graph_node_id ?? null;

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (value === "prototypes" || value === "changes" || value === "reconcile") {
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
          <ModulePrototypesTab
            key={selectedModule.id}
            moduleId={selectedModule.id}
            nodeId={moduleNodeId}
          />
        ) : null}
      </TabsContent>
      <TabsContent value="changes" className="mt-3 min-h-0 flex-1 overflow-auto">
        {tab === "changes" ? (
          <ChangeOverviewTab nodeId={moduleNodeId ?? ""} moduleId={selectedModule.id} />
        ) : null}
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
