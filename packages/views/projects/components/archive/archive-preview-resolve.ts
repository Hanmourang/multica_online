import { normalizeScanRel } from "./archive-import";

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
  const raw = relPath.replace(/\\/g, "/");
  const normalized = normalizeScanRel(raw);
  return (
    files.find((file) => {
      const path = file.replace(/\\/g, "/");
      return (
        path === raw ||
        path === normalized ||
        path.endsWith(`/${raw}`) ||
        path.endsWith(`/${normalized}`) ||
        normalizeScanRel(path) === raw ||
        normalizeScanRel(path) === normalized
      );
    }) ?? null
  );
}
