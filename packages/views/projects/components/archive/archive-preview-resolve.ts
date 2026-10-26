import { normalizeScanRel } from "./archive-import";

const PREVIEW_SHELVES = [
  "research",
  "product-design",
  "architecture",
  "retrospective",
] as const;

/** 货架挪过之后磁盘可能还在旧路径：按四货架改写；列举时再按文件名回退。 */
export function previewRelPathCandidates(relPath: string): string[] {
  const raw = relPath.replace(/\\/g, "/");
  const parts = raw.split("/").filter(Boolean);
  const overviewAt = parts.findIndex(
    (part, index) =>
      part === "overview" &&
      (PREVIEW_SHELVES as readonly string[]).includes(parts[index + 1] ?? ""),
  );
  const out = new Set<string>([raw]);
  if (overviewAt >= 0) {
    for (const shelf of PREVIEW_SHELVES) {
      out.add(
        [...parts.slice(0, overviewAt), "overview", shelf, ...parts.slice(overviewAt + 2)].join("/"),
      );
    }
  }
  return [...out];
}

export function ancestorPaths(absPath: string, max = 6): string[] {
  const normalized = absPath.replace(/\\/g, "/").replace(/\/$/, "");
  const out: string[] = [];
  let current = normalized;
  for (let i = 0; i < max; i++) {
    if (!current || current === "/" || /^[A-Za-z]:$/.test(current)) break;
    const depth = current.split("/").filter(Boolean).length;
    if (depth <= 2) break;
    out.push(current);
    const slash = current.lastIndexOf("/");
    if (slash <= 0) break;
    current = current.slice(0, slash);
  }
  return out;
}

const PROBE_SUFFIXES = ["projects_mgmt/projects", "projects_mgmt", "projects"];

export function previewProbeRoots(hintRoots: string[]): string[] {
  const probes = new Set<string>();
  for (const hint of hintRoots) {
    const trimmed = hint.trim().replace(/\\/g, "/").replace(/\/$/, "");
    if (!trimmed) continue;
    probes.add(trimmed);
    for (const ancestor of ancestorPaths(trimmed)) {
      for (const suffix of PROBE_SUFFIXES) {
        probes.add(`${ancestor}/${suffix}`);
      }
    }
  }
  return [...probes];
}

/** overview / requirements / filing 正文在 projects_mgmt，不在代码仓。 */
export function isContractRelPath(relPath: string): boolean {
  const path = relPath.replace(/\\/g, "/").replace(/^\//, "");
  return (
    path.startsWith("overview/") ||
    path.startsWith("requirements/") ||
    path.startsWith("filing/")
  );
}

export function contractMgmtRoots(hintRoots: string[]): string[] {
  return previewProbeRoots(hintRoots).filter((root) =>
    root.replace(/\\/g, "/").replace(/\/$/, "").endsWith("/projects_mgmt"),
  );
}

export function contractProjectsRoots(hintRoots: string[]): string[] {
  return previewProbeRoots(hintRoots).filter((root) =>
    root.replace(/\\/g, "/").replace(/\/$/, "").endsWith("/projects_mgmt/projects"),
  );
}

export function extractProjectKeysFromYaml(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/^[ \t]*-[ \t]+key:[ \t]+([A-Za-z0-9_-]+)/gm)) {
    const key = match[1];
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** 只对契约仓做全量列举，避免扫整个代码仓。 */
export function shouldListProbe(root: string): boolean {
  const normalized = root.replace(/\\/g, "/").replace(/\/$/, "");
  return (
    normalized.endsWith("/projects_mgmt") ||
    normalized.endsWith("/projects_mgmt/projects") ||
    /\/projects$/.test(normalized)
  );
}

export function matchListedPath(relPath: string, files: string[]): string | null {
  for (const candidate of previewRelPathCandidates(relPath)) {
    const raw = candidate.replace(/\\/g, "/");
    const normalized = normalizeScanRel(raw);
    const hit = files.find((file) => {
      const path = file.replace(/\\/g, "/");
      return (
        path === raw ||
        path === normalized ||
        path.endsWith(`/${raw}`) ||
        path.endsWith(`/${normalized}`) ||
        normalizeScanRel(path) === raw ||
        normalizeScanRel(path) === normalized
      );
    });
    if (hit) return hit;
  }
  const base = relPath.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  if (!base) return null;
  const byName = files.filter((file) => {
    const path = file.replace(/\\/g, "/");
    return path === base || path.endsWith(`/${base}`);
  });
  if (byName.length === 0) return null;
  return (
    byName.find((file) => file.replace(/\\/g, "/").includes("/overview/")) ??
    byName[0] ??
    null
  );
}
