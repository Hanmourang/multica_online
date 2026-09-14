export type RecognitionFailure = {
  rel?: string;
  failure_attribution?: string;
  matched_source?: string;
};

export type RecognitionReport = {
  coverage?: number;
  total?: number;
  recognized?: number;
  unclassified?: number;
  by_source?: Record<string, number>;
  attribution?: Record<string, number>;
  failures?: RecognitionFailure[];
};

export const RECOGNITION_JSON_REL = "_shared/archive/RECOGNITION.json";

export const RECOGNITION_CLI =
  "python3 _shared/archive/tools/doc_classifier.py recognition --format json --out _shared/archive/RECOGNITION.json";

export function parseRecognitionReport(raw: string): RecognitionReport | null {
  try {
    const parsed = JSON.parse(raw) as RecognitionReport;
    if (!parsed || typeof parsed !== "object") return null;
    if (
      parsed.coverage == null &&
      parsed.total == null &&
      parsed.by_source == null &&
      parsed.attribution == null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 从已绑档案根走到 projects_mgmt，供读取 RECOGNITION.json。 */
export function resolveProjectsMgmtRoot(archiveRoot: string | null | undefined): string | null {
  if (!archiveRoot) return null;
  const norm = archiveRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const mgmt = norm.lastIndexOf("/projects_mgmt");
  if (mgmt >= 0) return norm.slice(0, mgmt + "/projects_mgmt".length);
  const projects = norm.lastIndexOf("/projects/");
  if (projects >= 0) return norm.slice(0, projects);
  return norm;
}
