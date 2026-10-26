/**
 * Desktop 真 sync：把本机扫描结果收成 POST /artifacts/sync 的全量清单。
 * Web 没有读盘能力，不得用本模块去提交空清单。
 */

import type { ArtifactSyncItem } from "@multica/core/types";
import { listArchiveDocs, readArchiveFile } from "../../../platform/archive-fs";
import {
  classifyArchiveScan,
  inferDocType,
  inferVersion,
  isArchiveDocPath,
  normalizeScanRel,
  parseArchiveFrontmatter,
  type ArchiveScanFile,
} from "./archive-import";
import { parseArchivePath } from "./archive-inspector";
import {
  applyConflictPolicy,
  inferPlanningDocClass,
  type ArchiveConflictPolicy,
} from "./archive-mapping";
import { gitBlobSha1FromText } from "./git-blob-sha";

export { inferPlanningDocClass } from "./archive-mapping";

const READ_CONCURRENCY = 8;
const MAX_CONTENT_CHARS = 1_500_000;

export type ArchiveSyncBuildOptions = {
  conflictPolicy?: ArchiveConflictPolicy;
};

export type ArchiveSyncBuildResult = {
  items: ArtifactSyncItem[];
  unclassified: string[];
  skipped: number;
};

/**
 * 全量清单：已归类的文件都进 items（含索引里已有的），未归类进 unclassified。
 * 与「扫描录入」不同：录入跳过 exists，sync 必须带上 exists 才能避免误软删。
 */
export function buildArchiveSyncManifest(
  files: ArchiveScanFile[],
  options?: ArchiveSyncBuildOptions,
): ArchiveSyncBuildResult {
  const classified = classifyArchiveScan(files, []);
  const items: ArtifactSyncItem[] = [];
  const unclassified: string[] = [];
  let skipped = 0;

  for (const row of classified) {
    if (row.status === "skipped") {
      skipped += 1;
      continue;
    }
    if (row.status === "unclassified" || !row.draft) {
      unclassified.push(row.relPath);
      continue;
    }
    const draft = row.draft;
    const content = draft.content ?? "";
    const bytes = new TextEncoder().encode(content);
    const item: ArtifactSyncItem = {
      rel_path: draft.rel_path,
      blob_sha: gitBlobSha1FromText(content),
      scope: draft.scope,
      doc_type: draft.doc_type,
      version: draft.version,
      size_bytes: bytes.length,
    };
    if (draft.stage != null) item.stage = draft.stage;
    if (draft.requirement_key) item.requirement_key = draft.requirement_key;
    if (draft.issue_id) item.issue_id = draft.issue_id;
    const frontmatter = parseArchiveFrontmatter(content);
    const docClass = frontmatter.docClass
      || inferPlanningDocClass(draft.doc_type, draft.rel_path);
    if (docClass) item.doc_class = docClass;
    if (frontmatter.docModule) item.doc_module = frontmatter.docModule;
    items.push(applyConflictPolicy(item, options?.conflictPolicy ?? "path_first"));
  }

  return { items, unclassified, skipped };
}

/** 给没有走 classify 的单文件补一条（测试 / 未来 CLI 对齐用）。 */
export function syncItemFromScanFile(file: ArchiveScanFile): ArtifactSyncItem | null {
  if (!isArchiveDocPath(file.relPath)) return null;
  const relPath = normalizeScanRel(file.relPath);
  const parsed = parseArchivePath(relPath);
  const frontmatter = file.content ? parseArchiveFrontmatter(file.content) : {};
  const docType = inferDocType(relPath, parsed, frontmatter);
  if (
    !docType ||
    (parsed.scope !== "shared" && parsed.scope !== "project" && parsed.scope !== "requirement")
  ) {
    return null;
  }
  const content = file.content ?? "";
  const item: ArtifactSyncItem = {
    rel_path: relPath,
    blob_sha: gitBlobSha1FromText(content),
    scope: parsed.scope,
    doc_type: docType,
    version: inferVersion(relPath, frontmatter),
    size_bytes: new TextEncoder().encode(content).length,
  };
  if (parsed.stage === 1 || parsed.stage === 2 || parsed.stage === 3 || parsed.stage === 4 || parsed.stage === 5) {
    item.stage = parsed.stage;
  }
  if (parsed.reqKey) item.requirement_key = parsed.reqKey;
  if (frontmatter.issueId) item.issue_id = frontmatter.issueId;
  if (frontmatter.docModule) item.doc_module = frontmatter.docModule;
  return item;
}

export async function collectLocalArchiveSyncItems(
  root: string,
  options?: ArchiveSyncBuildOptions,
): Promise<{
  items: ArtifactSyncItem[];
  unclassified: string[];
  skipped: number;
  error?: string;
}> {
  const listed = await listArchiveDocs(root);
  if (!listed.ok) {
    return {
      items: [],
      unclassified: [],
      skipped: 0,
      error: listed.error ?? listed.reason ?? "scan_failed",
    };
  }
  const paths = (listed.files ?? []).filter(isArchiveDocPath);
  const scanned: ArchiveScanFile[] = [];
  for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
    const batch = paths.slice(i, i + READ_CONCURRENCY);
    const read = await Promise.all(
      batch.map(async (relPath) => {
        const result = await readArchiveFile(root, relPath);
        return {
          relPath,
          ...(result.ok && result.content != null && result.content.length <= MAX_CONTENT_CHARS
            ? { content: result.content }
            : {}),
        };
      }),
    );
    scanned.push(...read);
  }
  return buildArchiveSyncManifest(scanned, options);
}
