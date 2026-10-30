"use client";

// 资产文档预览对话框：覆盖两类可预览 binding——
//   1) external_ref.artifact_id（档案导入资产）→ 拉 ProjectArtifact 明细后
//      整体复用档案 TAB 的 ArtifactPreviewPane（md / html / 图片 / 文本，
//      快照优先、桌面端本机档案根兜底，口径与档案预览完全一致）。
//   2) external_ref.attachment_id（目录批量上传资产）→ 附件自渲染：
//      图片 / PDF 走 inline download URL，markdown / html / 文本走
//      getAttachmentTextContent + 对应渲染器；超大 / 不支持类型降级为下载。
// ←/→ 在当前可预览资产组内导航；链接类资产（仅 url）不出现在该组。

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileWarning,
} from "lucide-react";
import { api } from "@multica/core/api";
import { PreviewTooLargeError, PreviewUnsupportedError } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspaceSlug } from "@multica/core/paths";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import { projectArtifactDetailOptions } from "@multica/core/artifacts";
import type { AssetBinding } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../../../../i18n";
import { ArtifactPreviewPane } from "../../archive/artifact-preview-pane";
import { withSignedPreviewAssets } from "../../archive/use-archive-preview-source";
import { classifyArchivePreviewKind } from "../../archive/archive-display";
import { QueryLoading } from "../../archive/query-states";
import { RichContent } from "../../../../rich-content/rich-content";
import { CodeBlockIframe } from "../../../../editor/code-block-iframe";
import { assetPreviewMode } from "./asset-preview-mode";

// 预览判定纯函数已抽到 asset-preview-mode（共享表格/卡片免富文本依赖），
// 这里保持原导入面兼容。
export { assetPreviewMode, type AssetPreviewMode } from "./asset-preview-mode";

function refString(binding: AssetBinding, key: string): string {
  const value = binding.external_ref?.[key];
  return typeof value === "string" ? value : "";
}

/** 附件的 inline 展示 URL（image/PDF 的 Content-Disposition 是 inline）。 */
export function attachmentDisplayUrl(attachmentId: string, workspaceSlug: string): string {
  const params = new URLSearchParams({ workspace_slug: workspaceSlug });
  const endpoint = `/api/attachments/${encodeURIComponent(attachmentId)}/download?${params.toString()}`;
  return resolvePublicFileUrl(endpoint) ?? endpoint;
}

function displayNameOf(binding: AssetBinding): string {
  return (
    refString(binding, "filename") ||
    refString(binding, "rel_path") ||
    binding.asset_name
  );
}

/**
 * 可预览资产组的预览弹窗。`bindings` 必须是外部过滤过的可预览子集
 * （assetPreviewMode != null），index 指向其中当前项。
 */
