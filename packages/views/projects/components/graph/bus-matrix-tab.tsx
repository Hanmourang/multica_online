"use client";

import { useMemo, useState } from "react";
import { Database } from "lucide-react";
import type { BusMatrixCell } from "@multica/core/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@multica/ui/components/ui/tabs";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import { ScanStatusBar } from "./scan-status-bar";
import { BusMatrixGrid } from "./bus-matrix-grid";
import { BusMatrixSidebar } from "./bus-matrix-sidebar";
import { BusMatrixDrilldown } from "./bus-matrix-drilldown";
import { BusMatrixTimeline } from "./bus-matrix-timeline";
import { BusMatrixAlerts } from "./bus-matrix-alerts";
import { ArchiveEmpty } from "../archive/query-states";
import { Button } from "@multica/ui/components/ui/button";
import { BusMatrixManage } from "./bus-matrix-manage";
import {
  applyDomainLayout,
  loadBusMatrixLayout,
  saveBusMatrixLayout,
  type BusMatrixLayout,
} from "./bus-matrix-layout";

/**
 * f11 数据模型 Tab 顶层：产品 / 数据 / 迭代三视角。
 *
 * The grid consumes the bus-matrix pre-aggregation carried by the latest
 * snapshot. This tab does **not** create its own GraphDataProvider: the single
 * shared provider is lifted to `project-archive-views.tsx` (GraphViewStack),
 * which wraps f10 产品功能 and f11 together. That is what actually makes the
 * two tabs share state — the earlier "same provider query as f10" note only
 * described React Query's request dedupe, while two separately mounted
 * providers still meant two independent contexts, so `selectedCell` /
 * `selectedNodeId` were dropped on every tab switch.
 *
 * 产品视角 = rows (module × page) with a selected-row sidebar and cell
 * drilldown; 数据视角 = per-domain rollup computed client-side; 迭代视角 =
 * ontology changelog timeline + matrix alerts.
 */
export function BusMatrixTab() {
  return (
    <div className="space-y-3">
      <ScanStatusBar />
      <BusMatrixViews />
    </div>
  );
}

