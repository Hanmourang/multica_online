/**
 * 「新增原型」的纯逻辑：判定可登记的文件、算下一个版本号、生成档案相对路径。
 *
 * 原型在库里是两行：project_artifact（正文指针，可带 attachment_id）+ 
 * issue_prototype_version（版本坐标，issue_id 为空 = 模块自有）。两者共用同一个
 * rel_path，`artifactForPrototypeVersion` 才能把版本行映射回可预览的档案。
 */

/** 只有 HTML 能进原型预览（classifyArchivePreviewKind 也是按扩展名分类）。 */
const PROTOTYPE_EXTENSIONS = new Set(["html", "htm"]);

export function fileExtensionOf(name: string): string {
  const base = name.trim().split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isPrototypeFile(name: string): boolean {
  return PROTOTYPE_EXTENSIONS.has(fileExtensionOf(name));
}

/** 下一个可用版本号：取需求轴与模块轴两端的最老版本号 + 1。 */
export function nextPrototypeVersion(
  versionNumbers: ReadonlyArray<number>,
): number {
  let max = 0;
  for (const value of versionNumbers) {
    if (Number.isFinite(value) && value > max) max = Math.floor(value);
  }
  return max + 1;
}

/**
 * 把档案相对路径拆成「目录 + 文件名」。档案列表里同一批原型往往共享长前缀
 * （change_logs/<repo>/...），原样平铺会让每行都以相同的 60 个字符开头，用户
 * 无法一眼区分；分层展示让差异点（-v2 / -v3）落在文件名上。
 */
export function splitArtifactPath(relPath: string): { dir: string; name: string } {
  const normalized = (relPath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const cut = normalized.lastIndexOf("/");
  if (cut <= 0) return { dir: "", name: normalized };
  return { dir: normalized.slice(0, cut), name: normalized.slice(cut + 1) };
}

/**
 * 按关键词过滤档案行（大小写不敏感，匹配整条 rel_path）。
 *
 * 真实项目里一个项目能攒到上百个 HTML 档案，平铺后只能靠滚动找；
 * 关键词为空时原样返回，避免调用方多写一条分支。
 */
export function filterArtifactsByKeyword<T extends { rel_path: string }>(
  rows: ReadonlyArray<T>,
  keyword: string,
): T[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return rows.slice();
  return rows.filter((row) => row.rel_path.toLowerCase().includes(needle));
}

/** 目录段：去掉路径分隔符与空白，其余（含中文）原样保留，便于人读。 */
export function prototypePathSlug(value: string | null | undefined): string {
  const cleaned = (value ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "module";
}

/**
 * 模块自有原型的档案相对路径：`prototypes/<模块名>/prototype-v<n>.<ext>`。
 * 与需求原型（`requirements/.../s1-prototype/...`）分树，互不覆盖文件名。
 */
export function prototypeRelPath(input: {
  moduleName?: string | null;
  version: number;
  fileName: string;
}): string {
  const ext = fileExtensionOf(input.fileName) || "html";
  const slug = prototypePathSlug(input.moduleName);
  const version = Math.max(1, Math.floor(input.version));
  return `prototypes/${slug}/prototype-v${version}.${ext}`;
}
