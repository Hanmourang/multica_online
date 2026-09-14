import { describe, expect, it } from "vitest";
import type { ArtifactSyncItem } from "@multica/core/types";
import {
  applyConflictPolicy,
  batchBindPercent,
  inferPlanningDocClass,
  shouldAttachIssueId,
  splitInboxAbsolutePath,
  suggestInboxAdopt,
  suggestedAdoptRelPath,
} from "./archive-mapping";

function item(partial: Partial<ArtifactSyncItem>): ArtifactSyncItem {
  return {
    rel_path: "requirements/REQ-20260913-01/s2-plan/plan.md",
    blob_sha: "0",
    scope: "requirement",
    doc_type: "plan",
    version: 1,
    size_bytes: 1,
    ...partial,
  };
}

describe("conflict policy", () => {
  it("keeps issue_id on path_first even when REQ-KEY is present", () => {
    expect(shouldAttachIssueId("path_first", "iss-1", "REQ-20260913-01")).toBe(true);
    expect(
      applyConflictPolicy(
        item({ issue_id: "iss-1", requirement_key: "REQ-20260913-01" }),
        "path_first",
      ).issue_id,
    ).toBe("iss-1");
  });

  it("drops issue_id on review_queue when both signals exist", () => {
    expect(shouldAttachIssueId("review_queue", "iss-1", "REQ-20260913-01")).toBe(
      false,
    );
    expect(
      applyConflictPolicy(
        item({ issue_id: "iss-1", requirement_key: "REQ-20260913-01" }),
        "review_queue",
      ).issue_id,
    ).toBeUndefined();
  });

  it("keeps issue_id on review_queue when there is no REQ-KEY", () => {
    expect(shouldAttachIssueId("review_queue", "iss-1", undefined)).toBe(true);
  });
});

describe("planning aliases and inbox adopt", () => {
  it("maps spoken names to doc_class without inventing shelves", () => {
    expect(inferPlanningDocClass("research", "overview/research/mrd.md")).toBe("mrd");
    expect(inferPlanningDocClass("product-design", "prd.md")).toBe("prd");
    expect(inferPlanningDocClass("work-plan", "change_logs/multica/plans/x.md")).toBe(
      "roadmap",
    );
  });

  it("suggests a four-shelf dest for inbox files", () => {
    expect(suggestInboxAdopt("mrd-立项.md").shelf).toBe("research");
    expect(suggestInboxAdopt("prd.md")).toEqual({
      shelf: "product-design",
      docType: "product-design",
      docClass: "prd",
    });
    expect(suggestedAdoptRelPath("mrd.md", "research")).toBe(
      "overview/research/mrd.md",
    );
  });

  it("splits an inbox absolute path against known roots", () => {
    expect(
      splitInboxAbsolutePath(
        "/ws/projects_mgmt/_shared/inbox/draft.md",
        ["/ws/projects_mgmt/_shared/inbox"],
      ),
    ).toEqual({
      root: "/ws/projects_mgmt/_shared/inbox",
      relPath: "draft.md",
    });
  });

  it("converts 0..1 thresholds to percent", () => {
    expect(batchBindPercent(0.85)).toBe(85);
    expect(batchBindPercent(undefined)).toBe(85);
  });
});
