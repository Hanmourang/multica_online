"use client";

import { useQuery } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { moduleObjectsOptions } from "@multica/core/graph/queries";
import { Badge } from "@multica/ui/components/ui/badge";
import { useT } from "../../../../i18n";
import { useGraphData } from "../graph-data-provider";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../../archive/query-states";

/**
 * f10 子TAB 2 · 模块对象（代码中的对象）。
 *
 * GET .../graph/modules/{nodeId}/objects: when the ontology layer is not
 * extracted yet the endpoint answers objects=[] while obj_count /
 * tables_touched fall back to the graph-layer summary — that degraded pair
 * is exactly what renders here (spec 降级先行), never a fabricated table.
 */
export function ModuleObjectsTab({ nodeId }: { nodeId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId } = useGraphData();

  const query = useQuery(moduleObjectsOptions(wsId, projectId, nodeId));

  if (query.isPending) {
    return <QueryLoading rows={4} />;
  }
  if (query.isError) {
    return <QueryError onRetry={() => void query.refetch()} />;
  }

  const { objects, obj_count, tables_touched } = query.data;

  if (objects.length === 0) {
    return (
      <div className="space-y-3">
        <ArchiveEmpty
          icon={<Boxes className="size-5" />}
          title={t(($) => $.features.objects_title)}
          description={t(($) => $.features.objects_empty)}
        />
        {/* Degraded-but-real aggregate: counts fall back to the graph
            summary even when the ontology object list is empty. */}
        <div className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-caption text-muted-foreground">
          {t(($) => $.features.objects_stat, {
            count: obj_count,
            tables: tables_touched.length,
          })}
        </div>
        {tables_touched.length > 0 && (
          <div>
            <div className="mb-1.5 text-caption font-medium text-foreground">
              {t(($) => $.features.tables_touched)}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {tables_touched.map((table) => (
                <Badge
                  key={table}
                  variant="outline"
                  className="font-mono text-micro"
                >
                  {table}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-surface-border">
      <table className="w-full text-caption">
        <thead>
          <tr className="border-b border-surface-border bg-card/40 text-left text-micro text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">
              {t(($) => $.features.objects_title)}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t(($) => $.features.col_type)}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t(($) => $.features.col_impl_status)}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t(($) => $.bus_matrix.domain_label)}
            </th>
          </tr>
        </thead>
        <tbody>
          {objects.map((obj) => (
            <tr
              key={obj.id}
              className="border-b border-surface-border last:border-b-0"
            >
              <td className="max-w-[280px] truncate px-3 py-2 font-mono">
                {obj.qualified_name}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {obj.entity_type}
              </td>
              <td className="px-3 py-2">
                {obj.impl_status ? (
                  <Badge variant="secondary">{obj.impl_status}</Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {obj.domain ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
