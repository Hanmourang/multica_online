"use client";

import { useState } from "react";
import { LayoutGrid, List, RefreshCw, Share2 } from "lucide-react";
import { toast } from "sonner";
import { useRebridgeGraphSnapshot } from "@multica/core/graph/mutations";
import { Button } from "@multica/ui/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import { ScanStatusBar } from "./scan-status-bar";
import { ModuleListPanel } from "./module-list-panel";
import { ModuleDetailPanel } from "./module-detail-panel";

/**
 * f10 产品功能 Tab 顶层（项目详情新视图）。
 *
 * Left column: module list bridged to graph communities (product lens —
 * what the product can do, not where the code lives). Right column: the
 * four module facets as switchable sub-tabs.
 *
 * No GraphDataProvider here: the shared provider is lifted to
 * `project-archive-views.tsx` (GraphViewStack), which wraps f10 and f11 数据
 * 模型 together so both tabs read/write the *same* context. That keeps
 * `selectedNodeId` / `selectedCell` alive across the tab switch and still
 * issues exactly one snapshot request (single provider + React Query
 * dedupe). Mounting this tab outside that stack throws from `useGraphData`.
 */
export function ProductFeaturesTab() {
  return (
    <div className="space-y-3">
      <ProductFeaturesToolbar />
      <ScanStatusBar />
      <div className="grid items-start gap-3 lg:grid-cols-[296px_minmax(0,1fr)]">
        <ModuleListPanel />
        <ModuleDetailPanel />
      </div>
    </div>
  );
}

/** The f10 toolbar's view modes (原型 seg：模块列表 / 图谱视图 / 表格). */
type FeatureViewMode = "modules" | "graph" | "table";

/**
 * f10 工具栏（原型 ar-toolbar 行）：视图切换 seg + 「重算模块匹配」。
 *
 * View switch: only 「模块列表」 is implemented — 图谱视图 / 表格 are
 * disabled with a "coming soon" tooltip and render nothing fake. The
 * selection is local state; there is deliberately no second view to drive.
 *
 * Recompute module match (task 27 — bridge-only, no re-upload): the button
 * calls useRebridgeGraphSnapshot → POST /graph/rebridge. The server re-runs
 * the module ↔ community bridge against the latest snapshot it reads straight
 * from the DB, so NOTHING is uploaded (the old read-back-and-re-post of the
 * 9–20 MiB graph body is gone, and with it the read-back race). A real
 * filesystem rescan is still a CLI/gitnexus job — the label/tooltip say so
 * honestly. The toast reports the server's matched/updated counts. Disabled
 * without a snapshot: rebridge would just 404 (an honest empty state), so the
 * button is greyed out with the rescan_none tooltip instead.
 */
function ProductFeaturesToolbar() {
  const { t } = useT("archive");
  const { projectId, snapshot } = useGraphData();
  const [viewMode, setViewMode] = useState<FeatureViewMode>("modules");
  const rebridge = useRebridgeGraphSnapshot(projectId);

  const handleRebridge = () => {
    rebridge.mutate(undefined, {
      onSuccess: (result) => {
        // RebridgeGraphResponse carries the bridge stats directly (typed), so
        // no local widening is needed — these counts are the server's honest
        // match result, never fabricated.
        toast.success(
          t(($) => $.features.rescan_result, {
            matched: result.matched_modules,
            updated: result.updated_modules,
          }),
        );
      },
      onError: (error) => {
        // No read-back race on this path, so there is no GraphSnapshotChanged
        // branch; a failure here is a real error (e.g. the snapshot vanished
        // mid-flight → 404) and is surfaced as-is.
        toast.error(String(error));
      },
    });
  };

  const viewOptions: {
    id: FeatureViewMode;
    label: string;
    icon: typeof List;
    enabled: boolean;
  }[] = [
    { id: "modules", label: t(($) => $.features.view_modules), icon: List, enabled: true },
    { id: "graph", label: t(($) => $.features.view_graph), icon: Share2, enabled: false },
    { id: "table", label: t(($) => $.features.view_table), icon: LayoutGrid, enabled: false },
  ];

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="product-features-toolbar"
    >
      <div
        role="group"
        aria-label={t(($) => $.features.view_mode)}
        className="flex items-center gap-0.5 rounded-lg border border-surface-border bg-surface p-0.5"
      >
        {viewOptions.map((option) => {
          const button = (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={!option.enabled}
              aria-pressed={viewMode === option.id}
              className={cn(
                viewMode === option.id &&
                  "bg-surface-selected text-foreground shadow-none",
              )}
              onClick={() => {
                if (option.enabled) setViewMode(option.id);
              }}
            >
              <option.icon aria-hidden />
              {option.label}
            </Button>
          );
          if (option.enabled) return <span key={option.id}>{button}</span>;
          return (
            <Tooltip key={option.id}>
              <TooltipTrigger render={button} />
              <TooltipContent side="bottom">
                {t(($) => $.features.view_coming_soon)}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {rebridge.isError && (
          <span className="text-caption text-destructive">
            {String(rebridge.error)}
          </span>
        )}
        {/* Bridge-only endpoint (task 27): the server re-runs the module match
            against the stored snapshot, so this button no longer re-uploads the
            9–20 MiB nodes/edges body. The old re-upload + proxy-413 concern is
            resolved; graph/sync now also carries a 64 MiB cap for the CLI. */}
        {snapshot ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={handleRebridge}
                  disabled={rebridge.isPending}
                  aria-label={t(($) => $.features.rescan_label)}
                >
                  <RefreshCw
                    className={rebridge.isPending ? "animate-spin" : undefined}
                  />
                  {rebridge.isPending
                    ? t(($) => $.features.rescan_label_pending)
                    : t(($) => $.features.rescan_label)}
                </Button>
              }
            />
            <TooltipContent side="bottom">
              {t(($) => $.features.rescan_tooltip)}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled
                  aria-label={t(($) => $.features.rescan_label)}
                >
                  <RefreshCw />
                  {t(($) => $.features.rescan_label)}
                </Button>
              }
            />
            <TooltipContent side="bottom">
              {t(($) => $.features.rescan_none)}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
