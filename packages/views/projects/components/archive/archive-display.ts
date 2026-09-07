/**
 * 档案卡片展示名：卡片头已经是 doc_type，芯片必须用路径区分同一类型下的多份文件。
 */

const CONTRACT_SECTION_PREFIXES = new Set([
  "overview",
  "requirements",
  "filing",
  "change_logs",
]);

export function artifactDisplayName(relPath: string): string {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return relPath;
  if (parts.length === 1) return parts[0] ?? relPath;

  let rest = parts;
  const root = rest[0] ?? "";
  if (root === "change_logs" && rest.length >= 2) {
    rest = rest.slice(1);
  } else if (CONTRACT_SECTION_PREFIXES.has(root) && rest.length >= 3) {
    rest = rest.slice(2);
  } else if (CONTRACT_SECTION_PREFIXES.has(root) && rest.length === 2) {
    rest = rest.slice(1);
  }
  return rest.join("/") || (parts[parts.length - 1] ?? relPath);
}

export type ArchivePreviewKind = "markdown" | "html" | "text" | "image" | "binary";

const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdx"]);
const HTML_EXTS = new Set([".html", ".htm"]);
const TEXT_EXTS = new Set([
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".csv",
  ".log",
  ".xml",
  ".svg",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".go",
  ".py",
  ".sh",
  ".css",
]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function fileExtOf(relPath: string): string {
  const base = relPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

export function classifyArchivePreviewKind(relPath: string): ArchivePreviewKind {
  const ext = fileExtOf(relPath);
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (HTML_EXTS.has(ext)) return "html";
  if (TEXT_EXTS.has(ext)) return "text";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "binary";
}

export function resolveArchivePreviewRoots(
  sessionRoot?: string | null,
  boundPath?: string | null,
): string[] {
  const roots: string[] = [];
  for (const root of [sessionRoot, boundPath]) {
    const trimmed = root?.trim();
    if (trimmed && !roots.includes(trimmed)) roots.push(trimmed);
  }
  return roots;
}
