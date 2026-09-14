/**
 * 项目档案巡检：对齐 projects_mgmt/_shared SOP 06 章 + checklist.yaml。
 * 纯函数，不读磁盘——调用方传入相对路径列表（桌面扫目录或已索引 artifact）。
 */

import { resolveArchiveDocChoice } from "./archive-templates";

export type InspectSeverity = "blocking" | "suggestion";

export interface InspectFinding {
  severity: InspectSeverity;
  rule: string;
  path: string;
  message: string;
  /** 缺件时可一键从模板补齐。 */
  fix?: {
    docType: string;
    scope: "project" | "requirement";
    stage: 1 | 2 | 3 | 4 | null;
    requirementKey?: string;
    filename: string;
  };
}

export interface ChecklistItem {
  id: string;
  doc_type: string;
  scope: "project" | "requirement";
  stage: 1 | 2 | 3 | 4 | null;
  severity: "required" | "recommended";
  filename_pattern: string;
  description: string;
}

/** 与 _shared/sop/checklist.yaml 同源。改清单时两边一起改。 */
export const ARCHIVE_CHECKLIST: ChecklistItem[] = [
  {
    id: "req-requirement",
    doc_type: "requirement",
    scope: "requirement",
    stage: null,
    severity: "required",
    filename_pattern: "requirement*.md",
    description: "需求单（含状态头与 multica_issue_id）",
  },
  {
    id: "req-plan",
    doc_type: "plan",
    scope: "requirement",
    stage: 2,
    severity: "required",
    filename_pattern: "plan*.md",
    description: "执行计划（S2 拆解确认门）",
  },
  {
    id: "req-decomposition",
    doc_type: "decomposition",
    scope: "requirement",
    stage: 2,
    severity: "required",
    filename_pattern: "*decomposition*.md",
    description: "拆解明细（S2 拆解确认门）",
  },
  {
    id: "req-design",
    doc_type: "design",
    scope: "requirement",
    stage: 3,
    severity: "required",
    filename_pattern: "*design*.md",
    description: "实现方案（S3 执行门）",
  },
  {
    id: "req-test-plan",
    doc_type: "test-plan",
    scope: "requirement",
    stage: 3,
    severity: "required",
    filename_pattern: "*test-plan*.md",
    description: "测试方案（S3 执行门）",
  },
  {
    id: "req-acceptance",
    doc_type: "acceptance",
    scope: "requirement",
    stage: 4,
    severity: "required",
    filename_pattern: "*acceptance*.md",
    description: "验收标准（S4 验收门）",
  },
  {
    id: "req-report",
    doc_type: "report",
    scope: "requirement",
    stage: 4,
    severity: "required",
    filename_pattern: "*report*.md",
    description: "验收报告（S4 验收门）",
  },
  {
    id: "proj-architecture",
    doc_type: "architecture",
    scope: "project",
    stage: null,
    severity: "required",
    filename_pattern: "*.md",
    description: "项目架构总纲",
  },
  {
    id: "proj-project-md",
    doc_type: "project",
    scope: "project",
    stage: null,
    severity: "recommended",
    filename_pattern: "PROJECT.md",
    description: "项目登记（PROJECT.md）",
  },
  {
    id: "proj-research",
    doc_type: "research",
    scope: "project",
    stage: null,
    severity: "recommended",
    filename_pattern: "*.md",
    description: "立项调研",
  },
  {
    id: "proj-product-design",
    doc_type: "product-design",
    scope: "project",
    stage: null,
    severity: "recommended",
    filename_pattern: "*.md",
    description: "产品设计",
  },
  {
    id: "req-prototype",
    doc_type: "prototype",
    scope: "requirement",
    stage: 1,
    severity: "recommended",
    filename_pattern: "*.html",
    description: "可视化原型",
  },
  {
    id: "req-deliverables",
    doc_type: "deliverables",
    scope: "requirement",
    stage: 3,
    severity: "recommended",
    filename_pattern: "*deliverable*.md",
    description: "交付清单",
  },
  {
    id: "proj-retrospective",
    doc_type: "retrospective",
    scope: "project",
    stage: null,
    severity: "recommended",
    filename_pattern: "*.md",
    description: "项目复盘",
  },
  {
    id: "proj-filing",
    doc_type: "filing-software-copyright",
    scope: "project",
    stage: null,
    severity: "recommended",
    filename_pattern: "*.md",
    description: "软著申报材料",
  },
];

