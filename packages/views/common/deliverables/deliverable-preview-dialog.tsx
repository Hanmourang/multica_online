import { useEffect, useMemo } from "react";
import { ChevronLeft, ChevronRight, FileText, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@multica/ui/components/ui/dialog";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { RichContent } from "../../rich-content";
import { highlightBlock, highlightToLines, languageForPath } from "../task-transcript/diff-highlight";
import { renderDiffRows } from "../task-transcript/detail-surfaces";
import type { TraceDiffLine } from "../task-transcript/trace-event-presenter";
import { isMarkdownPath, type Deliverable } from "./build-deliverables";
import "../../editor/styles/code.css";
import "../task-transcript/task-transcript.css";

/**
 * Quick preview for one deliverable out of a run's wall. Markdown renders as
 * a document; other full-text files use the same highlighter as the
 * transcript; edit-only files render a syntax-coloured diff. Left/right keys
 * and the header chevrons move between deliverables without leaving the dialog.
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
  const language = languageForPath(d.path);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex h-[85vh] max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{d.name}</DialogTitle>
        <div className="flex shrink-0 items-center gap-3 border-b bg-muted/40 px-4 py-2.5">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-caption font-medium">{d.name}</div>
            <div className="truncate font-mono text-micro text-muted-foreground">{d.path}</div>
          </div>
          {language && (
            <span className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-micro text-muted-foreground">
              {language}
            </span>
          )}
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
        <div className="min-h-0 flex-1 overflow-auto">
          {d.content !== undefined && isMarkdownPath(d.path) ? (
            <div
              data-testid="deliverable-markdown"
              className="mx-auto max-w-3xl px-8 py-7"
            >
              <RichContent content={d.content} density="document" />
            </div>
          ) : d.content !== undefined ? (
            <CodePreview path={d.path} text={d.content} />
          ) : d.diff && d.diff.length > 0 ? (
            <DiffPreview path={d.path} lines={d.diff} />
          ) : (
            <div
              data-testid="deliverable-reference-note"
              className="px-6 py-5 text-caption text-muted-foreground"
            >
              {t(($) => $.deliverables.reference_only_note)}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CodePreview({ path, text }: { path: string; text: string }) {
  const language = languageForPath(path);
  const html = useMemo(
    () => (language ? highlightBlock(text, language) : null),
    [text, language],
  );
  return (
    <pre
      data-testid="deliverable-code"
      className="transcript-code h-full overflow-auto p-5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-all"
    >
      {html === null ? (
        <code>{text}</code>
      ) : (
        <code
          className={cn("hljs", language && `language-${language}`)}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </pre>
  );
}

function DiffPreview({ path, lines }: { path: string; lines: TraceDiffLine[] }) {
  const highlighted = useMemo(() => {
    const language = languageForPath(path);
    if (!language) return null;
    const sides: Record<"add" | "remove" | "context", string[] | null> = {
      add: null,
      remove: null,
      context: null,
    };
    for (const kind of ["add", "remove", "context"] as const) {
      const side = lines.filter((line) => line.kind === kind);
      if (side.length > 0) {
        sides[kind] = highlightToLines(side.map((line) => line.text).join("\n"), language);
      }
    }
    return sides;
  }, [lines, path]);

  return (
    <pre
      data-testid="deliverable-diff"
      className="transcript-code h-full overflow-auto p-5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-all"
    >
      {renderDiffRows(lines, highlighted)}
    </pre>
  );
}
