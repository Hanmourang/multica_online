"use client";

import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Loader2,
  Lock,
  RotateCw,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { BuiltinSkill } from "@multica/core/types";
import { ApiError } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { builtinSkillDetailOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@multica/ui/components/ui/sheet";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { SkillIcon } from "../lib/skill-icon";
import { FileTree } from "./file-tree";
import { isMarkdownPath, type FileMode } from "./file-viewer";
import { SkillSourceView } from "./skill-source-view";
import {
  SKILL_SHEET_WIDTH_CEILING,
  SKILL_SHEET_WIDTH_MIN,
  useSkillSheetWidth,
} from "./use-skill-sheet-width";

const SKILL_MD = "SKILL.md";

/**
 * Read-only inspector for a platform skill: what it tells an agent, and the
 * source of every file it ships.
 *
 * A side sheet rather than a route because platform skills have no page of
 * their own — they are not workspace rows, so there is nothing to link to and
 * nothing to edit. Keeping the list visible underneath is also the point:
 * comparing two platform skills means flipping between them, and a route would
 * turn each flip into a navigation.
 */
export function SkillSourceSheet({
  skillId,
  onClose,
}: {
  /** `builtin:<name>` from the list endpoint, or null to close. */
  skillId: string | null;
  onClose: () => void;
}) {
  const { t } = useT("skills");
  const wsId = useWorkspaceId();
  const { width, resizing, startResize, resetWidth, onResizeKeyDown } =
    useSkillSheetWidth();
  const { data, isLoading, error, refetch, isFetching } = useQuery(
    builtinSkillDetailOptions(wsId, skillId ?? ""),
  );
  // The sheet may fail before any body arrives, so the name the user clicked is
  // the only thing that can tell them *which* skill failed to load.
  const requestedName = skillId ? skillId.replace(/^builtin:/, "") : "";

  return (
    <Sheet
      open={!!skillId}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="gap-0 p-0"
        // Inline width wins over the sheet's own `sm:max-w-sm`, which was the
        // only thing keeping this pane narrow; the inline max-width replaces
        // that cap so the panel can grow to (nearly) the window edge. The
        // transition is dropped while dragging — a 200ms ease on every
        // pointermove is what makes a resize feel sticky.
        style={{
          width,
          maxWidth: "calc(100vw - 2rem)",
          transition: resizing ? "none" : undefined,
        }}
      >
        <SheetResizeHandle
          width={width}
          resizing={resizing}
          label={t(($) => $.source_sheet.resize_width)}
          onPointerDown={startResize}
          onDoubleClick={resetWidth}
          onKeyDown={onResizeKeyDown}
        />
        {error ? (
          <SheetState
            skillName={requestedName}
            error={error}
            onRetry={() => refetch()}
          />
        ) : isLoading || !data ? (
          <SheetLoading skillName={requestedName} />
        ) : (
          // Keyed by skill: selecting a different platform skill must land on
          // that skill's SKILL.md instead of carrying the previous file path.
          <SkillSourceBody key={data.id} skill={data} />
        )}
        {isFetching && data && (
          <span className="sr-only" role="status">
            {t(($) => $.source_sheet.loading)}
          </span>
        )}
      </SheetContent>
    </Sheet>
  );
}

function SkillSourceBody({ skill }: { skill: BuiltinSkill }) {
  const { t } = useT("skills");
  const [selectedPath, setSelectedPath] = useState(SKILL_MD);
  const [mode, setMode] = useState<FileMode>("preview");

  const fileMap = useMemo(() => {
    const map = new Map<string, string>();
    map.set(SKILL_MD, skill.content);
    for (const f of skill.files) {
      if (f.path.trim()) map.set(f.path, f.content);
    }
    return map;
  }, [skill]);

  const supportingPaths = skill.files.map((f) => f.path);
  const selectedContent = fileMap.get(selectedPath) ?? "";
  const isMd = isMarkdownPath(selectedPath);
  const totalChars = useMemo(() => {
    let total = skill.content.length;
    for (const f of skill.files) total += f.content.length;
    return total;
  }, [skill]);

  return (
    <>
      <SheetHeader className="shrink-0 gap-2 border-b px-4 py-3 pr-12">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/40">
            <SkillIcon className="h-4 w-4 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate font-mono text-body font-medium tracking-tight">
              {skill.name}
            </SheetTitle>
            <SheetDescription className="mt-1 text-caption leading-5">
              {skill.description}
            </SheetDescription>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
          <Badge>{t(($) => $.source_sheet.builtin_badge)}</Badge>
          <Badge>{t(($) => $.source_sheet.scope_all_agents)}</Badge>
          <span className="inline-flex items-center gap-1">
            <Lock className="h-3 w-3" aria-hidden="true" />
            {t(($) => $.source_sheet.read_only)}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {t(($) => $.source_sheet.source_label)}:{" "}
            {t(($) => $.source_sheet.source_builtin)}
          </span>
          <span aria-hidden="true">·</span>
          <span>{t(($) => $.source_sheet.files, { count: fileMap.size })}</span>
          <span aria-hidden="true">·</span>
          <span>{t(($) => $.source_sheet.chars, { count: totalChars })}</span>
        </div>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          role="tablist"
          aria-orientation="vertical"
          aria-label={t(($) => $.source_sheet.files_aria)}
          className="shrink-0 border-b border-surface-border p-3 md:w-56 md:overflow-y-auto md:border-b-0 md:border-r md:p-4 xl:w-64"
        >
          <p className="px-2.5 pb-1 text-micro font-semibold uppercase tracking-wider text-muted-foreground">
            {t(($) => $.source_sheet.main)}
          </p>
          <FileTree
            filePaths={[SKILL_MD]}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
          />
          {supportingPaths.length > 0 && (
            <>
              <p className="px-2.5 pb-1 pt-3 text-micro font-semibold uppercase tracking-wider text-muted-foreground">
                {t(($) => $.source_sheet.supporting, {
                  count: supportingPaths.length,
                })}
              </p>
              <FileTree
                filePaths={supportingPaths}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
              />
            </>
          )}
        </aside>

        <section className="flex min-h-[24rem] min-w-0 flex-1 flex-col md:min-h-0">
          <div className="flex h-10 shrink-0 items-center gap-3 border-b px-3 sm:px-4">
            <span className="truncate font-mono text-caption text-muted-foreground">
              {selectedPath}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {isMd && (
                <div
                  role="group"
                  aria-label={t(($) => $.source_sheet.mode_aria)}
                  className="flex items-center gap-0.5 rounded-md bg-muted p-0.5"
                >
                  {(["preview", "raw"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={mode === value}
                      onClick={() => setMode(value)}
                      className={cn(
                        "h-6 rounded px-2 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        mode === value
                          ? "bg-surface text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {value === "preview"
                        ? t(($) => $.source_sheet.mode_preview)
                        : t(($) => $.source_sheet.mode_source)}
                    </button>
                  ))}
                </div>
              )}
              <CopySourceButton text={selectedContent} />
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <SkillSourceView
              path={selectedPath}
              content={selectedContent}
              mode={mode}
            />
          </div>
        </section>
      </div>
    </>
  );
}

function CopySourceButton({ text }: { text: string }) {
  const { t } = useT("skills");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(t(($) => $.source_sheet.copied));
    } catch {
      toast.error(t(($) => $.source_sheet.copy_failed));
    }
  };

  const label = t(($) => $.source_sheet.copy);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={copy}
      aria-label={label}
      title={label}
      className="text-muted-foreground"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </Button>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border bg-muted/40 px-1.5 py-0.5 text-micro font-medium text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * Left-edge resize grip. Pointer drag is the primary interaction; arrow keys
 * and double-click keep it usable without a mouse (and give a way back to the
 * default width).
 *
 * The grip is deliberately visible at rest — a hairline on the panel edge plus
 * a short pill at mid-height — because a handle that only appears on hover is
 * a handle nobody finds.
 */
function SheetResizeHandle({
  width,
  resizing,
  label,
  onPointerDown,
  onDoubleClick,
  onKeyDown,
}: {
  width: number;
  resizing: boolean;
  label: string;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={SKILL_SHEET_WIDTH_MIN}
      aria-valuemax={SKILL_SHEET_WIDTH_CEILING}
      aria-valuetext={`${width}px`}
      tabIndex={0}
      title={label}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -left-1.5 z-10 hidden w-3 cursor-col-resize touch-none select-none items-center justify-center focus-visible:outline-none md:flex"
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-full w-px transition-colors",
          resizing
            ? "bg-primary/70"
            : "bg-surface-border group-hover:bg-primary/40 group-focus-visible:bg-primary/50",
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1/2 h-10 w-[3px] -translate-y-1/2 rounded-full transition-colors",
          resizing
            ? "bg-primary"
            : "bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary/60",
        )}
      />
    </div>
  );
}

