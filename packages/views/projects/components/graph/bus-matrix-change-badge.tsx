"use client";

import type { OntologyChangeType } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";

export function ChangeBadge({ type }: { type?: OntologyChangeType }) {
  const { t } = useT("archive");
  if (!type) return null;
  const label =
    type === "added"
      ? t(($) => $.bus_v2.chg_added)
      : type === "removed"
        ? t(($) => $.bus_v2.chg_removed)
        : type === "modified"
          ? t(($) => $.bus_v2.chg_modified)
          : t(($) => $.bus_v2.chg_same);
  return (
    <span
      className={cn(
        "rounded px-1 py-0.5 text-[10px] font-semibold",
        type === "added" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
        type === "modified" && "bg-blue-500/15 text-blue-700 dark:text-blue-400",
        type === "removed" && "bg-destructive/10 text-destructive",
        type === "status_change" && "text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}
