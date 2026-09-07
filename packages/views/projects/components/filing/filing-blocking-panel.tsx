"use client";

import type { FilingBlockingItem, FilingPriority } from "@multica/core/types";
import { AlertTriangle, Ban, ShieldAlert } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";

type Translator = ReturnType<typeof useT<"archive">>["t"];

/**
 * anno③: 阻塞项优先级面板 (P0/P1/P2).
 *
 * Priority semantics derived from the prototype (f12 :3385-3390):
 * - P0: must-tier + no artifact bound — complete absence, hardest blocker.
 *   The filing cannot proceed at all until material is produced.
 * - P1: must-tier + artifact bound but rule evaluation failed or pending —
 *   material exists but does not conform (e.g. page count < 60, heading
 *   sequence broken, version mismatch). Needs correction, not creation.
 * - P2: conditional/aux item missing or rule-failed — does not block
 *   acceptance (标注 2: 辅助件齐不齐不影响能不能递交) but degrades package
 *   completeness.
 */

function priorityIcon(priority: FilingPriority) {
  switch (priority) {
    case "P0":
      return <Ban aria-hidden className="size-4 text-destructive" />;
    case "P1":
      return <ShieldAlert aria-hidden className="size-4 text-amber-500" />;
    case "P2":
      return <AlertTriangle aria-hidden className="size-4 text-muted-foreground" />;
    default:
      return null;
  }
}

function priorityLabel(t: Translator, priority: FilingPriority): string {
  switch (priority) {
    case "P0":
      return t(($) => $.filing.priority_p0);
    case "P1":
      return t(($) => $.filing.priority_p1);
    case "P2":
      return t(($) => $.filing.priority_p2);
    default:
      return "";
  }
}

function priorityColor(priority: FilingPriority): string {
  switch (priority) {
    case "P0":
      return "border-destructive/40 bg-destructive/5";
    case "P1":
      return "border-amber-500/40 bg-amber-500/5";
    case "P2":
      return "border-muted bg-muted/30";
    default:
      return "border-surface-border";
  }
}

export function FilingBlockingPanel({
  items,
}: {
  items: FilingBlockingItem[];
}) {
  const { t } = useT("archive");

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
        <span className="text-caption font-medium text-emerald-700 dark:text-emerald-400">
          {t(($) => $.filing.no_blocking_items)}
        </span>
      </div>
    );
  }

  // Group by priority.
  const groups: Record<string, FilingBlockingItem[]> = { P0: [], P1: [], P2: [] };
  for (const item of items) {
    const key = item.priority || "P2";
    groups[key]?.push(item);
  }

  return (
    <div className="space-y-2 rounded-lg border border-surface-border bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-caption font-medium">
          {t(($) => $.filing.blocking_panel_title)}
        </span>
        <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
          {t(($) => $.filing.blocking_panel_count, { count: items.length })}
        </span>
      </div>

      {(["P0", "P1", "P2"] as const).map((priority) => {
        const group = groups[priority];
        if (!group || group.length === 0) return null;
        return (
          <div key={priority}>
            <div className="mb-1 flex items-center gap-1.5">
              {priorityIcon(priority)}
              <span
                className={cn(
                  "text-micro font-semibold",
                  priority === "P0" && "text-destructive",
                  priority === "P1" && "text-amber-600 dark:text-amber-400",
                  priority === "P2" && "text-muted-foreground",
                )}
              >
                {priority} · {priorityLabel(t, priority)}
              </span>
              <span className="ml-auto text-micro tabular-nums text-muted-foreground">
                {group.length}
              </span>
            </div>
            <ul className="space-y-1">
              {group.map((item) => (
                <li
                  key={item.item_id}
                  className={cn(
                    "rounded-md border px-2.5 py-1.5",
                    priorityColor(priority),
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-caption font-medium">{item.label}</span>
                    <span className="shrink-0 text-micro text-muted-foreground">
                      {item.status}
                    </span>
                  </div>
                  <p className="mt-0.5 text-micro leading-relaxed text-muted-foreground">
                    {item.reason}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
