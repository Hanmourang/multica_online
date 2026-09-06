/**
 * @vitest-environment jsdom
 *
 * RequirementDrawer — 需求五阶段抽屉（spec §3）：Sheet 承载概要头 +
 * RequirementFlowSection 复用。issueId=null 时不渲染；issue/children 查询
 * 走 issueKeys 缓存（与详情页共享同一份服务器状态）；关闭经 onOpenChange
 * 冒泡给宿主页面（日历页 / 项目需求 tab）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";
import { RequirementDrawer } from "./requirement-drawer";

const mockApi = vi.hoisted(() => ({
  getIssue: vi.fn(),
  listChildIssues: vi.fn(),
  listIssueRoleAssignments: vi.fn(),
  listPrototypeVersions: vi.fn(),
  getDecomposition: vi.fn(),
  generatePrototype: vi.fn(),
  updatePrototypeMarks: vi.fn(),
  confirmPrototype: vi.fn(),
  decomposeRequirement: vi.fn(),
  confirmDecomposition: vi.fn(),
  triggerRequirement: vi.fn(),
  submitAcceptanceVerdict: vi.fn(),
  listProjectModules: vi.fn(),
  listProjectResources: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
  ApiError: class ApiError extends Error {},
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

// 与 requirement-flow-section.test.tsx 同一约定：班底 actor 名称/头像依赖
// workspace hooks，stub 掉以保持容器测试可断言。
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `actor-${id}`,
  }),
}));
vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));

function requirement(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "req-1",
    identifier: "REQ-101",
    number: 101,
    title: "积分体系重构",
    description: "",
    status: "todo",
    priority: "medium",
    workspace_id: "workspace-1",
    project_id: "proj-1",
    parent_issue_id: null,
    assignee_id: null,
    assignee_type: null,
    creator_id: "user-1",
    creator_type: "member",
    labels: [],
    position: 0,
    stage: null,
    start_date: null,
    start_at: "2026-09-15T09:30:00Z",
    due_date: "2026-09-17",
    // 注意：不设 requirement_status —— 它是列表端投影列，GetIssue 不返回，
    // fixture 必须贴着真实 API 形状。
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    decomposition_confirmed_at: null,
    ...overrides,
  } as unknown as Issue;
}

function renderDrawer(
  ui: ReactElement,
  onOpenChange: (open: boolean) => void = vi.fn(),
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    onOpenChange,
    ...renderWithI18n(
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  mockApi.getIssue.mockResolvedValue(requirement());
  mockApi.listChildIssues.mockResolvedValue({ issues: [] });
  mockApi.listIssueRoleAssignments.mockResolvedValue({ roles: [], total: 0 });
  mockApi.listPrototypeVersions.mockResolvedValue({ versions: [] });
  mockApi.getDecomposition.mockResolvedValue({
    plan: null,
    drafts: [],
    source_comment_id: null,
  });
  mockApi.listProjectModules.mockResolvedValue([]);
  mockApi.listProjectResources.mockResolvedValue({ resources: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RequirementDrawer", () => {
  it("renders the header and the five-stage flow section for the given issue", async () => {
    renderDrawer(
      <RequirementDrawer
        issueId="req-1"
        statusBadge="原型待确认"
        onOpenChange={vi.fn()}
      />,
    );

    // 概要头：编号 + 标题 + 状态徽标（宿主传入）+ 时间窗（UTC 分钟）
    expect(
      await screen.findByRole("heading", { name: /积分体系重构/ }),
    ).toBeTruthy();
    expect(screen.getByText("#101")).toBeTruthy();
    expect(screen.getByText("原型待确认")).toBeTruthy();
    expect(screen.getByText(/2026-09-15 09:30 ~ 2026-09-17/)).toBeTruthy();
    // 五阶段面板复用（RequirementFlowSection 的阶段条标记；班底/版本/拆解
    // 三个查询 resolve 前 FlowSection 不渲染，用 findBy 等待）
    expect(await screen.findByTestId("requirement-flow")).toBeTruthy();

    expect(mockApi.getIssue).toHaveBeenCalledWith("req-1");
    expect(mockApi.listChildIssues).toHaveBeenCalledWith("req-1");
  });

  it("bubbles close via onOpenChange(false) when the close button is clicked", async () => {
    const onOpenChange = vi.fn();
    renderDrawer(
      <RequirementDrawer issueId="req-1" onOpenChange={onOpenChange} />,
      onOpenChange,
    );
    await screen.findByTestId("requirement-flow");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });

  it("renders nothing and skips fetching when issueId is null", () => {
    renderDrawer(<RequirementDrawer issueId={null} onOpenChange={vi.fn()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("requirement-flow")).toBeNull();
    expect(mockApi.getIssue).not.toHaveBeenCalled();
    expect(mockApi.listChildIssues).not.toHaveBeenCalled();
  });
});
