"use client";

import { useMemo } from "react";
import type { BusMatrixTableDetail, OntologyChangeType } from "@multica/core/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../../../i18n";
import type { MatrixTableRow } from "./bus-matrix-tables";
import { ChangeBadge } from "./bus-matrix-change-badge";

export function BusMatrixAsset360({
  row,
  detail,
  changeType,
  aliases,
  open,
  onOpenChange,
}: {
  row: MatrixTableRow | null;
  detail?: BusMatrixTableDetail;
  changeType?: OntologyChangeType;
  aliases: Record<string, string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("archive");
  const pages = useMemo(() => {
    const locators = detail?.source_cells ?? [];
    return locators
      .map((locator) => {
        const parts = locator.split(":");
        if (parts.length < 3) return null;
        return { moduleId: parts[0], pageKey: parts[1], domain: parts.slice(2).join(":") };
      })
      .filter((item): item is { moduleId: string; pageKey: string; domain: string } => Boolean(item));
  }, [detail?.source_cells]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="bus-matrix-asset-360">
        <DialogHeader>
          <DialogTitle>{t(($) => $.bus_v2.asset_360_title)}</DialogTitle>
        </DialogHeader>
        {row ? (
          <div className="space-y-3 text-caption">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[13px] font-semibold">{row.name}</span>
              <ChangeBadge type={changeType} />
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-micro">
              <dt className="text-muted-foreground">{t(($) => $.bus_matrix.domain_label)}</dt>
              <dd>{aliases[row.domain ?? ""] ?? row.domain ?? "—"}</dd>
              <dt className="text-muted-foreground">{t(($) => $.bus_matrix.read_short)}</dt>
              <dd className="tabular-nums">
                {t(($) => $.bus_matrix.read_write, {
                  read: row.read ?? detail?.read_count ?? 0,
                  write: row.write ?? detail?.write_count ?? 0,
                })}
              </dd>
              <dt className="text-muted-foreground">{t(($) => $.bus_matrix.module_label)}</dt>
              <dd>
                {row.modules.length === 0
                  ? t(($) => $.bus_v2.refs_none)
                  : row.modules.map((module) => module.name).join(" · ")}
              </dd>
            </dl>
            <section className="space-y-1">
              <h4 className="text-micro font-semibold text-muted-foreground">
                {t(($) => $.bus_v2.asset_pages, { n: pages.length })}
              </h4>
              {pages.length === 0 ? (
                <p className="text-micro text-muted-foreground">{t(($) => $.bus_v2.asset_pages_pending)}</p>
              ) : (
                <ul className="space-y-1">
                  {pages.map((page) => (
                    <li key={`${page.moduleId}:${page.pageKey}:${page.domain}`} className="font-mono text-[11px]">
                      {page.pageKey}
                      <span className="ml-2 text-muted-foreground">
                        {aliases[page.domain] ?? page.domain}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="space-y-1">
              <h4 className="text-micro font-semibold text-muted-foreground">
                {t(($) => $.bus_v2.asset_chain)}
              </h4>
              <p className="text-micro text-muted-foreground">{t(($) => $.bus_v2.asset_chain_pending)}</p>
            </section>
            {(detail?.columns.length ?? 0) > 0 ? (
              <section className="space-y-1">
                <h4 className="text-micro font-semibold text-muted-foreground">
                  {t(($) => $.bus_matrix_detail.drilldown_col_columns)}
                </h4>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {detail?.columns.map((column) => column.name).join(" / ")}
                </p>
              </section>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
