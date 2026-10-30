import { describe, expect, it } from "vitest";
import type { AssetBinding, ProjectArtifact } from "@multica/core/types";
import {
  assetMountCandidates,
  assetNameFromFile,
  docTypeForSyncLifecycle,
  fileExtension,
  filterMountCandidates,
  formatFileSize,
  isTextArchiveFile,
  shelfDocTypeForMount,
  syncLifecycleForPlacement,
  withFileExtension,
} from "./artifact-editor-source";

function artifact(patch: Partial<ProjectArtifact>): ProjectArtifact {
  return {
    id: "a1",
    workspace_id: "ws",
    project_id: "p",
    resource_id: "r",
    scope: "requirement",
    stage: null,
    doc_type: "requirement",
    version: 1,
    rel_path: "requirements/REQ-1/requirement.md",
    blob_sha: "0",
    size_bytes: 0,
    source: "manual",
    synced_at: "2026-10-30T00:00:00Z",
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
    ...patch,
  } as ProjectArtifact;
}

function binding(patch: Partial<AssetBinding>): AssetBinding {
  return {
    id: "b1",
    workspace_id: "ws",
    project_id: "p",
    asset_category: "knowledge_repo",
    external_ref: {},
    asset_name: "design",
    source: "manual",
    recommended: false,
    created_by_type: "member",
    created_by_id: "u1",
    created_at: "2026-10-30T00:00:00Z",
    ...patch,
  } as AssetBinding;
}

describe("syncLifecycleForPlacement", () => {
  it("maps the five shelves and S0, rejects open doc types", () => {
    expect(syncLifecycleForPlacement({ stage: 3, docType: "architecture" })).toBe("S3");
    expect(syncLifecycleForPlacement({ stage: 2, docType: "product-design" })).toBe("S2");
    expect(syncLifecycleForPlacement({ stage: null, docType: "requirement" })).toBe("S0");
    // 证据种类（design / test-plan）不是合法货架组合，先规整再映射（见下）。
    expect(syncLifecycleForPlacement({ stage: 3, docType: "design" })).toBeNull();
    // 开放式 doc_type 与矛盾组合没有资产阶段。
    expect(syncLifecycleForPlacement({ stage: 3, docType: "research" })).toBeNull();
    expect(syncLifecycleForPlacement({ stage: null, docType: "architecture" })).toBeNull();
  });
});

describe("shelfDocTypeForMount", () => {
  it("normalizes evidence kinds to the shelf doc_type of their stage", () => {
    expect(shelfDocTypeForMount(3, "design")).toBe("architecture");
    expect(shelfDocTypeForMount(3, "test-plan")).toBe("architecture");
    expect(shelfDocTypeForMount(1, "prototype")).toBe("research");
    // S0 与未分阶保持原值（requirement 本身就是货架词）。
    expect(shelfDocTypeForMount(null, "requirement")).toBe("requirement");
    expect(shelfDocTypeForMount(null, "plan")).toBe("plan");
  });

  it("makes the normalized placement syncable", () => {
    const docType = shelfDocTypeForMount(3, "design");
    expect(syncLifecycleForPlacement({ stage: 3, docType })).toBe("S3");
  });
});

describe("docTypeForSyncLifecycle", () => {
  it("returns the shelf doc_type the server will write back", () => {
    expect(docTypeForSyncLifecycle("S0")).toBe("requirement");
    expect(docTypeForSyncLifecycle("S3")).toBe("architecture");
    expect(docTypeForSyncLifecycle("S5")).toBe("iteration");
  });
});

describe("file helpers", () => {
  it("extracts extensions and detects text files", () => {
    expect(fileExtension("架构设计-v2.PDF")).toBe("pdf");
    expect(fileExtension("design")).toBe("");
    expect(fileExtension(".hidden")).toBe("");
    expect(isTextArchiveFile("design.md")).toBe(true);
    expect(isTextArchiveFile("design.pdf")).toBe(false);
  });

  it("keeps the doc-kind basename and swaps only the extension", () => {
    expect(withFileExtension("requirements/REQ-1/s3-execution/design.md", "架构设计.pdf")).toBe(
      "requirements/REQ-1/s3-execution/design.pdf",
    );
    expect(withFileExtension("requirements/REQ-1/s3-execution/design", "report.md")).toBe(
      "requirements/REQ-1/s3-execution/design.md",
    );
    // 无扩展名文件不动路径。
    expect(withFileExtension("requirements/REQ-1/design.md", "README")).toBe(
      "requirements/REQ-1/design.md",
    );
  });

  it("derives asset names and human readable sizes", () => {
    expect(assetNameFromFile("架构设计-v2.pdf")).toBe("架构设计-v2");
    expect(assetNameFromFile("design")).toBe("design");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("assetMountCandidates", () => {
  it("keeps attachment-backed rows, marks mounted ones and sorts them last", () => {
    const bindings = [
      binding({
        id: "used",
        asset_name: "used",
        external_ref: { attachment_id: "att-used", filename: "used.md" },
      }),
      binding({
        id: "free",
        asset_name: "free",
        external_ref: { attachment_id: "att-free", filename: "free.md" },
      }),
      binding({ id: "no-attachment", asset_name: "repo", external_ref: { url: "https://x" } }),
      binding({
        id: "imported",
        asset_name: "imported",
        asset_subtype: "md",
        external_ref: { attachment_id: "att-imported", artifact_id: "art-1" },
      }),
    ];
    const candidates = assetMountCandidates(bindings, [
      artifact({ attachment_id: "att-used" }),
    ]);

    expect(candidates.map((row) => row.binding.id)).toEqual([
      "free",
      "imported",
      "used",
    ]);
    expect(candidates.find((row) => row.binding.id === "free")?.mounted).toBe(false);
    expect(candidates.find((row) => row.binding.id === "used")?.mounted).toBe(true);
    expect(candidates.find((row) => row.binding.id === "imported")?.mounted).toBe(true);
    expect(candidates.find((row) => row.binding.id === "imported")?.filename).toBe(
      "imported.md",
    );
  });

  it("filters by filename / asset name", () => {
    const candidates = assetMountCandidates(
      [
        binding({ id: "a", asset_name: "架构设计", external_ref: { attachment_id: "1", filename: "架构设计.pdf" } }),
        binding({ id: "b", asset_name: "测试方案", external_ref: { attachment_id: "2", filename: "test-plan.md" } }),
      ],
      [],
    );
    expect(filterMountCandidates(candidates, "test").map((row) => row.binding.id)).toEqual([
      "b",
    ]);
    expect(filterMountCandidates(candidates, "架构").map((row) => row.binding.id)).toEqual([
      "a",
    ]);
    expect(filterMountCandidates(candidates, "  ")).toHaveLength(2);
  });
});
