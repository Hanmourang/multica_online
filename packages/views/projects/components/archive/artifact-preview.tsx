"use client";

import { useEffect, useMemo } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileWarning,
} from "lucide-react";
import type { ArtifactStage, ProjectArtifact } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { api } from "@multica/core/api";
import { copyText } from "@multica/ui/lib/clipboard";
import { useT } from "../../../i18n";
import { ArtifactPreviewPane } from "./artifact-preview-pane";
import { formatBytes, formatTimestamp } from "./query-states";

/**
 * f5 档案预览弹窗。
 *
 * 快照优先；仅索引时从档案根 / 会话选中的文件夹读正文再渲染。
 * ←/→ 在同组文档间切换。
 */
export function ArtifactPreviewDialog({
  projectId,
  artifacts,
  index,
  onIndexChange,
  open,
  onOpenChange,
  onRequestArchive,
  archiveRoots = [],
  onArchiveRootChange,
}: {
  projectId: string;
  /** Navigation group — same-requirement artifacts sorted by stage. */
  artifacts: ProjectArtifact[];
  index: number;
  onIndexChange: (index: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestArchive?: (artifact: ProjectArtifact) => void;
  archiveRoots?: string[];
  onArchiveRootChange?: (path: string | null) => void;
}) {
  const { t } = useT("archive");

  const artifact = artifacts[index];

  // Keyboard navigation: ←/→ move within the group while the dialog is open.
  useEffect(() => {
    if (!open || artifacts.length < 2) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        onIndexChange(index - 1);
      } else if (event.key === "ArrowRight" && index < artifacts.length - 1) {
        event.preventDefault();
        onIndexChange(index + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, artifacts.length, index, onIndexChange]);

  const metaRows = useMemo(() => {
    if (!artifact) return [];
    return [
      { key: "scope", label: t(($) => $.preview.field_scope), value: artifact.scope },
      {
        key: "stage",
        label: t(($) => $.preview.field_stage),
        value: stageLabel(
          artifact.stage,
          t(($) => $.browser.stage_s1),
          t(($) => $.browser.stage_s2),
          t(($) => $.browser.stage_s3),
          t(($) => $.browser.stage_s4),
          t(($) => $.browser.stage_missing),
        ),
      },
      {
        key: "doc_type",
        label: t(($) => $.preview.field_doc_type),
        value: artifact.doc_type,
      },
      {
        key: "version",
        label: t(($) => $.preview.field_version),
        value: `v${artifact.version}`,
      },
      {
        key: "source",
        label: t(($) => $.preview.field_source),
        value: artifact.source,
      },
      {
        key: "blob_sha",
        label: t(($) => $.preview.field_blob_sha),
        value: artifact.blob_sha.slice(0, 12),
      },
      {
        key: "attachment",
        label: t(($) => $.preview.field_attachment),
        value: artifact.attachment_id
          ? t(($) => $.preview.snapshot_yes)
          : t(($) => $.preview.snapshot_no),
      },
      {
        key: "synced_at",
        label: t(($) => $.preview.field_synced_at),
        value: formatTimestamp(artifact.synced_at),
      },
    ] as const;
  }, [artifact, t]);

  if (!artifact) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(94vh,1080px)] !w-[min(96vw,1440px)] !max-w-[min(96vw,1440px)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-surface-border px-5 py-3">
          <div className="flex items-center gap-2">
            <DialogTitle className="truncate text-title-sm">
              {fileNameOf(artifact.rel_path)}
            </DialogTitle>
            <Badge variant="secondary">{artifact.source}</Badge>
            {artifact.attachment_id ? (
              <Badge variant="outline" className="gap-1">
                <CheckCircle2 className="size-3" />
                {t(($) => $.preview.snapshot_yes)}
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1">
                <FileWarning className="size-3" />
                {t(($) => $.preview.snapshot_no)}
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={index <= 0}
                onClick={() => onIndexChange(index - 1)}
                aria-label={t(($) => $.preview.prev)}
              >
                <ChevronLeft />
              </Button>
              <span className="min-w-12 text-center text-caption tabular-nums text-muted-foreground">
                {t(($) => $.preview.position, {
                  current: index + 1,
                  total: artifacts.length,
                })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={index >= artifacts.length - 1}
                onClick={() => onIndexChange(index + 1)}
                aria-label={t(($) => $.preview.next)}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
          <DialogDescription className="break-all font-mono text-caption">
            {artifact.rel_path}
            {artifact.size_bytes > 0 && ` · ${formatBytes(artifact.size_bytes)}`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface/50 p-5">
          <ArtifactPreviewPane
            artifact={artifact}
            projectId={projectId}
            archiveRoots={archiveRoots}
            onArchiveRootChange={onArchiveRootChange}
            fill
          />
        </div>

        {/* Metadata drawer — fixed 8-field grid, matching the prototype. */}
        <div className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-2 border-t border-surface-border bg-surface-hover/40 px-5 py-3 sm:grid-cols-4">
          {metaRows.map((row) => (
            <div key={row.key} className="min-w-0">
              <div className="text-caption text-muted-foreground">{row.label}</div>
              <div className="truncate text-caption font-medium" title={String(row.value)}>
                {row.value}
              </div>
            </div>
          ))}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-surface-border px-5 py-3">
          <Button
            type="button"
            size="xs"
            disabled={!artifact.attachment_id}
            onClick={() => {
              void api.getProjectArtifactContent(projectId, artifact.id).then((res) => {
                if (res.attachment_url) {
                  window.open(res.attachment_url, "_blank", "noopener");
                }
              });
            }}
          >
            <ExternalLink />
            {t(($) => $.preview.open_content)}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              void copyText(artifact.rel_path);
            }}
          >
            {t(($) => $.common.copy_path)}
          </Button>
          {onRequestArchive && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="ml-auto"
              onClick={() => onRequestArchive(artifact)}
            >
              {t(($) => $.archive_action.trigger)}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function fileNameOf(relPath: string): string {
  const segments = relPath.split("/");
  return segments[segments.length - 1] || relPath;
}

function stageLabel(
  stage: ArtifactStage | null | undefined,
  s1: string,
  s2: string,
  s3: string,
  s4: string,
  missing: string,
): string {
  switch (stage) {
    case 1:
      return s1;
    case 2:
      return s2;
    case 3:
      return s3;
    case 4:
      return s4;
    default:
      return missing;
  }
}
