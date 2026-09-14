"use client";

import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import type { ActivityFilterKey, ActivityTimeWindow } from "./issue-detail-tab";

const FILTERS: ActivityFilterKey[] = ["comment", "status", "artifact", "system"];
const WINDOWS: ActivityTimeWindow[] = ["today", "7days", "all"];

export function ActivityStreamFilters({
  selected,
  onToggle,
  timeWindow,
  onTimeWindow,
}: {
  selected: ReadonlySet<ActivityFilterKey>;
  onToggle: (key: ActivityFilterKey) => void;
  timeWindow: ActivityTimeWindow;
  onTimeWindow: (window: ActivityTimeWindow) => void;
}) {
  const { t } = useT("issues");

  return (
    <div
      data-testid="activity-stream-filters"
      className="mb-2 mt-2 flex flex-wrap items-center gap-1.5"
    >
      {FILTERS.map((key) => {
        const on = selected.has(key);
        return (
          <button
            key={key}
            type="button"
            data-filter={key}
            aria-pressed={on}
            onClick={() => onToggle(key)}
            className={cn(
              "h-6 rounded-full border px-2.5 text-caption transition-colors",
              on
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {key === "comment" && t(($) => $.detail.filter_comment)}
            {key === "status" && t(($) => $.detail.filter_status)}
            {key === "artifact" && t(($) => $.detail.filter_artifact)}
            {key === "system" && t(($) => $.detail.filter_system)}
          </button>
        );
      })}
      <span className="ml-auto flex items-center gap-2 text-caption text-muted-foreground">
        {WINDOWS.map((window) => (
          <button
            key={window}
            type="button"
            data-window={window}
            onClick={() => onTimeWindow(window)}
            className={cn(
              "transition-colors hover:text-foreground",
              timeWindow === window && "font-semibold text-foreground",
            )}
          >
            {window === "today" && t(($) => $.detail.time_today)}
            {window === "7days" && t(($) => $.detail.time_7days)}
            {window === "all" && t(($) => $.detail.time_all)}
          </button>
        ))}
      </span>
    </div>
  );
}
