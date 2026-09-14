import { describe, expect, it } from "vitest";
import {
  groupUnboundArtifacts,
  HIGH_BIND_CONFIDENCE,
  rankRequirementMatches,
  suggestRequirement,
} from "./archive-bind-helpers";
import type { Issue, ProjectArtifact } from "@multica/core/types";

function issue(partial: Partial<Issue> & Pick<Issue, "id" | "identifier" | "title">): Issue {
  return {
    workspace_id: "ws",
    number: 1,
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "u1",
    parent_issue_id: null,
    project_id: "p1",
    position: 0,
    stage: null,
    start_date: null,
    due_date: null,
    created_at: "",
    updated_at: "",
    ...partial,
  } as Issue;
}

function artifact(
  partial: Partial<ProjectArtifact> & Pick<ProjectArtifact, "id" | "rel_path">,
): ProjectArtifact {
  return {
    workspace_id: "ws",
    project_id: "p1",
    resource_id: "r1",
    scope: "requirement",
    doc_type: "plan",
    version: 1,
    blob_sha: "abc",
    size_bytes: 1,
    source: "manual",
    synced_at: "",
    created_at: "",
    updated_at: "",
    ...partial,
  } as ProjectArtifact;
}

describe("suggestRequirement", () => {
  const issues = [
    issue({ id: "i1", identifier: "SIRI-29", title: "支付收银台" }),
    issue({ id: "i2", identifier: "SIRI-30", title: "其它需求" }),
  ];

  it("matches identifier in the path, not an unrelated REQ-KEY", () => {
    expect(
      suggestRequirement(
        artifact({
          id: "a1",
          rel_path: "requirements/REQ-20260907-01/s2-plan/plan.md",
          requirement_key: "REQ-20260907-01",
        }),
        issues,
      ),
    ).toBeNull();
    expect(
      suggestRequirement(
        artifact({
          id: "a2",
          rel_path: "requirements/siri-29/s1-prototype/v1.html",
        }),
        issues,
      )?.id,
    ).toBe("i1");
    expect(
      suggestRequirement(
        artifact({
          id: "a3",
          rel_path: "requirements/REQ-20260907-01/s2-plan/plan.md",
          requirement_key: "SIRI-29",
        }),
        issues,
      )?.id,
    ).toBe("i1");
  });

  it("exposes confidence for batch bind", () => {
    const match = rankRequirementMatches(
      artifact({
        id: "a4",
        rel_path: "requirements/SIRI-29/s2-plan/plan.md",
        requirement_key: "SIRI-29",
      }),
      issues,
    )[0];
    expect(match?.confidence).toBeGreaterThanOrEqual(HIGH_BIND_CONFIDENCE);
  });
});

describe("groupUnboundArtifacts", () => {
  it("buckets by requirement_key", () => {
    const groups = groupUnboundArtifacts([
      artifact({ id: "a1", rel_path: "a.md", requirement_key: "REQ-1" }),
      artifact({ id: "a2", rel_path: "b.md", requirement_key: "REQ-1" }),
      artifact({ id: "a3", rel_path: "c.md" }),
    ]);
    expect(groups[0]?.items).toHaveLength(2);
    expect(groups[1]?.key).toBe("__none__");
  });
});
