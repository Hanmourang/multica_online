"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
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
  matchListedPath,
  previewProbeRoots,
  shouldListProbe,
} from "./archive-preview-resolve";
import { resolveArchivePreviewRoots } from "./archive-display";
import {
  classifyArchivePreviewKind,
  type ArchivePreviewKind,
} from "./archive-display";

const LOCAL_PREVIEW_MAX = 800_000;

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

function clip(text: string): string {
  return text.length > LOCAL_PREVIEW_MAX ? text.slice(0, LOCAL_PREVIEW_MAX) : text;
}

const listedByRoot = new Map<string, Promise<string[] | null>>();
let rememberedRoot: string | null = null;
let lastReadReason: "unsupported" | "not_found" | undefined;

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

async function readAt(root: string, relPath: string): Promise<string | null> {
  const result = await readArchiveFile(root, relPath);
  if (result.reason === "unsupported") lastReadReason = "unsupported";
  if (result.ok && result.content != null) {
    rememberedRoot = root;
    lastReadReason = undefined;
    return clip(result.content);
  }
  return null;
}

async function readLocalPreview(
  relPath: string,
  hintRoots: string[],
): Promise<string | null> {
  lastReadReason = undefined;
  const cached = getArchivePreviewText(relPath);
  if (cached) return clip(cached);
  if (!isDesktopShell()) return null;

  const roots = rememberedRoot
    ? [rememberedRoot, ...hintRoots.filter((root) => root !== rememberedRoot)]
    : hintRoots;

  for (const root of roots) {
    const direct = await readAt(root, relPath);
    if (direct) return direct;
  }

  for (const probe of previewProbeRoots(roots)) {
    const direct = await readAt(probe, relPath);
    if (direct) return direct;
    if (!shouldListProbe(probe)) continue;
    const files = await listedFiles(probe);
    if (!files) continue;
    const matched = matchListedPath(relPath, files);
    if (!matched) continue;
    const fallback = await readAt(probe, matched);
    if (fallback) return fallback;
  }
  if (!lastReadReason) lastReadReason = "not_found";
  return null;
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

  const snapshotQuery = useQuery({
    ...projectArtifactContentOptions(wsId, projectId, artifactId),
    enabled: enabled && Boolean(artifactId),
  });

  const attachmentTextQuery = useQuery({
    queryKey: ["archive-preview-attachment-text", attachmentId],
    enabled: enabled && Boolean(attachmentId) && kind !== "html" && kind !== "image",
    queryFn: async () => {
      const { text } = await api.getAttachmentTextContent(attachmentId!);
      return text;
    },
    retry: false,
  });

  const canReadLocal =
    Boolean(artifact) &&
    kind !== "image" &&
    kind !== "binary" &&
    (isDesktopShell() || getArchivePreviewText(artifact?.rel_path ?? "") != null);

  const localQuery = useQuery({
    queryKey: [
      "archive-preview-local",
      artifact?.rel_path,
      hintRoots,
      cacheGen,
    ],
    enabled: enabled && Boolean(artifact) && canReadLocal,
    queryFn: () => readLocalPreview(artifact!.rel_path, hintRoots),
    retry: false,
  });

  if (!enabled || !artifact) return { status: "idle" };
  if (snapshotQuery.isPending || resourcesQuery.isPending) return { status: "loading" };
  if (snapshotQuery.isError) {
    if (localQuery.isPending && localQuery.fetchStatus !== "idle") {
      return { status: "loading" };
    }
    if (localQuery.data) {
      return { status: "ready", kind, from: "local", text: localQuery.data };
    }
    return { status: "error" };
  }

  const snapshot = snapshotQuery.data;
  const hasSnapshot =
    snapshot != null &&
    snapshot.content_unavailable !== true &&
    Boolean(snapshot.attachment_url);

  if (hasSnapshot) {
    if (kind === "html" || kind === "image") {
      return {
        status: "ready",
        kind,
        from: "attachment",
        url: snapshot.attachment_url,
      };
    }
    if (attachmentTextQuery.isPending) return { status: "loading" };
    if (attachmentTextQuery.data) {
      return {
        status: "ready",
        kind,
        from: "attachment",
        text: attachmentTextQuery.data,
        url: snapshot.attachment_url,
      };
    }
    return {
      status: "ready",
      kind: kind === "markdown" ? "text" : kind,
      from: "attachment",
      url: snapshot.attachment_url,
    };
  }

  if (localQuery.isPending && localQuery.fetchStatus !== "idle") {
    return { status: "loading" };
  }
  if (localQuery.data) {
    return { status: "ready", kind, from: "local", text: localQuery.data };
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
