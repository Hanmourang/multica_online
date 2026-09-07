"use client";

import { useMemo, useState } from "react";
import { Download, FileText } from "lucide-react";
import { toast } from "sonner";
import type { FilingItem, FilingTier, FilingTrack } from "@multica/core/types";
import {
  useExportFilingPackage,
  useWritebackFilingReadiness,
} from "@multica/core/filing/mutations";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@multica/ui/components/ui/collapsible";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { QueryError } from "../archive/query-states";

/**
 * f12 导出面板：可勾选清单（原型标注 5）+ READINESS.md 回写。
 *
 * Export gate — POST /projects/{id}/filing/export refuses the full package
 * when must items are unmet and answers export_type="diagnostic" with the
 * blocking reason. `canExport` is the server's own `can_export_filing`; this
 * component no longer recomputes it, so there is exactly one gate definition
 * (原型标注 1：不让用户带着缺件去递交).
 *
 * Checklist — the ticked items decide `artifact_ids`. Must items are locked
 * ON: unticking one would mean handing in a filing that cannot be accepted,
 * which is precisely what 标注 1 forbids, so the choice is not offered.
 * Conditional / aux items are free to untick (标注 2：辅助件齐不齐不影响能不能
 * 递交).
 *
 * The package tree the server returns stays reachable behind a collapsible —
 * it is real server output and 标注 5 wants the A/B/C layout visible, but the
 * checklist is now the primary surface instead of a wall of monospace text.
 */

/** A-必备 / B-条件必备 / C-辅助 (原型标注 5) — the checklist renders in this order. */
const TIER_RANK: Record<FilingTier, number> = {
  must: 0,
  conditional: 1,
  aux: 2,
};

type Translator = ReturnType<typeof useT<"archive">>["t"];

function tierLabel(t: Translator, tier: FilingTier): string {
  switch (tier) {
    case "must":
      return t(($) => $.filing.tier_must);
    case "conditional":
      return t(($) => $.filing.tier_conditional);
    default:
      return t(($) => $.filing.tier_aux);
  }
}

