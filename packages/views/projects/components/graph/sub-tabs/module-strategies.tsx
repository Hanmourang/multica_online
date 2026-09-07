"use client";

import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { moduleStrategiesOptions } from "@multica/core/graph/queries";
import { Badge } from "@multica/ui/components/ui/badge";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../../i18n";
import { useGraphData } from "../graph-data-provider";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../../archive/query-states";

/**
 * f10 子TAB 3 · 模块策略（S1–S10，本体层投影）。
 *
 * GET .../graph/modules/{nodeId}/strategies answers ontology_ready="empty"
 * with an empty list while ontology extraction has not landed (降级先行) —
 * the banner states exactly that; the graph layer stays the source of
 * truth until the strategies/ directory fills up.
 */
export function ModuleStrategiesTab({ nodeId }: { nodeId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId } = useGraphData();

  const query = useQuery(moduleStrategiesOptions(wsId, projectId, nodeId));

  if (query.isPending) {
    return <QueryLoading rows={3} />;
  }
  if (query.isError) {
    return <QueryError onRetry={() => void query.refetch()} />;
  }

  const { strategies, ontology_ready } = query.data;

  const degraded = ontology_ready !== "ready";

  return (
    <div className="space-y-3">
      {degraded && (
        <div
          role="status"
          className={cn(
            "flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5",
            "px-3 py-2 text-caption leading-relaxed text-amber-700 dark:text-amber-400",
          )}
        >
          <Lightbulb className="mt-0.5 size-4 shrink-0" />
          <span>{t(($) => $.features.strategies_empty)}</span>
        </div>
      )}

      <div className="flex items-baseline gap-2">
        <h4 className="text-caption font-medium text-foreground">
          {t(($) => $.features.strategies_title)}
        </h4>
        <span className="text-caption tabular-nums text-muted-foreground">
          {t(($) => $.features.strategies_count, { count: strategies.length })}
        </span>
      </div>

      {strategies.length === 0 ? (
        <ArchiveEmpty
          icon={<Lightbulb className="size-5" />}
          title={t(($) => $.features.strategies_title)}
          description={t(($) => $.features.strategies_empty)}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full text-caption">
            <thead>
              <tr className="border-b border-surface-border bg-card/40 text-left text-micro text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  {t(($) => $.features.col_strategy)}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t(($) => $.features.col_value)}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t(($) => $.features.col_source)}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t(($) => $.features.col_status)}
                </th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((strategy) => (
                <tr
                  key={`${strategy.key}:${strategy.source}`}
                  className="border-b border-surface-border last:border-b-0"
                >
                  <td className="px-3 py-2 font-mono">{strategy.key}</td>
                  <td className="max-w-[260px] truncate px-3 py-2">
                    {strategy.value}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {strategy.source}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary">{strategy.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
