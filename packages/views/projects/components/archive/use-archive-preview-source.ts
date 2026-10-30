"use client";

import { useMemo, useSyncExternalStore } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectArtifactContentOptions } from "@multica/core/artifacts/queries";
import { projectDetailOptions, projectResourcesOptions } from "@multica/core/projects";
import type { LocalDirectoryResourceRef, ProjectArtifact } from "@multica/core/types";
import { isDesktopShell } from "../../../platform";
import { listArchiveDocs, readArchiveFile } from "../../../platform/archive-fs";
import {
  archivePreviewCacheGeneration,
  getArchivePreviewText,
  subscribeArchivePreviewCache,
} from "./archive-preview-cache";
import {
  contractMgmtRoots,
  contractProjectsRoots,
  extractProjectKeysFromYaml,
  isContractRelPath,
  matchListedPath,
  previewProbeRoots,
  previewRelPathCandidates,
  shouldListProbe,
} from "./archive-preview-resolve";
import { resolveArchivePreviewRoots } from "./archive-display";
import {
  classifyArchivePreviewKind,
  type ArchivePreviewKind,
} from "./archive-display";
import {
  archiveFileUrl,
  collectRelativeScripts,
  collectRelativeStylesheets,
  inlineHtmlRelativeAssets,
  inlineRelativeScripts,
  inlineRelativeStylesheets,
  preparePreviewAssets,
  preparePreviewAssetsSigned,
  resolveRelativeRelPath,
  type PreviewAssetSigning,
} from "./archive-html-preview";

const LOCAL_PREVIEW_MAX = 800_000;

// 原型 HTML 里的 Tailwind / Google Fonts 要走同源代理，而代理路径必须签名（预
// 览 iframe 是 sandbox srcdoc，不透明源，不会带 cookie）。这里不缓存 getBaseUrl
// 的值：api 单例在 app 启动后才注入，模块加载时读到的会是 undefined。
function previewAssetSigning(): PreviewAssetSigning {
  return {
    assetBase: api.getBaseUrl(),
    sign: (urls) => api.signPreviewAssets(urls),
  };
}

function withSignedPreviewAssets(html: string): Promise<string> {
  const assets = previewAssetSigning();
  return preparePreviewAssetsSigned(html, assets.assetBase ?? "", assets.sign);
}

/** disabled 查询在 RQ v5 里 isPending=true，不能当「还在加载」。 */
function queryOpening(
  enabled: boolean,
  query: { isFetched: boolean; isFetching: boolean },
): boolean {
  return enabled && (query.isFetching || !query.isFetched);
}

export type ArchivePreviewSource =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; reason?: string }
  | {
      status: "ready";
      kind: ArchivePreviewKind;
      from: "attachment" | "local";
      text?: string;
      url?: string;
    }
  | { status: "unavailable"; reason?: "unsupported" | "not_found" };

type LocalPreviewHit = {
  text: string;
  root?: string;
  relPath?: string;
};

function clip(text: string): string {
  return text.length > LOCAL_PREVIEW_MAX ? text.slice(0, LOCAL_PREVIEW_MAX) : text;
}

const listedByRoot = new Map<string, Promise<string[] | null>>();
const hitCache = new Map<string, LocalPreviewHit>();
const projectKeysByMgmt = new Map<string, Promise<string[]>>();
let rememberedRoot: string | null = null;
let lastReadReason: "unsupported" | "not_found" | undefined;

function isConcretePrototypePath(relPath: string): boolean {
  const path = relPath.replace(/\\/g, "/");
  return path.includes("/") && /\.html?$/i.test(path);
}

function listedFiles(root: string): Promise<string[] | null> {
  const hit = listedByRoot.get(root);
  if (hit) return hit;
  const pending = listArchiveDocs(root).then((result) => {
    if (result.reason === "unsupported") lastReadReason = "unsupported";
    return result.ok ? (result.files ?? []) : null;
  });
  listedByRoot.set(root, pending);
  return pending;
}

async function readAt(root: string, relPath: string): Promise<LocalPreviewHit | null> {
  const key = `${root}\0${relPath}`;
  const cached = hitCache.get(key);
  if (cached) {
    rememberedRoot = root;
    lastReadReason = undefined;
    return cached;
  }
  const result = await readArchiveFile(root, relPath);
  if (result.reason === "unsupported") lastReadReason = "unsupported";
  if (result.ok && result.content != null && result.content.trim() !== "") {
    rememberedRoot = root;
    lastReadReason = undefined;
    const hit = { text: clip(result.content), root, relPath };
    hitCache.set(key, hit);
    return hit;
  }
  return null;
}

