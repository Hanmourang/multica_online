"use client";

import { useMemo, useState } from "react";
import type {
  DataModelTable,
  DataModelTableStatus,
  DataModelV2,
  DataModelVersion,
} from "@multica/core/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { DataModelAsset360, StatusBadge } from "./data-model-asset-360";

/**
 * 数据视角 v2（原型 f4）：版本化表级资产清单。
 *
 * 版本 diff 的单一事实来源是 data_model.versions[*].changes：给定基线版本
 * 后，把基线之后到当前版本的所有 change 逐条累加（added→modified 仍记
 * added；最后被 removed 则记 removed），推出每张表在该区间的状态。旧
 * 快照没有 data_model 时由调用方回落到 v1 的 BusMatrixDataView。
 */

type EffStatus = DataModelTableStatus;

function versionLabel(version: DataModelVersion): string {
  return version.label ?? version.scan_id.slice(0, 8);
}

/** 累加基线之后的版本变更，得到每张表在区间内的最终状态与最近说明。 */
export function diffFromBase(
  dataModel: DataModelV2,
  baseScanId: string | null,
): {
  statusByTable: Map<string, EffStatus>;
  detailByTable: Map<string, string>;
  counts: Record<"added" | "modified" | "removed", number>;
} {
  const sorted = [...dataModel.versions].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const baseIndex = baseScanId
    ? sorted.findIndex((version) => version.scan_id === baseScanId)
    : -1;
  const range = baseIndex >= 0 ? sorted.slice(baseIndex + 1) : sorted;
  const statusByTable = new Map<string, EffStatus>();
  const detailByTable = new Map<string, string>();
  for (const version of range) {
    for (const change of version.changes ?? []) {
      const prev = statusByTable.get(change.table);
      // added 后再 modified 仍是「本区间新增」；其余以最新一条为准。
      if (prev === "added" && change.change_type === "modified") {
        // keep "added"
      } else {
        statusByTable.set(change.table, change.change_type);
      }
      if (change.detail) detailByTable.set(change.table, change.detail);
    }
  }
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const status of statusByTable.values()) {
    if (status !== "unchanged") counts[status] += 1;
  }
  return { statusByTable, detailByTable, counts };
}

