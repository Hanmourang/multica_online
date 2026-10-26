/**
 * 自动 / 人工映射共用规则。
 * 自动：路径契约 + frontmatter + conflict_policy（与 CLI 同语义）。
 * 人工：画面 3 关联 / inbox 采纳到五货架；改绑定默认写回 frontmatter。
 * 五阶段对齐 plan §6.3：货架集合从 Core placement 派生，不再本地硬编码。
 */

import type { ArtifactSyncItem } from "@multica/core/types";
import { SHELF_DOC_TYPES } from "@multica/core/artifacts";
import {
  readArchiveFile,
  writeArchiveFile,
} from "../../../platform/archive-fs";
import { parseArchiveFrontmatter } from "./archive-import";
import { upsertArchiveFrontmatter } from "./archive-frontmatter";

export type ArchiveConflictPolicy = "path_first" | "review_queue";
export type ArchiveWritebackMode = "frontmatter" | "pointer_only";
export type PlanningShelf =
  | "research"
  | "product-design"
  | "architecture"
  | "retrospective"
  | "iteration";

// 顺序与 Core 五货架一致（S1..S5）。
export const PLANNING_SHELVES: PlanningShelf[] = SHELF_DOC_TYPES as PlanningShelf[];

export function inferPlanningDocClass(
  docType: string,
  relPath: string,
): string | undefined {
  const base = (relPath.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  const name = base.replace(/\.(md|html)$/i, "");
  if (name === "prd" || name.startsWith("prd-") || name === "requirement") {
    return "prd";
  }
  if (name === "mrd" || name.startsWith("mrd-")) return "mrd";
  if (name === "brd" || name.startsWith("brd-")) return "brd";
  if (docType === "requirement") return "prd";
  if (docType === "work-plan") return "roadmap";
  return undefined;
}

/** 与 CLI cmd_archive.go：review_queue 时路径 REQ-KEY + frontmatter 双信号不带 issue_id。 */
export function shouldAttachIssueId(
  policy: ArchiveConflictPolicy,
  issueId: string | undefined,
  requirementKey: string | undefined,
): boolean {
  if (!issueId) return false;
  return policy === "path_first" || !requirementKey;
}

export function applyConflictPolicy(
  item: ArtifactSyncItem,
  policy: ArchiveConflictPolicy,
): ArtifactSyncItem {
  if (shouldAttachIssueId(policy, item.issue_id, item.requirement_key)) {
    return item;
  }
  if (!item.issue_id) return item;
  const next = { ...item };
  delete next.issue_id;
  return next;
}

export function batchBindPercent(threshold?: number | null): number {
  if (threshold == null || Number.isNaN(threshold)) return 85;
  return threshold <= 1 ? Math.round(threshold * 100) : Math.round(threshold);
}

export function suggestInboxAdopt(
  filename: string,
  content?: string,
): {
  shelf: PlanningShelf;
  docType: PlanningShelf;
  docClass?: string;
} {
  const fm = content ? parseArchiveFrontmatter(content) : {};
  const name = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const lower = name.toLowerCase();
  const classHint = fm.docClass || inferPlanningDocClass(fm.docType ?? "", name);
  if (
    fm.docType === "research" ||
    classHint === "mrd" ||
    classHint === "brd" ||
    /^mrd|^brd/.test(lower)
  ) {
    return {
      shelf: "research",
      docType: "research",
      docClass: classHint === "brd" ? "brd" : classHint === "mrd" ? "mrd" : "mrd",
    };
  }
  if (
    fm.docType === "product-design" ||
    classHint === "prd" ||
    /^prd/.test(lower)
  ) {
    return {
      shelf: "product-design",
      docType: "product-design",
      docClass: "prd",
    };
  }
  if (
    fm.docType === "architecture" ||
    lower.includes("architecture") ||
    lower.includes("架构")
  ) {
    return { shelf: "architecture", docType: "architecture" };
  }
  if (
    fm.docType === "retrospective" ||
    lower.includes("retro") ||
    lower.includes("复盘")
  ) {
    return { shelf: "retrospective", docType: "retrospective" };
  }
  // S5 需求迭代（五阶段对齐 plan §6.3）
  if (
    fm.docType === "iteration" ||
    lower.includes("iteration") ||
    lower.includes("迭代")
  ) {
    return { shelf: "iteration", docType: "iteration" };
  }
  return {
    shelf: "research",
    docType: "research",
    ...(classHint ? { docClass: classHint } : {}),
  };
}

export function suggestedAdoptRelPath(
  filename: string,
  shelf: PlanningShelf,
): string {
  const base = (
    filename.replace(/\\/g, "/").split("/").pop() ?? "untitled.md"
  ).replace(/^\.+/, "");
  return `overview/${shelf}/${base || "untitled.md"}`;
}

export function splitInboxAbsolutePath(
  fullPath: string,
  inboxRoots: string[],
): { root: string; relPath: string } | null {
  const norm = fullPath.replace(/\\/g, "/");
  const sorted = [...inboxRoots].sort((a, b) => b.length - a.length);
  for (const root of sorted) {
    const prefix = root.replace(/\\/g, "/").replace(/\/$/, "");
    if (norm.startsWith(`${prefix}/`)) {
      return { root: prefix, relPath: norm.slice(prefix.length + 1) };
    }
  }
  const i = norm.lastIndexOf("/");
  if (i <= 0) return null;
  return { root: norm.slice(0, i), relPath: norm.slice(i + 1) };
}

export async function writebackArtifactFrontmatter(input: {
  archiveRoot: string;
  relPath: string;
  issueId?: string | null;
  docType?: string | null;
  docClass?: string | null;
  docModule?: string | null;
  requirementKey?: string | null;
  content?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  let content = input.content;
  if (content == null) {
    const read = await readArchiveFile(input.archiveRoot, input.relPath);
    if (!read.ok || read.content == null) {
      return { ok: false, reason: read.reason ?? "not_found" };
    }
    content = read.content;
  }
  const next = upsertArchiveFrontmatter(content, {
    ...(input.docType !== undefined ? { docType: input.docType } : {}),
    ...(input.docClass !== undefined ? { docClass: input.docClass } : {}),
    ...(input.docModule !== undefined ? { docModule: input.docModule } : {}),
    ...(input.issueId !== undefined ? { issueId: input.issueId } : {}),
    ...(input.requirementKey !== undefined
      ? { requirementKey: input.requirementKey }
      : {}),
  });
  const written = await writeArchiveFile(input.archiveRoot, input.relPath, next);
  return written.ok ? { ok: true } : { ok: false, reason: written.reason ?? "error" };
}
