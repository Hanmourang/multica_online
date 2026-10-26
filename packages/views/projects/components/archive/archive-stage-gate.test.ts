import { describe, expect, it } from "vitest";
import type { ArtifactStage, ProjectArtifact } from "@multica/core/types";
import {
  blockingReadiness,
  missingBlockingDocTypes,
  requirementMissingBlocking,
} from "./archive-stage-gate";

function artifact(docType: string, stage: number | null = null): ProjectArtifact {
  return {
    id: `${docType}-${stage ?? "root"}`,
    workspace_id: "ws",
    project_id: "p",
    resource_id: "r",
    scope: "requirement",
    stage,
    doc_type: docType,
    version: 1,
    rel_path: `requirements/REQ-20260913-01/${docType}.md`,
    blob_sha: "0",
    size_bytes: 0,
    source: "manual",
    synced_at: "2026-09-13T00:00:00Z",
    created_at: "2026-09-13T00:00:00Z",
    updated_at: "2026-09-13T00:00:00Z",
  } as ProjectArtifact;
}

describe("archive-stage-gate", () => {
  it("does not treat an arbitrary file as closing S2", () => {
    expect(missingBlockingDocTypes(2, [artifact("notes", 2)])).toEqual([
      "plan",
      "decomposition",
    ]);
    expect(missingBlockingDocTypes(2, [artifact("plan", 2)])).toEqual(["decomposition"]);
  });

  it("counts only requirement + blocking gates for readiness", () => {
    const files = new Map<ArtifactStage | null, ProjectArtifact[]>();
    files.set(null, [artifact("requirement")]);
    files.set(2, [artifact("plan", 2), artifact("decomposition", 2)]);
    files.set(3, [artifact("design", 3)]);
    expect(
      requirementMissingBlocking({ rootDocs: files.get(null) ?? [], filesByStage: files }),
    ).toBe(true);
    expect(
      blockingReadiness({ rootDocs: files.get(null) ?? [], filesByStage: files }),
    ).toEqual({ filled: 2, total: 5 });
  });

  it("treats S1 prototype as a blocking gate", () => {
    expect(missingBlockingDocTypes(1, [])).toEqual(["prototype"]);
    expect(missingBlockingDocTypes(1, [artifact("prototype", 1)])).toEqual([]);
  });
});
