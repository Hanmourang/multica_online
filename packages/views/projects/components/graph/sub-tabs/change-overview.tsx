"use client";

import { useQuery } from "@tanstack/react-query";
import { Ticket } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { moduleChangesOptions } from "@multica/core/graph/queries";
import { Badge } from "@multica/ui/components/ui/badge";
import { useT } from "../../../../i18n";
import { useGraphData } from "../graph-data-provider";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
  formatTimestamp,
} from "../../archive/query-states";

/**
 * f10 子TAB 1 · 模块变更概览（需求侧）。
 *
 * GET .../graph/modules/{nodeId}/changes returns the module's issue list.
 * The prototype's task-progress bar next to it is not part of the endpoint —
 * only real issue rows render, no fabricated task rollup.
 */
export function ChangeOverviewTab({ nodeId }: { nodeId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId } = useGraphData();

  const query = useQuery(moduleChangesOptions(wsId, projectId, nodeId));

  if (query.isPending) {
    return <QueryLoading rows={4} />;
  }
  if (query.isError) {
    return <QueryError onRetry={() => void query.refetch()} />;
  }

  const { issues, total } = query.data;

  if (issues.length === 0) {
    return (
      <ArchiveEmpty
        icon={<Ticket className="size-5" />}
        title={t(($) => $.features.changes_title)}
        description={t(($) => $.features.changes_empty)}
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h4 className="text-caption font-medium text-foreground">
          {t(($) => $.features.changes_title)}
        </h4>
        <span className="text-caption tabular-nums text-muted-foreground">
          {t(($) => $.features.issues_count, { count: total })}
        </span>
      </div>
      <ul className="rounded-lg border border-surface-border">
        {issues.map((issue) => (
          <li
            key={issue.id}
            className="flex items-center gap-3 border-b border-surface-border px-3 py-2 text-body last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate" title={issue.title}>
              {issue.title}
            </span>
            <Badge variant="secondary" className="shrink-0">
              {issue.status}
            </Badge>
            <span className="shrink-0 text-caption text-muted-foreground">
              {formatTimestamp(issue.updated_at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
