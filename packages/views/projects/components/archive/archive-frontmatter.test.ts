import { describe, expect, it } from "vitest";
import { parseArchiveFrontmatter } from "./archive-import";
import { upsertArchiveFrontmatter } from "./archive-frontmatter";

describe("upsertArchiveFrontmatter", () => {
  it("inserts a header when the file has none", () => {
    const next = upsertArchiveFrontmatter("# 正文\n", {
      docType: "research",
      docClass: "mrd",
      docModule: "deepseek-harness",
      issueId: "issue-1",
    });
    expect(parseArchiveFrontmatter(next)).toEqual({
      docType: "research",
      docClass: "mrd",
      docModule: "deepseek-harness",
      issueId: "issue-1",
    });
    expect(next).toContain("# 正文");
  });

  it("updates existing keys and drops empty ones", () => {
    const next = upsertArchiveFrontmatter(
      `---
doc_type: research
multica_issue_id: old
title: keep
---
body
`,
      { issueId: "new", docClass: null },
    );
    expect(next).toContain("title: keep");
    expect(parseArchiveFrontmatter(next)).toMatchObject({
      docType: "research",
      issueId: "new",
    });
    expect(next).not.toContain("doc_class");
  });
});