function projectKeysForMgmt(mgmtRoot: string): Promise<string[]> {
  const hit = projectKeysByMgmt.get(mgmtRoot);
  if (hit) return hit;
  const pending = readAt(mgmtRoot, "_shared/archive/projects.yaml").then((file) =>
    file ? extractProjectKeysFromYaml(file.text) : [],
  );
  projectKeysByMgmt.set(mgmtRoot, pending);
  return pending;
}

async function readFromContractProjects(
  relPath: string,
  hintRoots: string[],
): Promise<LocalPreviewHit | null> {
  if (!isContractRelPath(relPath)) return null;
  const keys = new Set<string>();
  await Promise.all(
    contractMgmtRoots(hintRoots).map(async (mgmt) => {
      for (const key of await projectKeysForMgmt(mgmt)) keys.add(key);
    }),
  );
  if (keys.size === 0) return null;
  const candidates = previewRelPathCandidates(relPath);
  const reads = contractProjectsRoots(hintRoots).flatMap((projectsRoot) =>
    [...keys].flatMap((key) =>
      candidates.map((candidate) => readAt(`${projectsRoot}/${key}`, candidate)),
    ),
  );
  const hits = await Promise.all(reads);
  return hits.find((row): row is LocalPreviewHit => Boolean(row)) ?? null;
}

async function withInlinedStyles(hit: LocalPreviewHit): Promise<LocalPreviewHit> {
  if (!hit.root || !hit.relPath) return hit;
  const ext = hit.relPath.replace(/\\/g, "/").toLowerCase();
  if (!ext.endsWith(".html") && !ext.endsWith(".htm")) return hit;
  const hrefs = collectRelativeStylesheets(hit.text);
  const scripts = collectRelativeScripts(hit.text);
  if (hrefs.length === 0 && scripts.length === 0) {
    return { ...hit, text: await withSignedPreviewAssets(hit.text) };
  }
  const files: Record<string, string> = {};
  // 先落成 const：闭包里对 hit.root / hit.relPath 的收窄会丢失（属性可变）。
  const root = hit.root;
  const relPath = hit.relPath;
  await Promise.all(
    [...hrefs, ...scripts].map(async (href) => {
      const assetPath = resolveRelativeRelPath(relPath, href);
      const asset = await readAt(root, assetPath);
      if (asset) files[href] = asset.text;
    }),
  );
  const withCss = inlineRelativeStylesheets(hit.text, files);
  const withJs = inlineRelativeScripts(withCss, files);
  return { ...hit, text: await withSignedPreviewAssets(withJs) };
}

async function readLocalPreview(
  relPath: string,
  hintRoots: string[],
): Promise<LocalPreviewHit | null> {
  lastReadReason = undefined;
  const cached = getArchivePreviewText(relPath);
  if (cached) {
    return { text: await withSignedPreviewAssets(clip(cached)), relPath };
  }
  if (!isDesktopShell()) return null;

  const roots = rememberedRoot
    ? [rememberedRoot, ...hintRoots.filter((root) => root !== rememberedRoot)]
    : hintRoots;
  const exact = relPath.replace(/\\/g, "/");
  const exactHits = await Promise.all(roots.map((root) => readAt(root, exact)));
  const exactHit = exactHits.find((row): row is LocalPreviewHit => Boolean(row));
  if (exactHit) return withInlinedStyles(exactHit);

  const candidates = previewRelPathCandidates(relPath).filter((path) => path !== exact);
  for (const root of roots) {
    const extras = await Promise.all(candidates.map((candidate) => readAt(root, candidate)));
    const extraHit = extras.find((row): row is LocalPreviewHit => Boolean(row));
    if (extraHit) return withInlinedStyles(extraHit);
  }

  const contractHit = await readFromContractProjects(exact, roots);
  if (contractHit) return withInlinedStyles(contractHit);

  // 契约相对路径已经定点试过 projects/<key>/：不要再扫整棵 projects_mgmt。
  if (isConcretePrototypePath(exact) || isContractRelPath(exact)) {
    if (!lastReadReason) lastReadReason = "not_found";
    return null;
  }

  for (const probe of previewProbeRoots(roots)) {
    if (roots.includes(probe)) continue;
    const extras = await Promise.all(candidates.map((candidate) => readAt(probe, candidate)));
    const extraHit = extras.find((row): row is LocalPreviewHit => Boolean(row));
    if (extraHit) return withInlinedStyles(extraHit);
    if (!shouldListProbe(probe)) continue;
    const files = await listedFiles(probe);
    if (!files) continue;
    const matched = matchListedPath(relPath, files);
    if (!matched) continue;
    const fallback = await readAt(probe, matched);
    if (fallback) return withInlinedStyles(fallback);
  }
  if (!lastReadReason) lastReadReason = "not_found";
  return null;
}

