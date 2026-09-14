"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BusMatrixAlert, BusMatrixCell, OntologyChangeType } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  busMatrixAlertsOptions,
  busMatrixDrilldownOptions,
  busMatrixTimelineOptions,
} from "@multica/core/graph/queries";
import { Badge } from "@multica/ui/components/ui/badge";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import { QueryError, QueryLoading } from "../archive/query-states";
import type { BusMatrixLayout } from "./bus-matrix-layout";
import { collectMatrixTables, type MatrixTableRow } from "./bus-matrix-tables";
import { changeByTableName } from "./bus-matrix-mount";
import { BusMatrixAsset360 } from "./bus-matrix-asset-360";
import { ChangeBadge } from "./bus-matrix-change-badge";

type StatusFilter = "all" | "changed" | "bound" | "unbound";

export function BusMatrixDataView({
  cells,
  aliases,
  layout,
}: {
  cells: BusMatrixCell[];
  aliases: Record<string, string>;
  layout: BusMatrixLayout;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId, snapshot } = useGraphData();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [domainFilter, setDomainFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const drilldown = useQuery(busMatrixDrilldownOptions(wsId, projectId, {}));
  const alerts = useQuery(busMatrixAlertsOptions(wsId, projectId));
  const timeline = useQuery(busMatrixTimelineOptions(wsId, projectId, 50));

  const changeMap = useMemo(
    () => changeByTableName(timeline.data?.changes ?? []),
    [timeline.data?.changes],
  );

  const rows = useMemo(
    () =>
      collectMatrixTables({
        summaries: snapshot?.module_summary ?? [],
        drilldownTables: drilldown.data?.tables ?? [],
        alerts: alerts.data?.alerts ?? [],
        bindings: layout.tableBindings,
      }),
    [alerts.data?.alerts, drilldown.data?.tables, layout.tableBindings, snapshot?.module_summary],
  );

  const domainStats = useMemo(() => rollupDomains(cells, aliases), [aliases, cells]);

  const visible = useMemo(() => {
    return rows.filter((row) => {
      if (domainFilter && row.domain !== domainFilter) return false;
      if (status === "bound") return row.bound;
      if (status === "unbound") return !row.bound;
      if (status === "changed") return Boolean(changeMap[row.name]);
      return true;
    });
  }, [changeMap, domainFilter, rows, status]);

  const selectedRow = rows.find((row) => row.name === selected) ?? null;
  const selectedDetail = (drilldown.data?.tables ?? []).find((table) => table.name === selected);

  const counts = useMemo(() => {
    let added = 0;
    let modified = 0;
    let removed = 0;
    for (const type of Object.values(changeMap)) {
      if (type === "added") added += 1;
      else if (type === "modified") modified += 1;
      else if (type === "removed") removed += 1;
    }
    return { added, modified, removed, unchanged: Math.max(0, rows.length - added - modified - removed) };
  }, [changeMap, rows.length]);

  if (drilldown.isPending && alerts.isPending) return <QueryLoading rows={6} />;
  if (drilldown.isError && alerts.isError) {
    return <QueryError compact onRetry={() => void drilldown.refetch()} />;
  }

  return (
    <div className="space-y-3" data-testid="bus-matrix-data-view">
      <div className="flex flex-wrap items-center gap-2 text-micro">
        {snapshot?.scan_id ? (
          <span className="rounded-md border border-primary/20 bg-primary/5 px-2 py-1 font-mono text-primary">
            {t(($) => $.bus_v2.scan_current, { scan: snapshot.scan_id.slice(0, 8) })}
          </span>
        ) : null}
        <span className="rounded-md border border-surface-border px-2 py-1 tabular-nums text-muted-foreground">
          {t(($) => $.bus_v2.diff_stat, counts)}
        </span>
        <select
          className="h-7 rounded-md border border-surface-border bg-surface px-1.5"
          value={domainFilter ?? ""}
          onChange={(event) => setDomainFilter(event.target.value || null)}
          aria-label={t(($) => $.bus_matrix.domain_all)}
        >
          <option value="">{t(($) => $.bus_matrix.domain_all)}</option>
          {domainStats.map((item) => (
            <option key={item.domain} value={item.domain}>
              {item.label}
            </option>
          ))}
        </select>
        {(["all", "changed", "bound", "unbound"] as const).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={status === id}
            onClick={() => setStatus(id)}
            className={cn(
              "rounded-full border px-2 py-0.5",
              status === id
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-surface-border text-muted-foreground",
            )}
          >
            {id === "all"
              ? t(($) => $.bus_manage.tables_all)
              : id === "changed"
                ? t(($) => $.bus_v2.filter_changed)
                : id === "bound"
                  ? t(($) => $.bus_manage.tables_bound)
                  : t(($) => $.bus_manage.tables_unbound)}
          </button>
        ))}
      </div>

      <AlertStrip alerts={alerts.data?.alerts ?? []} />

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {domainStats.map((item) => (
          <button
            key={item.domain}
            type="button"
            onClick={() => setDomainFilter((current) => (current === item.domain ? null : item.domain))}
            className={cn(
              "rounded-lg border bg-surface p-3 text-left",
              domainFilter === item.domain
                ? "border-primary/50 ring-1 ring-primary/30"
                : "border-surface-border",
            )}
          >
            <div className="truncate font-mono text-caption font-semibold">{item.label}</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-title-sm font-semibold tabular-nums">{item.tables}</span>
              <span className="text-micro text-muted-foreground">
                {t(($) => $.bus_matrix.read_write, { read: item.read, write: item.write })}
              </span>
            </div>
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full border-collapse text-left text-caption">
          <thead>
            <tr className="border-b border-surface-border bg-muted/30 text-micro text-muted-foreground">
              <th className="px-2.5 py-1.5 font-medium">{t(($) => $.bus_matrix_detail.drilldown_col_table)}</th>
              <th className="px-2.5 py-1.5 font-medium">{t(($) => $.bus_matrix.domain_label)}</th>
              <th className="px-2.5 py-1.5 font-medium">{t(($) => $.bus_v2.col_status)}</th>
              <th className="px-2.5 py-1.5 font-medium">{t(($) => $.bus_matrix_detail.drilldown_col_rw)}</th>
              <th className="px-2.5 py-1.5 font-medium">{t(($) => $.bus_v2.col_refs)}</th>
              <th className="px-2.5 py-1.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  {t(($) => $.bus_manage.no_tables)}
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <DataTableRow
                  key={row.name}
                  row={row}
                  aliases={aliases}
                  changeType={changeMap[row.name]}
                  onOpen={() => setSelected(row.name)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <BusMatrixAsset360
        row={selectedRow}
        detail={selectedDetail}
        changeType={selected ? changeMap[selected] : undefined}
        aliases={aliases}
        open={selected !== null}
        onOpenChange={(next) => !next && setSelected(null)}
      />
    </div>
  );
}

function DataTableRow({
  row,
  aliases,
  changeType,
  onOpen,
}: {
  row: MatrixTableRow;
  aliases: Record<string, string>;
  changeType?: OntologyChangeType;
  onOpen: () => void;
}) {
  const { t } = useT("archive");
  return (
    <tr className="border-b border-surface-border/60 last:border-b-0">
      <td className="px-2.5 py-1.5 font-mono text-[11px] font-medium">{row.name}</td>
      <td className="px-2.5 py-1.5 text-micro text-muted-foreground">
        {aliases[row.domain ?? ""] ?? row.domain ?? "—"}
      </td>
      <td className="px-2.5 py-1.5">
        {changeType ? (
          <ChangeBadge type={changeType} />
        ) : (
          <Badge variant="outline" className="text-[10px]">
            {!row.bound
              ? t(($) => $.bus_manage.table_status_unbound)
              : !row.attributed
                ? t(($) => $.bus_manage.table_status_unattributed)
                : t(($) => $.bus_v2.chg_same)}
          </Badge>
        )}
      </td>
      <td className="px-2.5 py-1.5 tabular-nums text-micro">
        {t(($) => $.bus_matrix.read_write, { read: row.read ?? 0, write: row.write ?? 0 })}
      </td>
      <td className="px-2.5 py-1.5 text-micro">
        {t(($) => $.bus_v2.refs_n, { n: row.modules.length })}
      </td>
      <td className="px-2.5 py-1.5 text-right">
        <button type="button" className="text-[11px] font-semibold text-brand hover:underline" onClick={onOpen}>
          {t(($) => $.bus_v2.open_360)}
        </button>
      </td>
    </tr>
  );
}

function AlertStrip({ alerts }: { alerts: BusMatrixAlert[] }) {
  const { t } = useT("archive");
  const orphans = alerts.filter((alert) => alert.type === "orphan_table");
  const deprecated = alerts.filter((alert) => alert.type === "deprecated_access");
  const cross = alerts.filter((alert) => alert.type === "cross_domain_write");
  if (orphans.length === 0 && deprecated.length === 0 && cross.length === 0) return null;
  const orphanTables = orphans.flatMap((alert) => alert.tables ?? []).slice(0, 4);
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-micro text-amber-800 dark:text-amber-300">
      {orphans.length > 0 ? (
        <span>
          {t(($) => $.bus_v2.alert_orphan, { n: orphans.reduce((sum, alert) => sum + alert.count, 0) })}
          {orphanTables.length > 0 ? `：${orphanTables.join("、")}` : ""}
        </span>
      ) : null}
      {cross.length > 0 ? (
        <span className="ml-2">
          {t(($) => $.bus_v2.alert_cross, { n: cross.length })}
        </span>
      ) : null}
      {deprecated.length > 0 ? (
        <span className="ml-2">{t(($) => $.bus_v2.alert_deprecated, { n: deprecated.length })}</span>
      ) : null}
    </div>
  );
}

function rollupDomains(cells: BusMatrixCell[], aliases: Record<string, string>) {
  const map = new Map<string, { domain: string; label: string; tables: number; read: number; write: number }>();
  for (const cell of cells) {
    const entry = map.get(cell.domain) ?? {
      domain: cell.domain,
      label: aliases[cell.domain] ?? cell.domain,
      tables: 0,
      read: 0,
      write: 0,
    };
    entry.tables += cell.table_count;
    entry.read += cell.read_count;
    entry.write += cell.write_count;
    map.set(cell.domain, entry);
  }
  return [...map.values()].sort((a, b) => b.tables - a.tables);
}
