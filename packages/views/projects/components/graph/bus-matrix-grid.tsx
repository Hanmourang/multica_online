"use client";

import { Fragment, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import type { BusMatrixCell } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { BusMatrixMountDialog } from "./bus-matrix-mount-dialog";
import { useT } from "../../../i18n";
import {
  addMatrixDomain,
  addMatrixPage,
  cellRowKey,
  removeMatrixDomain,
  removeMatrixRow,
  type BusMatrixLayout,
  type MatrixRowSeed,
} from "./bus-matrix-layout";

/**
 * f11 总线矩阵 · 模块 → 子功能（页面）→ 业务过程 × 数据域 表格。
 *
 * Rows are grouped three levels deep (数据模型 v2): module rowspan header,
 * page rowspan cell with a per-page subtotal, then one row per business
 * process (主键组合). v1 payloads carry no process keys and degrade to a
 * single implicit process per page. Columns are the domains present in the
 * snapshot's pre-aggregated bus_matrix. Cell = table_count with an R/W split;
 * styles follow the prototype legend: read (emerald) / write (amber) /
 * cross-domain write (destructive ring) / new table (blue ring) / no access
 * (dot). Display-only edits stay in localStorage — graph facts are not
 * rewritten.
 */

interface ProcessRow {
  /** processKey ?? pageKey — the layout/mount locator's second component. */
  rowKey: string;
  processKey?: string;
  processName?: string;
  pageKey: string;
  pageName: string;
  cellsByDomain: Map<string, BusMatrixCell>;
  totalTables: number;
}

interface PageGroup {
  pageKey: string;
  pageName: string;
  rows: ProcessRow[];
}

interface ModuleGroup {
  moduleKey: string;
  moduleName: string;
  pages: PageGroup[];
}

export interface BusMatrixGridProps {
  cells: BusMatrixCell[];
  rowSeeds: MatrixRowSeed[];
  /** Layout-applied original domain keys (aliases stay out of the locator). */
  domains: string[];
  /** null = all domains; otherwise the matrix renders a single column. */
  domainFilter: string | null;
  /** Keep only cross-domain-write cells (rows collapse to their x cells). */
  crossOnly: boolean;
  selectedCell: BusMatrixCell | null;
  onSelectCell: (cell: BusMatrixCell | null) => void;
  layout: BusMatrixLayout;
  onChangeLayout: (next: BusMatrixLayout) => void;
}

function isSameCell(a: BusMatrixCell | null, b: BusMatrixCell): boolean {
  return (
    a !== null &&
    a.module_node_id === b.module_node_id &&
    cellRowKey(a) === cellRowKey(b) &&
    a.domain === b.domain
  );
}

function CellChangeMarks({ cell }: { cell: BusMatrixCell }) {
  const marks = [
    cell.added ? "▲" : null,
    cell.modified ? "◆" : null,
    cell.removed ? "✕" : null,
  ].filter(Boolean);
  if (marks.length === 0) return null;
  return (
    <span className="absolute left-1 top-0.5 text-[9px] leading-none text-muted-foreground">
      {marks.join("")}
    </span>
  );
}

function draftCell(
  group: ModuleGroup,
  page: PageGroup,
  row: ProcessRow,
  domain: string,
): BusMatrixCell {
  return {
    module_name: group.moduleName,
    module_node_id: group.moduleKey,
    page_name: page.pageName,
    page_key: page.pageKey,
    process_key: row.processKey,
    process_name: row.processName,
    domain,
    table_count: 0,
    read_count: 0,
    write_count: 0,
  };
}

export function BusMatrixGrid({
  cells,
  rowSeeds,
  domains,
  domainFilter,
  crossOnly,
  selectedCell,
  onSelectCell,
  layout,
  onChangeLayout,
}: BusMatrixGridProps) {
  const { t } = useT("archive");
  const [editing, setEditing] = useState<BusMatrixCell | null>(null);

  const visibleDomains = useMemo(
    () => (domainFilter ? domains.filter((domain) => domain === domainFilter) : domains),
    [domains, domainFilter],
  );

  const visibleSeeds = useMemo(() => {
    if (!crossOnly) return rowSeeds;
    const crossPages = new Set(
      cells.filter((cell) => cell.is_cross_domain_write).map((cell) => cell.page_key),
    );
    return rowSeeds.filter((seed) => crossPages.has(seed.pageKey));
  }, [cells, crossOnly, rowSeeds]);

  const groups = useMemo(() => {
    const moduleMap = new Map<string, ModuleGroup>();
    const ensureRow = (seed: MatrixRowSeed): ProcessRow => {
      let group = moduleMap.get(seed.moduleKey);
      if (!group) {
        group = { moduleKey: seed.moduleKey, moduleName: seed.moduleName, pages: [] };
        moduleMap.set(seed.moduleKey, group);
      }
      let page = group.pages.find((item) => item.pageKey === seed.pageKey);
      if (!page) {
        page = { pageKey: seed.pageKey, pageName: seed.pageName, rows: [] };
        group.pages.push(page);
      }
      const rowKey = seed.processKey ?? seed.pageKey;
      let row = page.rows.find((item) => item.rowKey === rowKey);
      if (!row) {
        row = {
          rowKey,
          processKey: seed.processKey,
          processName: seed.processName,
          pageKey: seed.pageKey,
          pageName: seed.pageName,
          cellsByDomain: new Map(),
          totalTables: 0,
        };
        page.rows.push(row);
      }
      return row;
    };
    for (const seed of visibleSeeds) ensureRow(seed);
    for (const cell of cells) {
      if (domainFilter && cell.domain !== domainFilter) continue;
      if (crossOnly && !cell.is_cross_domain_write) continue;
      const row = ensureRow({
        moduleKey: cell.module_node_id,
        moduleName: cell.module_name,
        pageKey: cell.page_key,
        pageName: cell.page_name,
        processKey: cell.process_key,
        processName: cell.process_name,
      });
      row.cellsByDomain.set(cell.domain, cell);
      row.totalTables += cell.table_count;
    }
    const order = new Map(
      visibleSeeds.map((seed, index) => [seed.processKey ?? seed.pageKey, index]),
    );
    return [...moduleMap.values()].map((group) => ({
      ...group,
      pages: group.pages.map((page) => ({
        ...page,
        rows: [...page.rows].sort(
          (a, b) => (order.get(a.rowKey) ?? 999) - (order.get(b.rowKey) ?? 999),
        ),
      })),
    }));
  }, [cells, crossOnly, domainFilter, visibleSeeds]);

  const columnSummary = useMemo(() => {
    return visibleDomains.map((domain) => {
      let tables = 0;
      let rows = 0;
      for (const group of groups) {
        for (const page of group.pages) {
          for (const row of page.rows) {
            const cell = row.cellsByDomain.get(domain);
            if (cell) {
              tables += cell.table_count;
              rows += 1;
            }
          }
        }
      }
      return { domain, tables, rows };
    });
  }, [groups, visibleDomains]);

  const openCell = (cell: BusMatrixCell) => {
    if (isSameCell(selectedCell, cell) && editing === null) {
      onSelectCell(null);
      return;
    }
    onSelectCell(cell);
    setEditing(cell);
  };

  const renameDomain = (domain: string) => {
    const next = window.prompt(t(($) => $.bus_manage.rename_prompt), layout.aliases[domain] ?? domain);
    if (!next?.trim()) return;
    onChangeLayout({
      ...layout,
      aliases: { ...layout.aliases, [domain]: next.trim() },
    });
  };

  const renameModule = (moduleKey: string, current: string) => {
    const next = window.prompt(t(($) => $.bus_manage.module_rename_prompt), current);
    if (!next?.trim()) return;
    onChangeLayout({
      ...layout,
      moduleAliases: { ...layout.moduleAliases, [moduleKey]: next.trim() },
    });
  };

  const renamePage = (pageKey: string, current: string) => {
    const next = window.prompt(t(($) => $.bus_manage.row_rename_prompt), current);
    if (!next?.trim()) return;
    onChangeLayout({
      ...layout,
      rowAliases: { ...layout.rowAliases, [pageKey]: next.trim() },
    });
  };

  const renameProcess = (rowKey: string, current: string) => {
    const next = window.prompt(t(($) => $.bus_manage.process_rename_prompt), current);
    if (!next?.trim()) return;
    onChangeLayout({
      ...layout,
      rowAliases: { ...layout.rowAliases, [rowKey]: next.trim() },
    });
  };

  const addColumn = () => {
    const next = window.prompt(t(($) => $.bus_manage.column_name), "");
    if (!next?.trim()) return;
    onChangeLayout(addMatrixDomain(layout, next, domains));
  };

  const addRow = () => {
    const moduleName = window.prompt(t(($) => $.bus_manage.add_row_module), "");
    if (!moduleName?.trim()) return;
    const pageName = window.prompt(t(($) => $.bus_manage.add_row_page), "");
    if (!pageName?.trim()) return;
    const processName = window.prompt(t(($) => $.bus_manage.add_row_process), "") ?? "";
    const trimmedModule = moduleName.trim();
    const trimmedPage = pageName.trim();
    const trimmedProcess = processName.trim();
    const existingModule = rowSeeds.find((seed) => seed.moduleName === trimmedModule);
    const existingPage = rowSeeds.find(
      (seed) => seed.moduleName === trimmedModule && seed.pageName === trimmedPage,
    );
    onChangeLayout(
      addMatrixPage(
        layout,
        {
          id: `${trimmedProcess ? "proc" : "page"}-${Date.now()}`,
          moduleName: trimmedModule,
          pageName: trimmedPage,
          moduleKey: existingModule?.moduleKey,
          pageKey: trimmedProcess ? existingPage?.pageKey : undefined,
          processName: trimmedProcess || undefined,
        },
        rowSeeds.map((seed) => seed.processKey ?? seed.pageKey),
      ),
    );
  };

  const deleteColumn = (domain: string) => {
    if (!window.confirm(t(($) => $.bus_manage.confirm_delete_column))) return;
    onChangeLayout(removeMatrixDomain(layout, domain));
  };

  const deleteRow = (rowKey: string) => {
    if (!window.confirm(t(($) => $.bus_manage.confirm_delete_row))) return;
    if (selectedCell && cellRowKey(selectedCell) === rowKey) onSelectCell(null);
    onChangeLayout(removeMatrixRow(layout, rowKey));
  };

  const deletePage = (page: PageGroup) => {
    if (!window.confirm(t(($) => $.bus_manage.confirm_delete_page))) return;
    let next = layout;
    for (const row of page.rows) {
      if (selectedCell && cellRowKey(selectedCell) === row.rowKey) onSelectCell(null);
      next = removeMatrixRow(next, row.rowKey);
    }
    onChangeLayout(next);
  };

  return (
    <div className="space-y-2">
      <p className="text-micro text-muted-foreground">{t(($) => $.bus_manage.grid_hint)}</p>
      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full min-w-[880px] border-collapse text-caption">
          <thead>
            <tr className="border-b border-surface-border bg-card/40 text-left text-micro text-muted-foreground">
              <th scope="col" className="sticky left-0 z-10 w-28 bg-card/95 px-3 py-2 font-medium">
                {t(($) => $.bus_matrix.module_label)}
              </th>
              <th scope="col" className="w-36 px-3 py-2 font-medium">
                {t(($) => $.bus_matrix.page_label)}
              </th>
              <th scope="col" className="w-44 px-3 py-2 font-medium">
                {t(($) => $.bus_matrix.process_label)}
              </th>
              {visibleDomains.map((domain) => (
                <th scope="col" key={domain} className="min-w-24 px-1 py-2 text-center font-medium">
                  <div className="group flex items-center justify-center gap-0.5">
                    <button
                      type="button"
                      title={t(($) => $.bus_manage.rename)}
                      onClick={() => renameDomain(domain)}
                      className="max-w-28 truncate hover:text-foreground hover:underline"
                    >
                      {layout.aliases[domain] ?? domain}
                    </button>
                    <button
                      type="button"
                      aria-label={t(($) => $.bus_manage.delete_column)}
                      title={t(($) => $.bus_manage.delete_column)}
                      onClick={() => deleteColumn(domain)}
                      className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                </th>
              ))}
              <th scope="col" className="w-10 px-1 py-2 text-center">
                <button
                  type="button"
                  aria-label={t(($) => $.bus_manage.add_column)}
                  title={t(($) => $.bus_manage.add_column)}
                  onClick={addColumn}
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Plus className="size-3.5" />
                </button>
              </th>
              <th scope="col" className="w-16 px-2 py-2 text-center font-medium">
                {t(($) => $.bus_matrix.row_total)}
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const flat = group.pages.flatMap((page) =>
                page.rows.map((row, index) => ({ page, row, pageFirst: index === 0 })),
              );
              return (
                <Fragment key={group.moduleKey}>
                  {flat.map(({ page, row, pageFirst }, index) => (
                    <tr
                      key={row.rowKey}
                      className="border-b border-surface-border last:border-b-0"
                    >
                      {index === 0 && (
                        <th
                          scope="rowgroup"
                          rowSpan={flat.length}
                          className="sticky left-0 z-10 border-r border-surface-border bg-background px-3 py-2 align-middle text-left font-medium"
                        >
                          <button
                            type="button"
                            title={t(($) => $.bus_manage.rename)}
                            onClick={() => renameModule(group.moduleKey, group.moduleName)}
                            className="max-w-full truncate text-left hover:underline"
                          >
                            {group.moduleName}
                          </button>
                        </th>
                      )}
                      {pageFirst && (
                        <td
                          rowSpan={page.rows.length}
                          className="border-r border-surface-border px-3 py-2 align-top"
                        >
                          <div className="flex items-start justify-between gap-1">
                            <button
                              type="button"
                              title={t(($) => $.bus_manage.rename)}
                              onClick={() => renamePage(page.pageKey, page.pageName)}
                              className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                            >
                              {page.pageName}
                            </button>
                            <button
                              type="button"
                              aria-label={t(($) => $.bus_manage.delete_page)}
                              title={t(($) => $.bus_manage.delete_page)}
                              onClick={() => deletePage(page)}
                              className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            >
                              <X className="size-3" />
                            </button>
                          </div>
                          <div className="mt-0.5 text-micro text-muted-foreground">
                            {t(($) => $.bus_matrix.page_subtotal, {
                              n: page.rows.reduce((sum, item) => sum + item.totalTables, 0),
                            })}
                          </div>
                        </td>
                      )}
                      <td className="border-r border-surface-border px-3 py-2">
                        <div className="flex items-start justify-between gap-1">
                          <button
                            type="button"
                            title={t(($) => $.bus_manage.rename)}
                            onClick={() =>
                              renameProcess(
                                row.rowKey,
                                row.processName ?? row.pageName,
                              )
                            }
                            className="min-w-0 flex-1 truncate text-left hover:underline"
                          >
                            {row.processName ?? row.pageName}
                          </button>
                          <button
                            type="button"
                            aria-label={t(($) => $.bus_manage.delete_row)}
                            title={t(($) => $.bus_manage.delete_row)}
                            onClick={() => deleteRow(row.rowKey)}
                            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                        <div className="truncate font-mono text-micro text-muted-foreground">
                          {row.rowKey}
                        </div>
                      </td>
                      {visibleDomains.map((domain) => {
                        const cell = row.cellsByDomain.get(domain);
                        if (!cell) {
                          const empty = draftCell(group, page, row, domain);
                          const selected = isSameCell(selectedCell, empty);
                          return (
                            <td key={domain} className="p-0 text-center">
                              <button
                                type="button"
                                aria-pressed={selected}
                                aria-label={`${empty.module_name} ${empty.page_name} ${layout.aliases[domain] ?? domain} ${t(($) => $.bus_manage.cell_empty)}`}
                                onClick={() => openCell(empty)}
                                className={cn(
                                  "flex h-12 w-full items-center justify-center text-faint-foreground hover:bg-accent/50 hover:text-muted-foreground",
                                  selected && "ring-2 ring-primary",
                                )}
                              >
                                ·
                              </button>
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
                              onClick={() => openCell(cell)}
                              aria-label={`${cell.module_name} ${cell.page_name} ${layout.aliases[cell.domain] ?? cell.domain} ${cell.table_count}`}
                              className={cn(
                                "relative flex h-12 w-full flex-col items-center justify-center gap-0.5 font-semibold tabular-nums transition-colors",
                                cross
                                  ? "bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/40"
                                  : cell.write_count > 0
                                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                    : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                                cell.is_new_table && "ring-1 ring-inset ring-blue-500/60",
                                selected && "ring-2 ring-primary",
                              )}
                            >
                              <CellChangeMarks cell={cell} />
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
                      <td className="px-2 py-2 text-center text-faint-foreground"> </td>
                      <td className="px-2 py-2 text-center font-semibold tabular-nums">
                        {row.totalTables}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            <tr className="border-t border-dashed border-surface-border">
              <td colSpan={3} className="px-3 py-2">
                <button
                  type="button"
                  onClick={addRow}
                  className="inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground"
                >
                  <Plus className="size-3.5" />
                  {t(($) => $.bus_manage.add_row)}
                </button>
              </td>
              {visibleDomains.map((domain) => (
                <td key={domain} />
              ))}
              <td />
              <td />
            </tr>
          </tbody>
          <tfoot>
            <tr className="border-t border-surface-border bg-card/40 text-micro text-muted-foreground">
              <th scope="row" className="sticky left-0 z-10 bg-card/95 px-3 py-2 text-left font-medium">
                {t(($) => $.bus_matrix.row_total)}
              </th>
              <td colSpan={2} className="px-3 py-2">
                {t(($) => $.bus_matrix.domain_label)}
              </td>
              {columnSummary.map((summary) => (
                <td key={summary.domain} className="px-2 py-2 text-center leading-tight">
                  <div className="font-semibold tabular-nums text-foreground">
                    {summary.tables}
                  </div>
                  <div className="tabular-nums">{summary.rows}</div>
                </td>
              ))}
              <td />
              <td className="px-2 py-2 text-center font-semibold tabular-nums">
                {columnSummary.reduce((sum, entry) => sum + entry.tables, 0)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <BusMatrixMountDialog
        cell={editing}
        layout={layout}
        onChange={onChangeLayout}
        open={editing !== null}
        onOpenChange={(next) => !next && setEditing(null)}
      />
    </div>
  );
}
