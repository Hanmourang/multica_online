"use client";

import { useEffect, useRef, type ReactNode } from "react";
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
import { CodeBlockIframe } from "../../../editor/code-block-iframe";
import { withFragmentNavShim } from "../../../editor/utils/iframe-fragment-nav";
import { stripRemotePreviewAssets, withContractPrototypeChrome } from "./archive-html-preview";
import {
  isPrototypeFpFrom,
  postPrototypeHighlight,
  withPrototypeInteractShim,
} from "./prototype-interact";

const WEB_PREVIEW_MAX = 800_000;

export function ArtifactPreviewPane({
  artifact,
  projectId,
  archiveRoots,
  onArchiveRootChange,
  compact = false,
  fill = false,
  embedded = false,
  frameClassName,
  interact = false,
  highlightFp = null,
  onSelectFp,
}: {
  artifact: ProjectArtifact;
  projectId: string;
  archiveRoots: string[];
  onArchiveRootChange?: (path: string | null) => void;
  compact?: boolean;
  fill?: boolean;
  /** 嵌进原型窗框：不要徽章和圆角边框。 */
  embedded?: boolean;
  /** 非嵌入态可覆盖默认高度。嵌入态铺满相对定位的父级。 */
  frameClassName?: string;
  /** 注入 data-fp 热点点击 / 高亮协议。 */
  interact?: boolean;
  highlightFp?: string | null;
  onSelectFp?: (id: string) => void;
}) {
  const { t } = useT("archive");
  const source = useArchivePreviewSource({
    artifact,
    projectId,
    archiveRoots,
    enabled: true,
  });
  const frameClass = frameClassName
    ?? (embedded
      ? "h-full min-h-[200px] w-full rounded-none border-0 bg-white"
      : compact
        ? "h-[min(40vh,360px)] w-full rounded-lg border border-surface-border bg-white"
        : fill
          ? "h-full min-h-0 w-full rounded-lg border border-surface-border bg-white"
          : "min-h-[min(48vh,480px)] w-full rounded-lg border border-surface-border bg-white");
  const bodyClass = compact
    ? "max-h-[min(40vh,360px)] overflow-auto rounded-lg border border-surface-border bg-surface px-3 py-2"
    : fill
      ? "h-full min-h-0 overflow-auto rounded-lg border border-surface-border bg-surface px-5 py-4"
      : "min-h-[min(48vh,480px)] overflow-auto rounded-lg border border-surface-border bg-surface px-5 py-4";

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
    return (
      <EmbeddedFill embedded={embedded}>
        <QueryLoading rows={5} />
      </EmbeddedFill>
    );
  }
  if (source.status === "error") {
    return (
      <EmbeddedFill embedded={embedded}>
        <p className="text-caption text-destructive" role="alert">
          {t(($) => $.common.retry_hint)}
        </p>
      </EmbeddedFill>
    );
  }
  if (source.status === "ready") {
    return (
      <div className={embedded ? "absolute inset-0 min-h-[200px]" : fill ? "flex h-full min-h-0 flex-col gap-2" : "space-y-2"}>
        {!embedded && (
          <Badge variant="outline" className="w-fit shrink-0">
            {source.from === "local"
              ? t(($) => $.preview.source_local)
              : t(($) => $.preview.source_snapshot)}
          </Badge>
        )}
        <div className={embedded || fill ? "h-full min-h-0" : undefined}>
          {source.kind === "html" && (source.url || source.text) ? (
            <ArchiveHtmlFrame
              title={artifact.rel_path}
              className={frameClass}
              fileUrl={source.url?.startsWith("file:") ? source.url : undefined}
              html={source.text}
              embedded={embedded}
              interact={interact}
              highlightFp={highlightFp}
              onSelectFp={onSelectFp}
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
            />
          ) : (
            <UnavailableCard
              onPickRoot={pickRoot}
              sha={artifact.blob_sha}
              path={artifact.rel_path}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <EmbeddedFill embedded={embedded}>
      <UnavailableCard
        onPickRoot={pickRoot}
        sha={artifact.blob_sha}
        path={artifact.rel_path}
        reason={source.status === "unavailable" ? source.reason : undefined}
      />
    </EmbeddedFill>
  );
}

function EmbeddedFill({
  embedded,
  children,
}: {
  embedded: boolean;
  children: ReactNode;
}) {
  if (!embedded) return children;
  return (
    <div className="absolute inset-0 flex min-h-[200px] items-center justify-center overflow-auto bg-muted/10">
      {children}
    </div>
  );
}

/**
 * 原型 HTML 走 srcDoc + allow-scripts（与编辑器预览同一套）。
 * 旧实现是 allow-same-origin 且不放行脚本，Tailwind CDN 原型会白屏。
 * file:// 仅当没有正文时兜底；http 页面里嵌 file:// 经常被拦。
 */
function ArchiveHtmlFrame({
  title,
  className,
  fileUrl,
  html,
  embedded,
  interact,
  highlightFp,
  onSelectFp,
}: {
  title: string;
  className: string;
  fileUrl?: string;
  html?: string;
  embedded?: boolean;
  interact?: boolean;
  highlightFp?: string | null;
  onSelectFp?: (id: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!interact || !onSelectFp) return;
    const onMessage = (event: MessageEvent) => {
      const id = isPrototypeFpFrom(event, iframeRef.current?.contentWindow);
      if (id) onSelectFp(id);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [interact, onSelectFp]);

  const pushHighlight = () => {
    if (!interact) return;
    postPrototypeHighlight(iframeRef.current?.contentWindow, highlightFp ?? null);
  };

  useEffect(() => {
    pushHighlight();
  }, [highlightFp, interact, html]);

  if (html != null && html.trim() !== "") {
    const body = withFragmentNavShim(
      withContractPrototypeChrome(stripRemotePreviewAssets(html)),
    );
    return (
      <CodeBlockIframe
        ref={iframeRef}
        html={interact ? withPrototypeInteractShim(body) : body}
        title={title}
        heightClassName={className}
        className={embedded ? "rounded-none border-0 bg-white" : "border-surface-border bg-white"}
        onLoad={pushHighlight}
      />
    );
  }
  if (fileUrl) {
    return <iframe src={fileUrl} title={title} className={className} />;
  }
  return null;
}

function UnavailableCard({
  sha,
  path,
  onPickRoot,
  reason,
}: {
  sha: string;
  path?: string;
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
      {path ? (
        <code className="max-w-full break-all font-mono text-[11px] text-foreground">
          {path}
        </code>
      ) : null}
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
