"use client";

import { useMemo } from "react";
import { MousePointerClick } from "lucide-react";
import type { BusMatrixCell } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { ArchiveEmpty } from "../archive/query-states";

/**
 * f11 右侧栏 · 选中行详情（原型 f11 anno 4：跟随选中「模块 × 功能类型（页面）」）。
 *
 * Everything here derives from the selected cell's row — the per-domain
 * breakdown with table counts and R/W splits is a real client-side
 * aggregation over the bus-matrix cells.
 *
 * The prototype's S8 StrategyModel card is omitted: no endpoint exposes it
 * and migration-level facts are not fabricated at runtime. Its 本期迭代 row,
 * by contrast, IS rendered — but only from `added` / `modified` / `removed`
 * counts the snapshot actually carries (see CHANGES doc below).
 */
export function BusMatrixSidebar({
  cells,
  selectedCell,
}: {
  cells: BusMatrixCell[];
  selectedCell: BusMatrixCell | null;
}) {
  const { t } = useT("archive");

  // All three derivations run before the `!selectedCell` early return: hooks
  // must not be conditional, and the empty state is a return, not a branch.
  const rowCells = useMemo(
    () =>
      selectedCell
        ? cells.filter(
            (cell) =>
              cell.module_node_id === selectedCell.module_node_id &&
              cell.page_key === selectedCell.page_key,
          )
        : [],
    [cells, selectedCell],
  );

  const totals = useMemo(() => {
    let tables = 0;
    let read = 0;
    let write = 0;
    for (const cell of rowCells) {
      tables += cell.table_count;
      read += cell.read_count;
      write += cell.write_count;
    }
    return { tables, read, write };
  }, [rowCells]);

  /**
   * 本期变更 (原型「本期迭代」: "3 表 added / 2 modified").
   *
   * The bus_matrix contract does not require the CLI to report iteration
   * deltas, and an *absent* `added` field is not the same statement as
   * `added: 0` — the first means "not measured", the second "measured, none".
   * Summing with `?? 0` would collapse the two and print a confident "0 added"
   * over a snapshot that never counted anything, so each metric stays `null`
   * until a cell actually reports it, and the whole block is dropped when none
   * of the three does. No placeholder zeros.
   */
  const changes = useMemo(() => {
    let added: number | null = null;
    let modified: number | null = null;
    let removed: number | null = null;
    for (const cell of rowCells) {
      if (typeof cell.added === "number") added = (added ?? 0) + cell.added;
      if (typeof cell.modified === "number") {
        modified = (modified ?? 0) + cell.modified;
      }
      if (typeof cell.removed === "number") removed = (removed ?? 0) + cell.removed;
    }
    if (added === null && modified === null && removed === null) return null;
    return { added, modified, removed };
  }, [rowCells]);

  if (!selectedCell) {
    return (
      <ArchiveEmpty
        icon={<MousePointerClick className="size-5" />}
        title={t(($) => $.bus_matrix.selected_row)}
        description={t(($) => $.bus_matrix.drilldown_title)}
        className="min-h-40"
      />
    );
  }

  // Only the metrics the snapshot reported, joined — a missing metric is
  // absent from the sentence rather than shown as zero.
  const changeParts: string[] = [];
  if (changes) {
    if (changes.added !== null) {
      changeParts.push(
        t(($) => $.bus_matrix_detail.sidebar_changes_added, {
          count: changes.added,
        }),
      );
    }
    if (changes.modified !== null) {
      changeParts.push(
        t(($) => $.bus_matrix_detail.sidebar_changes_modified, {
          count: changes.modified,
        }),
      );
    }
    if (changes.removed !== null) {
      changeParts.push(
        t(($) => $.bus_matrix_detail.sidebar_changes_removed, {
          count: changes.removed,
        }),
      );
    }
  }

  return (
    <aside className="space-y-3 rounded-lg border border-surface-border bg-surface p-3">
      <div>
        <div className="text-caption font-medium text-muted-foreground">
          {t(($) => $.bus_matrix.selected_row)}
        </div>
        <div
          className="mt-0.5 truncate text-body font-semibold"
          title={selectedCell.page_name}
        >
          {selectedCell.page_name}
        </div>
        <div className="truncate font-mono text-micro text-muted-foreground">
          {selectedCell.page_key}
        </div>
      </div>

      <dl className="space-y-1.5 text-caption">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">
            {t(($) => $.bus_matrix.module_label)}
          </dt>
          <dd className="truncate font-medium" title={selectedCell.module_name}>
            {selectedCell.module_name}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">
            {t(($) => $.bus_matrix.tables_label)}
          </dt>
          <dd className="tabular-nums font-medium">
            {t(($) => $.bus_matrix.table_count, { count: totals.tables })}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">
            {t(($) => $.bus_matrix_detail.drilldown_col_rw)}
          </dt>
          <dd className="tabular-nums font-medium">
            {t(($) => $.bus_matrix.read_write, {
              read: totals.read,
              write: totals.write,
            })}
          </dd>
        </div>
        {/* 本期变更 — rendered only when the snapshot carries the deltas. */}
        {changeParts.length > 0 && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">
              {t(($) => $.bus_matrix_detail.sidebar_changes_title)}
            </dt>
            <dd className="text-right tabular-nums font-medium">
              {changeParts.join(" · ")}
            </dd>
          </div>
        )}
      </dl>

      <div>
        <div className="mb-1.5 text-caption font-medium text-foreground">
          {t(($) => $.bus_matrix.domain_label)}
        </div>
        <ul className="space-y-1">
          {rowCells.map((cell) => (
            <li
              key={cell.domain}
              className="flex items-center gap-2 rounded-md border border-surface-border px-2 py-1 text-caption"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-micro">
                {cell.domain}
              </span>
              <span className="shrink-0 tabular-nums font-semibold">
                {cell.table_count}
              </span>
              <span
                className={cn(
                  "shrink-0 text-micro tabular-nums",
                  cell.is_cross_domain_write
                    ? "text-destructive"
                    : cell.write_count > 0
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-emerald-700 dark:text-emerald-400",
                )}
              >
                {t(($) => $.bus_matrix.read_write, {
                  read: cell.read_count,
                  write: cell.write_count,
                })}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
