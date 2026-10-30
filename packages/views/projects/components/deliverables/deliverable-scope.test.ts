// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ProjectArtifact } from "@multica/core/types";
import { isDeliverableArtifact, splitDeliverables } from "./deliverable-scope";

function artifact(overrides: Partial<ProjectArtifact> = {}): ProjectArtifact {
  return {
    id: "a1",
    workspace_id: "w1",
    project_id: "p1",
    resource_id: "r1",
    scope: "project",
    doc_type: "research",
    version: 1,
    rel_path: "overview/research/a.md",
    blob_sha: "sha",
    size_bytes: 10,
    source: "sync",
    synced_at: "2026-10-30T00:00:00Z",
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
    ...overrides,
  };
}

describe("isDeliverableArtifact", () => {
  it("未关联资产的档案（git 同步 / agent / 手工）算交付物", () => {
    expect(isDeliverableArtifact(artifact())).toBe(true);
    expect(
      isDeliverableArtifact(artifact({ source: "agent", asset_binding_id: null })),
    ).toBe(true);
  });

  it("关联资产的产物（output）算交付物", () => {
    expect(
      isDeliverableArtifact(
        artifact({
          source: "asset",
          rel_path: "assets/other/out.md",
          asset_binding_id: "b1",
          asset_role: "output",
        }),
      ),
    ).toBe(true);
  });

  it("资产管理上传的输入物（input）不算交付物", () => {
    expect(
      isDeliverableArtifact(
        artifact({
          source: "asset",
          rel_path: "assets/other/uploaded.md",
          asset_binding_id: "b2",
          asset_role: "input",
        }),
      ),
    ).toBe(false);
  });

  it("关联资产但对象未标（null / 缺省）不算交付物", () => {
    expect(
      isDeliverableArtifact(
        artifact({ source: "asset", asset_binding_id: "b3", asset_role: null }),
      ),
    ).toBe(false);
    expect(isDeliverableArtifact(artifact({ source: "asset", asset_binding_id: "b4" }))).toBe(
      false,
    );
  });
});

describe("splitDeliverables", () => {
  it("保留未关联资产与产物，挡下输入物并如实计数", () => {
    const { deliverables, hiddenNonOutput } = splitDeliverables([
      artifact({ id: "git" }),
      artifact({ id: "out", asset_binding_id: "b1", asset_role: "output" }),
      artifact({ id: "in", asset_binding_id: "b2", asset_role: "input" }),
      artifact({ id: "raw", asset_binding_id: "b3", asset_role: null }),
    ]);
    expect(deliverables.map((a) => a.id)).toEqual(["git", "out"]);
    expect(hiddenNonOutput).toBe(2);
  });

  it("空列表两个出口都为零，不产生假提示", () => {
    expect(splitDeliverables([])).toEqual({ deliverables: [], hiddenNonOutput: 0 });
  });
});
