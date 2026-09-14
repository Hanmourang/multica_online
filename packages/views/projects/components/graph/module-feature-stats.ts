import type {
  GraphNode,
  Issue,
  IssueStatus,
  ModuleGraphSummary,
  OntologyObject,
  ProjectArtifact,
  PrototypeMark,
  PrototypeVersion,
} from "@multica/core/types";
import { isTopLevelRequirement } from "../requirements/requirement-helpers";

export type ModuleHealth = "ok" | "busy" | "warn" | "unbound";

export type TaskRollup = {
  done: number;
  doing: number;
  stuck: number;
  other: number;
  total: number;
};

const DONE: IssueStatus[] = ["done", "cancelled"];
const DOING: IssueStatus[] = ["in_progress", "in_review"];
const STUCK: IssueStatus[] = ["blocked"];

export function issuesForModule(issues: Issue[], projectId: string, moduleId: string): Issue[] {
  return issues.filter((issue) => issue.project_id === projectId && issue.module_id === moduleId);
}

export function moduleRequirements(issues: Issue[]): Issue[] {
  return issues.filter((issue) => isTopLevelRequirement(issue));
}

export function moduleTasks(issues: Issue[]): Issue[] {
  return issues.filter((issue) => !isTopLevelRequirement(issue));
}

export function rollupTasks(tasks: Issue[]): TaskRollup {
  const rollup: TaskRollup = { done: 0, doing: 0, stuck: 0, other: 0, total: tasks.length };
  for (const task of tasks) {
    if (DONE.includes(task.status)) rollup.done += 1;
    else if (DOING.includes(task.status)) rollup.doing += 1;
    else if (STUCK.includes(task.status)) rollup.stuck += 1;
    else rollup.other += 1;
  }
  return rollup;
}

export function moduleHealth(bound: boolean, issues: Issue[]): ModuleHealth {
  if (!bound) return "unbound";
  if (issues.some((issue) => issue.status === "blocked")) return "warn";
  if (issues.some((issue) => DOING.includes(issue.status))) return "busy";
  if (issues.length === 0 || issues.every((issue) => DONE.includes(issue.status))) return "ok";
  return "warn";
}

export function objectKind(properties: Record<string, unknown> | undefined, entityType: string): string {
  const kind = properties?.kind;
  return typeof kind === "string" && kind.trim() ? kind : entityType;
}

export function objectTables(properties: Record<string, unknown> | undefined): string {
  const tables = properties?.tables;
  if (typeof tables === "string" && tables.trim()) return tables;
  if (Array.isArray(tables)) {
    return tables.filter((item): item is string => typeof item === "string").join(" · ");
  }
  return "";
}

export function strategyRows<T extends { key: string }>(rows: T[]): T[] {
  const preferred = rows.filter((row) => /^S\d/i.test(row.key));
  return preferred.length > 0 ? preferred : rows.filter((row) => row.key !== "community_id");
}

/** 已绑定走 graph_node_id；未绑定按社区/摘要同名投影，避免未绑定行数字全是 0。 */
export function summaryForModule(
  summaries: ModuleGraphSummary[],
  graphNodeId: string | null | undefined,
  moduleName: string,
): ModuleGraphSummary | undefined {
  if (graphNodeId) {
    const bound = summaries.find((row) => row.node_id === graphNodeId);
    if (bound) return bound;
  }
  return summaries.find((row) => row.name === moduleName);
}

export function communityLabel(nodeId: string | null | undefined): string {
  if (!nodeId) return "";
  return nodeId.replace(/^comm-/, "");
}

export type FeaturePointKind = "new" | "modify";

export type ExtractedFeaturePoint = {
  id: string;
  title: string;
  text: string;
  kind?: FeaturePointKind;
};

function readFpKind(attrs: string): FeaturePointKind | undefined {
  const match = /data-kind=["']([^"']+)["']/.exec(attrs);
  const value = match?.[1]?.trim();
  return value === "new" || value === "modify" ? value : undefined;
}

export function extractFeaturePoints(html: string): ExtractedFeaturePoint[] {
  const points: ExtractedFeaturePoint[] = [];
  const seen = new Set<string>();
  const re = /<([a-z][a-z0-9]*)\b([^>]*\bdata-fp=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null = re.exec(html);
  while (match) {
    const id = (match[3] ?? "").trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      const attrs = match[2] ?? "";
      const titleMatch = /data-title=["']([^"']+)["']/.exec(attrs);
      const text = (match[4] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      points.push({
        id,
        title: titleMatch?.[1] ?? id,
        text,
        kind: readFpKind(attrs),
      });
    }
    match = re.exec(html);
  }
  return points;
}

export type PrototypeModule = {
  id: string;
  title: string;
  text: string;
  source: "fp" | "heading" | "nav";
  kind?: FeaturePointKind;
};

export type DecoratedPrototypeFeature = PrototypeModule & {
  mark?: PrototypeMark;
};

export function decoratePrototypeFeatures(
  points: PrototypeModule[],
  marks: PrototypeMark[] | undefined,
): DecoratedPrototypeFeature[] {
  const byId = new Map((marks ?? []).map((mark) => [mark.detail_id, mark]));
  return points.map((point) => ({ ...point, mark: byId.get(point.id) }));
}

function innerText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function moduleSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]+/g, "")
    .slice(0, 40);
  return slug || "item";
}

/**
 * 对比用模块清单：有 data-fp 用 fp；否则抽 title / h1–h3 / nav，
 * 覆盖没有标注 fp 的 HTML 原型。
 */
