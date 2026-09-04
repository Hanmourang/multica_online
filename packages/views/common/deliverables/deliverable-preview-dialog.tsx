import { useEffect } from "react";
import { ChevronLeft, ChevronRight, FileText, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@multica/ui/components/ui/dialog";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { RichContent } from "../../rich-content";
import { previewContent, type Deliverable } from "./build-deliverables";

/**
 * Quick preview for one deliverable out of a run's wall. Full-text files
 * render as markdown; edit-only files render the accumulated diff fragment;
 * reply-declared files carry no content and get an explanatory note instead.
 * Left/right keys and the header chevrons move between deliverables without
 * leaving the dialog.
 */
export function DeliverablePreviewDialog({
  deliverables,
  index,
  onIndexChange,
  onClose,
}: {
  deliverables: Deliverable[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
}) {
  const { t } = useT("issues");
  const d = deliverables[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      else if (e.key === "ArrowRight" && index < deliverables.length - 1) onIndexChange(index + 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, deliverables.length, onIndexChange, onClose]);

  if (!d) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{d.name}</DialogTitle>
        <div className="flex shrink-0 items-center gap-3 border-b bg-muted/40 px-4 py-2.5">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-caption font-medium">{d.name}</div>
            <div className="truncate font-mono text-micro text-muted-foreground">{d.path}</div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              data-testid="deliverable-prev"
              aria-label={t(($) => $.deliverables.prev)}
              disabled={index === 0}
              onClick={() => onIndexChange(index - 1)}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <span className="px-1 font-mono text-micro tabular-nums text-muted-foreground">
              {index + 1}/{deliverables.length}
            </span>
            <button
              type="button"
              data-testid="deliverable-next"
              aria-label={t(($) => $.deliverables.next)}
              disabled={index === deliverables.length - 1}
              onClick={() => onIndexChange(index + 1)}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t(($) => $.deliverables.close)}
              onClick={onClose}
              className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          {d.source === "reply" ? (
            <div
              data-testid="deliverable-reference-note"
              className="rounded-md border border-dashed px-4 py-3 text-caption text-muted-foreground"
            >
              {t(($) => $.deliverables.reference_only_note)}
            </div>
          ) : d.content !== undefined ? (
            <RichContent content={previewContent(d)!} />
          ) : (
            <div className="font-mono text-caption leading-relaxed">
              {d.diff?.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "whitespace-pre-wrap px-2 py-px",
                    line.kind === "add" && "bg-success/10 text-success",
                    line.kind === "remove" && "bg-destructive/10 text-destructive",
                  )}
                >
                  {line.kind === "add" ? "+ " : line.kind === "remove" ? "− " : "  "}
                  {line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
