"use client";

import { useMemo, useState } from "react";
import { Database } from "lucide-react";
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
import { BusMatrixDataView } from "./bus-matrix-data-view";
import { BusMatrixTablesPanel } from "./bus-matrix-tables-panel";
import { DataModelAssets } from "./data-model-assets";
import { DataModelIterations } from "./data-model-iterations";
import {
  applyCellEdits,
  applyDomainLayout,
  applyRowLayout,
  cellRowKey,
  collectRowSeeds,
  loadBusMatrixLayout,
  saveBusMatrixLayout,
  saveCellCounts,
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
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden">
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
  const [layoutOpen, setLayoutOpen] = useState(true);
  const [layout, setLayout] = useState<BusMatrixLayout>(() =>
    loadBusMatrixLayout(projectId),
  );

  const rawCells = useMemo(() => snapshot?.bus_matrix ?? [], [snapshot]);

  const persistLayout = (next: BusMatrixLayout) => {
    setLayout(next);
    saveBusMatrixLayout(projectId, next);
  };

  const visibleDomains = useMemo(
    () =>
      applyDomainLayout(
        [...new Set([...rawCells.map((cell) => cell.domain), ...layout.manualDomains])],
        layout,
      ),
    [layout, rawCells],
  );

  const cells = useMemo(() => {
    const visible = new Set(visibleDomains);
    const mapped = rawCells.filter(
      (cell) => visible.has(cell.domain) && !layout.hiddenRows.includes(cellRowKey(cell)),
    );
    const manuals: typeof mapped = layout.manualRows
      .filter((row) => visible.has(row.domain) && !layout.hiddenRows.includes(row.id))
      .map((row) => ({
        module_name: row.name,
        module_node_id: row.id,
        page_name: row.name,
        page_key: row.id,
        domain: row.domain,
        table_count: row.read + row.write,
        read_count: row.read,
        write_count: row.write,
      }));
    const combined = applyCellEdits([...mapped, ...manuals], layout).map((cell) => ({
      ...cell,
      module_name: layout.moduleAliases[cell.module_node_id] ?? cell.module_name,
      page_name: layout.rowAliases[cell.page_key] ?? cell.page_name,
      process_name: cell.process_key
        ? layout.rowAliases[cell.process_key] ?? cell.process_name
        : cell.process_name,
    }));
    const rank = new Map(
      applyRowLayout(
        [...new Set(combined.map((cell) => cellRowKey(cell)))],
        layout,
      ).map((key, index) => [key, index]),
    );
    return combined.sort(
      (a, b) => (rank.get(cellRowKey(a)) ?? 999) - (rank.get(cellRowKey(b)) ?? 999),
    );
  }, [layout, rawCells, visibleDomains]);

  const rowSeeds = useMemo(() => collectRowSeeds(rawCells, layout), [layout, rawCells]);

  const layoutRows = useMemo(
    () =>
      rowSeeds.map((seed) => ({
        key: seed.processKey ?? seed.pageKey,
        name: seed.processName ?? seed.pageName,
      })),
    [rowSeeds],
  );

  const domainItems = useMemo(
    () =>
      visibleDomains.map((value) => ({
        value,
        label: layout.aliases[value] ?? value,
      })),
    [layout.aliases, visibleDomains],
  );

  return (
    <Tabs defaultValue="product" className="flex min-h-0 flex-1 flex-col overflow-hidden">
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

      <TabsContent value="product" className="mt-3 min-h-0 flex-1 space-y-3 overflow-auto">
        {/* Perspective toolbar — domain column filter + cross-only switch. */}
        <div className="flex flex-wrap items-center gap-2">
          {snapshot?.scan_id ? (
            <span className="rounded-md border border-primary/20 bg-primary/5 px-2 py-1 font-mono text-micro text-primary">
              {t(($) => $.bus_v2.scan_current, { scan: snapshot.scan_id.slice(0, 8) })}
            </span>
          ) : null}
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

        {rawCells.length === 0 && cells.length === 0 && rowSeeds.length === 0 && (
          <ArchiveEmpty
            icon={<Database className="size-5" />}
            title={t(($) => $.bus_matrix.matrix_empty)}
            description={t(($) => $.bus_matrix.matrix_empty_hint)}
          />
        )}
        <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(220px,28%)]">
          <BusMatrixGrid
            cells={cells}
            rowSeeds={rowSeeds}
            domains={visibleDomains}
            domainFilter={domainFilter}
            crossOnly={crossOnly}
            selectedCell={selectedCell}
            onSelectCell={setSelectedCell}
            layout={layout}
            onChangeLayout={persistLayout}
          />
          <BusMatrixSidebar
            cells={cells}
            selectedCell={selectedCell}
            onSaveCell={(cell, read, write) => {
              persistLayout(
                saveCellCounts(layout, cell.module_node_id, cellRowKey(cell), cell.domain, read, write),
              );
              setSelectedCell({
                ...cell,
                read_count: read,
                write_count: write,
                table_count: read + write,
              });
            }}
          />
        </div>

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

        <BusMatrixTablesPanel
          layout={layout}
          onChange={persistLayout}
        />
        {selectedCell ? <BusMatrixDrilldown /> : null}
        {layoutOpen && (
          <BusMatrixManage
            projectId={projectId}
            domains={[...new Set([...rawCells.map((c) => c.domain), ...layout.manualDomains])]}
            rows={layoutRows}
            layout={layout}
            onChange={persistLayout}
          />
        )}
      </TabsContent>

      <TabsContent value="data" className="mt-3 min-h-0 flex-1 overflow-auto">
        {snapshot?.data_model?.schema_version === 2 ? (
          <DataModelAssets dataModel={snapshot.data_model} aliases={layout.aliases} />
        ) : (
          <BusMatrixDataView cells={cells} aliases={layout.aliases} layout={layout} />
        )}
      </TabsContent>

      <TabsContent value="iteration" className="mt-3 min-h-0 flex-1 space-y-3 overflow-auto">
        {snapshot?.data_model?.schema_version === 2 ? (
          <DataModelIterations dataModel={snapshot.data_model} />
        ) : null}
        <div className="grid items-start gap-3 lg:grid-cols-2">
          <BusMatrixTimeline />
          <BusMatrixAlerts />
        </div>
      </TabsContent>
    </Tabs>
  );
}

