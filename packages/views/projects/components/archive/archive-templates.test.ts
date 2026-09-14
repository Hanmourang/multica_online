import { describe, expect, it } from "vitest";
import { renderArchiveTemplate, resolveArchiveDocChoice } from "./archive-templates";

describe("resolveArchiveDocChoice", () => {
  it("folds PRD/MRD aliases onto the four shelves", () => {
    expect(resolveArchiveDocChoice("prd")).toEqual({
      shelf: "product-design",
      docClass: "prd",
      templateKey: "prd",
    });
    expect(resolveArchiveDocChoice("mrd")).toEqual({
      shelf: "research",
      docClass: "mrd",
      templateKey: "mrd",
    });
  });
});

describe("renderArchiveTemplate", () => {
  it("keeps shared PRD headings and product-design doc_type", () => {
    const text = renderArchiveTemplate({
      docType: "prd",
      title: "档案模块",
    });
    expect(text).toContain("doc_type: product-design");
    expect(text).toContain("doc_class: prd");
    expect(text).toContain("## 目标与场景");
    expect(text).toContain("## 验收要点");
    expect(text).toContain("档案模块");
    expect(text).not.toMatch(/^overview\/prd\//m);
  });

  it("keeps shared MRD headings on the research shelf", () => {
    const text = renderArchiveTemplate({
      docType: "mrd",
      title: "立项",
    });
    expect(text).toContain("doc_type: research");
    expect(text).toContain("doc_class: mrd");
    expect(text).toContain("## 结论先行");
    expect(text).toContain("## 市场与用户");
  });

  it("keeps requirement checklist sections from the handbook", () => {
    const text = renderArchiveTemplate({
      docType: "requirement",
      title: "真 sync",
      requirementKey: "REQ-20260913-01",
      issueId: "issue-1",
    });
    expect(text).toContain("# 需求单：REQ-20260913-01");
    expect(text).toContain("## 子需求清单");
    expect(text).toContain("## 需求背景");
    expect(text).toContain("multica_issue_id: issue-1");
  });

  it("keeps architecture blocking sections", () => {
    const text = renderArchiveTemplate({
      docType: "architecture",
      title: "档案管道",
    });
    expect(text).toContain("## 背景与约束");
    expect(text).toContain("## 回退策略");
  });
});
