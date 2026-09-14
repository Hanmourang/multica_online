"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BusMatrixCell } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  busMatrixAlertsOptions,
  busMatrixDrilldownOptions,
  busMatrixTimelineOptions,
} from "@multica/core/graph/queries";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { QueryError, QueryLoading } from "../archive/query-states";
import { useGraphData } from "./graph-data-provider";
import type { AssetMountRw, BusMatrixLayout } from "./bus-matrix-layout";
import { cellRowKey, saveCellCounts } from "./bus-matrix-layout";
import { collectMatrixTables } from "./bus-matrix-tables";
import { ChangeBadge } from "./bus-matrix-change-badge";
import {
  cellMountKey,
  changeByTableName,
  ignoreAsset,
  listCellMounts,
  mergeCellAssets,
  mountAsset,
  restoreAsset,
  setMountRw,
  unmountAsset,
  type MergedMountRow,
} from "./bus-matrix-mount";

const RW_CYCLE: AssetMountRw[] = ["R", "W", "RW"];

export function BusMatrixMountDialog({
  cell,
  layout,
  onChange,
  open,
  onOpenChange,
}: {
  cell: BusMatrixCell | null;
  layout: BusMatrixLayout;
  onChange: (next: BusMatrixLayout) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId, snapshot } = useGraphData();
  const [query, setQuery] = useState("");
  const [readDraft, setReadDraft] = useState(String(cell?.read_count ?? 0));
  const [writeDraft, setWriteDraft] = useState(String(cell?.write_count ?? 0));

  useEffect(() => {
    if (!open || !cell) return;
    setQuery("");
    setReadDraft(String(cell.read_count));
    setWriteDraft(String(cell.write_count));
  }, [cell, open]);

  const filters = cell
    ? {
        module_node_id: cell.module_node_id,
        page_key: cell.page_key,
        process_key: cell.process_key,
        domain: cell.domain,
      }
    : {};
  const drilldown = useQuery({
    ...busMatrixDrilldownOptions(wsId, projectId, filters),
    enabled: open && Boolean(cell),
  });
  const catalog = useQuery({
    ...busMatrixDrilldownOptions(wsId, projectId, {}),
    enabled: open,
  });
  const alerts = useQuery({
    ...busMatrixAlertsOptions(wsId, projectId),
    enabled: open,
  });
  const timeline = useQuery({
    ...busMatrixTimelineOptions(wsId, projectId, 50),
    enabled: open,
  });

  const cellKey = cell
    ? cellMountKey(cell.module_node_id, cellRowKey(cell), cell.domain)
    : "";
  const changeMap = useMemo(
    () => changeByTableName(timeline.data?.changes ?? []),
    [timeline.data?.changes],
  );
  const merged = useMemo(
    () =>
      mergeCellAssets({
        autoTables: drilldown.data?.tables ?? [],
        mounts: cellKey ? listCellMounts(layout, cellKey) : [],
        changeByTable: changeMap,
      }),
    [cellKey, changeMap, drilldown.data?.tables, layout],
  );
  const mounted = merged.filter((row) => !row.ignored);
  const ignored = merged.filter((row) => row.ignored);
  const mountedNames = new Set(merged.map((row) => row.table));

  const candidates = useMemo(() => {
    const rows = collectMatrixTables({
      summaries: snapshot?.module_summary ?? [],
      drilldownTables: catalog.data?.tables ?? [],
      alerts: alerts.data?.alerts ?? [],
      bindings: layout.tableBindings,
    });
    const q = query.trim().toLowerCase();
    return rows
      .filter((row) => !mountedNames.has(row.name))
      .filter((row) => !q || row.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [alerts.data?.alerts, catalog.data?.tables, layout.tableBindings, mountedNames, query, snapshot?.module_summary]);

  const apply = (next: BusMatrixLayout) => onChange(next);

  const persistCounts = (read: number, write: number) => {
    if (!cell) return;
    onChange(saveCellCounts(layout, cell.module_node_id, cellRowKey(cell), cell.domain, read, write));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" data-testid="bus-matrix-mount">
        <DialogHeader>
          <DialogTitle>{t(($) => $.bus_v2.mount_title)}</DialogTitle>
          {cell ? (
            <p className="text-caption text-muted-foreground">
              {cell.page_name}
              {cell.process_name ? ` · ${cell.process_name}` : ""} ×{" "}
              {layout.aliases[cell.domain] ?? cell.domain}
              {snapshot?.scan_id ? (
                <span className="ml-2 font-mono text-micro">
                  {t(($) => $.bus_v2.scan_current, { scan: snapshot.scan_id.slice(0, 8) })}
                </span>
              ) : null}
            </p>
          ) : null}
        </DialogHeader>

        {!cell ? null : drilldown.isPending ? (
          <QueryLoading rows={4} />
        ) : drilldown.isError ? (
          <QueryError compact onRetry={() => void drilldown.refetch()} />
        ) : (
          <div className="space-y-4 text-caption">
            {!drilldown.data?.detail_available ? (
              <p className="rounded-md border border-dashed border-surface-border px-2.5 py-2 text-micro text-muted-foreground">
                {t(($) => $.bus_matrix_detail.drilldown_detail_unavailable)}
              </p>
            ) : null}

            <section className="space-y-1.5">
              <h4 className="text-micro font-semibold text-muted-foreground">
                {t(($) => $.bus_v2.mount_mounted, { n: mounted.length })}
              </h4>
              {mounted.length === 0 ? (
                <p className="text-micro text-muted-foreground">{t(($) => $.bus_v2.mount_empty)}</p>
              ) : (
                mounted.map((row) => (
                  <MountRow
                    key={row.table}
                    row={row}
                    onRw={() =>
                      apply(setMountRw(layout, cellKey, row.table, nextRw(row.rw)))
                    }
                    onIgnore={() => apply(ignoreAsset(layout, cellKey, row.table, row.rw))}
                    onUnmount={() => apply(unmountAsset(layout, cellKey, row.table))}
                  />
                ))
              )}
            </section>

            <section className="space-y-1.5">
              <h4 className="text-micro font-semibold text-muted-foreground">
                {t(($) => $.bus_v2.mount_ignored, { n: ignored.length })}
              </h4>
              {ignored.length === 0 ? (
                <p className="text-micro text-muted-foreground">{t(($) => $.bus_v2.mount_ignored_empty)}</p>
              ) : (
                ignored.map((row) => (
                  <div
                    key={row.table}
                    className="flex items-center gap-2 rounded-md border border-dashed border-surface-border px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{row.table}</span>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => apply(restoreAsset(layout, cellKey, row.table))}
                    >
                      {t(($) => $.bus_v2.mount_restore)}
                    </Button>
                  </div>
                ))
              )}
            </section>

            <section className="space-y-1.5">
              <h4 className="text-micro font-semibold text-muted-foreground">
                {t(($) => $.bus_v2.mount_add)}
              </h4>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t(($) => $.bus_v2.mount_search)}
                className="h-8"
              />
              {candidates.map((row) => (
                <div
                  key={row.name}
                  className="flex items-center gap-2 rounded-md border border-surface-border px-2 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{row.name}</span>
                  <span className="text-micro text-muted-foreground">
                    {row.domain ?? t(($) => $.bus_v2.domain_unknown)}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => apply(mountAsset(layout, cellKey, row.name, "R"))}
                  >
                    {t(($) => $.bus_v2.mount_as_read)}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    onClick={() => apply(mountAsset(layout, cellKey, row.name, "RW"))}
                  >
                    {t(($) => $.bus_v2.mount_as_rw)}
                  </Button>
                </div>
              ))}
              {query.trim() && !candidates.some((row) => row.name === query.trim()) ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    apply(mountAsset(layout, cellKey, query.trim(), "R"));
                    setQuery("");
                  }}
                >
                  {t(($) => $.bus_v2.mount_typed, { name: query.trim() })}
                </Button>
              ) : null}
            </section>

            <section className="grid grid-cols-2 gap-2 border-t border-surface-border pt-3">
              <label className="space-y-1">
                <span className="text-micro text-muted-foreground">{t(($) => $.bus_manage.cell_read)}</span>
                <Input
                  type="number"
                  min={0}
                  value={readDraft}
                  onChange={(event) => setReadDraft(event.target.value)}
                />
              </label>
              <label className="space-y-1">
                <span className="text-micro text-muted-foreground">{t(($) => $.bus_manage.cell_write)}</span>
                <Input
                  type="number"
                  min={0}
                  value={writeDraft}
                  onChange={(event) => setWriteDraft(event.target.value)}
                />
              </label>
            </section>
          </div>
        )}

        <DialogFooter>
          <Button size="xs" variant="ghost" onClick={() => persistCounts(0, 0)}>
            {t(($) => $.bus_manage.cell_clear)}
          </Button>
          <Button
            size="xs"
            onClick={() => {
              persistCounts(Number(readDraft) || 0, Number(writeDraft) || 0);
              onOpenChange(false);
            }}
          >
            {t(($) => $.bus_v2.mount_done)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function nextRw(current: AssetMountRw): AssetMountRw {
  return RW_CYCLE[(RW_CYCLE.indexOf(current) + 1) % RW_CYCLE.length] ?? "R";
}

function MountRow({
  row,
  onRw,
  onIgnore,
  onUnmount,
}: {
  row: MergedMountRow;
  onRw: () => void;
  onIgnore: () => void;
  onUnmount: () => void;
}) {
  const { t } = useT("archive");
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-surface-border px-2 py-1.5">
      <span
        className={cn(
          "rounded px-1 py-0.5 text-[10px] font-semibold",
          row.source === "manual"
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
            : "bg-primary/10 text-primary",
        )}
      >
        {row.source === "manual" ? t(($) => $.bus_v2.src_manual) : t(($) => $.bus_v2.src_auto)}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium">{row.table}</span>
      <button
        type="button"
        onClick={onRw}
        className="rounded border border-surface-border px-1.5 py-0.5 text-[10px] font-bold"
      >
        {row.rw}
      </button>
      <ChangeBadge type={row.changeType} />
      {row.columns.length > 0 ? (
        <span className="max-w-40 truncate text-micro text-muted-foreground" title={row.columns.join(" / ")}>
          {row.columns.slice(0, 4).join(" / ")}
        </span>
      ) : null}
      <Button type="button" size="xs" variant="ghost" onClick={onIgnore}>
        {t(($) => $.bus_v2.mount_ignore)}
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={onUnmount}>
        {t(($) => $.bus_manage.unbind)}
      </Button>
    </div>
  );
}

