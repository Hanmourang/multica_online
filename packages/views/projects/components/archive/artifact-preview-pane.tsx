"use client";

import { FileWarning, FolderSearch } from "lucide-react";
import type { ProjectArtifact } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { RichContent } from "../../../rich-content/rich-content";
import { isDesktopShell, pickDirectory } from "../../../platform";
import { useT } from "../../../i18n";
import { QueryLoading } from "./query-states";
import { classifyArchivePreviewKind } from "./archive-display";
import {
  pickWebDirectoryFiles,
  putArchivePreviewTexts,
} from "./archive-preview-cache";
import { useArchivePreviewSource } from "./use-archive-preview-source";

const WEB_PREVIEW_MAX = 800_000;

export function ArtifactPreviewPane({
  artifact,
  projectId,
  archiveRoots,
  onArchiveRootChange,
  compact = false,
}: {
  artifact: ProjectArtifact;
  projectId: string;
  archiveRoots: string[];
  onArchiveRootChange?: (path: string | null) => void;
  compact?: boolean;
}) {
  const { t } = useT("archive");
  const source = useArchivePreviewSource({
    artifact,
    projectId,
    archiveRoots,
    enabled: true,
  });
  const frameClass = compact
    ? "h-[min(36vh,280px)] w-full rounded-lg border border-surface-border bg-surface"
    : "h-[min(60vh,520px)] w-full rounded-lg border border-surface-border bg-surface";
  const bodyClass = compact
    ? "max-h-[min(36vh,280px)] overflow-auto rounded-lg border border-surface-border bg-surface px-3 py-2"
    : "max-h-[min(60vh,520px)] overflow-auto rounded-lg border border-surface-border bg-surface px-3 py-2";

  const pickRoot = async () => {
    if (isDesktopShell()) {
      const picked = await pickDirectory(archiveRoots[0]);
      if (picked.ok && picked.path) onArchiveRootChange?.(picked.path);
      return;
    }
    const files = await pickWebDirectoryFiles();
    const entries: Array<{ relPath: string; text: string }> = [];
    for (const file of files) {
      const relPath =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
        file.name;
      const kind = classifyArchivePreviewKind(relPath);
      if (kind === "binary" || kind === "image") continue;
      try {
        const text = await file.text();
        if (text.length > 0) {
          entries.push({
            relPath,
            text: text.length > WEB_PREVIEW_MAX ? text.slice(0, WEB_PREVIEW_MAX) : text,
          });
        }
      } catch {
        // skip unreadable files
      }
    }
    if (entries.length > 0) putArchivePreviewTexts(entries);
  };

  if (source.status === "loading") {
    return <QueryLoading rows={5} />;
  }
  if (source.status === "error") {
    return (
      <p className="text-caption text-destructive" role="alert">
        {t(($) => $.common.retry_hint)}
      </p>
    );
  }
  if (source.status === "ready") {
    return (
      <div className="space-y-2">
        <Badge variant="outline">
          {source.from === "local"
            ? t(($) => $.preview.source_local)
            : t(($) => $.preview.source_snapshot)}
        </Badge>
        {source.kind === "html" && (source.url || source.text) ? (
          <iframe
            src={source.url}
            srcDoc={source.url ? undefined : source.text}
            title={artifact.rel_path}
            className={frameClass}
            sandbox="allow-same-origin"
          />
        ) : source.kind === "image" && source.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={source.url}
            alt={artifact.rel_path}
            className={`${frameClass} object-contain`}
          />
        ) : source.kind === "markdown" && source.text != null ? (
          <div className={bodyClass}>
            <RichContent content={source.text} density="document" />
          </div>
        ) : source.text != null ? (
          <pre className={`${bodyClass} font-mono text-[11px] whitespace-pre-wrap`}>
            {source.text}
          </pre>
        ) : source.url ? (
          <iframe
            src={source.url}
            title={artifact.rel_path}
            className={frameClass}
            sandbox="allow-same-origin"
          />
        ) : (
          <UnavailableCard onPickRoot={pickRoot} sha={artifact.blob_sha} />
        )}
      </div>
    );
  }

  return (
    <UnavailableCard
      onPickRoot={pickRoot}
      sha={artifact.blob_sha}
      reason={source.status === "unavailable" ? source.reason : undefined}
    />
  );
}

function UnavailableCard({
  sha,
  onPickRoot,
  reason,
}: {
  sha: string;
  onPickRoot?: () => void;
  reason?: "unsupported" | "not_found";
}) {
  const { t } = useT("archive");
  const message = !isDesktopShell()
    ? t(($) => $.preview.web_no_disk)
    : reason === "unsupported"
      ? t(($) => $.preview.content_unavailable_restart)
      : t(($) => $.preview.content_unavailable_search);
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-surface-border bg-surface px-3 py-6 text-center">
      <FileWarning className="size-5 text-muted-foreground" />
      <p className="text-caption leading-relaxed text-muted-foreground">
        {message}
      </p>
      <code className="break-all font-mono text-[11px] text-muted-foreground">
        {sha}
      </code>
      {onPickRoot && (
        <Button type="button" size="xs" variant="outline" onClick={() => void onPickRoot()}>
          <FolderSearch />
          {t(($) => $.preview.pick_root)}
        </Button>
      )}
    </div>
  );
}
