"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Table2 } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  busMatrixAlertsOptions,
  busMatrixDrilldownOptions,
  graphModulesOptions,
} from "@multica/core/graph/queries";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import { QueryError, QueryLoading } from "../archive/query-states";
import {
  collectMatrixTables,
  filterMatrixTables,
  type MatrixTableRow,
} from "./bus-matrix-tables";
import type { BusMatrixLayout } from "./bus-matrix-layout";

type TableFilter = "all" | "bound" | "unbound" | "unattributed";

export function BusMatrixTablesPanel({
  layout,
  onChange,
}: {
  layout: BusMatrixLayout;
  onChange: (next: BusMatrixLayout) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId, snapshot, selectedCell } = useGraphData();
  const [filter, setFilter] = useState<TableFilter>("all");
  const [bindTarget, setBindTarget] = useState("");
  const drilldown = useQuery(busMatrixDrilldownOptions(wsId, projectId, {}));
  const alerts = useQuery(busMatrixAlertsOptions(wsId, projectId));
  const modules = useQuery(graphModulesOptions(wsId, projectId));

  const rows = useMemo(() => {
    const collected = collectMatrixTables({
      summaries: snapshot?.module_summary ?? [],
      drilldownTables: drilldown.data?.tables ?? [],
      alerts: alerts.data?.alerts ?? [],
      bindings: layout.tableBindings,
    });
    if (!selectedCell) return collected;
    const locator = `${selectedCell.module_node_id}:${selectedCell.page_key}:${selectedCell.domain}`;
    return collected.filter((row) => {
      const fromCell = (drilldown.data?.tables ?? []).some(
        (table) =>
          table.name === row.name &&
          (table.source_cells?.includes(locator) || table.domain === selectedCell.domain),
      );
      const fromModule = row.modules.some((module) => module.id === selectedCell.module_node_id);
      return fromCell || fromModule;
    });
  }, [alerts.data, drilldown.data, layout.tableBindings, selectedCell, snapshot?.module_summary]);

  const visible = filterMatrixTables(rows, filter);
  const boundCount = rows.filter((row) => row.bound).length;
  const unboundCount = rows.filter((row) => !row.bound).length;

  if (drilldown.isPending && alerts.isPending) return <QueryLoading rows={4} />;
  if (drilldown.isError && alerts.isError) {
    return <QueryError compact onRetry={() => void drilldown.refetch()} />;
  }

  const bindTable = (name: string) => {
    const module = (modules.data?.modules ?? []).find((item) => item.id === bindTarget || item.graph_node_id === bindTarget);
    if (!module) return;
    onChange({
      ...layout,
      tableBindings: {
        ...layout.tableBindings,
        [name]: {
          moduleName: module.name,
          moduleNodeId: module.graph_node_id ?? module.id,
        },
      },
    });
  };

  return (
    <div className="space-y-2" data-testid="bus-matrix-tables">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="flex items-center gap-1.5 text-caption font-medium">
          <Table2 className="size-3.5 text-muted-foreground" />
          {selectedCell
            ? t(($) => $.bus_matrix_detail.drilldown_tables_title)
            : t(($) => $.bus_manage.tables_title)}
        </h4>
        <span className="text-micro text-muted-foreground">
          {t(($) => $.bus_manage.tables_counts, { bound: boundCount, unbound: unboundCount })}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          {(["all", "bound", "unbound", "unattributed"] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px]",
                filter === id
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-surface-border text-muted-foreground",
              )}
            >
              {id === "all"
                ? t(($) => $.bus_manage.tables_all)
                : id === "bound"
                  ? t(($) => $.bus_manage.tables_bound)
                  : id === "unbound"
                    ? t(($) => $.bus_manage.tables_unbound)
                    : t(($) => $.bus_manage.tables_unattributed)}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[10.5px] text-muted-foreground">
        {selectedCell ? t(($) => $.bus_manage.tables_selected_hint) : t(($) => $.bus_manage.tables_hint)}
      </p>
      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-surface-border px-3 py-4 text-center text-caption text-muted-foreground">
          {t(($) => $.bus_manage.no_tables)}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full border-collapse text-left text-caption">
            <thead>
              <tr className="border-b border-surface-border bg-muted/30 text-micro text-muted-foreground">
                <th className="px-2.5 py-1.5 font-medium">{t(($) => $.bus_matrix_detail.drilldown_col_table)}</th>
                <th className="px-2.5 py-1.5 font-medium">{t(($) => $.bus_matrix.domain_label)}</th>
                <th className="px-2.5 py-1.5 font-medium">{t(($) => $.bus_matrix.module_label)}</th>
                <th className="px-2.5 py-1.5 font-medium">{t(($) => $.bus_manage.table_status)}</th>
                <th className="px-2.5 py-1.5 font-medium">{t(($) => $.bus_manage.bind_to)}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <TableRow
                  key={row.name}
                  row={row}
                  modules={modules.data?.modules ?? []}
                  bindTarget={bindTarget}
                  onBindTarget={setBindTarget}
                  onBind={() => bindTable(row.name)}
                  onUnbind={() => {
                    const next = { ...layout.tableBindings };
                    delete next[row.name];
                    onChange({ ...layout, tableBindings: next });
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TableRow({
  row,
  modules,
  bindTarget,
  onBindTarget,
  onBind,
  onUnbind,
}: {
  row: MatrixTableRow;
  modules: Array<{ id: string; name: string; graph_node_id?: string | null }>;
  bindTarget: string;
  onBindTarget: (id: string) => void;
  onBind: () => void;
  onUnbind: () => void;
}) {
  const { t } = useT("archive");
  return (
    <tr className="border-b border-surface-border/60 last:border-b-0">
      <td className="px-2.5 py-1.5 font-mono text-[11px]">{row.name}</td>
      <td className="px-2.5 py-1.5 text-micro text-muted-foreground">{row.domain ?? "—"}</td>
      <td className="px-2.5 py-1.5 text-[11px]">
        {row.modules.length === 0 ? "—" : row.modules.map((module) => module.name).join(" · ")}
      </td>
      <td className="px-2.5 py-1.5">
        <Badge variant="outline" className={cn("text-[10px]", !row.bound && "text-amber-700 dark:text-amber-400")}>
          {!row.bound
            ? t(($) => $.bus_manage.table_status_unbound)
            : !row.attributed
              ? t(($) => $.bus_manage.table_status_unattributed)
              : t(($) => $.bus_manage.table_status_bound)}
        </Badge>
      </td>
      <td className="px-2.5 py-1.5">
        <div className="flex flex-wrap items-center gap-1">
          <select
            className="h-7 max-w-36 rounded-md border border-surface-border bg-surface px-1.5 text-[11px]"
            value={bindTarget}
            onChange={(event) => onBindTarget(event.target.value)}
            aria-label={t(($) => $.bus_manage.bind_to)}
          >
            <option value="">{t(($) => $.bus_manage.bind_to)}</option>
            {modules.map((module) => (
              <option key={module.id} value={module.graph_node_id ?? module.id}>
                {module.name}
              </option>
            ))}
          </select>
          <Button type="button" size="xs" variant="outline" disabled={!bindTarget} onClick={onBind}>
            {t(($) => $.bus_manage.bind)}
          </Button>
          {row.sources.includes("manual") && (
            <Button type="button" size="xs" variant="ghost" onClick={onUnbind}>
              {t(($) => $.bus_manage.unbind)}
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
