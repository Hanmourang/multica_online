import type { CreateProjectArtifactRequest, ProjectArtifact } from "@multica/core/types";
import { writeArchiveFile } from "../../../platform/archive-fs";
import { renderArchiveTemplate } from "./archive-templates";

const REQ_KEY_RE = /^REQ-(\d{8})-(\d{2})$/;

export function nextRequirementKey(existing: Iterable<string | null | undefined>, now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const today = `${y}${m}${d}`;
  let max = 0;
  for (const raw of existing) {
    const match = REQ_KEY_RE.exec(raw ?? "");
    if (!match || match[1] !== today) continue;
    const n = Number(match[2]);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `REQ-${today}-${String(max + 1).padStart(2, "0")}`;
}

export function requirementKeysFromArtifacts(artifacts: ProjectArtifact[]): string[] {
  return artifacts
    .map((artifact) => artifact.requirement_key)
    .filter((key): key is string => Boolean(key));
}

const STAGE_DIRS = [
  "s1-prototype",
  "s2-plan",
  "s3-execution",
  "s4-acceptance",
] as const;

export async function scaffoldRequirementArchive(input: {
  issueId: string;
  title: string;
  existingKeys: string[];
  archiveRoot?: string | null;
  createArtifact: (body: CreateProjectArtifactRequest) => Promise<unknown>;
}): Promise<{ key: string; written: boolean }> {
  const key = nextRequirementKey(input.existingKeys);
  const title = input.title.trim() || key;
  const relPath = `requirements/${key}/requirement.md`;
  const content = renderArchiveTemplate({
    docType: "requirement",
    title,
    requirementKey: key,
    issueId: input.issueId,
  });
  await input.createArtifact({
    scope: "requirement",
    doc_type: "requirement",
    doc_class: "prd",
    rel_path: relPath,
    requirement_key: key,
    issue_id: input.issueId,
    content,
    version: 1,
  });
  let written = false;
  if (input.archiveRoot) {
    const file = await writeArchiveFile(input.archiveRoot, relPath, content);
    written = file.ok;
    if (file.ok) {
      await Promise.all(
        STAGE_DIRS.map((dir) =>
          writeArchiveFile(input.archiveRoot!, `requirements/${key}/${dir}/.gitkeep`, ""),
        ),
      );
    }
  }
  return { key, written };
}

export function resolveInboxRoots(archiveRoot: string | null | undefined): string[] {
  if (!archiveRoot) return [];
  const norm = archiveRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const roots = new Set<string>();
  roots.add(`${norm}/_shared/inbox`);
  const projectsIdx = norm.lastIndexOf("/projects/");
  if (projectsIdx >= 0) {
    roots.add(`${norm.slice(0, projectsIdx)}/_shared/inbox`);
  }
  if (norm.endsWith("/projects_mgmt")) {
    roots.add(`${norm}/_shared/inbox`);
  }
  return [...roots];
}