function readyFromLocal(
  kind: ArchivePreviewKind,
  hit: LocalPreviewHit,
): Extract<ArchivePreviewSource, { status: "ready" }> {
  const fileUrl =
    kind === "html" && hit.root && hit.relPath && isDesktopShell()
      ? archiveFileUrl(hit.root, hit.relPath)
      : undefined;
  return {
    status: "ready",
    kind,
    from: "local",
    text: hit.text,
    url: fileUrl,
  };
}

export function useArchivePreviewSource({
  artifact,
  projectId,
  archiveRoots,
  enabled,
}: {
  artifact: ProjectArtifact | null;
  projectId: string;
  archiveRoots: string[];
  enabled: boolean;
}): ArchivePreviewSource {
  const wsId = useWorkspaceId();
  const artifactId = artifact?.id ?? "";
  const kind = artifact ? classifyArchivePreviewKind(artifact.rel_path) : "binary";
  const attachmentId = artifact?.attachment_id ?? null;
  const cacheGen = useSyncExternalStore(
    subscribeArchivePreviewCache,
    archivePreviewCacheGeneration,
    archivePreviewCacheGeneration,
  );
  const projectQuery = useQuery({
    ...projectDetailOptions(wsId, projectId),
    enabled: enabled && Boolean(projectId),
  });
  const resourcesQuery = useQuery({
    ...projectResourcesOptions(wsId, projectId),
    enabled: enabled && Boolean(projectId),
  });
  const hintRoots = useMemo(() => {
    const locals = (resourcesQuery.data ?? [])
      .filter((resource) => resource.resource_type === "local_directory")
      .map((resource) => (resource.resource_ref as LocalDirectoryResourceRef).local_path)
      .filter((path): path is string => Boolean(path));
    const bound = (resourcesQuery.data ?? []).find(
      (resource) => resource.id === projectQuery.data?.archive_resource_id,
    );
    const boundPath =
      bound?.resource_type === "local_directory"
        ? (bound.resource_ref as LocalDirectoryResourceRef).local_path
        : null;
    return resolveArchivePreviewRoots(
      archiveRoots[0] ?? null,
      boundPath ?? locals[0] ?? null,
    ).concat(locals.filter((path) => !archiveRoots.includes(path) && path !== boundPath));
  }, [archiveRoots, projectQuery.data, resourcesQuery.data]);

  const snapshotEnabled = enabled && Boolean(artifactId) && Boolean(attachmentId);
  const snapshotQuery = useQuery({
    ...projectArtifactContentOptions(wsId, projectId, artifactId),
    enabled: snapshotEnabled,
  });

  // 本机可读判定必须先于 attachment 文本查询：HTML 在桌面端（或已选过目录）
  // 优先本机磁盘，不并发取快照文本；Web 端没有静默磁盘访问能力，只能靠快照文本。
  const canReadLocal =
    Boolean(artifact) &&
    kind !== "image" &&
    kind !== "binary" &&
    (isDesktopShell() || getArchivePreviewText(artifact?.rel_path ?? "") != null);

  const effectiveRoots =
    hintRoots.length > 0 ? hintRoots : rememberedRoot ? [rememberedRoot] : [];
  const localEnabled =
    enabled &&
    Boolean(artifact) &&
    canReadLocal &&
    (effectiveRoots.length > 0 || !isDesktopShell());
  const hintKey = effectiveRoots.join("\0");
  const localQuery = useQuery({
    queryKey: ["archive-preview-local", "contract-v1", artifact?.rel_path, hintKey, cacheGen],
    enabled: localEnabled,
    queryFn: () => readLocalPreview(artifact!.rel_path, effectiveRoots),
    retry: false,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  // 本机目录对不上（档案绑在代码仓、原型在 projects_mgmt）时，改用已归档的
  // HTML 正文，并把同目录 CSS / JS 附件嵌进去，srcdoc 才能按原型图渲染。
  const htmlNeedsSnapshot =
    kind === "html" &&
    !localQuery.data &&
    !queryOpening(localEnabled, localQuery);
  const attachmentTextEnabled =
    enabled &&
    Boolean(attachmentId) &&
    kind !== "image" &&
    (kind !== "html" || htmlNeedsSnapshot);

  const attachmentTextQuery = useQuery({
    queryKey: ["archive-preview-attachment-text", attachmentId],
    enabled: attachmentTextEnabled,
    queryFn: async () => {
      const { text } = await api.getAttachmentTextContent(attachmentId!);
      return text;
    },
    retry: false,
  });

  const snapshotHtml =
    kind === "html" && attachmentTextQuery.data ? attachmentTextQuery.data : null;
  const inlineEnabled =
    enabled &&
    Boolean(snapshotHtml) &&
    Boolean(projectId) &&
    Boolean(artifact) &&
    !localQuery.data;
  const inlineQuery = useQuery({
    queryKey: ["archive-preview-html-assets", projectId, artifactId, attachmentId],
    enabled: inlineEnabled,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const listed = await api.listProjectArtifacts(projectId);
      const byPath = new Map(
        listed.artifacts.map((item) => [item.rel_path.replace(/\\/g, "/"), item]),
      );
      return inlineHtmlRelativeAssets(
        snapshotHtml!,
        artifact!.rel_path,
        async (resolved) => {
          const norm = resolved.replace(/\\/g, "/");
          const match =
            byPath.get(norm) ??
            listed.artifacts.find((item) => {
              const path = item.rel_path.replace(/\\/g, "/");
              return path.endsWith(`/${norm}`) || norm.endsWith(`/${path}`);
            });
          if (!match?.attachment_id) return null;
          try {
            const { text } = await api.getAttachmentTextContent(match.attachment_id);
            return text;
          } catch {
            return null;
          }
        },
        previewAssetSigning(),
      );
    },
  });

  if (!enabled || !artifact) return { status: "idle" };
  if (queryOpening(localEnabled, localQuery)) {
    if (localQuery.data) return readyFromLocal(kind, localQuery.data);
    return { status: "loading" };
  }
  if (
    queryOpening(enabled && Boolean(projectId), resourcesQuery) &&
    !localQuery.data &&
    !rememberedRoot
  ) {
    return { status: "loading" };
  }
  if (snapshotQuery.isError && !localQuery.data) {
    return { status: "error" };
  }
  // HTML 原型优先走本机目录，相对 CSS / 多页面链接才能生效。
  if (kind === "html" && localQuery.data) {
    return readyFromLocal(kind, localQuery.data);
  }

  const snapshot = snapshotQuery.data;
  const hasSnapshot =
    snapshot != null &&
    snapshot.content_unavailable !== true &&
    Boolean(snapshot.attachment_url);

  if (hasSnapshot) {
    if (kind === "image") {
      return {
        status: "ready",
        kind,
        from: "attachment",
        url: snapshot.attachment_url,
      };
    }
    if (queryOpening(attachmentTextEnabled, attachmentTextQuery)) {
      return { status: "loading" };
    }
    if (attachmentTextQuery.data) {
      if (kind === "html" && queryOpening(inlineEnabled, inlineQuery) && !inlineQuery.data) {
        return { status: "loading" };
      }
      return {
        status: "ready",
        kind,
        from: "attachment",
        // 附件正文接口一律回 text/plain + nosniff，不能当 iframe.src；
        // HTML 交给 srcdoc iframe。相对样式和脚本从同项目档案嵌进正文。
        text:
          kind === "html"
            ? (inlineQuery.data ?? preparePreviewAssets(attachmentTextQuery.data, api.getBaseUrl()))
            : attachmentTextQuery.data,
      };
    }
    if (kind !== "html") {
      return {
        status: "ready",
        kind: kind === "markdown" ? "text" : kind,
        from: "attachment",
        url: snapshot.attachment_url,
      };
    }
    // html 且快照文本拿不到（413 超限 / 415 类型拒绝）：继续试本机目录，
    // 都失败才落 unavailable。
  }

  if (queryOpening(snapshotEnabled, snapshotQuery)) return { status: "loading" };
  if (localQuery.data) {
    return readyFromLocal(kind, localQuery.data);
  }

  const cached = getArchivePreviewText(artifact.rel_path);
  if (cached) {
    return { status: "ready", kind, from: "local", text: clip(cached) };
  }
  return {
    status: "unavailable",
    reason: lastReadReason === "unsupported" ? "unsupported" : "not_found",
  };
}
