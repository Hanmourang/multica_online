import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecomposeDraftTask, Issue } from "@multica/core/types";
import { QuickConfirmError, quickConfirmIssue } from "./quick-confirm";

const mockApi = vi.hoisted(() => ({
  getIssue: vi.fn(),
  getDecomposition: vi.fn(),
  listIssueRoleAssignments: vi.fn(),
  confirmDecomposition: vi.fn(),
  listPrototypeVersions: vi.fn(),
  confirmPrototype: vi.fn(),
  updateIssue: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
}));

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "req-1",
    workspace_id: "ws-1",
    number: 1,
    identifier: "REQ-1",
    title: "数据模型分析",
    status: "todo",
    status_category: "todo",
    parent_issue_id: null,
    requirement_status: null,
    ...overrides,
  } as Issue;
}

const completeDraft: DecomposeDraftTask = {
  temp_id: "d1",
  title: "实现数据模型",
  stage: 3,
  assignee_id: "agent-1",
  assignee_type: "agent",
  feature_points: [{ kind: "new", title: "表结构" }],
};

describe("quickConfirmIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("confirms a pending decomposition", async () => {
    mockApi.getIssue.mockResolvedValue(issue({ requirement_status: "拆解待确认" }));
    mockApi.getDecomposition.mockResolvedValue({ drafts: [completeDraft] });
    mockApi.listIssueRoleAssignments.mockResolvedValue({ roles: [] });
    mockApi.confirmDecomposition.mockResolvedValue({ issues: [] });

    await expect(quickConfirmIssue("req-1")).resolves.toBe("decompose");
    expect(mockApi.confirmDecomposition).toHaveBeenCalledWith("req-1", [
      completeDraft,
    ]);
  });

  it("synthesizes fallback drafts when the PM left none", async () => {
    mockApi.getIssue.mockResolvedValue(
      issue({
        requirement_status: "拆解待确认",
        title: "本体能力评估",
        goal: "出具评估结论",
      }),
    );
    mockApi.getDecomposition.mockResolvedValue({ drafts: [], plan: null });
    mockApi.listIssueRoleAssignments.mockResolvedValue({
      roles: [
        {
          id: "r1",
          role: "developer",
          enabled: true,
          assignee_type: "agent",
          assignee_id: "agent-dev",
          ordinal: 0,
        },
      ],
    });
    mockApi.confirmDecomposition.mockResolvedValue({ issues: [] });

    await expect(quickConfirmIssue("req-1")).resolves.toBe("decompose");
    const payload = mockApi.confirmDecomposition.mock.calls[0]?.[1] as DecomposeDraftTask[];
    expect(payload[0]?.title).toContain("本体能力评估");
    expect(payload.some((draft) => draft.stage === 4)).toBe(true);
  });

  it("rejects an incomplete decomposition draft", async () => {
    mockApi.getIssue.mockResolvedValue(issue({ requirement_status: "拆解待确认" }));
    mockApi.getDecomposition.mockResolvedValue({
      drafts: [{ ...completeDraft, assignee_id: undefined, feature_points: [] }],
    });
    mockApi.listIssueRoleAssignments.mockResolvedValue({ roles: [] });

    await expect(quickConfirmIssue("req-1")).rejects.toBeInstanceOf(QuickConfirmError);
    expect(mockApi.confirmDecomposition).not.toHaveBeenCalled();
  });

  it("confirms a pending prototype", async () => {
    mockApi.getIssue.mockResolvedValue(issue({ requirement_status: "原型待确认" }));
    mockApi.listPrototypeVersions.mockResolvedValue({
      versions: [{ version: 2, status: "pending" }],
    });
    mockApi.confirmPrototype.mockResolvedValue({});

    await expect(quickConfirmIssue("req-1")).resolves.toBe("prototype");
    expect(mockApi.confirmPrototype).toHaveBeenCalledWith("req-1", 2);
  });

  it("marks an in_review issue as done", async () => {
    mockApi.getIssue.mockResolvedValue(
      issue({ status: "in_review", status_category: "in_review" }),
    );
    mockApi.updateIssue.mockResolvedValue({});

    await expect(quickConfirmIssue("req-1")).resolves.toBe("review");
    expect(mockApi.updateIssue).toHaveBeenCalledWith("req-1", { status: "done" });
  });

  it("confirms parent decomposition when a child is in review", async () => {
    mockApi.getIssue
      .mockResolvedValueOnce(
        issue({
          id: "child-1",
          parent_issue_id: "req-1",
          status: "in_review",
          status_category: "in_review",
        }),
      )
      .mockResolvedValueOnce(issue({ requirement_status: "拆解待确认" }));
    mockApi.getDecomposition.mockResolvedValue({ drafts: [completeDraft] });
    mockApi.listIssueRoleAssignments.mockResolvedValue({ roles: [] });
    mockApi.confirmDecomposition.mockResolvedValue({ issues: [] });

    await expect(quickConfirmIssue("child-1")).resolves.toBe("decompose");
    expect(mockApi.confirmDecomposition).toHaveBeenCalledWith("req-1", [
      completeDraft,
    ]);
  });
});
