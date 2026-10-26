import {
  readArchiveFile,
  removeArchiveFile,
  writeArchiveFile,
} from "../../../platform/archive-fs";
import { upsertArchiveFrontmatter } from "./archive-frontmatter";
import type { PlanningShelf } from "./archive-mapping";
import { PLANNING_SHELVES } from "./archive-mapping";

export const ARTIFACT_DND_MIME = "application/x-multica-artifact-ids";

export function isPlanningShelf(value: string): value is PlanningShelf {
  return (PLANNING_SHELVES as readonly string[]).includes(value);
}

let pendingDragIds: string[] = [];

export function setPendingDragIds(ids: string[]): void {
  pendingDragIds = ids;
}

export function takePendingDragIds(raw?: string): string[] {
  const fromTransfer = parseArtifactDragIds(raw);
  if (fromTransfer.length > 0) {
    pendingDragIds = [];
    return fromTransfer;
  }
  const held = pendingDragIds;
  pendingDragIds = [];
  return held;
}

/** 五货架之间改路径：只动 `overview/<shelf>/` 这一段，子目录与文件名原样带走。 */
export function relocateOverviewPath(
  relPath: string,
  toShelf: PlanningShelf,
): string | null {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const overviewAt = parts.findIndex(
    (part, index) => part === "overview" && isPlanningShelf(parts[index + 1] ?? ""),
  );
  if (overviewAt < 0) return null;
  return [...parts.slice(0, overviewAt), "overview", toShelf, ...parts.slice(overviewAt + 2)].join(
    "/",
  );
}

/** 项目级文档一定能落到目标货架；契约外路径只带走文件名。 */
export function relocateToShelf(relPath: string, toShelf: PlanningShelf): string {
  const rewritten = relocateOverviewPath(relPath, toShelf);
  if (rewritten) return rewritten;
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = parts[parts.length - 1] || "untitled.md";
  return `overview/${toShelf}/${base}`;
}

export function parseArtifactDragIds(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function dragArtifactIds(
  artifactId: string,
  pickedIds?: Set<string> | null,
): string[] {
  if (pickedIds && pickedIds.has(artifactId) && pickedIds.size > 1) {
    return [...pickedIds];
  }
  return [artifactId];
}

export async function writeRelocatedArchiveFile(input: {
  archiveRoot: string;
  fromPath: string;
  toPath: string;
  docType: PlanningShelf;
}): Promise<{ ok: boolean; content?: string; reason?: string }> {
  const read = await readArchiveFile(input.archiveRoot, input.fromPath);
  if (!read.ok || read.content == null) {
    return { ok: false, reason: read.reason ?? "not_found" };
  }
  const content = upsertArchiveFrontmatter(read.content, { docType: input.docType });
  if (input.toPath !== input.fromPath) {
    const existing = await readArchiveFile(input.archiveRoot, input.toPath);
    if (existing.ok && existing.content != null) {
      return { ok: false, reason: "exists" };
    }
  }
  const written = await writeArchiveFile(input.archiveRoot, input.toPath, content);
  if (!written.ok) {
    return { ok: false, reason: written.reason ?? "error" };
  }
  if (input.toPath !== input.fromPath) {
    await removeArchiveFile(input.archiveRoot, input.fromPath);
  }
  return { ok: true, content };
}
