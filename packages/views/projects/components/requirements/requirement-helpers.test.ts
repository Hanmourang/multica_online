import { describe, expect, it } from "vitest";
import type { Issue } from "@multica/core/types";
import {
  acceptanceVerdict,
  canReflow,
  compareRequirements,
  hasAcceptanceScene,
  projectRequirements,
  requirementBucket,
} from "./requirement-helpers";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    workspace_id: "ws-1",
    number: 1,
    identifier: "SIRI-1",
    title: "Req",
    description: "",
    status: "todo",
    priority: "medium",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    project_id: "proj-1",
    position: 0,
    stage: null,
    start_date: null,
    due_date: null,
    metadata: {},
    properties: {},
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    requirement_status: "执行中",
    ...overrides,
  };
}

describe("requirementBucket / compareRequirements", () => {
  it("sorts pending confirm ahead of failed, then active, then done", () => {
    const rows = [
      issue({ id: "done", requirement_status: "已完成", updated_at: "2026-09-01T00:00:00Z" }),
      issue({ id: "active", requirement_status: "执行中", updated_at: "2026-09-03T00:00:00Z" }),
      issue({ id: "fail", requirement_status: "验收失败", updated_at: "2026-09-02T00:00:00Z" }),
      issue({ id: "pending", requirement_status: "原型待确认", updated_at: "2026-09-01T00:00:00Z" }),
    ];
    expect(rows.sort(compareRequirements).map((row) => row.id)).toEqual([
      "pending",
      "fail",
      "active",
      "done",
    ]);
  });

  it("projectRequirements keeps only top-level requirements of that project", () => {
    const rows = projectRequirements(
      [
        issue({ id: "mine" }),
        issue({ id: "other", project_id: "proj-2" }),
        issue({ id: "child", parent_issue_id: "mine" }),
        issue({ id: "plain", requirement_status: null }),
        issue({
          id: "task-goal-only",
          requirement_status: null,
          goal: "交付目标",
        }),
      ],
      "proj-1",
    );
    expect(rows.map((row) => row.id)).toEqual(["mine"]);
  });
});

describe("canReflow / acceptanceVerdict", () => {
  it("allows reflow only for 验收失败 within 3 rounds", () => {
    expect(canReflow(issue({ requirement_status: "验收失败", acceptance_round: 2 }))).toBe(true);
    expect(canReflow(issue({ requirement_status: "验收失败", acceptance_round: 4 }))).toBe(false);
    expect(canReflow(issue({ requirement_status: "验收中" }))).toBe(false);
    expect(canReflow(issue({ requirement_status: "执行中" }))).toBe(false);
  });

  it("maps verdict and acceptance-scene membership from status", () => {
    expect(acceptanceVerdict(issue({ requirement_status: "已完成" }))).toBe("pass");
    expect(acceptanceVerdict(issue({ requirement_status: "验收失败" }))).toBe("fail");
    expect(acceptanceVerdict(issue({ requirement_status: "验收中" }))).toBe("running");
    expect(hasAcceptanceScene(issue({ requirement_status: "验收中" }))).toBe(true);
    expect(hasAcceptanceScene(issue({ requirement_status: "执行中" }))).toBe(false);
    expect(requirementBucket(issue({ requirement_status: "原型待确认" }))).toBe("pending");
  });
});
