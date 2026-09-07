/**
 * 项目档案「扫描录入」：把用户指定目录里的文档路径解析成可入库草稿。
 * 纯函数，不读磁盘、不调用 sync——入库走 createArtifact，避免空清单 / 子集清单 purge。
 */

import type {
  ArtifactScope,
  ArtifactStage,
  CreateProjectArtifactRequest,
} from "@multica/core/types";
import {
  CHANGE_LOG_SKIP_DIRS,
  looksLikeChangeLogTree,
  parseArchivePath,
  type ParsedArchivePath,
} from "./archive-inspector";

export const ARCHIVE_DOC_EXTS = new Set([".md", ".html"]);
export const ARCHIVE_SKIP_DIRS = new Set([
  "_attic",
  "assets",
  "node_modules",
  ".git",
  "__pycache__",
  ...CHANGE_LOG_SKIP_DIRS,
]);

const CONTRACT_ROOTS = new Set([
  "overview",
  "requirements",
  "filing",
  "change_logs",
  "projects",
  "_shared",
  "docs",
]);
const OVERVIEW_CATS = new Set([
  "research",
  "product-design",
  "architecture",
  "retrospective",
]);
const FILING_CATS = new Set(["software-copyright", "patent"]);
const REQ_KEY_RE = /^REQ-\d{8}-\d{2}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_RE = /(?:^|[._-])(?:v|r)(\d+)(?:[._-]|\.|$)/i;

export type ArchiveImportStatus =
  | "importable"
  | "exists"
  | "unclassified"
  | "skipped";

export interface ArchiveScanFile {
  /** 扫描根下的相对路径（Web 为 webkitRelativePath）。 */
  relPath: string;
  content?: string;
}

export interface ArchiveFrontmatter {
  docType?: string;
  issueId?: string;
  requirementKey?: string;
  version?: number;
}

export interface ArchiveImportDraft {
  scope: ArtifactScope;
  stage: ArtifactStage | null;
  doc_type: string;
  rel_path: string;
  requirement_key: string | null;
  issue_id: string | null;
  version: number;
  content?: string;
}

export interface ArchiveImportRow {
  scannedPath: string;
  relPath: string;
  status: ArchiveImportStatus;
  reason: string;
  selected: boolean;
  draft?: ArchiveImportDraft;
}

export function fileExt(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

export function isArchiveDocPath(rel: string): boolean {
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some((part) => ARCHIVE_SKIP_DIRS.has(part))) return false;
  return ARCHIVE_DOC_EXTS.has(fileExt(parts[parts.length - 1] ?? ""));
}

/**
 * 把扫描到的相对路径收成契约路径：
 * - webkitdirectory 的「选中文件夹名/overview/...」去掉首段
 * - 选中 requirements/ 或 overview/ 子目录时补回区段前缀
 * - projects/<key>/... 收成项目相对路径（与 CLI 清单一致）
 */
export function normalizeScanRel(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return "";
  let rest = parts;
  if (
    rest.length >= 2 &&
    !CONTRACT_ROOTS.has(rest[0] ?? "") &&
    CONTRACT_ROOTS.has(rest[1] ?? "")
  ) {
    rest = rest.slice(1);
  }
  if (REQ_KEY_RE.test(rest[0] ?? "")) {
    rest = ["requirements", ...rest];
  } else if (OVERVIEW_CATS.has(rest[0] ?? "")) {
    rest = ["overview", ...rest];
  } else if (FILING_CATS.has(rest[0] ?? "")) {
    rest = ["filing", ...rest];
  }
  if (rest[0] === "projects" && rest.length >= 3) {
    rest = rest.slice(2);
  }
  if (rest[0] !== "change_logs" && looksLikeChangeLogTree(rest)) {
    rest = ["change_logs", ...rest];
  }
  return rest.join("/");
}

