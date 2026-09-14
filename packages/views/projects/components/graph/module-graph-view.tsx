"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { graphModulesOptions, graphSnapshotDetailOptions } from "@multica/core/graph/queries";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { TypeChip } from "./feature-chrome";
import { useGraphData } from "./graph-data-provider";
import { communityLabel, summaryForModule } from "./module-feature-stats";
import {
  EMPTY_FEATURE_FILTERS,
  resolveFeatureFilters,
  type FeatureModuleFilters,
} from "./feature-modules-model";
import { ArchiveEmpty, QueryError, QueryLoading } from "../archive/query-states";

export function ModuleGraphView({ filters }: { filters?: FeatureModuleFilters }) {
  const resolvedFilters = resolveFeatureFilters(filters ?? EMPTY_FEATURE_FILTERS);
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId, snapshot, selectedNodeId, setSelectedNodeId } = useGraphData();
  const detailQuery = useQuery(graphSnapshotDetailOptions(wsId, projectId));
  const modulesQuery = useQuery(graphModulesOptions(wsId, projectId));

  const communities = useMemo(() => {
    const query = resolvedFilters.search.trim().toLowerCase();
    return (detailQuery.data?.communities ?? []).filter((community) => {
      if (query && !community.name.toLowerCase().includes(query) && !community.id.toLowerCase().includes(query)) {
        return false;
      }
      if (resolvedFilters.bizKind !== "all" && (community.biz_kind ?? "") !== resolvedFilters.bizKind) return false;
      if (resolvedFilters.unboundOnly) {
        const bound = (modulesQuery.data?.modules ?? []).some((module) => module.graph_node_id === community.id);
        if (bound) return false;
      }
      return true;
    });
  }, [detailQuery.data, resolvedFilters, modulesQuery.data]);

  if (detailQuery.isPending) return <QueryLoading rows={6} />;
  if (detailQuery.isError) return <QueryError onRetry={() => void detailQuery.refetch()} />;
  if (communities.length === 0) {
    return (
      <ArchiveEmpty
        icon={<Share2 className="size-5" />}
        title={t(($) => $.features.view_graph)}
        description={t(($) => $.features.graph_empty)}
      />
    );
  }

  const summaries = snapshot?.module_summary ?? [];
  const modules = modulesQuery.data?.modules ?? [];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        {communities.map((community) => {
          const selected = selectedNodeId === community.id;
          const summary = summaryForModule(summaries, community.id, community.name);
          const bound = modules.find((module) => module.graph_node_id === community.id);
          return (
            <button
              key={community.id}
              type="button"
              onClick={() => setSelectedNodeId(community.id)}
              className={cn(
                "rounded-[10px] border bg-surface px-3 py-2.5 text-left transition-colors",
                !bound && "border-dashed",
                selected
                  ? "border-primary shadow-[0_0_0_2px] shadow-primary/15"
                  : "border-surface-border hover:bg-accent/40",
              )}
            >
              <div className="flex items-center gap-1.5">
                <TypeChip muted={!bound}>{bound ? t(($) => $.features.page_badge) : "?"}</TypeChip>
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">
                  {bound?.name ?? community.label ?? community.name}
                </span>
              </div>
              <div className="mt-1.5 flex gap-3 text-[9.5px] text-muted-foreground">
                <span>
                  {t(($) => $.features.stat_objects)}{" "}
                  <b className="tabular-nums text-foreground">{summary?.obj_count ?? community.node_ids.length}</b>
                </span>
                <span>
                  {t(($) => $.features.stat_strategies)}{" "}
                  <b className="tabular-nums text-foreground">{summary?.strategy_count ?? 0}</b>
                </span>
              </div>
              <div className={cn("mt-1 text-[9px] text-muted-foreground", !bound && "text-destructive")}>
                {t(($) => $.features.community_ref, { id: communityLabel(community.id) })}
                {bound ? "" : ` · ${t(($) => $.features.unbound_badge)}`}
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground">
        {t(($) => $.features.graph_cluster_hint, { count: communities.length })}
      </p>
    </div>
  );
}
