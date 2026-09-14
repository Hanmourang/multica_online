"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Waypoints } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { moduleNeighborhoodOptions } from "@multica/core/graph/queries";
import type { GraphNode } from "@multica/core/types";
import { useT } from "../../../../i18n";
import { FeatureEdge, FeatureNode, FeaturePane } from "../feature-chrome";
import { useGraphData } from "../graph-data-provider";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../../archive/query-states";

const TYPE_ORDER = ["Process", "Route", "Community", "Component", "Hook", "Class", "Function"];

export function GraphNeighborhoodTab({ nodeId }: { nodeId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId } = useGraphData();
  const query = useQuery({
    ...moduleNeighborhoodOptions(wsId, projectId, nodeId),
    placeholderData: keepPreviousData,
  });

  if (query.isPending) return <QueryLoading rows={3} />;
  if (query.isError) return <QueryError onRetry={() => void query.refetch()} />;

  const { nodes, edges, module_name } = query.data;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sorted = [...nodes].sort((a, b) => typeRank(a.type) - typeRank(b.type));

  return (
    <FeaturePane
      tag="子TAB 5"
      title={t(($) => $.features.neighborhood_title)}
      meta={t(($) => $.features.neighborhood_ready)}
    >
      <div className="space-y-0.5">
        {nodes.length === 0 ? (
          <ArchiveEmpty
            icon={<Waypoints className="size-5" />}
            title={t(($) => $.features.neighborhood_title)}
            description={t(($) => $.features.neighborhood_empty)}
            className="min-h-0 border-dashed py-6"
          />
        ) : (
          sorted.map((node) => {
            const related = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
            const caption = nodeCaption(node, related, nodeId);
            const outgoing = related.filter((edge) => edge.source === node.id).slice(0, 2);
            return (
              <div key={node.id}>
                <FeatureNode type={node.type} caption={caption}>
                  <span className="font-mono">
                    {node.qualified_name ?? node.name}
                    {node.type === "Community" && module_name ? ` ↔ ${module_name}` : ""}
                  </span>
                </FeatureNode>
                {outgoing.map((edge, index) => (
                  <FeatureEdge key={`${edge.source}-${edge.target}-${index}`}>
                    {edge.type}
                    {edge.type === "STEP_IN_PROCESS"
                      ? ` × ${related.filter((item) => item.type === "STEP_IN_PROCESS").length}`
                      : ` → ${byId.get(edge.target)?.name ?? edge.target}`}
                  </FeatureEdge>
                ))}
              </div>
            );
          })
        )}
      </div>
    </FeaturePane>
  );
}

function typeRank(type: string): number {
  const index = TYPE_ORDER.indexOf(type);
  return index === -1 ? TYPE_ORDER.length : index;
}

function nodeCaption(
  node: GraphNode,
  related: { type: string; source: string; target: string }[],
  communityId: string,
): string {
  if (node.type === "Process") {
    const steps = related.filter((edge) => edge.type === "STEP_IN_PROCESS").length;
    return steps > 0 ? `${steps} 步` : "Process";
  }
  if (node.type === "Route") {
    return related.find((edge) => edge.type === "HANDLES_ROUTE")?.type ?? "HANDLES_ROUTE";
  }
  if (node.type === "Community" || node.id === communityId) {
    return "graph_node_id";
  }
  return related[0]?.type ?? "MEMBER_OF";
}