export function FilingExport({
  projectId,
  track,
  canExport,
  items,
}: {
  projectId: string;
  track: FilingTrack;
  /** Server-computed `can_export_filing` — never recomputed client-side. */
  canExport: boolean;
  items: FilingItem[];
}) {
  const { t } = useT("archive");
  const exportRun = useExportFilingPackage(projectId);
  const writeback = useWritebackFilingReadiness(projectId);

  /**
   * Opt-out set rather than opt-in: must items are absent by construction and
   * every non-must item starts ticked, so the default state needs no effect
   * syncing against `items` (which changes on every check run).
   */
  const [optOut, setOptOut] = useState<ReadonlySet<string>>(() => new Set());

  const rows = useMemo(
    () =>
      [...items].sort(
        (a, b) =>
          TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.sort_order - b.sort_order,
      ),
    [items],
  );

  const selectedRows = rows.filter(
    (item) => item.tier === "must" || !optOut.has(item.id),
  );
  const artifactIds = selectedRows.flatMap((item) =>
    item.artifact_id ? [item.artifact_id] : [],
  );

  const downgraded = exportRun.data?.export_type === "diagnostic";

  const toggle = (itemId: string, checked: boolean) => {
    setOptOut((previous) => {
      const next = new Set(previous);
      if (checked) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const runExport = () => exportRun.mutate({ track, artifact_ids: artifactIds });

  return (
    <div className="space-y-2 rounded-lg border border-surface-border bg-surface p-3">
      {/* --- 可勾选清单 ---------------------------------------------------- */}
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-caption font-medium">
            {t(($) => $.filing.export_checklist_title)}
          </span>
          <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
            {t(($) => $.filing.export_selected, {
              selected: selectedRows.length,
              total: rows.length,
            })}
          </span>
        </div>
        <ul className="mt-1.5 rounded-md border border-surface-border">
          {rows.map((item) => {
            const locked = item.tier === "must";
            const checked = locked || !optOut.has(item.id);
            const inputId = `filing-export-${item.id}`;
            return (
              <li
                key={item.id}
                className={cn(
                  "flex items-start gap-2 border-b border-surface-border px-2.5 py-1.5 last:border-b-0",
                  !checked && "opacity-55",
                )}
              >
                <Checkbox
                  id={inputId}
                  className="mt-0.5"
                  checked={checked}
                  disabled={locked}
                  onCheckedChange={(value) => toggle(item.id, value === true)}
                  aria-label={item.label}
                />
                <label
                  htmlFor={inputId}
                  className={cn(
                    "min-w-0 flex-1 text-caption leading-snug",
                    locked ? "cursor-default" : "cursor-pointer",
                  )}
                >
                  <span className="block truncate font-medium">{item.label}</span>
                  {locked && (
                    <span className="block truncate text-micro text-muted-foreground">
                      {t(($) => $.filing.export_locked)}
                    </span>
                  )}
                </label>
                <span
                  className={cn(
                    "mt-0.5 shrink-0 rounded px-1 py-0.5 text-micro",
                    item.tier === "must" && "bg-destructive/10 text-destructive",
                    item.tier === "conditional" &&
                      "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                    item.tier === "aux" && "bg-muted text-muted-foreground",
                    !item.artifact_id && "line-through opacity-70",
                  )}
                >
                  {item.artifact_id
                    ? tierLabel(t, item.tier)
                    : t(($) => $.filing.unbound)}
                </span>
              </li>
            );
          })}
        </ul>
        {rows.length > 0 && artifactIds.length === 0 && (
          <p className="mt-1.5 text-micro leading-relaxed text-destructive">
            {t(($) => $.filing.export_empty_package)}
          </p>
        )}
        <p className="mt-1.5 text-micro leading-relaxed text-muted-foreground">
          {t(($) => $.filing.export_checklist_hint)}
        </p>
      </div>

      {/* --- 导出按钮 ------------------------------------------------------ */}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!canExport || exportRun.isPending}
          onClick={runExport}
          aria-label={t(($) => $.filing.export_button)}
          className={cn(
            "flex-1",
            !canExport && "pointer-events-none opacity-45 line-through",
          )}
        >
          <Download />
          {exportRun.isPending
            ? t(($) => $.filing.exporting)
            : t(($) => $.filing.export_button)}
        </Button>
        {/* 原型标注 1: the downgrade path must stay reachable while the full
            package is greyed out, otherwise a blocked project can never export
            anything at all. */}
        {(!canExport || exportRun.isPending || downgraded) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={exportRun.isPending}
            onClick={runExport}
            aria-label={t(($) => $.filing.export_diagnostic)}
          >
            <Download />
            {t(($) => $.filing.export_diagnostic)}
          </Button>
        )}
      </div>

      {exportRun.isError && (
        <QueryError
          compact
          onRetry={runExport}
          message={
            exportRun.error instanceof Error ? exportRun.error.message : undefined
          }
        />
      )}

      {exportRun.data && (
        <div className="space-y-2 text-caption">
          {downgraded ? (
            <div
              role="status"
              className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-amber-700 dark:text-amber-400"
            >
              {t(($) => $.filing.export_downgraded)}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">
                {t(($) => $.filing.export_success, {
                  type: exportRun.data.export_type,
                })}
              </Badge>
            </div>
          )}
          {exportRun.data.reason && (
            <div>
              <div className="text-micro font-medium text-muted-foreground">
                {t(($) => $.filing.export_reason)}
              </div>
              <p className="mt-0.5 leading-relaxed">
                {exportRun.data.reason}
              </p>
            </div>
          )}
          {exportRun.data.structure && (
            <Collapsible>
              <CollapsibleTrigger className="group/tree -mx-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-micro font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground">
                {t(($) => $.filing.export_structure)}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-1 overflow-x-auto rounded-md border border-surface-border bg-card/40 px-2.5 py-2 font-mono text-micro leading-relaxed text-muted-foreground">
                  {exportRun.data.structure}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
          <p className="text-micro leading-relaxed text-muted-foreground">
            {t(($) => $.filing.export_hint)}
          </p>
        </div>
      )}

      {/* --- READINESS.md 回写 --------------------------------------------- */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-center"
        disabled={writeback.isPending}
        aria-label={t(($) => $.filing.writeback_button)}
        onClick={() =>
          writeback.mutate(undefined, {
            onSuccess: (result) => {
              toast.success(
                result.action === "created"
                  ? t(($) => $.filing.writeback_created, { path: result.rel_path })
                  : t(($) => $.filing.writeback_updated, { path: result.rel_path }),
              );
            },
            onError: () => {
              toast.error(t(($) => $.filing.writeback_failed));
            },
          })
        }
      >
        <FileText />
        {writeback.isPending
          ? t(($) => $.filing.writeback_running)
          : t(($) => $.filing.writeback_button)}
      </Button>

      {writeback.isError && (
        <QueryError
          compact
          onRetry={() => writeback.mutate()}
          message={
            writeback.error instanceof Error ? writeback.error.message : undefined
          }
        />
      )}
    </div>
  );
}
