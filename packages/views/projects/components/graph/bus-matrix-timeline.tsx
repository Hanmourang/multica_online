"use client";

import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { busMatrixTimelineOptions } from "@multica/core/graph/queries";
import type { OntologyChangeType } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../archive/query-states";

/**
 * f11 迭代时间线（OntologyChangelog，按 TableObject 聚合）。
 *
 * GET .../graph/bus-matrix/timeline — until ontology extraction lands the
 * changes array is legitimately empty and the panel says so; no migration
 * history is fabricated.
 */
const CHANGE_TYPE_CLASS: Record<OntologyChangeType, string> = {
  added: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  modified: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  removed: "border-destructive/40 bg-destructive/10 text-destructive",
  status_change: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

export function BusMatrixTimeline() {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId } = useGraphData();

  const query = useQuery(busMatrixTimelineOptions(wsId, projectId, 20));

  if (query.isPending) {
    return <QueryLoading rows={4} />;
  }
  if (query.isError) {
    return <QueryError compact onRetry={() => void query.refetch()} />;
  }

  const { changes } = query.data;

  if (changes.length === 0) {
    return (
      <ArchiveEmpty
        icon={<History className="size-5" />}
        title={t(($) => $.bus_matrix.timeline_title)}
        description={t(($) => $.bus_matrix.timeline_empty)}
      />
    );
  }

  return (
    <div className="space-y-2">
      <h4 className="text-caption font-medium text-foreground">
        {t(($) => $.bus_matrix.timeline_title)}
      </h4>
      <ul className="rounded-lg border border-surface-border">
        {changes.map((change) => (
          <li
            key={change.id}
            className="flex flex-wrap items-center gap-2 border-b border-surface-border px-3 py-2 text-caption last:border-b-0"
          >
            <span className="shrink-0 tabular-nums text-micro text-muted-foreground">
              {new Date(change.created_at).toLocaleDateString()}
            </span>
            <span
              className={cn(
                "shrink-0 rounded border px-1.5 py-0.5 font-mono text-micro font-semibold",
                CHANGE_TYPE_CLASS[change.change_type] ?? CHANGE_TYPE_CLASS.modified,
              )}
            >
              {change.change_type}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono font-medium" title={change.object_name}>
              {change.object_name}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