export function extractPrototypeModules(html: string): PrototypeModule[] {
  const fps = extractFeaturePoints(html);
  if (fps.length > 0) {
    return fps.map((point) => ({ ...point, source: "fp" as const }));
  }
  const out: PrototypeModule[] = [];
  const seen = new Set<string>();
  const push = (id: string, title: string, text: string, source: PrototypeModule["source"]) => {
    if (!title || seen.has(id)) return;
    seen.add(id);
    out.push({ id, title, text, source });
  };
  const docTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (docTitle) {
    const text = innerText(docTitle[1] ?? "");
    push("doc.title", text, text, "heading");
  }
  const headingRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let heading: RegExpExecArray | null = headingRe.exec(html);
  while (heading) {
    const text = innerText(heading[2] ?? "");
    push(`h${heading[1]}.${moduleSlug(text)}`, text, text, "heading");
    heading = headingRe.exec(html);
  }
  const navRe = /<nav\b[\s\S]*?<\/nav>/gi;
  let nav: RegExpExecArray | null = navRe.exec(html);
  while (nav) {
    const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let link: RegExpExecArray | null = linkRe.exec(nav[0]);
    while (link) {
      const href = /href=["']([^"']+)["']/.exec(link[1] ?? "")?.[1] ?? "";
      const text = innerText(link[2] ?? "");
      push(`nav.${moduleSlug(href || text)}`, text, href ? `${text} · ${href}` : text, "nav");
      link = linkRe.exec(nav[0]);
    }
    nav = navRe.exec(html);
  }
  return out;
}

export function diffFeaturePoints(
  left: Array<{ id: string; title: string; text: string }>,
  right: Array<{ id: string; title: string; text: string }>,
): Array<{ id: string; title: string; kind: "added" | "removed" | "modified" | "same"; text: string }> {
  const leftMap = new Map(left.map((item) => [item.id, item]));
  const rightMap = new Map(right.map((item) => [item.id, item]));
  const ids = [...new Set([...leftMap.keys(), ...rightMap.keys()])];
  return ids.map((id) => {
    const a = leftMap.get(id);
    const b = rightMap.get(id);
    if (!a && b) return { id, title: b.title, kind: "added" as const, text: b.text };
    if (a && !b) return { id, title: a.title, kind: "removed" as const, text: a.text };
    if (a && b && a.text !== b.text) return { id, title: b.title, kind: "modified" as const, text: b.text };
    return { id, title: (b ?? a)?.title ?? id, kind: "same" as const, text: (b ?? a)?.text ?? "" };
  });
}

export function issueShortLabel(issue: Pick<Issue, "identifier" | "number" | "title">): string {
  const id = issue.identifier?.trim() || `#${issue.number}`;
  return `${id} ${issue.title}`.trim();
}

export function shortChipDate(iso: string | undefined): string {
  if (!iso) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[2]}-${match[3]}` : iso.slice(0, 10);
}

export function pickPrototypePair(versions: PrototypeVersion[]): {
  sorted: PrototypeVersion[];
  current?: PrototypeVersion;
  baseline?: PrototypeVersion;
} {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const current =
    [...sorted].reverse().find((row) => row.status === "confirmed") ?? sorted[sorted.length - 1];
  const baseline = [...sorted].reverse().find((row) => row.id !== current?.id) ?? current;
  return { sorted, current, baseline };
}

export function markRollup(marks: PrototypeMark[] | undefined): { ok: number; total: number } {
  const list = marks ?? [];
  return { ok: list.filter((mark) => mark.verdict === "ok").length, total: list.length };
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function artifactForPrototypeVersion(
  version: PrototypeVersion,
  artifacts: ProjectArtifact[],
  fallback: { workspace_id: string; project_id: string },
): ProjectArtifact {
  const path = normalizeRelPath(version.html_path);
  const base = path.split("/").pop() ?? path;
  const exact = artifacts.find((row) => normalizeRelPath(row.rel_path) === path);
  const suffix = artifacts.find((row) => normalizeRelPath(row.rel_path).endsWith(`/${path}`));
  const byBase = artifacts.filter((row) => (normalizeRelPath(row.rel_path).split("/").pop() ?? "") === base);
  const hit = exact ?? suffix ?? (byBase.length === 1 ? byBase[0] : undefined);
  if (hit) return hit;
  return {
    id: version.id,
    workspace_id: fallback.workspace_id,
    project_id: fallback.project_id,
    resource_id: "",
    issue_id: version.issue_id,
    scope: "requirement",
    stage: 1,
    doc_type: "prototype",
    version: version.version,
    rel_path: version.html_path,
    blob_sha: "",
    size_bytes: 0,
    source: "server",
    synced_at: version.created_at,
    created_at: version.created_at,
    updated_at: version.created_at,
  };
}

function fpNeedles(fpId: string): string[] {
  const id = fpId.toLowerCase();
  const last = id.split(".").pop() ?? id;
  return [...new Set([id, last].filter((item) => item.length >= 2))];
}

function haystack(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/** 变更 fp → 本体对象（codeHints 事实源）。对不上就返回空，禁止编造。 */
export function matchObjectForFeaturePoint(
  fpId: string,
  objects: OntologyObject[],
): OntologyObject | undefined {
  const needles = fpNeedles(fpId);
  return objects.find((object) => {
    const props = object.properties ? JSON.stringify(object.properties) : "";
    const text = haystack(object.qualified_name, object.domain, props);
    return needles.some((needle) => text.includes(needle));
  });
}

/** 变更 fp → 图谱邻域节点。对不上就是「契约态 · 无图谱节点」。 */
export function matchNodesForFeaturePoint(fpId: string, nodes: GraphNode[]): GraphNode[] {
  const needles = fpNeedles(fpId);
  return nodes.filter((node) => {
    const text = haystack(node.name, node.qualified_name, node.file_path);
    return needles.some((needle) => text.includes(needle));
  });
}

export function parseObjectProperties(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}