const OVERVIEW_CATS = new Set([
  "research",
  "product-design",
  "architecture",
  "retrospective",
]);
const FILING_CATS = new Set(["software-copyright", "patent"]);
const REQ_KEY_RE = /^REQ-\d{8}-\d{2}$/;
const STAGE_RE = /^s(\d+)-/;
const SKIP_TOP = new Set(["_attic", "assets", "node_modules", ".git"]);
/** 工作区 change_logs 下的备份 / 库快照，识别为跳过，不入库、不巡检阻塞。 */
export const CHANGE_LOG_SKIP_DIRS = new Set([
  "qoder_backup",
  "db_backups",
  "wiki_snapshots",
]);
const CHANGE_LOG_SHARED = new Set(["0.overview"]);
const CHANGE_LOG_MARKERS = new Set(["daily_logs", "qoder-plans", "prototypes"]);
const DATE_LOG_RE = /^(\d{8}|\d{4}-\d{2}-\d{2})[-_]/;
const MONTH_LOG_RE = /^\d{4}-\d{2}$/;

export function inferChangeLogDocType(relParts: string[]): string {
  const joined = relParts.join("/").toLowerCase();
  if (joined.includes("qoder-plans") || /(^|\/)plans\//.test(joined)) {
    return "work-plan";
  }
  const name = relParts[relParts.length - 1] ?? "";
  if (name.toLowerCase().endsWith(".html")) return "prototype";
  return "change-log";
}

/** 扫描根是 change_logs 或其项目子树时，路径长这样。 */
export function looksLikeChangeLogTree(parts: string[]): boolean {
  if (parts.length === 0) return false;
  if (CHANGE_LOG_SKIP_DIRS.has(parts[0] ?? "")) return false;
  if (parts[0] === "change_logs") return true;
  if (CHANGE_LOG_SHARED.has(parts[0] ?? "") || parts[0] === "qoder-plans") {
    return true;
  }
  if (CHANGE_LOG_MARKERS.has(parts[0] ?? "") || CHANGE_LOG_MARKERS.has(parts[1] ?? "")) {
    return true;
  }
  const last = (parts[parts.length - 1] ?? "").replace(/\.(md|html)$/i, "");
  if (DATE_LOG_RE.test(last) || MONTH_LOG_RE.test(last)) {
    const head = parts[0] ?? "";
    return (
      head !== "overview" &&
      head !== "requirements" &&
      head !== "filing" &&
      head !== "projects" &&
      head !== "_shared" &&
      head !== "docs"
    );
  }
  return false;
}

function applyChangeLogs(
  result: ParsedArchivePath,
  rest: string[],
): ParsedArchivePath {
  if (rest.some((part) => CHANGE_LOG_SKIP_DIRS.has(part))) {
    result.scope = "repo";
    return result;
  }
  if (rest.length === 0) {
    result.scope = "project";
    result.docTypeHint = "change-log";
    return result;
  }
  const head = rest[0] ?? "";
  if (CHANGE_LOG_SHARED.has(head)) {
    result.scope = "shared";
    result.docTypeHint = "change-log";
    return result;
  }
  if (head === "qoder-plans") {
    result.scope = "project";
    result.projectKey = result.projectKey ?? "qoder-plans";
    result.docTypeHint = "work-plan";
    return result;
  }
  if (head === "daily_logs") {
    result.scope = "project";
    result.docTypeHint = "change-log";
    return result;
  }
  if (!result.projectKey) result.projectKey = head;
  result.scope = "project";
  result.docTypeHint = inferChangeLogDocType(rest);
  return result;
}

export interface ParsedArchivePath {
  projectKey: string | null;
  scope: "shared" | "project" | "requirement" | "repo" | "orphan";
  reqKey: string | null;
  stage: number | null;
  docTypeHint: string | null;
  errors: string[];
}

