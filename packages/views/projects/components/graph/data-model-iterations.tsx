"use client";

import { useMemo, useState } from "react";
import type { DataModelV2 } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";

/**
 * 迭代视角 v2（原型 f5）：版本时间线 + 每个版本的表级变更追踪
 * （新增 / 修改 / 删除分组）。数据来自快照 data_model.versions；下方
 * 继续并列展示既有的本体变更时间线与矩阵告警。
 */

type ChangeType = "added" | "modified" | "removed";

const CHANGE_STYLE: Record<ChangeType, string> = {
  added: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  modified: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  removed: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function DataModelIterations({ dataModel }: { dataModel: DataModelV2 }) {
  const { t } = useT("archive");
  const versions = useMemo(
    () => [...dataModel.versions].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [dataModel.versions],
  );
  const [selectedScan, setSelectedScan] = useState<string>(
    dataModel.current_version || versions[versions.length - 1]?.scan_id || "",
  );
  const selected = versions.find((version) => version.scan_id === selectedScan) ?? null;

  const grouped = useMemo(() => {
    const map: Record<ChangeType, Array<{ table: string; detail?: string }>> = {
      added: [],
      modified: [],
      removed: [],
    };
    for (const change of selected?.changes ?? []) {
      map[change.change_type].push({ table: change.table, detail: change.detail });
    }
    return map;
  }, [selected]);

  if (versions.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-surface-border px-3 py-4 text-center text-micro text-muted-foreground">
        {t(($) => $.bus_v2.iter_empty)}
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-surface-border p-3">
      <h3 className="text-caption font-semibold">
        {t(($) => $.bus_v2.iter_timeline_title)}
      </h3>

      <div className="flex flex-wrap gap-2">
        {versions.map((version, index) => {
          const isCurrent = version.scan_id === dataModel.current_version;
          const isSelected = version.scan_id === selectedScan;
          const summary = version.change_summary;
          return (
            <button
              key={version.scan_id}
              type="button"
              onClick={() => setSelectedScan(version.scan_id)}
              aria-pressed={isSelected}
              className={cn(
                "min-w-36 rounded-lg border border-surface-border px-3 py-2 text-left transition-colors hover:border-primary/40",
                isSelected && "border-primary ring-1 ring-primary",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-caption font-semibold">
                  {version.label ?? version.scan_id.slice(0, 8)}
                </span>
                {isCurrent ? (
                  <span className="rounded bg-primary/10 px-1 py-0.5 text-[9px] font-semibold text-primary">
                    {t(($) => $.bus_v2.version_now)}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 font-mono text-micro text-muted-foreground">
                {version.scan_id.slice(0, 8)} · {version.created_at.slice(0, 10)}
              </div>
              {summary ? (
                <div className="mt-1 flex gap-1.5 text-[10px] tabular-nums">
                  {summary.added > 0 ? (
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {"▲"}{summary.added}
                    </span>
                  ) : null}
                  {summary.modified > 0 ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      {"◆"}{summary.modified}
                    </span>
                  ) : null}
                  {summary.removed > 0 ? (
                    <span className="text-destructive">{"✕"}{summary.removed}</span>
                  ) : null}
                  {index === 0 && summary.added === 0 && summary.modified === 0 && summary.removed === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : null}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      {selected ? (
        <div className="space-y-2">
          <h4 className="text-micro font-semibold text-muted-foreground">
            {t(($) => $.bus_v2.version_changes_title, {
              label: selected.label ?? selected.scan_id.slice(0, 8),
            })}
          </h4>
          <div className="grid gap-2 md:grid-cols-3">
            {(["added", "modified", "removed"] as const).map((type) => (
              <div
                key={type}
                className="space-y-1 rounded-md border border-surface-border p-2"
              >
                <div className="text-micro font-semibold text-muted-foreground">
                  {type === "added"
                    ? t(($) => $.bus_v2.chg_added)
                    : type === "modified"
                      ? t(($) => $.bus_v2.chg_modified)
                      : t(($) => $.bus_v2.chg_removed)}
                  <span className="ml-1 tabular-nums">{grouped[type].length}</span>
                </div>
                {grouped[type].length === 0 ? (
                  <p className="text-[10px] text-muted-foreground/50">—</p>
                ) : (
                  grouped[type].map((change) => (
                    <div
                      key={change.table}
                      className={cn(
                        "rounded border px-1.5 py-1",
                        CHANGE_STYLE[type],
                      )}
                    >
                      <div className="font-mono text-[11px] font-medium">
                        {change.table}
                      </div>
                      {change.detail ? (
                        <div className="mt-0.5 text-[10px] opacity-80">{change.detail}</div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