function BusMatrixViews() {
  const { t } = useT("archive");
  const { projectId, snapshot, selectedCell, setSelectedCell } = useGraphData();
  const [domainFilter, setDomainFilter] = useState<string | null>(null);
  const [crossOnly, setCrossOnly] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [layout, setLayout] = useState<BusMatrixLayout>(() =>
    loadBusMatrixLayout(projectId),
  );

  const rawCells = useMemo(() => snapshot?.bus_matrix ?? [], [snapshot]);

  const cells = useMemo(() => {
    const visible = new Set(
      applyDomainLayout(
        [...new Set(rawCells.map((c) => c.domain))],
        layout,
      ),
    );
    const mapped = rawCells
      .filter((cell) => visible.has(cell.domain) && !layout.hiddenRows.includes(cell.page_key))
      .map((cell) => ({
        ...cell,
        domain: layout.aliases[cell.domain] ?? cell.domain,
      }));
    const manuals: typeof mapped = layout.manualRows.map((row) => ({
      module_name: row.name,
      module_node_id: row.id,
      page_name: row.name,
      page_key: row.id,
      domain: layout.aliases[row.domain] ?? row.domain,
      table_count: row.read + row.write,
      read_count: row.read,
      write_count: row.write,
    }));
    return [...mapped, ...manuals];
  }, [rawCells, layout]);

  const domainItems = useMemo(() => {
    const seen = new Set<string>();
    for (const cell of cells) seen.add(cell.domain);
    return [...seen].sort().map((value) => ({ value, label: value }));
  }, [cells]);

  const empty = cells.length === 0;

  return (
    <Tabs defaultValue="product">
      <TabsList variant="line">
        <TabsTrigger value="product">
          {t(($) => $.bus_matrix.perspective_product)}
        </TabsTrigger>
        <TabsTrigger value="data">
          {t(($) => $.bus_matrix.perspective_data)}
        </TabsTrigger>
        <TabsTrigger value="iteration">
          {t(($) => $.bus_matrix.perspective_iteration)}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="product" className="mt-3 space-y-3">
        {/* Perspective toolbar — domain column filter + cross-only switch. */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            items={domainItems}
            value={domainFilter}
            onValueChange={(value) => setDomainFilter(value ?? null)}
          >
            <SelectTrigger
              className="h-8 w-44 text-caption"
              aria-label={t(($) => $.bus_matrix.domain_all)}
            >
              <SelectValue placeholder={t(($) => $.bus_matrix.domain_all)} />
            </SelectTrigger>
            <SelectContent>
              {domainItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="xs"
            variant={layoutOpen ? "default" : "outline"}
            onClick={() => setLayoutOpen((v) => !v)}
          >
            {t(($) => $.bus_manage.layout)}
          </Button>
          <button
            type="button"
            aria-pressed={crossOnly}
            onClick={() => setCrossOnly((value) => !value)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-micro font-medium transition-colors",
              crossOnly
                ? "border-primary/40 bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {t(($) => $.bus_matrix.cross_domain_only)}
          </button>
        </div>

        {empty ? (
          <ArchiveEmpty
            icon={<Database className="size-5" />}
            title={t(($) => $.bus_matrix.matrix_empty)}
            description={t(($) => $.bus_matrix.matrix_empty_hint)}
          />
        ) : (
        <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
          <BusMatrixGrid
            cells={cells}
            domainFilter={domainFilter}
            crossOnly={crossOnly}
            selectedCell={selectedCell}
            onSelectCell={setSelectedCell}
          />
          <BusMatrixSidebar cells={cells} selectedCell={selectedCell} />
        </div>
        )}

        {!empty && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-3 rounded-sm bg-emerald-500/25" />
            {t(($) => $.bus_matrix.read_short)}
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-3 rounded-sm bg-amber-500/30" />
            {t(($) => $.bus_matrix.write_short)}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-3 rounded-sm ring-1 ring-inset ring-blue-500/60"
            />
            {t(($) => $.bus_matrix.legend_new)}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-3 rounded-sm bg-destructive/15 ring-1 ring-inset ring-destructive/40"
            />
            {t(($) => $.bus_matrix.legend_cross)}
          </span>
        </div>
        )}

        {!empty && <BusMatrixDrilldown />}
        {layoutOpen && (
          <BusMatrixManage
            projectId={projectId}
            domains={[...new Set(rawCells.map((c) => c.domain))]}
            layout={layout}
            onChange={(next) => {
              setLayout(next);
              saveBusMatrixLayout(projectId, next);
            }}
          />
        )}
      </TabsContent>

      <TabsContent value="data" className="mt-3">
        <BusMatrixDataView cells={cells} />
      </TabsContent>

      <TabsContent value="iteration" className="mt-3 grid items-start gap-3 lg:grid-cols-2">
        <BusMatrixTimeline />
        <BusMatrixAlerts />
      </TabsContent>
    </Tabs>
  );
}

/** 数据视角：按列汇总 — 每个数据域被谁读写（客户端聚合，真实 cells）。 */
function BusMatrixDataView({ cells }: { cells: BusMatrixCell[] }) {
  const { t } = useT("archive");

  const domainStats = useMemo(() => {
    const map = new Map<
      string,
      {
        tables: number;
        read: number;
        write: number;
        modules: Set<string>;
        cross: number;
        newTables: number;
      }
    >();
    for (const cell of cells) {
      let entry = map.get(cell.domain);
      if (!entry) {
        entry = {
          tables: 0,
          read: 0,
          write: 0,
          modules: new Set(),
          cross: 0,
          newTables: 0,
        };
        map.set(cell.domain, entry);
      }
      entry.tables += cell.table_count;
      entry.read += cell.read_count;
      entry.write += cell.write_count;
      entry.modules.add(cell.module_name);
      if (cell.is_cross_domain_write) entry.cross += 1;
      if (cell.is_new_table) entry.newTables += 1;
    }
    return [...map.entries()].sort((a, b) => b[1].tables - a[1].tables);
  }, [cells]);

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {domainStats.map(([domain, stat]) => (
        <div
          key={domain}
          className="space-y-2 rounded-lg border border-surface-border bg-surface p-3"
        >
          <div className="truncate font-mono text-caption font-semibold" title={domain}>
            {domain}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-title-sm font-semibold tabular-nums">
              {stat.tables}
            </span>
            <span className="text-micro text-muted-foreground">
              {t(($) => $.bus_matrix.table_count, { count: stat.tables })}
            </span>
            <span className="text-micro tabular-nums text-muted-foreground">
              {t(($) => $.bus_matrix.read_write, {
                read: stat.read,
                write: stat.write,
              })}
            </span>
          </div>
          <div className="text-micro text-muted-foreground">
            {t(($) => $.bus_matrix.modules_touched, { count: stat.modules.size })}
          </div>
          <div className="flex flex-wrap gap-1">
            {[...stat.modules].map((module) => (
              <span
                key={module}
                className="rounded border border-surface-border px-1.5 py-0.5 text-micro text-muted-foreground"
              >
                {module}
              </span>
            ))}
          </div>
          {(stat.cross > 0 || stat.newTables > 0) && (
            <div className="flex flex-wrap gap-1.5 text-micro">
              {stat.cross > 0 && (
                <span className="text-destructive">
                  {t(($) => $.bus_matrix.legend_cross)} {stat.cross}
                </span>
              )}
              {stat.newTables > 0 && (
                <span className="text-blue-600 dark:text-blue-400">
                  {t(($) => $.bus_matrix.legend_new)} {stat.newTables}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
