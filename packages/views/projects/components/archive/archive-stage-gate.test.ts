import { describe, expect, it } from "vitest";
import type { ProjectArtifact } from "@multica/core/types";
import {
  columnForArtifact,
  columnReadiness,
  docKindOf,
  entersRequirementMatrix,
  missingBlockingDocKinds,
  requirementMissingBlocking,
  type RequirementColumn,
} from "./archive-stage-gate";

function artifact(relPath: string, stage: number | null = null): ProjectArtifact {
  return {
    id: relPath,
    workspace_id: "ws",
    project_id: "p",
    resource_id: "r",
    scope: "requirement",
    stage,
    doc_type: "research",
    version: 1,
    rel_path: relPath,
    blob_sha: "0",
    size_bytes: 0,
    source: "manual",
    synced_at: "2026-09-13T00:00:00Z",
    created_at: "2026-09-13T00:00:00Z",
    updated_at: "2026-09-13T00:00:00Z",
  } as ProjectArtifact;
}

const KEY = "requirements/REQ-20260913-01";

describe("archive-stage-gate", () => {
  it("classifies doc kinds from filename before directory", () => {
    expect(docKindOf(artifact(`${KEY}/requirement.md`, 1))).toBe("requirement");
    expect(docKindOf(artifact(`${KEY}/s1-prototype/prototype-v3.html`, 1))).toBe("prototype");
    expect(docKindOf(artifact(`${KEY}/s2-plan/plan.md`, 2))).toBe("plan");
    expect(docKindOf(artifact(`${KEY}/s2-plan/decomposition.md`, 2))).toBe("decomposition");
    expect(docKindOf(artifact(`${KEY}/s3-execution/design.md`, 3))).toBe("design");
    expect(docKindOf(artifact(`${KEY}/s3-execution/test-plan.md`, 3))).toBe("test-plan");
    expect(docKindOf(artifact(`${KEY}/s4-acceptance/report-r1.md`, 4))).toBe("report");
    expect(docKindOf(artifact(`${KEY}/s3-execution/src/extract-bridge.ts`, 3))).toBe("design");
    // 目录段兜底：落在 s3-execution 的正文/源码都算技术方案证据。
    expect(docKindOf(artifact(`${KEY}/s3-execution/notes.md`, 3))).toBe("design");
    expect(docKindOf(artifact(`${KEY}/notes.md`, 3))).toBe("other");
  });

  it("maps requirement docs onto the four columns regardless of stage", () => {
    expect(columnForArtifact(artifact(`${KEY}/requirement.md`, 1))).toBe("s0");
    expect(columnForArtifact(artifact(`${KEY}/s1-prototype/prototype.html`, 1))).toBe("s2");
    expect(columnForArtifact(artifact(`${KEY}/s2-plan/plan.md`, 2))).toBe("s3");
    expect(columnForArtifact(artifact(`${KEY}/s3-execution/test-plan.md`, 3))).toBe("s3");
    expect(columnForArtifact(artifact(`${KEY}/s4-acceptance/acceptance.md`, 4))).toBe("s4");
    // S5 不再单挂底部区块：无资产节点时按 stage 兜底进落地及复盘列。
    expect(columnForArtifact(artifact(`${KEY}/s5-iteration/iteration.md`, 5))).toBe("s4");
  });

  it("lets the asset node stage decide the column first", () => {
    // 资产节点（人工在资产管理里标的阶段）优先于文件名 / 目录段。
    expect(columnForArtifact(artifact(`${KEY}/requirement.md`, 1), "S3")).toBe("s3");
    expect(columnForArtifact(artifact(`${KEY}/s2-plan/plan.md`, 2), "S0")).toBe("s0");
    expect(columnForArtifact(artifact(`${KEY}/s3-execution/design.md`, 3), "S1")).toBe("s2");
    expect(columnForArtifact(artifact(`${KEY}/s3-execution/design.md`, 3), "S5")).toBe("s4");
    // 未标 / general 不由资产决定，回到文档类型判定。
    expect(columnForArtifact(artifact(`${KEY}/s3-execution/design.md`, 3), "general")).toBe("s3");
    expect(columnForArtifact(artifact(`${KEY}/s3-execution/design.md`, 3), null)).toBe("s3");
  });

  it("only pulls docs with an issue or task tag into the matrix", () => {
    const req = artifact(`${KEY}/notes.md`, null);
    expect(entersRequirementMatrix(req)).toBe(true);
    expect(
      entersRequirementMatrix({ ...req, scope: "project", issue_id: "issue-1", doc_type: "research" }),
    ).toBe(true);
    expect(
      entersRequirementMatrix({ ...req, scope: "project", issue_id: "issue-1", task_id: "task-1" }),
    ).toBe(true);
    // 项目级流水 / 未分阶保留区 / 共享 / 无归属的项目级文档不参与。
    expect(
      entersRequirementMatrix({ ...req, scope: "project", doc_type: "change-log", issue_id: "issue-1" }),
    ).toBe(false);
    expect(entersRequirementMatrix({ ...req, scope: "project", doc_type: "asset" })).toBe(false);
    expect(entersRequirementMatrix({ ...req, scope: "shared", issue_id: "issue-1" })).toBe(false);
    expect(entersRequirementMatrix({ ...req, scope: "project", doc_type: "research" })).toBe(false);
  });

  it("does not treat an arbitrary file as closing a column gate", () => {
    // 不在任何契约目录下的无名文件不外推，仍算缺件。
    expect(missingBlockingDocKinds("s3", [artifact(`${KEY}/notes.md`, 3)])).toEqual([
      "design",
      "test-plan",
    ]);
    expect(
      missingBlockingDocKinds("s3", [artifact(`${KEY}/s3-execution/design.md`, 3)]),
    ).toEqual(["test-plan"]);
  });

  it("counts readiness across the four columns", () => {
    const cells = new Map<RequirementColumn, ProjectArtifact[]>([
      ["s0", [artifact(`${KEY}/requirement.md`, 1)]],
      ["s2", [artifact(`${KEY}/s1-prototype/prototype.html`, 1)]],
      ["s3", [artifact(`${KEY}/s2-plan/plan.md`, 2)]],
      ["s4", []],
    ]);
    expect(requirementMissingBlocking(cells)).toBe(true);
    expect(columnReadiness(cells)).toEqual({ filled: 2, total: 4 });
  });

  it("treats S0 requirement brief as a blocking gate", () => {
    expect(missingBlockingDocKinds("s0", [])).toEqual(["requirement"]);
    expect(
      missingBlockingDocKinds("s0", [artifact(`${KEY}/requirement.md`, 1)]),
    ).toEqual([]);
  });
});
