/**
 * Heuristic split of the PM plan comment into 目标 / 阶段 / 风险.
 * Missing headings fall back to the whole plan (never throw).
 */
export interface PlanSections {
  goals: string | null;
  phases: string | null;
  risks: string | null;
  raw: string;
  split: boolean;
}

const HEADING =
  /^(#{1,3}\s*)(目标分解|Goals|目标|阶段划分|Phases|阶段|风险|Risks)\s*$/gim;

function headingKind(label: string): "goals" | "phases" | "risks" | null {
  const n = label.trim().toLowerCase();
  if (n === "目标分解" || n === "goals" || n === "目标") return "goals";
  if (n === "阶段划分" || n === "phases" || n === "阶段") return "phases";
  if (n === "风险" || n === "risks") return "risks";
  return null;
}

export function splitPlanSections(plan: string | null | undefined): PlanSections {
  const raw = plan ?? "";
  const empty: PlanSections = { goals: null, phases: null, risks: null, raw, split: false };
  if (!raw.trim()) return empty;

  const matches = [...raw.matchAll(HEADING)];
  if (matches.length === 0) return empty;

  const sections: PlanSections = { ...empty, split: true };
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const kind = headingKind(match[2] ?? "");
    if (!kind) continue;
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[i + 1];
    const end = next?.index ?? raw.length;
    sections[kind] = raw.slice(start, end).trim();
  }
  if (!sections.goals && !sections.phases && !sections.risks) {
    return empty;
  }
  return sections;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;

/** Pull work-item titles from plan list rows (phases first, then goals). */
export function extractPlanWorkItems(
  plan: string | null | undefined,
  limit = 6,
): string[] {
  const sections = splitPlanSections(plan);
  const chunks = [sections.phases, sections.goals];
  if (!sections.split) chunks.push(sections.raw);
  const seen = new Set<string>();
  const items: string[] = [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    for (const line of chunk.split("\n")) {
      const match = line.match(LIST_ITEM);
      if (!match) continue;
      const text = match[1].replace(/^[*_~`]+|[*_~`]+$/g, "").trim();
      if (text.length < 2) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(text);
      if (items.length >= limit) return items;
    }
  }
  return items;
}

export function titleMatchesGoals(title: string, goals: string | null): boolean {
  if (!goals) return true;
  const n = title.trim().toLowerCase();
  if (!n) return true;
  return goals.toLowerCase().includes(n);
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        return String(rec.id ?? rec.label ?? rec.name ?? rec.path ?? "");
      }
      return "";
    })
    .filter((s) => s.length > 0);
}

export function readGraphContext(graph: unknown): {
  nodes: string[];
  code_objects: string[];
  dependencies: string[];
  impacts: string[];
} {
  if (!graph || typeof graph !== "object") {
    return { nodes: [], code_objects: [], dependencies: [], impacts: [] };
  }
  const rec = graph as Record<string, unknown>;
  return {
    nodes: stringList(rec.nodes),
    code_objects: stringList(rec.code_objects),
    dependencies: stringList(rec.dependencies),
    impacts: stringList(rec.impacts),
  };
}

export function readAcceptanceSpec(spec: unknown): {
  path: string;
  version: string;
  assertions: string[];
  cases: string[];
  evidence: string[];
  coverage: string[];
  graph: string[];
} {
  if (!spec || typeof spec !== "object") {
    return {
      path: "",
      version: "",
      assertions: [],
      cases: [],
      evidence: [],
      coverage: [],
      graph: [],
    };
  }
  const rec = spec as Record<string, unknown>;
  return {
    path: typeof rec.path === "string" ? rec.path : "",
    version: typeof rec.version === "string" ? rec.version : rec.version != null ? String(rec.version) : "",
    assertions: stringList(rec.assertions),
    cases: stringList(rec.cases),
    evidence: stringList(rec.evidence ?? rec.sources),
    coverage: stringList(rec.coverage ?? rec.goals),
    graph: stringList(rec.graph ?? rec.impacts),
  };
}
