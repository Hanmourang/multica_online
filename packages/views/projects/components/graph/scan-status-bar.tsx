"use client";

import { Check, Hourglass, Network, Radar } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import { QueryError, formatTimestamp } from "../archive/query-states";

/**
 * f10/f11 数据来源常驻条（原型标注 2：scan id 与两层就绪状态常驻顶栏，
 * 不让用户把「本体未抽取」误读为「项目没数据」）。
 *
 * Graph-layer readiness derives from the snapshot itself; ontology readiness
 * comes from the selected module's strategies query (shared key → one
 * request) and shows the degraded label until a module is selected. A null
 * snapshot means the project was never scanned — rendered as its own honest
 * empty state, never as an error.
 */
export function ScanStatusBar({ className }: { className?: string }) {
  const { t } = useT("archive");
  const {
    snapshot,
    snapshotLoading,
    snapshotError,
    refetchSnapshot,
    ontologyReady,
  } = useGraphData();

  if (snapshotLoading) {
    return (
      <div role="status" aria-busy="true">
        <Skeleton className={cn("h-9 w-full max-w-xl", className)} />
      </div>
    );
  }

  if (snapshotError) {
    return <QueryError compact onRetry={refetchSnapshot} />;
  }

  if (!snapshot) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-caption text-amber-700 dark:text-amber-400",
          className,
        )}
      >
        <Radar className="size-4 shrink-0" />
        <span>{t(($) => $.features.graph_none)}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-surface-border bg-surface px-3 py-2 text-caption text-muted-foreground",
        className,
      )}
    >
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <Network className="size-3.5 text-primary" />
        {t(($) => $.features.scan_status)}
      </span>
      <span className="font-mono text-[11px]">
        {t(($) => $.sync.scan_id)} {snapshot.scan_id.slice(0, 8)}
      </span>
      <span className="font-mono text-[11px]">
        {t(($) => $.sync.git_sha)} {snapshot.git_sha.slice(0, 8)}
      </span>
      <span>{formatTimestamp(snapshot.created_at)}</span>
      <span className="flex items-center gap-1 text-emerald-500">
        <Check aria-hidden className="size-3" />
        {t(($) => $.features.graph_ready)}
      </span>
      <span
        className={cn(
          "flex items-center gap-1",
          ontologyReady === "ready"
            ? "text-emerald-500"
            : "text-amber-600 dark:text-amber-400",
        )}
      >
        {ontologyReady === "ready" ? (
          <Check aria-hidden className="size-3" />
        ) : (
          <Hourglass aria-hidden className="size-3" />
        )}
        {t(($) => $.features.ontology_label)}
        {ontologyReady === "ready"
          ? t(($) => $.features.ontology_ready)
          : t(($) => $.features.ontology_empty)}
      </span>
    </div>
  );
}
