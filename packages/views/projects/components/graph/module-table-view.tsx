"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { graphModulesOptions, projectIssuesForModulesOptions } from "@multica/core/graph/queries";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { FeaturePill, FeatureTable, FeatureTd, FeatureTh, TypeChip } from "./feature-chrome";
import { useGraphData } from "./graph-data-provider";
import {
  EMPTY_FEATURE_FILTERS,
  resolveFeatureFilters,
  type FeatureModuleFilters,
} from "./feature-modules-model";
import {
  communityLabel,
  issuesForModule,
  moduleHealth,
  moduleRequirements,
  moduleTasks,
  rollupTasks,
  summaryForModule,
} from "./module-feature-stats";
import { QueryError, QueryLoading } from "../archive/query-states";

export function ModuleTableView({ filters }: { filters?: FeatureModuleFilters }) {
  const resolvedFilters = resolveFeatureFilters(filters ?? EMPTY_FEATURE_FILTERS);
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId, snapshot, selectedNodeId, selectedModuleId, setSelectedNodeId, setSelectedModuleId } =
    useGraphData();
  const modulesQuery = useQuery(graphModulesOptions(wsId, projectId));
  const issuesQuery = useQuery(projectIssuesForModulesOptions(wsId, projectId));

  const rows = useMemo(() => {
    const query = resolvedFilters.search.trim().toLowerCase();
    const summaries = snapshot?.module_summary ?? [];
    const modules = (modulesQuery.data?.modules ?? []).filter((module) => {
      if (resolvedFilters.unboundOnly && module.graph_node_id) return false;
      if (query && !module.name.toLowerCase().includes(query)) return false;
      if (resolvedFilters.bizKind !== "all") {
        const summary = summaryForModule(summaries, module.graph_node_id, module.name);
        if ((summary?.biz_kind ?? "") !== resolvedFilters.bizKind) return false;
      }
      return true;
    });
    return [...modules].sort((a, b) => Number(Boolean(b.graph_node_id)) - Number(Boolean(a.graph_node_id)));
  }, [modulesQuery.data, resolvedFilters, snapshot]);

  if (modulesQuery.isPending) return <QueryLoading rows={6} />;
  if (modulesQuery.isError) return <QueryError onRetry={() => void modulesQuery.refetch()} />;

  const summaries = snapshot?.module_summary ?? [];
  const issues = issuesQuery.data ?? [];

  return (
    <div className="overflow-hidden rounded-[10px] border border-surface-border bg-surface">
      <FeatureTable>
        <thead>
          <tr className="bg-muted/30">
            <FeatureTh>{t(($) => $.features.page_badge)}</FeatureTh>
            <FeatureTh className="text-right">{t(($) => $.features.stat_objects)}</FeatureTh>
            <FeatureTh className="text-right">{t(($) => $.features.stat_strategies)}</FeatureTh>
            <FeatureTh className="text-right">{t(($) => $.features.stat_requirements)}</FeatureTh>
            <FeatureTh>{t(($) => $.features.table_community)}</FeatureTh>
            <FeatureTh>{t(($) => $.features.table_health)}</FeatureTh>
            <FeatureTh>{t(($) => $.features.table_bound)}</FeatureTh>
          </tr>
        </thead>
        <tbody>
          {rows.map((module) => {
            const summary = summaryForModule(summaries, module.graph_node_id, module.name);
            const moduleIssues = issuesForModule(issues, projectId, module.id);
            const tasks = rollupTasks(moduleTasks(moduleIssues));
            const health = moduleHealth(Boolean(module.graph_node_id), moduleIssues);
            const selected = selectedModuleId
              ? selectedModuleId === module.id
              : Boolean(module.graph_node_id) && selectedNodeId === module.graph_node_id;
            return (
              <tr
                key={module.id}
                className={cn("cursor-pointer", selected && "bg-primary/5")}
                onClick={() => {
                  setSelectedModuleId(module.id);
                  setSelectedNodeId(module.graph_node_id ?? null);
                }}
              >
                <FeatureTd>
                  <span className="inline-flex items-center gap-1.5">
                    <TypeChip muted={!module.graph_node_id}>
                      {module.graph_node_id ? t(($) => $.features.page_badge) : "?"}
                    </TypeChip>
                    <span className="font-semibold">{module.name}</span>
                  </span>
                </FeatureTd>
                <FeatureTd className="text-right tabular-nums">{summary?.obj_count ?? 0}</FeatureTd>
                <FeatureTd className="text-right tabular-nums">{summary?.strategy_count ?? 0}</FeatureTd>
                <FeatureTd className="text-right tabular-nums">
                  {moduleRequirements(moduleIssues).length}
                </FeatureTd>
                <FeatureTd className="font-mono text-[10.5px] text-muted-foreground">
                  {communityLabel(module.graph_node_id ?? summary?.node_id) || "—"}
                  {tasks.total > 0 ? ` · ${tasks.done}/${tasks.total}` : ""}
                </FeatureTd>
                <FeatureTd>
                  <span className={cn("inline-block size-[7px] rounded-full", healthDot(health))} />
                </FeatureTd>
                <FeatureTd>
                  <FeaturePill tone={module.graph_node_id ? "ok" : "warn"}>
                    {module.graph_node_id ? t(($) => $.features.page_badge) : t(($) => $.features.unbound_badge)}
                  </FeaturePill>
                </FeatureTd>
              </tr>
            );
          })}
        </tbody>
      </FeatureTable>
    </div>
  );
}

function healthDot(health: ReturnType<typeof moduleHealth>): string {
  switch (health) {
    case "ok":
      return "bg-emerald-500";
    case "busy":
      return "bg-primary";
    case "warn":
      return "bg-amber-500";
    case "unbound":
      return "bg-destructive";
  }
}
