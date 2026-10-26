// placement 契约测试（五阶段对齐 plan §9.2）：五种映射、未分阶、未知服务端值防御。
// 期望表与 Go 端 project_asset_archive_placement.go lifecyclePlacementMap 镜像一致。

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_STAGES,
  ASSET_UNSTAGED_PLACEMENT,
  FIVE_STAGE_PLACEMENTS,
  SHELF_DOC_TYPES,
  isArtifactStage,
  isShelfDocType,
  lifecycleForArtifactStage,
  lifecycleForPlacement,
  placementForLifecycle,
  shelfRelPathForMove,
  stageForShelfDocType,
} from "./placement";

describe("five-stage placement contract", () => {
  it("matches the Go mapping table exactly", () => {
    expect(FIVE_STAGE_PLACEMENTS).toEqual([
      { lifecycle: "S1", stage: 1, docType: "research" },
      { lifecycle: "S2", stage: 2, docType: "product-design" },
      { lifecycle: "S3", stage: 3, docType: "architecture" },
      { lifecycle: "S4", stage: 4, docType: "retrospective" },
      { lifecycle: "S5", stage: 5, docType: "iteration" },
    ]);
    expect(SHELF_DOC_TYPES).toEqual(["research", "product-design", "architecture", "retrospective", "iteration"]);
    expect(ARTIFACT_STAGES).toEqual([1, 2, 3, 4, 5]);
  });

  it("maps each lifecycle stage to its archive placement", () => {
    expect(placementForLifecycle("S1")).toEqual({ stage: 1, docType: "research" });
    expect(placementForLifecycle("S5")).toEqual({ stage: 5, docType: "iteration" });
  });

  it("treats general / empty as the unstaged retention shelf", () => {
    expect(placementForLifecycle("general")).toEqual(ASSET_UNSTAGED_PLACEMENT);
    expect(placementForLifecycle(null)).toEqual(ASSET_UNSTAGED_PLACEMENT);
    expect(placementForLifecycle(undefined)).toEqual(ASSET_UNSTAGED_PLACEMENT);
  });

  it("defends against unknown server values without throwing", () => {
    expect(placementForLifecycle("S9")).toEqual(ASSET_UNSTAGED_PLACEMENT);
    expect(placementForLifecycle("  s3 ")).toEqual({ stage: 3, docType: "architecture" });
    expect(lifecycleForPlacement({ stage: 3, docType: "research" })).toBe("general");
    // 模拟服务端 JSON 越界值：防御式回退到 general，不抛错。
    expect(lifecycleForPlacement({ stage: 9 as unknown as typeof ARTIFACT_STAGES[number], docType: "research" })).toBe(
      "general",
    );
    expect(isArtifactStage(5)).toBe(true);
    expect(isArtifactStage(6)).toBe(false);
    expect(isArtifactStage("5")).toBe(false);
    expect(isShelfDocType("iteration")).toBe(true);
    expect(isShelfDocType("marketing")).toBe(false);
  });

  it("reverse-maps placements and stages to lifecycle badges", () => {
    expect(lifecycleForPlacement({ stage: 2, docType: "product-design" })).toBe("S2");
    expect(lifecycleForPlacement({ stage: 5, docType: "iteration" })).toBe("S5");
    expect(lifecycleForPlacement({ stage: null, docType: "asset" })).toBe("general");
    expect(lifecycleForArtifactStage(4)).toBe("S4");
    expect(lifecycleForArtifactStage(null)).toBe("general");
    expect(stageForShelfDocType("retrospective")).toBe(4);
    expect(stageForShelfDocType("test-report")).toBeNull();
  });

  it("rewrites shelf paths without ping-ponging custom paths", () => {
    expect(shelfRelPathForMove("overview/research/a.md", "research", "iteration")).toBe(
      "overview/iteration/a.md",
    );
    // 旧→新同货架 / 空值不动作
    expect(shelfRelPathForMove("overview/research/a.md", "research", "research")).toBeNull();
    // 自定义路径与未分阶区不劫持
    expect(shelfRelPathForMove("assets/team/a.md", "research", "iteration")).toBeNull();
    expect(shelfRelPathForMove("project-notes.md", "research", "iteration")).toBeNull();
  });
});