function SheetLoading({ skillName }: { skillName: string }) {
  const { t } = useT("skills");
  return (
    <>
      <SheetHeader className="shrink-0 gap-1 border-b px-4 py-3 pr-12">
        <SheetTitle className="truncate font-mono text-body font-medium tracking-tight">
          {skillName || t(($) => $.source_sheet.loading)}
        </SheetTitle>
        <SheetDescription className="flex items-center gap-1.5 text-caption">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t(($) => $.source_sheet.loading)}
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-2 p-6">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </>
  );
}

// A missing skill is the common failure (a stale binary, or a ref id from an
// older page), and it is not something "try again" fixes on its own — so it
// says what changed instead of echoing the API's `skill not found`.
function SheetState({
  skillName,
  error,
  onRetry,
}: {
  skillName: string;
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useT("skills");
  const missing = error instanceof ApiError && error.status === 404;
  const detail = error instanceof Error ? error.message : "";
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <AlertCircle className="h-7 w-7 text-faint-foreground" aria-hidden="true" />
      <p className="text-body font-medium">
        {missing
          ? t(($) => $.source_sheet.error_missing)
          : t(($) => $.source_sheet.error_title)}
      </p>
      {skillName && (
        <p className="font-mono text-caption text-muted-foreground">{skillName}</p>
      )}
      <p className="max-w-sm text-caption leading-5 text-muted-foreground">
        {missing
          ? t(($) => $.source_sheet.error_missing_hint)
          : t(($) => $.source_sheet.error_generic_hint)}
      </p>
      {detail && (
        <p className="max-w-sm break-words font-mono text-micro text-faint-foreground">
          {detail}
        </p>
      )}
      <Button variant="outline" size="xs" className="mt-2 gap-1" onClick={onRetry}>
        <RotateCw className="h-3 w-3" aria-hidden="true" />
        {t(($) => $.source_sheet.error_retry)}
      </Button>
    </div>
  );
}