export function AssetPreviewDialog({
  projectId,
  bindings,
  index,
  onIndexChange,
  open,
  onOpenChange,
}: {
  projectId: string;
  bindings: AssetBinding[];
  index: number;
  onIndexChange: (index: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const slug = useWorkspaceSlug() || "";
  const binding = bindings[index];
  const mode = binding ? assetPreviewMode(binding) : null;
  // 工作区级调用方的 bindings 会混合多项目：行自带 project_id 时以其为准，
  // prop 仅作兜底（项目 TAB / 工作项 TAB 内两者恒等，行为不变）。
  const scopedProjectId = binding?.project_id || projectId;

  // 档案分支：按 artifact_id 拉明细，pane 需要完整 ProjectArtifact。
  const artifactId = binding ? refString(binding, "artifact_id") : "";
  const artifactEnabled = open && mode === "artifact" && Boolean(artifactId);
  const artifactQuery = useQuery({
    ...projectArtifactDetailOptions(wsId, scopedProjectId, artifactId),
    enabled: artifactEnabled,
  });

  const canPrev = index > 0;
  const canNext = index < bindings.length - 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(92vh,1000px)] !w-[min(96vw,1280px)] !max-w-[min(96vw,1280px)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-surface-border px-5 py-3">
          <div className="flex items-center gap-2">
            <DialogTitle className="truncate text-title-sm">
              {binding ? binding.asset_name : ""}
            </DialogTitle>
            {binding?.asset_subtype ? (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">
                {binding.asset_subtype}
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={!canPrev}
                onClick={() => onIndexChange(index - 1)}
                aria-label={t(($) => $.preview.prev)}
              >
                <ChevronLeft />
              </Button>
              <span className="min-w-12 text-center text-caption tabular-nums text-muted-foreground">
                {t(($) => $.preview.position, { current: index + 1, total: bindings.length })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={!canNext}
                onClick={() => onIndexChange(index + 1)}
                aria-label={t(($) => $.preview.next)}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
          <DialogDescription className="truncate font-mono text-caption">
            {binding ? displayNameOf(binding) : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface/50 p-4">
          {!binding || !mode ? (
            <PreviewNotice text={t(($) => $.preview.unavailable)} />
          ) : mode === "artifact" ? (
            <ArtifactBranch
              loading={artifactEnabled && artifactQuery.isPending}
              missing={artifactEnabled && !artifactQuery.isPending && !artifactQuery.data}
              artifact={artifactQuery.data ?? null}
              projectId={scopedProjectId}
              missingText={t(($) => $.preview.artifact_missing)}
            />
          ) : (
            <AttachmentBranch key={binding.id} binding={binding} />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-surface-border px-5 py-3">
          {mode === "attachment" && binding ? (
            <>
              <a
                href={attachmentDisplayUrl(refString(binding, "attachment_id"), slug)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button type="button" size="xs" variant="outline">
                  <ExternalLink />
                  {t(($) => $.preview.open_external)}
                </Button>
              </a>
              <a
                href={attachmentDisplayUrl(refString(binding, "attachment_id"), slug)}
                download={displayNameOf(binding)}
              >
                <Button type="button" size="xs" variant="outline">
                  <Download />
                  {t(($) => $.preview.download)}
                </Button>
              </a>
            </>
          ) : null}
          {mode === "artifact" && artifactQuery.data?.attachment_id ? (
            <ArtifactContentButton projectId={scopedProjectId} artifactId={artifactQuery.data.id} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactBranch({
  loading,
  missing,
  artifact,
  projectId,
  missingText,
}: {
  loading: boolean;
  missing: boolean;
  artifact: import("@multica/core/types").ProjectArtifact | null;
  projectId: string;
  missingText: string;
}) {
  if (loading) {
    return (
      <div className="p-3">
        <QueryLoading rows={6} />
      </div>
    );
  }
  if (missing || !artifact) {
    return <PreviewNotice text={missingText} />;
  }
  return (
    <ArtifactPreviewPane
      artifact={artifact}
      projectId={projectId}
      archiveRoots={[]}
      fill
    />
  );
}

/** 附件分支：按扩展名选渲染器；文本类走 /content 内联接口（2MB 白名单）。 */
function AttachmentBranch({ binding }: { binding: AssetBinding }) {
  const { t } = useT("assets");
  const slug = useWorkspaceSlug() || "";
  const attachmentId = refString(binding, "attachment_id");
  const name = displayNameOf(binding);
  const kind = useMemo(() => classifyArchivePreviewKind(name), [name]);
  const displayUrl = attachmentDisplayUrl(attachmentId, slug);

  const needsText = kind === "markdown" || kind === "html" || kind === "text";
  const textQuery = useQuery({
    // html 要多做一次资源签名改写，缓存键里带上 kind，否则升级后旧的未改写
    // 正文会一直命中（staleTime 5 分钟）。
    queryKey: ["asset-preview-attachment-text", attachmentId, kind],
    enabled: needsText,
    queryFn: async () => {
      const { text } = await api.getAttachmentTextContent(attachmentId);
      // 预览 iframe 是 srcdoc 不透明源，子资源既不带 cookie 也不带
      // Authorization，直连境外 CDN 时就连不上；而原型里的 Google Fonts
      // 样式表是渲染阻塞资源，实测 fonts.googleapis.com 25s 才超时 —— 在它
      // 返回前整页一直是空白。改写成本站签名代理后，浏览器只连本机站点。
      return kind === "html" ? withSignedPreviewAssets(text) : text;
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

  if (kind === "image") {
    return <img src={displayUrl} alt={name} className="h-full min-h-0 w-full rounded-lg border border-surface-border bg-white object-contain" />;
  }
  if (kind === "binary") {
    // classify 把 pdf 归 binary；pdf 交给浏览器内建查看器 iframe。
    if (/\.[pdf]$/i.test(name)) {
      return <iframe src={displayUrl} title={name} className="h-full min-h-0 w-full rounded-lg border border-surface-border bg-white" />;
    }
    return <PreviewNotice text={t(($) => $.preview.unsupported_type)} />;
  }
  if (needsText) {
    if (needsText && textQuery.isPending) {
      return (
        <div className="p-3">
          <QueryLoading rows={6} />
        </div>
      );
    }
    if (textQuery.error) {
      const tooLarge = textQuery.error instanceof PreviewTooLargeError;
      const unsupported = textQuery.error instanceof PreviewUnsupportedError;
      return (
        <PreviewNotice
          text={
            tooLarge
              ? t(($) => $.preview.too_large)
              : unsupported
                ? t(($) => $.preview.unsupported_type)
                : t(($) => $.preview.unavailable)
          }
        />
      );
    }
    const text = textQuery.data ?? "";
    if (kind === "html") {
      return (
        <CodeBlockIframe
          html={text}
          title={name}
          heightClassName="h-full min-h-[200px] w-full"
          className="border-surface-border bg-white"
        />
      );
    }
    if (kind === "markdown") {
      return (
        <div className="h-full min-h-0 overflow-auto rounded-lg border border-surface-border bg-surface px-5 py-4">
          <RichContent content={text} density="document" />
        </div>
      );
    }
    return (
      <pre className="h-full min-h-0 overflow-auto rounded-lg border border-surface-border bg-surface px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
        {text}
      </pre>
    );
  }
  return <PreviewNotice text={t(($) => $.preview.unavailable)} />;
}

/** 档案快照附件是签名短链，需要经 content 端点换取后再开。 */
function ArtifactContentButton({ projectId, artifactId }: { projectId: string; artifactId: string }) {
  const { t } = useT("assets");
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={() => {
        void api.getProjectArtifactContent(projectId, artifactId).then((res) => {
          if (res.attachment_url) {
            window.open(res.attachment_url, "_blank", "noopener");
          }
        });
      }}
    >
      <ExternalLink />
      {t(($) => $.preview.open_external)}
    </Button>
  );
}

function PreviewNotice({ text }: { text: string }) {
  return (
    <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-surface-border bg-surface px-4 py-8 text-center">
      <FileWarning className="size-5 text-muted-foreground" />
      <p className="text-caption leading-relaxed text-muted-foreground">{text}</p>
    </div>
  );
}
