"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { busMatrixTimelineOptions } from "@multica/core/graph/queries";
import type { OntologyChangeType, OntologyChangelog } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../archive/query-states";
import { ChangeBadge } from "./bus-matrix-change-badge";

/**
 * f11 迭代时间线：按 added / modified / removed 分组（本体 changelog 暂空则诚实空态）。
 */
const GROUPS: OntologyChangeType[] = ["added", "modified", "removed", "status_change"];

const CHANGE_TYPE_CLASS: Record<OntologyChangeType, string> = {
  added: "border-emerald-500/40 bg-emerald-500/10",
  modified: "border-blue-500/40 bg-blue-500/10",
  removed: "border-destructive/40 bg-destructive/10",
  status_change: "border-amber-500/40 bg-amber-500/10",
};

export function BusMatrixTimeline() {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId, snapshot } = useGraphData();

  const query = useQuery(busMatrixTimelineOptions(wsId, projectId, 50));

  const grouped = useMemo(() => {
    const map = new Map<OntologyChangeType, OntologyChangelog[]>();
    for (const type of GROUPS) map.set(type, []);
    for (const change of query.data?.changes ?? []) {
      const bucket = map.get(change.change_type) ?? [];
      bucket.push(change);
      map.set(change.change_type, bucket);
    }
    return map;
  }, [query.data?.changes]);

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
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-caption font-medium text-foreground">
          {t(($) => $.bus_matrix.timeline_title)}
        </h4>
        {snapshot?.scan_id ? (
          <span className="font-mono text-micro text-muted-foreground">
            {t(($) => $.bus_v2.scan_current, { scan: snapshot.scan_id.slice(0, 8) })}
          </span>
        ) : null}
      </div>
      {GROUPS.map((type) => {
        const items = grouped.get(type) ?? [];
        if (items.length === 0) return null;
        return (
          <section key={type} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <ChangeBadge type={type} />
              <span className="text-micro tabular-nums text-muted-foreground">{items.length}</span>
            </div>
            <ul className={cn("rounded-lg border", CHANGE_TYPE_CLASS[type])}>
              {items.map((change) => (
                <li
                  key={change.id}
                  className="flex flex-wrap items-center gap-2 border-b border-surface-border/60 px-3 py-2 text-caption last:border-b-0"
                >
                  <span className="shrink-0 tabular-nums text-micro text-muted-foreground">
                    {new Date(change.created_at).toLocaleDateString()}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono font-medium" title={change.object_name}>
                    {change.object_name}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
