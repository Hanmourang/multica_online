import { describe, expect, it } from "vitest";
import type { Issue } from "@multica/core/types";
import { matrixRequirementDisplay } from "./artifact-matrix-label";

function issue(partial: Partial<Issue> & Pick<Issue, "id" | "identifier" | "title">): Issue {
  return {
    workspace_id: "ws",
    number: 26,
    description: "",
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "u",
    parent_issue_id: null,
    project_id: "p",
    position: 0,
    stage: null,
    start_date: null,
    due_date: null,
    metadata: {},
    properties: {},
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

describe("matrixRequirementDisplay", () => {
  const issues = [
    issue({ id: "iss-29", identifier: "SIRI-29", title: "退款流程异步化改造" }),
    issue({ id: "iss-9", identifier: "req_9", title: "本体评估", number: 9 }),
  ];

  it("resolves identifier and title from issue_id", () => {
    expect(
      matrixRequirementDisplay(
        { key: "REQ-29", label: "REQ-29", issueId: "iss-29" },
        issues,
      ),
    ).toEqual({
      identifier: "SIRI-29",
      title: "退款流程异步化改造",
      issueId: "iss-29",
      status: null,
    });
  });

  it("falls back to requirement_key when the issue is missing", () => {
    expect(
      matrixRequirementDisplay(
        { key: "REQ-99", label: "REQ-99", issueId: "missing" },
        issues,
      ),
    ).toEqual({
      identifier: "REQ-99",
      title: null,
      issueId: "missing",
      status: null,
    });
  });

  it("matches REQ-<number> to the issue number", () => {
    expect(
      matrixRequirementDisplay({ key: "REQ-9", label: "REQ-9", issueId: null }, issues),
    ).toEqual({
      identifier: "req_9",
      title: "本体评估",
      issueId: "iss-9",
      status: null,
    });
  });

  it("carries requirement_status when the issue is bound", () => {
    expect(
      matrixRequirementDisplay(
        { key: "REQ-29", label: "REQ-29", issueId: "iss-29" },
        [issue({ id: "iss-29", identifier: "SIRI-29", title: "退款", requirement_status: "执行中" })],
      ).status,
    ).toBe("执行中");
  });
});