/** 接受仓根相对路径或项目相对路径（CLI 清单常见后者）。 */
export function parseArchivePath(rel: string): ParsedArchivePath {
  const result: ParsedArchivePath = {
    projectKey: null,
    scope: "orphan",
    reqKey: null,
    stage: null,
    docTypeHint: null,
    errors: [],
  };
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) {
    result.errors.push("空路径");
    return result;
  }
  if (SKIP_TOP.has(parts[0] ?? "")) {
    result.scope = "repo";
    return result;
  }
  if (parts[0] === "_shared" || parts[0] === "docs") {
    result.scope = parts[0] === "_shared" ? "shared" : "repo";
    return result;
  }

  let rest = parts;
  if (parts[0] === "projects") {
    if (parts.length < 2) {
      result.errors.push("projects/ 下缺少 project_key");
      return result;
    }
    result.projectKey = parts[1] ?? null;
    rest = parts.slice(2);
  }

  if (rest.length === 0) return result;
  if (rest.length === 1 && (rest[0] ?? "").toUpperCase() === "PROJECT.MD") {
    result.scope = "project";
    result.docTypeHint = "project";
    return result;
  }
  const section = rest[0];
  if (section === "overview") {
    result.scope = "project";
    const cat = rest[1];
    if (cat && !OVERVIEW_CATS.has(cat)) {
      result.errors.push(
        `overview 类目 '${cat}' 非法，应为 research / product-design / architecture / retrospective`,
      );
    } else if (cat) {
      result.docTypeHint = cat;
    }
    return result;
  }
  if (section === "requirements") {
    result.scope = "requirement";
    const req = rest[1];
    if (req && !REQ_KEY_RE.test(req)) {
      result.errors.push(`REQ-KEY '${req}' 非法，格式应为 REQ-YYYYMMDD-NN`);
    } else if (req) {
      result.reqKey = req;
    }
    const stagePart = rest[2];
    if (stagePart) {
      const match = STAGE_RE.exec(stagePart);
      if (match) {
        const n = Number(match[1]);
        if (n < 1 || n > 4) {
          result.errors.push(`stage 越界 s${n}，仅允许 s1..s4`);
        } else {
          result.stage = n;
        }
      }
    }
    return result;
  }
  if (section === "filing") {
    result.scope = "project";
    const cat = rest[1];
    if (cat && !FILING_CATS.has(cat)) {
      result.errors.push(`filing 类目 '${cat}' 非法，应为 software-copyright / patent`);
    } else if (cat) {
      result.docTypeHint = `filing-${cat}`;
    }
    return result;
  }
  if (section === "change_logs") {
    return applyChangeLogs(result, rest.slice(1));
  }
  if (looksLikeChangeLogTree(rest)) {
    return applyChangeLogs(result, rest[0] === "change_logs" ? rest.slice(1) : rest);
  }
  result.errors.push(
    `未知区段 '${section}'，应为 overview / requirements / filing / change_logs`,
  );
  return result;
}

function globMatch(filename: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(filename);
}

function fileName(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? rel;
}

function dirOf(rel: string): string {
  const norm = rel.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx < 0 ? "" : norm.slice(0, idx);
}

export function inspectArchivePaths(relPaths: string[]): {
  findings: InspectFinding[];
  blocking: number;
  suggestions: number;
} {
  const findings: InspectFinding[] = [];
  const parsedRows = relPaths.map((path) => ({
    path,
    parsed: parseArchivePath(path),
  }));

  for (const row of parsedRows) {
    for (const error of row.parsed.errors) {
      findings.push({
        severity: "blocking",
        rule: "path.contract",
        path: row.path,
        message: error,
      });
    }
  }

  const reqKeys = new Set<string>();
  for (const row of parsedRows) {
    if (row.parsed.reqKey) reqKeys.add(row.parsed.reqKey);
  }

  for (const item of ARCHIVE_CHECKLIST) {
    const severity: InspectSeverity =
      item.severity === "required" ? "blocking" : "suggestion";
    if (item.scope === "project") {
      const dir =
        item.doc_type.startsWith("filing-")
          ? `filing/${item.doc_type.slice("filing-".length)}`
          : item.doc_type === "project"
            ? null
            : `overview/${item.doc_type}`;
      const hit = parsedRows.some((row) => {
        const norm = row.path.replace(/\\/g, "/");
        if (!globMatch(fileName(norm), item.filename_pattern)) return false;
        if (dir == null) {
          return (
            fileName(norm) === "PROJECT.md" &&
            !norm.includes("/overview/") &&
            !norm.includes("/requirements/") &&
            !norm.includes("/filing/")
          );
        }
        return norm.includes(`/${dir}/`) || norm.startsWith(`${dir}/`);
      });
      if (!hit) {
        findings.push({
          severity,
          rule: `checklist.${item.id}`,
          path: `${dir}/`,
          message: `缺${item.severity === "required" ? "必备" : "推荐"}文档「${item.description}」`,
          fix: {
            docType: item.doc_type,
            scope: "project",
            stage: item.stage,
            filename: defaultFilename(item),
          },
        });
      }
      continue;
    }

    if (reqKeys.size === 0) {
      findings.push({
        severity,
        rule: `checklist.${item.id}`,
        path: "requirements/",
        message: `尚未发现 REQ-YYYYMMDD-NN 目录，无法校验「${item.description}」`,
      });
      continue;
    }

    for (const reqKey of reqKeys) {
      const stageDir =
        item.stage == null ? `requirements/${reqKey}` : null;
      const hasStageDir =
        item.stage == null
          ? true
          : parsedRows.some((row) => {
              const parsed = row.parsed;
              return parsed.reqKey === reqKey && parsed.stage === item.stage;
            }) ||
            parsedRows.some((row) =>
              /\/s(\d+)-/.test(dirOf(row.path)) &&
              row.parsed.reqKey === reqKey &&
              row.parsed.stage === item.stage,
            );
      if (item.stage != null && !hasStageDir) {
        findings.push({
          severity,
          rule: `checklist.${item.id}`,
          path: `requirements/${reqKey}/`,
          message: `缺 s${item.stage}- 阶段目录，必备「${item.description}」无从放置`,
          fix: {
            docType: item.doc_type,
            scope: "requirement",
            stage: item.stage,
            requirementKey: reqKey,
            filename: defaultFilename(item),
          },
        });
        continue;
      }
      const hit = parsedRows.some((row) => {
        if (row.parsed.reqKey !== reqKey) return false;
        if (item.stage != null && row.parsed.stage !== item.stage) return false;
        if (item.stage == null && row.parsed.stage != null) {
          // requirement.md 应在 REQ 根，不在 sN 下也算命中（兼容两种放法）
          if (!globMatch(fileName(row.path), item.filename_pattern)) return false;
          return true;
        }
        return globMatch(fileName(row.path), item.filename_pattern);
      });
      if (!hit) {
        findings.push({
          severity,
          rule: `checklist.${item.id}`,
          path: stageDir ?? `requirements/${reqKey}/s${item.stage}-/`,
          message: `缺${item.severity === "required" ? "必备" : "推荐"}文档「${item.description}」（${item.filename_pattern}）`,
          fix: {
            docType: item.doc_type,
            scope: "requirement",
            stage: item.stage,
            requirementKey: reqKey,
            filename: defaultFilename(item),
          },
        });
      }
    }
  }

  return {
    findings,
    blocking: findings.filter((f) => f.severity === "blocking").length,
    suggestions: findings.filter((f) => f.severity === "suggestion").length,
  };
}