export function parseArchiveFrontmatter(content: string): ArchiveFrontmatter {
  const result: ArchiveFrontmatter = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return result;
  for (const line of match[1]?.split(/\r?\n/) ?? []) {
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$/);
    if (!kv) continue;
    const key = kv[1]?.toLowerCase() ?? "";
    const value = stripYamlScalar(kv[2] ?? "");
    if (!value) continue;
    if (key === "doc_type" || key === "doctype") result.docType = value;
    if (key === "multica_issue_id" || key === "issue_id") result.issueId = value;
    if (key === "requirement_key" || key === "req_key") result.requirementKey = value;
    if (key === "version") {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 1) result.version = n;
    }
  }
  return result;
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** spec_infos/.../prototypes/ 下的 HTML 原型页，不是架构正文。 */
export function isOptionalPrototypeAsset(relPath: string): boolean {
  return relPath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .includes("prototypes");
}

export function inferDocType(
  relPath: string,
  parsed: ParsedArchivePath,
  frontmatter: ArchiveFrontmatter,
): string | null {
  if (frontmatter.docType?.trim()) return frontmatter.docType.trim();
  if (isOptionalPrototypeAsset(relPath)) return "prototype";
  if (parsed.docTypeHint) return parsed.docTypeHint;
  const name = (relPath.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  if (name === "project.md") return "project";
  if (name.includes("test-plan")) return "test-plan";
  if (name.includes("decomposition")) return "decomposition";
  if (name.includes("product-design")) return "product-design";
  if (name.includes("acceptance")) return "acceptance";
  if (name.startsWith("requirement")) return "requirement";
  if (name.includes("report")) return "report";
  if (name.includes("architecture")) return "architecture";
  if (name.includes("research") || name.includes("调研")) return "research";
  if (name.includes("retrospective") || name.includes("复盘")) return "retrospective";
  if (name.includes("prototype") || name.endsWith(".html")) return "prototype";
  if (name.startsWith("plan") || name.includes("-plan.")) return "plan";
  if (name.includes("design")) return "design";
  if (parsed.stage === 1 && name.endsWith(".html")) return "prototype";
  return null;
}

export function inferVersion(relPath: string, frontmatter: ArchiveFrontmatter): number {
  if (frontmatter.version && frontmatter.version >= 1) return frontmatter.version;
  const name = relPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const match = VERSION_RE.exec(name);
  const n = match ? Number(match[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function asArtifactScope(scope: ParsedArchivePath["scope"]): ArtifactScope | null {
  if (scope === "shared" || scope === "project" || scope === "requirement") {
    return scope;
  }
  return null;
}

function asStage(stage: number | null): ArtifactStage | null {
  if (stage === 1 || stage === 2 || stage === 3 || stage === 4) return stage;
  return null;
}

export function classifyArchiveScan(
  files: ArchiveScanFile[],
  existingRelPaths: Iterable<string>,
): ArchiveImportRow[] {
  const existing = new Set(
    [...existingRelPaths].map((path) => normalizeScanRel(path)).filter(Boolean),
  );
  const rows: ArchiveImportRow[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const scannedPath = file.relPath.replace(/\\/g, "/");
    if (!isArchiveDocPath(scannedPath)) {
      rows.push({
        scannedPath,
        relPath: scannedPath,
        status: "skipped",
        reason: "非档案文档或位于跳过目录",
        selected: false,
      });
      continue;
    }

    const relPath = normalizeScanRel(scannedPath);
    if (!relPath) {
      rows.push({
        scannedPath,
        relPath: scannedPath,
        status: "unclassified",
        reason: "空路径",
        selected: false,
      });
      continue;
    }
    if (seen.has(relPath)) {
      rows.push({
        scannedPath,
        relPath,
        status: "skipped",
        reason: "同目录扫描到重复路径",
        selected: false,
      });
      continue;
    }
    seen.add(relPath);

    const parsed = parseArchivePath(relPath);
    if (parsed.scope === "repo") {
      rows.push({
        scannedPath,
        relPath,
        status: "skipped",
        reason: "仓库辅助目录，不入库",
        selected: false,
      });
      continue;
    }

    const frontmatter = file.content ? parseArchiveFrontmatter(file.content) : {};
    const scope = asArtifactScope(parsed.scope);
    const docType = inferDocType(relPath, parsed, frontmatter);
    const errors = parsed.errors.filter(Boolean);

    if (!scope || !docType || errors.length > 0) {
      rows.push({
        scannedPath,
        relPath,
        status: "unclassified",
        reason: errors[0] ?? (!scope ? "无法归入 overview / requirements / filing / change_logs" : "无法识别文档类型"),
        selected: false,
      });
      continue;
    }

    if (existing.has(relPath)) {
      rows.push({
        scannedPath,
        relPath,
        status: "exists",
        reason: "档案索引已有相同路径",
        selected: false,
      });
      continue;
    }

    const issueId =
      frontmatter.issueId && UUID_RE.test(frontmatter.issueId)
        ? frontmatter.issueId
        : null;
    const optionalPrototype = isOptionalPrototypeAsset(relPath);
    rows.push({
      scannedPath,
      relPath,
      status: "importable",
      reason: optionalPrototype
        ? "原型页默认不入库，需要请勾选"
        : "将写入档案索引（source=manual）",
      selected: !optionalPrototype,
      draft: {
        scope,
        stage: asStage(parsed.stage),
        doc_type: docType,
        rel_path: relPath,
        requirement_key: frontmatter.requirementKey ?? parsed.reqKey,
        issue_id: issueId,
        version: inferVersion(relPath, frontmatter),
        ...(file.content != null ? { content: file.content } : {}),
      },
    });
  }

  return rows;
}

const INDEX_CONTENT_MAX = 64_000;

function shouldIndexContent(relPath: string, content: string | undefined): boolean {
  if (content == null) return false;
  if (content.length > INDEX_CONTENT_MAX) return false;
  return fileExt(relPath) !== ".html";
}

/** 只收集勾选且可入库的草稿。不会生成 sync 清单，避免子集 purge。 */
export function selectedImportRequests(
  rows: ArchiveImportRow[],
): CreateProjectArtifactRequest[] {
  return rows
    .filter((row) => row.selected && row.status === "importable" && row.draft)
    .map((row) => {
      const draft = row.draft!;
      return {
        scope: draft.scope,
        stage: draft.stage,
        doc_type: draft.doc_type,
        rel_path: draft.rel_path,
        requirement_key: draft.requirement_key,
        issue_id: draft.issue_id,
        version: draft.version,
        ...(shouldIndexContent(draft.rel_path, draft.content)
          ? { content: draft.content }
          : {}),
      };
    });
}

export function isArchiveResourceMissingError(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "body" in err
      ? (err as { body?: { code?: unknown } }).body?.code
      : undefined;
  if (code === "archive_resource_missing") return true;
  const message = err instanceof Error ? err.message : "";
  return message.includes("no archive resource configured");
}

export function resolveArchiveBindTarget(
  archiveResourceId: string | null | undefined,
  resources: ReadonlyArray<{ id: string; resource_type: string }>,
): { status: "bound" | "bind-local" | "missing"; resourceId: string | null } {
  if (archiveResourceId && resources.some((resource) => resource.id === archiveResourceId)) {
    return { status: "bound", resourceId: archiveResourceId };
  }
  const local = resources.find((resource) => resource.resource_type === "local_directory");
  if (local) {
    return { status: "bind-local", resourceId: local.id };
  }
  return { status: "missing", resourceId: null };
}

export function importScanSummary(rows: ArchiveImportRow[]): {
  importable: number;
  exists: number;
  unclassified: number;
  skipped: number;
  selected: number;
} {
  return {
    importable: rows.filter((row) => row.status === "importable").length,
    exists: rows.filter((row) => row.status === "exists").length,
    unclassified: rows.filter((row) => row.status === "unclassified").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
    selected: rows.filter(
      (row) => row.selected && row.status === "importable",
    ).length,
  };
}
