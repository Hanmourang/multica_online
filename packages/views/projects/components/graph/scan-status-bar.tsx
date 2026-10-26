"use client";

import { Check, Hourglass, Network, Radar } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@multica/ui/lib/utils";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useWorkspaceId } from "@multica/core/hooks";
import { moduleStrategiesOptions } from "@multica/core/graph/queries";
import { useT } from "../../../i18n";
import { formatScanWhen } from "./feature-chrome";
import { useGraphData } from "./graph-data-provider";
import { QueryError } from "../archive/query-states";

/**
 * f11 数据来源常驻条（原型标注 2：scan id 与两层就绪状态常驻顶栏，
 * 不让用户把「本体未抽取」误读为「项目没数据」）。
 */
export function ScanStatusBar({
  className,
  variant = "flag",
}: {
  className?: string;
  variant?: "flag" | "card";
}) {
  const { t } = useT("archive");
  const {
    projectId,
    selectedNodeId,
    snapshot,
    snapshotLoading,
    snapshotError,
    refetchSnapshot,
  } = useGraphData();
  const wsId = useWorkspaceId();
  const strategiesQuery = useQuery({
    ...moduleStrategiesOptions(wsId, projectId, selectedNodeId ?? ""),
    enabled: Boolean(selectedNodeId),
  });
  const ontologyReady = strategiesQuery.data?.ontology_ready ?? null;

  if (snapshotLoading) {
    return (
      <div role="status" aria-busy="true">
        <Skeleton className={cn("h-7 w-72", className)} />
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
          "inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-1 text-[10.5px] text-amber-700 dark:text-amber-400",
          className,
        )}
      >
        <Radar className="size-3.5 shrink-0" />
        <span>{t(($) => $.features.graph_none)}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-muted-foreground",
        variant === "card" &&
          "rounded-lg border border-surface-border bg-surface px-3 py-2",
        variant === "flag" &&
          "rounded-lg border border-surface-border bg-surface px-2.5 py-1",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1 font-medium text-foreground">
        <Network className="size-3.5 text-primary" />
        {t(($) => $.features.scan_graph)}
      </span>
      <span className="font-mono">
        {`${t(($) => $.features.scan_label)} ${snapshot.scan_id.replace(/^demo-/, "").slice(0, 8)}`}
      </span>
      <span>·</span>
      <span>{formatScanWhen(snapshot.created_at)}</span>
      <span>·</span>
      <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
        <Check aria-hidden className="size-3" />
        {t(($) => $.features.graph_layer_ok)}
      </span>
      <span>·</span>
      <span
        className={cn(
          "inline-flex items-center gap-0.5",
          ontologyReady === "ready"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-amber-700 dark:text-amber-400",
        )}
      >
        {ontologyReady === "ready" ? (
          <Check aria-hidden className="size-3" />
        ) : (
          <Hourglass aria-hidden className="size-3" />
        )}
        {ontologyReady === "ready"
          ? t(($) => $.features.ontology_layer_ok)
          : t(($) => $.features.ontology_layer_wait)}
      </span>
    </div>
  );
}
