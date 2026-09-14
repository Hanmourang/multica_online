/**
 * 契约文档 YAML 头的写回。改绑定默认改 Git 正本（_shared/archive/07 §5），
 * 不要只改 Multica 指针。
 */

export type ArchiveFrontmatterPatch = {
  docType?: string | null;
  docClass?: string | null;
  docModule?: string | null;
  issueId?: string | null;
  requirementKey?: string | null;
};

const READ_KEYS: Record<string, keyof ArchiveFrontmatterPatch> = {
  doc_type: "docType",
  doctype: "docType",
  doc_class: "docClass",
  docclass: "docClass",
  doc_module: "docModule",
  docmodule: "docModule",
  multica_issue_id: "issueId",
  issue_id: "issueId",
  requirement_key: "requirementKey",
  req_key: "requirementKey",
};

const WRITE_KEYS: { field: keyof ArchiveFrontmatterPatch; yaml: string }[] = [
  { field: "docType", yaml: "doc_type" },
  { field: "docClass", yaml: "doc_class" },
  { field: "docModule", yaml: "doc_module" },
  { field: "issueId", yaml: "multica_issue_id" },
  { field: "requirementKey", yaml: "requirement_key" },
];

export function upsertArchiveFrontmatter(
  content: string,
  patch: ArchiveFrontmatterPatch,
): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  const header = match?.[1] ?? "";
  const rest = match ? content.slice(match[0].length) : content.replace(/^\uFEFF/, "");
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = header ? header.split(/\r?\n/) : [];
  const seen = new Set<keyof ArchiveFrontmatterPatch>();
  const next: string[] = [];

  for (const line of lines) {
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:/);
    const rawKey = kv?.[1]?.toLowerCase() ?? "";
    const field = READ_KEYS[rawKey];
    if (field && Object.prototype.hasOwnProperty.call(patch, field)) {
      if (seen.has(field)) continue;
      seen.add(field);
      const value = patch[field];
      if (value == null || value === "") continue;
      const yaml = WRITE_KEYS.find((row) => row.field === field)?.yaml ?? rawKey;
      next.push(`${yaml}: ${escapeYamlScalar(value)}`);
      continue;
    }
    next.push(line);
  }

  for (const { field, yaml } of WRITE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field) || seen.has(field)) {
      continue;
    }
    const value = patch[field];
    if (value == null || value === "") continue;
    next.push(`${yaml}: ${escapeYamlScalar(value)}`);
  }

  const block = next.join(newline);
  const body = rest.replace(/^\r?\n/, "");
  return `---${newline}${block}${newline}---${newline}${body}`;
}

function escapeYamlScalar(value: string): string {
  if (/[:#]|^\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}
