"use client";

import type { DataModelTable, DataModelTableStatus } from "@multica/core/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";

/**
 * 资产 360°（数据模型 v2，原型 f6）：一张表的版本状态、消费绑定（模块 ×
 * 页面 × 业务过程）、列级 diff 与前后端调用链。数据全部来自快照
 * data_model 投影，没有投递的段落诚实降级为空态文案。
 *
 * 与 v1 的 BusMatrixAsset360（由 drilldown source_cells 驱动）并存：
 * 数据视角在 data_model v2 就绪时换用本组件。
 */

const STATUS_STYLE: Record<DataModelTableStatus, string> = {
  added: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  modified: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  removed: "bg-destructive/15 text-destructive",
  unchanged: "bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { status: DataModelTableStatus }) {
  const { t } = useT("archive");
  const label = {
    added: t(($) => $.bus_v2.status_added),
    modified: t(($) => $.bus_v2.status_modified),
    removed: t(($) => $.bus_v2.status_removed),
    unchanged: t(($) => $.bus_v2.status_unchanged),
  }[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold",
        STATUS_STYLE[status],
      )}
    >
      {label}
    </span>
  );
}

function RwBadge({ rw }: { rw: "R" | "W" | "RW" }) {
  return (
    <span
      className={cn(
        "rounded border px-1 py-0.5 text-[10px] font-bold",
        rw === "R" && "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
        rw === "W" && "border-amber-500/40 text-amber-700 dark:text-amber-400",
        rw === "RW" && "border-primary/40 text-primary",
      )}
    >
      {rw}
    </span>
  );
}

export function DataModelAsset360({
  table,
  open,
  onOpenChange,
}: {
  table: DataModelTable | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("archive");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" data-testid="data-model-asset-360">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t(($) => $.bus_v2.asset_360_title)}
            {table ? <StatusBadge status={table.status} /> : null}
          </DialogTitle>
          {table ? (
            <p className="font-mono text-caption text-muted-foreground">
              {table.name}
              <span className="ml-2 font-sans text-micro">
                {table.domain}
                {table.migration ? ` · #${table.migration}` : ""}
              </span>
            </p>
          ) : null}
        </DialogHeader>

        {!table ? null : (
          <div className="space-y-4 text-caption">
            <section className="space-y-1.5">
              <h4 className="text-micro font-semibold text-muted-foreground">
                {t(($) => $.bus_v2.a360_consumers, { n: table.consumers.length })}
              </h4>
              {table.consumers.length === 0 ? (
                <p className="text-micro text-muted-foreground">
                  {t(($) => $.bus_v2.a360_no_consumers)}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {table.consumers.map((consumer, index) => (
                    <span
                      key={`${consumer.module_node_id}:${consumer.page_key}:${consumer.process_key ?? ""}:${index}`}
                      className="inline-flex items-center gap-1.5 rounded-md border border-surface-border px-2 py-1"
                    >
                      <span className="text-[11px]">
                        {consumer.module_name} / {consumer.page_name}
                        {consumer.process_name ? ` · ${consumer.process_name}` : ""}
                      </span>
                      <RwBadge rw={consumer.rw} />
                    </span>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-1.5">
              <h4 className="text-micro font-semibold text-muted-foreground">
                {t(($) => $.bus_v2.a360_columns, { n: table.columns.length })}
              </h4>
              <div className="flex flex-wrap gap-1">
                {table.columns.map((column) => {
                  const diff = table.column_diffs;
                  const isAdded = diff?.added.includes(column.name) ?? false;
                  const typeChange = diff?.type_changed.find((item) => item.name === column.name);
                  return (
                    <span
                      key={column.name}
                      className={cn(
                        "rounded border border-surface-border px-1.5 py-0.5 font-mono text-[10px]",
                        isAdded && "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                        typeChange && "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
                      )}
                      title={
                        typeChange
                          ? `${typeChange.from} → ${typeChange.to}`
                          : column.type
                      }
                    >
                      {column.name}
                      {column.type ? (
                        <span className="ml-1 text-muted-foreground">
                          {typeChange ? `${typeChange.from}→${typeChange.to}` : column.type}
                        </span>
                      ) : null}
                    </span>
                  );
                })}
                {(table.column_diffs?.removed ?? []).map((name) => (
                  <span
                    key={`removed-${name}`}
                    className="rounded border border-destructive/40 px-1.5 py-0.5 font-mono text-[10px] text-destructive line-through"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </section>

            <section className="space-y-1.5">
              <h4 className="text-micro font-semibold text-muted-foreground">
                {t(($) => $.bus_v2.asset_chain)}
              </h4>
              {!table.call_chain || table.call_chain.length === 0 ? (
                <p className="text-micro text-muted-foreground">
                  {t(($) => $.bus_v2.chain_empty)}
                </p>
              ) : (
                table.call_chain.map((chain, chainIndex) => (
                  <div
                    key={chainIndex}
                    className="space-y-1 rounded-md border border-surface-border p-2"
                  >
                    {(
                      [
                        [t(($) => $.bus_v2.a360_chain_fe), chain.frontend],
                        [t(($) => $.bus_v2.a360_chain_api), chain.api],
                        [t(($) => $.bus_v2.a360_chain_service), chain.service],
                        [t(($) => $.bus_v2.a360_chain_table), [table.name]],
                      ] as Array<[string, string[]]>
                    ).map(([label, hops]) => (
                      <div key={label} className="flex items-start gap-2">
                        <span className="w-14 shrink-0 pt-0.5 text-right text-[10px] font-medium text-muted-foreground">
                          {label}
                        </span>
                        <div className="flex min-w-0 flex-wrap items-center gap-1">
                          {hops.length === 0 ? (
                            <span className="text-[10px] text-muted-foreground/50">—</span>
                          ) : (
                            hops.map((hop, hopIndex) => (
                              <span key={hopIndex} className="flex items-center gap-1">
                                {hopIndex > 0 ? (
                                  <span className="text-muted-foreground/40">→</span>
                                ) : null}
                                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                                  {hop}
                                </span>
                              </span>
                            ))
                          )}
                        </div>
                      </div>
                    ))}
                    {(chain.risks ?? []).length > 0 ? (
                      <div className="border-t border-dashed border-surface-border pt-1.5">
                        <span className="text-[10px] font-medium text-destructive">
                          {t(($) => $.bus_v2.a360_risks)}
                        </span>
                        <ul className="mt-0.5 list-inside list-disc text-[10px] text-muted-foreground">
                          {(chain.risks ?? []).map((risk, riskIndex) => (
                            <li key={riskIndex}>{risk}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
