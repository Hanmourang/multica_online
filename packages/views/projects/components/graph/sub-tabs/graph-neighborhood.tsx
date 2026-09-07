"use client";

import { useQuery } from "@tanstack/react-query";
import { Waypoints } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { moduleNeighborhoodOptions } from "@multica/core/graph/queries";
import type { GraphStats } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { useT } from "../../../../i18n";
import { useGraphData } from "../graph-data-provider";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../../archive/query-states";

/**
 * f10 子TAB 4 · 图谱邻域（零等待本体层）。
 *
 * GET .../graph/modules/{nodeId}/neighborhood: the server-side BFS extraction
 * is a TODO — nodes/edges come back empty today, and that empty state is
 * stated honestly instead of being faked. What IS real: the snapshot
 * identity and the global graph stats. When the BFS lands, the node list
 * below lights up without any UI change (降级先行).
 */
function statNumber(
  stats: GraphStats | Record<string, unknown>,
  key: keyof GraphStats,
): string {
  const value = (stats as Record<string, unknown>)[key];
  return typeof value === "number" ? String(value) : "—";
}

export function GraphNeighborhoodTab({ nodeId }: { nodeId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId } = useGraphData();

  const query = useQuery(moduleNeighborhoodOptions(wsId, projectId, nodeId));

  if (query.isPending) {
    return <QueryLoading rows={3} />;
  }
  if (query.isError) {
    return <QueryError onRetry={() => void query.refetch()} />;
  }

  const { nodes, edges, stats, module_name, scan_id, git_sha } = query.data;

  return (
    <div className="space-y-3">
      {nodes.length === 0 && edges.length === 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-caption leading-relaxed text-amber-700 dark:text-amber-400">
          {t(($) => $.features.neighborhood_empty)}
        </div>
      )}

      {/* Snapshot identity + global stats — real data from the response. */}
      <div className="rounded-lg border border-surface-border bg-surface px-3 py-2">
        <div className="mb-2 text-caption font-medium text-foreground">
          {t(($) => $.features.neighborhood_stats)}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-caption sm:grid-cols-4">
          <div className="text-micro text-muted-foreground">
            {t(($) => $.features.node_count, {
              count: Number(statNumber(stats, "node_count")),
            })}
          </div>
          <div className="text-micro text-muted-foreground">
            {t(($) => $.features.edge_count, {
              count: Number(statNumber(stats, "edge_count")),
            })}
          </div>
          <div className="text-micro text-muted-foreground">
            {t(($) => $.features.community_count, {
              count: Number(statNumber(stats, "community_count")),
            })}
          </div>
          <div className="truncate font-mono text-micro text-muted-foreground">
            {scan_id.slice(0, 8)} {git_sha.slice(0, 8)}
          </div>
        </div>
      </div>

      {nodes.length === 0 ? (
        <ArchiveEmpty
          icon={<Waypoints className="size-5" />}
          title={t(($) => $.features.neighborhood_title)}
          description={module_name}
        />
      ) : (
        <ul className="rounded-lg border border-surface-border">
          {nodes.map((node) => (
            <li
              key={node.id}
              className="flex items-center gap-3 border-b border-surface-border px-3 py-2 text-caption last:border-b-0"
            >
              <Badge variant="outline" className="shrink-0 font-mono">
                {node.type}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono">
                {node.qualified_name ?? node.name}
              </span>
              <span className="shrink-0 text-micro text-muted-foreground">
                {edges.filter((edge) => edge.source === node.id).length}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
