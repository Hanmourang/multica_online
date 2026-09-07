"use client";

import { Fragment, useMemo } from "react";
import type { BusMatrixCell } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";

/**
 * f11 总线矩阵 · 模块×页面 × 数据域 表格。
 *
 * Rows are grouped by module (rowspan header, sticky first column), columns
 * are the domains present in the snapshot's pre-aggregated bus_matrix. Cell
 * = table_count with an R/W split; styles follow the prototype legend:
 * read (emerald) / write (amber) / cross-domain write (destructive ring) /
 * new table (blue ring) / no access (dot). No third-party grid — a plain
 * table with overflow-x-auto is enough at the current scale.
 */

interface PageRow {
  pageName: string;
  pageKey: string;
  cellsByDomain: Map<string, BusMatrixCell>;
  totalTables: number;
}

interface ModuleGroup {
  moduleKey: string;
  moduleName: string;
  rows: PageRow[];
}

export interface BusMatrixGridProps {
  cells: BusMatrixCell[];
  /** null = all domains; otherwise the matrix renders a single column. */
  domainFilter: string | null;
  /** Keep only cross-domain-write cells (rows collapse to their x cells). */
  crossOnly: boolean;
  selectedCell: BusMatrixCell | null;
  onSelectCell: (cell: BusMatrixCell) => void;
}

function isSameCell(a: BusMatrixCell | null, b: BusMatrixCell): boolean {
  return (
    a !== null &&
    a.module_node_id === b.module_node_id &&
    a.page_key === b.page_key &&
    a.domain === b.domain
  );
}

export function BusMatrixGrid({
  cells,
  domainFilter,
  crossOnly,
  selectedCell,
  onSelectCell,
}: BusMatrixGridProps) {
  const { t } = useT("archive");

  const domains = useMemo(() => {
    const seen: string[] = [];
    for (const cell of cells) {
      if (!seen.includes(cell.domain)) seen.push(cell.domain);
    }
    return domainFilter ? seen.filter((d) => d === domainFilter) : seen;
  }, [cells, domainFilter]);

  const groups = useMemo(() => {
    const groupMap = new Map<string, ModuleGroup>();
    for (const cell of cells) {
      if (domainFilter && cell.domain !== domainFilter) continue;
      if (crossOnly && !cell.is_cross_domain_write) continue;
      let group = groupMap.get(cell.module_node_id);
      if (!group) {
        group = { moduleKey: cell.module_node_id, moduleName: cell.module_name, rows: [] };
        groupMap.set(cell.module_node_id, group);
      }
      let row = group.rows.find((r) => r.pageKey === cell.page_key);
      if (!row) {
        row = { pageName: cell.page_name, pageKey: cell.page_key, cellsByDomain: new Map(), totalTables: 0 };
        group.rows.push(row);
      }
      row.cellsByDomain.set(cell.domain, cell);
      row.totalTables += cell.table_count;
    }
    return [...groupMap.values()];
  }, [cells, domainFilter, crossOnly]);

  const columnSummary = useMemo(() => {
    return domains.map((domain) => {
      let tables = 0;
      let rows = 0;
      for (const group of groups) {
        for (const row of group.rows) {
          const cell = row.cellsByDomain.get(domain);
          if (cell) {
            tables += cell.table_count;
            rows += 1;
          }
        }
      }
      return { domain, tables, rows };
    });
  }, [domains, groups]);

  if (cells.length === 0) {
    return null;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-surface-border">
      <table className="w-full min-w-[720px] border-collapse text-caption">
        <thead>
          <tr className="border-b border-surface-border bg-card/40 text-left text-micro text-muted-foreground">
            <th scope="col" className="sticky left-0 z-10 w-28 bg-card/95 px-3 py-2 font-medium">
              {t(($) => $.bus_matrix.module_label)}
            </th>
            <th scope="col" className="w-40 px-3 py-2 font-medium">
              {t(($) => $.bus_matrix.page_label)}
            </th>
            {domains.map((domain) => (
              <th scope="col" key={domain} className="min-w-20 px-2 py-2 text-center font-medium">
                {domain}
              </th>
            ))}
            <th scope="col" className="w-16 px-2 py-2 text-center font-medium">
              {t(($) => $.bus_matrix.row_total)}
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.moduleKey}>
              {group.rows.map((row, index) => (
                <tr
                  key={`${group.moduleKey}:${row.pageKey}`}
                  className="border-b border-surface-border last:border-b-0"
                >
                  {index === 0 && (
                    <th
                      scope="rowgroup"
                      rowSpan={group.rows.length}
                      className="sticky left-0 z-10 border-r border-surface-border bg-background px-3 py-2 align-middle text-left font-medium"
                    >
                      {group.moduleName}
                    </th>
                  )}
                  <td className="border-r border-surface-border px-3 py-2">
                    <div className="truncate" title={row.pageName}>
                      {row.pageName}
                    </div>
                    <div className="truncate font-mono text-micro text-muted-foreground">
                      {row.pageKey}
                    </div>
                  </td>
                  {domains.map((domain) => {
                    const cell = row.cellsByDomain.get(domain);
                    if (!cell) {
                      return (
                        <td key={domain} className="px-2 py-2 text-center">
                          <span aria-hidden className="text-muted-foreground/40">
                            ·
                          </span>
                        </td>
                      );
                    }
                    const cross = Boolean(cell.is_cross_domain_write);
                    const selected = isSameCell(selectedCell, cell);
                    return (
                      <td key={domain} className="p-0 text-center">
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={() => onSelectCell(cell)}
                          aria-label={`${cell.module_name} ${cell.page_name} ${cell.domain} ${cell.table_count}`}
                          className={cn(
                            "flex h-12 w-full flex-col items-center justify-center gap-0.5 font-semibold tabular-nums transition-colors",
                            cross
                              ? "bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/40"
                              : cell.write_count > 0
                                ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                            cell.is_new_table && "ring-1 ring-inset ring-blue-500/60",
                            selected && "ring-2 ring-primary",
                          )}
                        >
                          <span>{cell.table_count}</span>
                          <span className="text-micro font-medium opacity-80">
                            {t(($) => $.bus_matrix.read_write, {
                              read: cell.read_count,
                              write: cell.write_count,
                            })}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                  <td className="px-2 py-2 text-center font-semibold tabular-nums">
                    {row.totalTables}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-surface-border bg-card/40 text-micro text-muted-foreground">
            <th scope="row" className="sticky left-0 z-10 bg-card/95 px-3 py-2 text-left font-medium">
              {t(($) => $.bus_matrix.row_total)}
            </th>
            <td className="px-3 py-2">{t(($) => $.bus_matrix.domain_label)}</td>
            {columnSummary.map((summary) => (
              <td key={summary.domain} className="px-2 py-2 text-center leading-tight">
                <div className="font-semibold tabular-nums text-foreground">
                  {summary.tables}
                </div>
                <div className="tabular-nums">{summary.rows}</div>
              </td>
            ))}
            <td className="px-2 py-2 text-center font-semibold tabular-nums">
              {columnSummary.reduce((sum, entry) => sum + entry.tables, 0)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
