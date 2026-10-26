/**
 * 档案列表展示：文件名不带目录；标签默认取文件直属目录，人工覆盖优先。
 */

function pathParts(relPath: string): string[] {
  return relPath.replace(/\\/g, "/").split("/").filter(Boolean);
}

export function artifactDisplayName(relPath: string): string {
  const parts = pathParts(relPath);
  return parts[parts.length - 1] ?? relPath;
}

/** 路径最后一级目录名；仓库根文件没有标签。 */
export function artifactParentDir(relPath: string): string | undefined {
  const parts = pathParts(relPath);
  if (parts.length < 2) return undefined;
  const parent = parts[parts.length - 2]?.trim();
  return parent || undefined;
}

/** 人工 `doc_module` 优先，否则用直属目录。 */
export function artifactModuleTag(
  relPath: string,
  override?: string | null,
): string | undefined {
  const manual = override?.trim();
  if (manual) return manual;
  return artifactParentDir(relPath);
}

/** 档案标签色板：同名稳定、异名尽量撞色。 */
export const MODULE_TAG_TONES = {
  sky: "border-sky-500/55 bg-sky-400/22 font-medium text-sky-950 dark:border-sky-300/50 dark:bg-sky-400/20 dark:text-sky-50",
  violet:
    "border-violet-500/55 bg-violet-400/22 font-medium text-violet-950 dark:border-violet-300/50 dark:bg-violet-400/20 dark:text-violet-50",
  emerald:
    "border-emerald-500/55 bg-emerald-400/22 font-medium text-emerald-950 dark:border-emerald-300/50 dark:bg-emerald-400/20 dark:text-emerald-50",
  orange:
    "border-orange-500/55 bg-orange-400/22 font-medium text-orange-950 dark:border-orange-300/50 dark:bg-orange-400/20 dark:text-orange-50",
  rose: "border-rose-500/55 bg-rose-400/22 font-medium text-rose-950 dark:border-rose-300/50 dark:bg-rose-400/20 dark:text-rose-50",
  teal: "border-teal-500/55 bg-teal-400/22 font-medium text-teal-950 dark:border-teal-300/50 dark:bg-teal-400/20 dark:text-teal-50",
  indigo:
    "border-indigo-500/55 bg-indigo-400/22 font-medium text-indigo-950 dark:border-indigo-300/50 dark:bg-indigo-400/20 dark:text-indigo-50",
  amber:
    "border-amber-500/55 bg-amber-400/22 font-medium text-amber-950 dark:border-amber-300/50 dark:bg-amber-400/20 dark:text-amber-50",
  fuchsia:
    "border-fuchsia-500/55 bg-fuchsia-400/22 font-medium text-fuchsia-950 dark:border-fuchsia-300/50 dark:bg-fuchsia-400/20 dark:text-fuchsia-50",
  slate:
    "border-slate-400/70 bg-slate-300/25 font-medium text-slate-900 dark:border-slate-400/50 dark:bg-slate-400/20 dark:text-slate-50",
} as const;

export type ModuleTagTone = keyof typeof MODULE_TAG_TONES;

const TONE_ORDER = Object.keys(MODULE_TAG_TONES) as ModuleTagTone[];

/** 截图里已出现的常见标签 + 契约货架目录，固定语义色。 */
const NAMED_TAG_TONES: Record<string, ModuleTagTone> = {
  本体对象: "violet",
  ontology: "violet",
  查阅: "sky",
  图通: "indigo",
  图谱: "indigo",
  变更: "orange",
  changelog: "orange",
  "change-log": "orange",
  申报稿: "teal",
  申报链: "teal",
  档案同步: "slate",
  architecture: "indigo",
  "product-design": "fuchsia",
  features: "fuchsia",
  research: "sky",
  retrospective: "slate",
  filing: "teal",
  prototype: "violet",
  plan: "emerald",
  design: "fuchsia",
  acceptance: "emerald",
  billing: "orange",
};

function hashTag(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** 同一标签永远同色；未登记的标签按哈希落到色板。 */
export function artifactModuleTagTone(tag: string): ModuleTagTone {
  const trimmed = tag.trim();
  if (!trimmed) return "amber";
  return (
    NAMED_TAG_TONES[trimmed] ??
    NAMED_TAG_TONES[trimmed.toLowerCase()] ??
    TONE_ORDER[hashTag(trimmed.toLowerCase()) % TONE_ORDER.length] ?? "slate"
  );
}

export function artifactModuleTagToneClass(tag: string): string {
  return MODULE_TAG_TONES[artifactModuleTagTone(tag)];
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