function defaultFilename(item: ChecklistItem): string {
  if (item.doc_type === "requirement") return "requirement.md";
  if (item.doc_type === "plan") return "plan.md";
  if (item.doc_type === "decomposition") return "decomposition.md";
  if (item.doc_type === "design") return "design.md";
  if (item.doc_type === "test-plan") return "test-plan.md";
  if (item.doc_type === "acceptance") return "acceptance.md";
  if (item.doc_type === "report") return "report-r1.md";
  if (item.doc_type === "project") return "PROJECT.md";
  if (item.doc_type === "prototype") return "prototype-v1.html";
  if (item.doc_type === "deliverables") return "deliverables.md";
  if (item.doc_type === "architecture") return "architecture.md";
  if (item.doc_type === "retrospective") return "retrospective.md";
  if (item.doc_type === "filing-software-copyright") return "originality.md";
  return `${item.doc_type}.md`;
}

export function suggestedRelPath(input: {
  scope: "project" | "requirement" | "shared";
  docType: string;
  stage?: 1 | 2 | 3 | 4 | null;
  requirementKey?: string | null;
  filename: string;
}): string {
  const shelf = resolveArchiveDocChoice(input.docType).shelf;
  const file = input.filename.trim() || `${shelf}.md`;
  if (input.scope === "shared") return `_shared/${file}`;
  if (input.scope === "project") {
    if (shelf === "project") return file === "PROJECT.md" ? "PROJECT.md" : `PROJECT.md`;
    if (shelf.startsWith("filing-")) {
      return `filing/${shelf.slice("filing-".length)}/${file}`;
    }
    if (shelf === "change-log" || shelf === "work-plan") {
      const folder = shelf === "work-plan" ? "plans" : "daily_logs";
      return `change_logs/${folder}/${file}`;
    }
    const overview = OVERVIEW_CATS.has(shelf) ? shelf : "architecture";
    return `overview/${overview}/${file}`;
  }
  const key = input.requirementKey?.trim() || "REQ-00000000-00";
  if (input.stage == null) return `requirements/${key}/${file}`;
  const slug =
    input.stage === 1
      ? "prototype"
      : input.stage === 2
        ? "plan"
        : input.stage === 3
          ? "execution"
          : "acceptance";
  return `requirements/${key}/s${input.stage}-${slug}/${file}`;
}

export function todayRequirementKey(seq = 1): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `REQ-${y}${m}${d}-${String(seq).padStart(2, "0")}`;
}
