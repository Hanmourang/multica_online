"use client";

import { useQuery } from "@tanstack/react-query";
import { Table2, ZoomIn } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { busMatrixDrilldownOptions } from "@multica/core/graph/queries";
import { Badge } from "@multica/ui/components/ui/badge";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import { QueryError, QueryLoading } from "../archive/query-states";

/**
 * f11 格子下钻面板（原型 f11 底部「🔍 格子下钻」）。
 *
 * GET .../graph/bus-matrix/drilldown with {module_node_id, page_key, domain}
 * returns the matching cells plus, when the snapshot carries them, the tables
 * behind those cells.
 *
 * The two halves have different guarantees. The cell half is always real —
 * it is the bus_matrix pre-aggregation itself (table counts, R/W splits,
 * new/cross flags). The table half depends on optional CLI payload: the
 * migration only declares `bus_matrix JSONB`, and the aggregated cells the
 * sync delivers today carry counts, not names. So the server answers with
 * `detail_available` / `columns_available` and this panel degrades honestly
 * when they are false.
 *
 * TODO(project-archive): table-level rows light up automatically once the CLI
 * pre-aggregation emits a `tables` list (names, optional `columns`) inside
 * each bus-matrix cell. No UI change is needed then — only the payload.
 * Nothing here ever invents a table name to fill the gap.
 */
export function BusMatrixDrilldown() {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId, selectedCell } = useGraphData();

  const filters = selectedCell
    ? {
        module_node_id: selectedCell.module_node_id,
        page_key: selectedCell.page_key,
        domain: selectedCell.domain,
      }
    : {};

  const query = useQuery(busMatrixDrilldownOptions(wsId, projectId, filters));

  if (!selectedCell) {
    return (
      <div className="rounded-lg border border-dashed border-surface-border px-3 py-6 text-center text-caption text-muted-foreground">
        {t(($) => $.bus_matrix.drilldown_title)}
      </div>
    );
  }

  if (query.isPending) {
    return <QueryLoading rows={3} />;
  }
  if (query.isError) {
    return <QueryError compact onRetry={() => void query.refetch()} />;
  }

  const {
    cells,
    total,
    tables,
    detail_available: detailAvailable,
    columns_available: columnsAvailable,
    tables_truncated: tablesTruncated,
  } = query.data;

  const hasTableDetail = detailAvailable && tables.length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <ZoomIn className="size-3.5 self-center text-muted-foreground" />
        <h4 className="text-caption font-medium text-foreground">
          {t(($) => $.bus_matrix.drilldown_title)}
        </h4>
        <span className="text-caption tabular-nums text-muted-foreground">
          {total}
        </span>
      </div>
      {cells.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-border px-3 py-4 text-center text-caption text-muted-foreground">
          {t(($) => $.common.empty)}
        </div>
      ) : (
        <ul className="rounded-lg border border-surface-border">
          {cells.map((cell) => (
            <li
              key={`${cell.module_node_id}:${cell.page_key}:${cell.domain}`}
              className="flex flex-wrap items-center gap-2 border-b border-surface-border px-3 py-2 text-caption last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate" title={cell.page_name}>
                {cell.page_name}
              </span>
              <span className="shrink-0 font-mono text-micro text-muted-foreground">
                {cell.domain}
              </span>
              <span className="shrink-0 tabular-nums font-semibold">
                {t(($) => $.bus_matrix.table_count, { count: cell.table_count })}
              </span>
              <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
                {t(($) => $.bus_matrix.read_write, {
                  read: cell.read_count,
                  write: cell.write_count,
                })}
              </span>
              {cell.is_new_table && (
                <Badge variant="outline" className="shrink-0 text-micro">
                  {t(($) => $.bus_matrix.legend_new)}
                </Badge>
              )}
              {cell.is_cross_domain_write && (
                <Badge variant="destructive" className="shrink-0 text-micro">
                  {t(($) => $.bus_matrix.legend_cross)}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 表级明细：原型的四列（表 / 读写 / 触达列 / 边·来源）。只有当快照真的
          带了表名才渲染，否则说明缺口 —— 宁缺勿假。 */}
      {hasTableDetail ? (
        <div className="space-y-1.5">
          <h5 className="flex items-center gap-1.5 text-micro font-medium text-muted-foreground">
            <Table2 className="size-3.5" />
            {t(($) => $.bus_matrix_detail.drilldown_tables_title)}
          </h5>
          <div className="overflow-x-auto rounded-lg border border-surface-border">
            <table className="w-full border-collapse text-left text-caption">
              <thead>
                <tr className="border-b border-surface-border bg-accent/40 text-micro text-muted-foreground">
                  <th className="px-2.5 py-1.5 font-medium">
                    {t(($) => $.bus_matrix_detail.drilldown_col_table)}
                  </th>
                  <th className="px-2.5 py-1.5 font-medium">
                    {t(($) => $.bus_matrix_detail.drilldown_col_rw)}
                  </th>
                  <th className="px-2.5 py-1.5 font-medium">
                    {t(($) => $.bus_matrix_detail.drilldown_col_columns)}
                  </th>
                  <th className="px-2.5 py-1.5 font-medium">
                    {t(($) => $.bus_matrix_detail.drilldown_col_source)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {tables.map((table) => (
                  <tr
                    key={table.name}
                    className="border-b border-surface-border/60 last:border-b-0"
                  >
                    <td className="px-2.5 py-1.5 align-top">
                      <span className="flex flex-wrap items-center gap-1">
                        <span className="font-mono text-micro">{table.name}</span>
                        {table.is_new_table && (
                          <Badge variant="outline" className="shrink-0 text-micro">
                            {t(($) => $.bus_matrix.legend_new)}
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 align-top text-micro tabular-nums text-muted-foreground">
                      {table.read_count === undefined &&
                      table.write_count === undefined
                        ? t(($) => $.bus_matrix_detail.drilldown_value_pending)
                        : t(($) => $.bus_matrix.read_write, {
                            read: table.read_count ?? 0,
                            write: table.write_count ?? 0,
                          })}
                    </td>
                    <td className="max-w-56 px-2.5 py-1.5 align-top text-micro text-muted-foreground">
                      {table.columns.length === 0 ? (
                        t(($) => $.bus_matrix_detail.drilldown_value_pending)
                      ) : (
                        <span className="font-mono">
                          {table.columns.map((column) => column.name).join(", ")}
                        </span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 align-top text-micro text-muted-foreground">
                      {table.source_cells && table.source_cells.length > 0 ? (
                        <span className="font-mono">
                          {table.source_cells.join(", ")}
                        </span>
                      ) : (
                        t(($) => $.bus_matrix_detail.drilldown_value_pending)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!columnsAvailable && (
            <p className="text-micro leading-relaxed text-muted-foreground">
              {t(($) => $.bus_matrix_detail.drilldown_columns_pending)}
            </p>
          )}
          {tablesTruncated && (
            <p className="text-micro leading-relaxed text-muted-foreground">
              {t(($) => $.bus_matrix_detail.drilldown_tables_truncated, {
                count: tables.length,
              })}
            </p>
          )}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-surface-border px-3 py-2 text-micro leading-relaxed text-muted-foreground">
          {t(($) => $.bus_matrix_detail.drilldown_detail_unavailable)}
        </p>
      )}
    </div>
  );
}
