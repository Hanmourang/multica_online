import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, PackageOpen } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import { useT } from "../../i18n";
import { buildTimeline } from "../task-transcript/build-timeline";
import { buildSteps } from "../task-transcript/build-steps";
import { buildDeliverables, type Deliverable } from "./build-deliverables";
import { DeliverablePreviewDialog } from "./deliverable-preview-dialog";

/**
 * A run's final deliverables as a card wall, pinned to the task_completed
 * activity entry in an issue timeline. Reads the run's transcript through the
 * shared `taskMessages` query cache — the same cache the live chat view and
 * transcript button observe — so reopening a wall (or reading a task that is
 * still streaming in) costs no extra request and sees realtime frames.
 *
 * Renders nothing while loading (the wall popping in under a collapsed
 * activity block is better than a skeleton that mostly flashes by) and
 * nothing at all when the run produced no deliverables; a failed load leaves
 * a small inline error with retry rather than breaking the timeline.
 */
export function DeliverablesSection({
  taskId,
  replyText,
}: {
  taskId: string;
  replyText?: string | null;
}) {
  const { t } = useT("issues");
  const query = useQuery(taskMessagesOptions(taskId));
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const items = useMemo<Deliverable[] | null | undefined>(
    () =>
      query.data === undefined
        ? undefined
        : buildDeliverables(buildSteps(buildTimeline(query.data)), replyText),
    [query.data, replyText],
  );

  if (query.isError) {
    return (
      <div
        data-testid="deliverables-error"
        className="px-4 pb-3 text-caption text-muted-foreground max-md:px-3"
      >
        {t(($) => $.deliverables.load_error)}
        <button
          type="button"
          className="ml-2 underline underline-offset-2 hover:text-foreground"
          onClick={() => void query.refetch()}
        >
          {t(($) => $.deliverables.retry)}
        </button>
      </div>
    );
  }
  if (!items) return null;
  let added = 0;
  let removed = 0;
  let written = 0;
  let referenced = 0;
  for (const d of items) {
    added += d.addedLines;
    removed += d.removedLines;
    if (d.source === "reply") referenced += 1;
    else written += 1;
  }

  return (
    <div data-testid="deliverables-section" className="px-4 pb-3 max-md:px-3">
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
          <PackageOpen className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-caption font-medium">
            {t(($) => $.deliverables.section_title)}
          </span>
          <span className="rounded-full border px-1.5 text-micro tabular-nums text-muted-foreground">
            {items.length}
          </span>
          <span className="ml-auto font-mono text-micro tabular-nums text-muted-foreground">
            {added > 0 && <span className="text-success">+{added}</span>}{" "}
            {removed > 0 && <span className="text-destructive">−{removed}</span>}
            {" · "}
            {t(($) => $.deliverables.stats_written, { count: written })}
            {referenced > 0 && (
              <>
                {" · "}
                {t(($) => $.deliverables.stats_referenced, { count: referenced })}
              </>
            )}
          </span>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 p-2.5">
          {items.map((d, i) => (
            <Tooltip key={d.path}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => setPreviewIndex(i)}
                    className="rounded-md border px-2.5 py-2 text-left transition-colors hover:border-primary/60 hover:bg-accent/40"
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate text-caption font-medium">{d.name}</span>
                    </div>
                    <div
                      className="mt-0.5 truncate font-mono text-micro text-muted-foreground"
                      title={d.path}
                    >
                      {d.path}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      {d.source === "reply" ? (
                        <span className="rounded bg-amber-500/10 px-1 text-micro text-amber-600 dark:text-amber-400">
                          {t(($) => $.deliverables.badge_reference)}
                        </span>
                      ) : d.kind === "added" ? (
                        <span className="rounded bg-success/10 px-1 text-micro text-success">
                          {t(($) => $.deliverables.badge_added)}
                        </span>
                      ) : (
                        <span className="rounded bg-info/10 px-1 text-micro text-info">
                          {t(($) => $.deliverables.badge_modified)}
                        </span>
                      )}
                      <span className="ml-auto font-mono text-micro tabular-nums">
                        {d.addedLines > 0 && <span className="text-success">+{d.addedLines}</span>}
                        {d.removedLines > 0 && <span className="text-destructive"> −{d.removedLines}</span>}
                      </span>
                    </div>
                  </button>
                }
              />
              <TooltipContent>{t(($) => $.deliverables.open_hint)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
      {previewIndex !== null && (
        <DeliverablePreviewDialog
          deliverables={items}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </div>
  );
}
