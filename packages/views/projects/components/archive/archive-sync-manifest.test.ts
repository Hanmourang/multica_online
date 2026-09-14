import { describe, expect, it } from "vitest";
import { buildArchiveSyncManifest } from "./archive-sync-manifest";
import { gitBlobSha1FromText } from "./git-blob-sha";

describe("gitBlobSha1FromText", () => {
  it("matches git hash-object for hello\\n", () => {
    expect(gitBlobSha1FromText("hello\n")).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
  });
});

describe("buildArchiveSyncManifest", () => {
  it("includes already-indexed paths so a later sync cannot purge them", () => {
    const content = `---
doc_type: architecture
doc_module: deepseek-harness
---
# 架构
`;
    const result = buildArchiveSyncManifest([
      { relPath: "overview/architecture/architecture.md", content },
      { relPath: "overview/marketing/x.md", content: "# no" },
      { relPath: "node_modules/pkg/readme.md", content: "# skip" },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.rel_path).toBe("overview/architecture/architecture.md");
    expect(result.items[0]?.doc_type).toBe("architecture");
    expect(result.items[0]?.blob_sha).toBe(gitBlobSha1FromText(content));
    expect(result.items[0]?.scope).toBe("project");
    expect(result.items[0]?.doc_module).toBe("deepseek-harness");
    expect(result.unclassified).toContain("overview/marketing/x.md");
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("keeps requirement stage and issue from frontmatter", () => {
    const content = `---
doc_type: plan
multica_issue_id: 9d8b6a67-0000-4000-8000-000000000001
---
# 计划
`;
    const result = buildArchiveSyncManifest([
      {
        relPath: "requirements/REQ-20260913-01/s2-plan/plan.md",
        content,
      },
    ]);
    expect(result.items[0]).toMatchObject({
      scope: "requirement",
      stage: 2,
      doc_type: "plan",
      requirement_key: "REQ-20260913-01",
      issue_id: "9d8b6a67-0000-4000-8000-000000000001",
    });
  });

  it("drops issue_id under review_queue when path and frontmatter both signal", () => {
    const content = `---
doc_type: plan
multica_issue_id: 9d8b6a67-0000-4000-8000-000000000001
---
# 计划
`;
    const result = buildArchiveSyncManifest(
      [
        {
          relPath: "requirements/REQ-20260913-01/s2-plan/plan.md",
          content,
        },
      ],
      { conflictPolicy: "review_queue" },
    );
    expect(result.items[0]?.requirement_key).toBe("REQ-20260913-01");
    expect(result.items[0]?.issue_id).toBeUndefined();
  });
});
