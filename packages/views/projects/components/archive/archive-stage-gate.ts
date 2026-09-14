import type { ArtifactStage, ProjectArtifact } from "@multica/core/types";

/** 与 checklist.yaml / stage_gate 对齐的 blocking 缺件：不数格子里的任意文件。 */
export const BLOCKING_BY_STAGE: Partial<Record<ArtifactStage, string[]>> = {
  1: ["prototype"],
  2: ["plan", "decomposition"],
  3: ["design", "test-plan"],
  4: ["acceptance", "report"],
};

export const BLOCKING_STAGES: ArtifactStage[] = [1, 2, 3, 4];

export function missingBlockingDocTypes(
  stage: ArtifactStage,
  files: ProjectArtifact[],
): string[] {
  const needed = BLOCKING_BY_STAGE[stage];
  if (!needed) return [];
  return needed.filter((docType) => !files.some((artifact) => artifact.doc_type === docType));
}

export function hasRequirementDoc(rootDocs: ProjectArtifact[]): boolean {
  return rootDocs.some((artifact) => artifact.doc_type === "requirement");
}

export function requirementMissingBlocking(input: {
  rootDocs: ProjectArtifact[];
  filesByStage: Map<ArtifactStage | null, ProjectArtifact[]>;
}): boolean {
  if (!hasRequirementDoc(input.rootDocs)) return true;
  return BLOCKING_STAGES.some(
    (stage) => missingBlockingDocTypes(stage, input.filesByStage.get(stage) ?? []).length > 0,
  );
}

export function blockingReadiness(input: {
  rootDocs: ProjectArtifact[];
  filesByStage: Map<ArtifactStage | null, ProjectArtifact[]>;
}): { filled: number; total: number } {
  const req = hasRequirementDoc(input.rootDocs) ? 1 : 0;
  const stages = BLOCKING_STAGES.filter(
    (stage) => missingBlockingDocTypes(stage, input.filesByStage.get(stage) ?? []).length === 0,
  ).length;
  return { filled: req + stages, total: 1 + BLOCKING_STAGES.length };
}