export function DataModelAssets({
  dataModel,
  aliases,
}: {
  dataModel: DataModelV2;
  aliases: Record<string, string>;
}) {
  const { t } = useT("archive");
  const sortedVersions = useMemo(
    () => [...dataModel.versions].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [dataModel.versions],
  );
  const currentVersion =
    sortedVersions.find((version) => version.scan_id === dataModel.current_version) ??
    sortedVersions[sortedVersions.length - 1] ??
    null;
  const previousVersion = currentVersion
    ? sortedVersions[sortedVersions.indexOf(currentVersion) - 1]
    : undefined;

  const [baseScanId, setBaseScanId] = useState<string | null>(
    previousVersion?.scan_id ?? null,
  );
  const [changedOnly, setChangedOnly] = useState(false);
  const [selected, setSelected] = useState<DataModelTable | null>(null);

  const { statusByTable, detailByTable, counts } = useMemo(
    () => diffFromBase(dataModel, baseScanId),
    [dataModel, baseScanId],
  );

  const rows = useMemo(() => {
    const mapped = dataModel.tables.map((table) => ({
      table,
      status: statusByTable.get(table.name) ?? ("unchanged" as EffStatus),
      detail: detailByTable.get(table.name),
    }));
    const filtered = changedOnly
      ? mapped.filter((row) => row.status !== "unchanged")
      : mapped;
    const weight: Record<EffStatus, number> = {
      removed: 0,
      added: 1,
      modified: 2,
      unchanged: 3,
    };
    return [...filtered].sort(
      (a, b) => weight[a.status] - weight[b.status] || a.table.name.localeCompare(b.table.name),
    );
  }, [changedOnly, dataModel.tables, detailByTable, statusByTable]);

  const unchangedCount = dataModel.tables.length - rows.filter((r) => r.status !== "unchanged").length;

  const baseItems = sortedVersions
    .filter((version) => version.scan_id !== currentVersion?.scan_id)
    .map((version) => ({
      value: version.scan_id,
      label: `${versionLabel(version)} · ${version.created_at.slice(0, 10)}`,
    }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {currentVersion ? (
          <span className="rounded-md border border-primary/20 bg-primary/5 px-2 py-1 font-mono text-micro text-primary">
            {t(($) => $.bus_v2.version_label)} {versionLabel(currentVersion)} ·{" "}
            {t(($) => $.bus_v2.version_now)}
          </span>
        ) : null}
        {baseItems.length > 0 ? (
          <Select
            items={baseItems}
            value={baseScanId}
            onValueChange={(value) => setBaseScanId(value ?? null)}
          >
            <SelectTrigger
              className="h-8 w-56 text-caption"
              aria-label={t(($) => $.bus_v2.version_base)}
            >
              <SelectValue placeholder={t(($) => $.bus_v2.version_base)} />
            </SelectTrigger>
            <SelectContent>
              {baseItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <span className="rounded-md border border-surface-border px-2 py-1 text-micro text-muted-foreground">
          {t(($) => $.bus_v2.diff_stat, {
            added: counts.added,
            modified: counts.modified,
            removed: counts.removed,
            unchanged: unchangedCount,
          })}
        </span>
        <Button
          size="xs"
          variant={changedOnly ? "default" : "outline"}
          onClick={() => setChangedOnly((value) => !value)}
        >
          {t(($) => $.bus_v2.filter_changed)}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full min-w-[720px] border-collapse text-caption">
          <thead>
            <tr className="border-b border-surface-border bg-card/40 text-left text-micro text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">
                {t(($) => $.bus_v2.data_col_table)}
              </th>
              <th scope="col" className="w-24 px-3 py-2 font-medium">
                {t(($) => $.bus_matrix.domain_label)}
              </th>
              <th scope="col" className="w-24 px-3 py-2 font-medium">
                {t(($) => $.bus_v2.col_status)}
              </th>
              <th scope="col" className="w-28 px-3 py-2 font-medium">
                {t(($) => $.bus_v2.data_col_columns)}
              </th>
              <th scope="col" className="w-28 px-3 py-2 font-medium">
                {t(($) => $.bus_v2.col_refs)}
              </th>
              <th scope="col" className="w-20 px-3 py-2 font-medium">
                {t(($) => $.bus_v2.data_col_migration)}
              </th>
              <th scope="col" className="w-16 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ table, status, detail }) => (
              <tr
                key={table.name}
                className={cn(
                  "border-b border-surface-border last:border-b-0",
                  status === "removed" && "opacity-60",
                )}
              >
                <td className="px-3 py-2">
                  <div className="font-mono text-[12px] font-medium">{table.name}</div>
                  {detail ? (
                    <div className="mt-0.5 text-micro text-muted-foreground">{detail}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-micro">
                  {aliases[table.domain] ?? table.domain}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={status} />
                </td>
                <td className="px-3 py-2 text-micro tabular-nums">
                  {table.columns.length}
                  {table.column_diffs &&
                  (table.column_diffs.added.length > 0 ||
                    table.column_diffs.removed.length > 0 ||
                    table.column_diffs.type_changed.length > 0) ? (
                    <span className="ml-1 text-muted-foreground">
                      {table.column_diffs.added.length > 0
                        ? `+${table.column_diffs.added.length} `
                        : ""}
                      {table.column_diffs.removed.length > 0
                        ? `-${table.column_diffs.removed.length} `
                        : ""}
                      {table.column_diffs.type_changed.length > 0
                        ? `~${table.column_diffs.type_changed.length}`
                        : ""}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-micro text-muted-foreground">
                  {table.consumers.length > 0
                    ? t(($) => $.bus_v2.refs_n, { n: table.consumers.length })
                    : t(($) => $.bus_v2.refs_none)}
                </td>
                <td className="px-3 py-2 font-mono text-micro text-muted-foreground">
                  {table.migration ? `#${table.migration}` : "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setSelected(table)}
                  >
                    {t(($) => $.bus_v2.open_360)}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DataModelAsset360
        table={selected}
        open={selected !== null}
        onOpenChange={(next) => !next && setSelected(null)}
      />
    </div>
  );
}
