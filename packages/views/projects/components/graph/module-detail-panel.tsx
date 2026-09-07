"use client";

import { Boxes } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@multica/ui/components/ui/tabs";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import { ArchiveEmpty } from "../archive/query-states";
import { ChangeOverviewTab } from "./sub-tabs/change-overview";
import { ModuleObjectsTab } from "./sub-tabs/module-objects";
import { ModuleStrategiesTab } from "./sub-tabs/module-strategies";
import { GraphNeighborhoodTab } from "./sub-tabs/graph-neighborhood";

/**
 * f10 右栏 · 模块详情（4 个子 Tab，原型标注 4：原型平铺、实现为切换式）。
 *
 * The sub-tab value persists across module switches on purpose — comparing
 * the same facet between modules is the primary workflow.
 */
export function ModuleDetailPanel() {
  const { t } = useT("archive");
  const { selectedNodeId } = useGraphData();

  if (!selectedNodeId) {
    return (
      <ArchiveEmpty
        icon={<Boxes className="size-5" />}
        title={t(($) => $.features.select_module)}
        className="min-h-48"
      />
    );
  }

  return (
    <Tabs defaultValue="changes">
      <TabsList variant="line">
        <TabsTrigger value="changes">
          {t(($) => $.features.sub_change_overview)}
        </TabsTrigger>
        <TabsTrigger value="objects">
          {t(($) => $.features.sub_objects)}
        </TabsTrigger>
        <TabsTrigger value="strategies">
          {t(($) => $.features.sub_strategies)}
        </TabsTrigger>
        <TabsTrigger value="neighborhood">
          {t(($) => $.features.sub_neighborhood)}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="changes" className="mt-3">
        <ChangeOverviewTab nodeId={selectedNodeId} />
      </TabsContent>
      <TabsContent value="objects" className="mt-3">
        <ModuleObjectsTab nodeId={selectedNodeId} />
      </TabsContent>
      <TabsContent value="strategies" className="mt-3">
        <ModuleStrategiesTab nodeId={selectedNodeId} />
      </TabsContent>
      <TabsContent value="neighborhood" className="mt-3">
        <GraphNeighborhoodTab nodeId={selectedNodeId} />
      </TabsContent>
    </Tabs>
  );
}
