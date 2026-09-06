/**
 * @vitest-environment jsdom
 *
 * RequirementListPanel — 项目维度需求列表（spec §4b 需求详情 TAB）：
 * 仅本项目顶层需求（有排期或派生状态）按 start_at 升序渲染成卡片；
 * 点卡片开 RequirementDrawer（statusBadge 由列表投影数据供给，因
 * GetIssue 不返回 requirement_status——同 CalendarPage 的接线约定）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";
import { RequirementListPanel } from "./requirement-list-panel";

const mockApi = vi.hoisted(() => ({
  listIssues: vi.fn(),
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

// 与 requirement-drawer.test.tsx 同一约定：班底 actor 名称/头像依赖
// workspace hooks，stub 掉以保持容器测试可断言。
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `actor-${id}`,
  }),
}));
vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
    start_at: "2026-09-15T09:00:00Z",
    due_date: "2026-09-17",
    requirement_status: "原型待确认",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    decomposition_confirmed_at: null,
    ...overrides,
  } as unknown as Issue;
}

// issueListOptions 的 fixture 入口：beforeEach 里的 mockImplementation 读它
// （模块级 let，非 hoisted 工厂引用，无 hoisting 风险）。
let currentIssues: Issue[] = [];

function renderPanel(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  currentIssues = [];
  // issueListOptions 按 7 个 status_category 并发拉取后 flatten；只在首个
  // 响应里放 fixture，其余空桶，避免同一批 issue 被铺 7 份。
  let served = false;
  mockApi.listIssues.mockImplementation(() => {
    if (served) return Promise.resolve({ issues: [], total: 0 });
    served = true;
    return Promise.resolve({
      issues: currentIssues,
      total: currentIssues.length,
    });
  });
  // getIssue 贴着列表 fixture 返回，抽屉概要头才能对上被点击的卡片。
  mockApi.getIssue.mockImplementation((id: string) =>
    Promise.resolve(
      currentIssues.find((i) => i.id === id) ?? requirement({ id }),
    ),
  );
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

describe("RequirementListPanel", () => {
  it("lists only this project's top-level requirements, sorted by start_at ascending", async () => {
    currentIssues = [
      // 乱序投喂：晚开始的排前面，断言渲染时被重排。
      requirement({
        id: "req-b",
        identifier: "REQ-202",
        number: 202,
        title: "晚开始需求",
        start_at: "2026-09-20T09:00:00Z",
        due_date: "2026-09-22",
        requirement_status: "执行中",
      }),
      requirement({
        id: "req-a",
        identifier: "REQ-201",
        number: 201,
        title: "早开始需求",
        start_at: "2026-09-10T09:00:00Z",
        due_date: "2026-09-12",
        requirement_status: "待触发",
      }),
      requirement({
        id: "child-1",
        identifier: "REQ-203",
        number: 203,
        title: "子任务不进列表",
        parent_issue_id: "req-a",
        start_at: "2026-09-11T09:00:00Z",
        requirement_status: undefined,
      }),
      requirement({
        id: "other-1",
        identifier: "REQ-301",
        number: 301,
        title: "他项目需求不进列表",
        project_id: "proj-2",
        start_at: "2026-09-05T09:00:00Z",
        requirement_status: undefined,
      }),
    ];
    renderPanel(<RequirementListPanel projectId="proj-1" />);

    // 仅本项目两条顶层需求，按 start_at 升序：早开始在前。
    const cards = await screen.findAllByRole("button");
    const texts = cards.map((c) => c.textContent ?? "");
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("早开始需求");
    expect(texts[1]).toContain("晚开始需求");
    expect(screen.queryByText(/子任务不进列表/)).toBeNull();
    expect(screen.queryByText(/他项目需求不进列表/)).toBeNull();
  });

  it("opens the requirement drawer with the list-projected status badge on card click", async () => {
    currentIssues = [requirement()];
    renderPanel(<RequirementListPanel projectId="proj-1" />);

    fireEvent.click(
      await screen.findByRole("button", { name: /积分体系重构/ }),
    );

    // 抽屉打开：概要头 + 列表投影的派生状态徽标。
    expect(
      await screen.findByRole("heading", { name: /积分体系重构/ }),
    ).toBeTruthy();
    expect(mockApi.getIssue).toHaveBeenCalledWith("req-1");
    expect(screen.getByRole("dialog").textContent).toContain("原型待确认");
  });

  it("renders the empty state when the project has no requirements", async () => {
    currentIssues = [
      requirement({
        id: "other-1",
        title: "他项目需求",
        project_id: "proj-2",
        requirement_status: undefined,
      }),
    ];
    renderPanel(<RequirementListPanel projectId="proj-1" />);

    expect(
      await screen.findByText("No requirements in this project yet"),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows an error bar with toast and retry when the list query fails (spec §5)", async () => {
    mockApi.listIssues.mockReset();
    mockApi.listIssues.mockRejectedValue(new Error("boom"));
    renderPanel(<RequirementListPanel projectId="proj-1" />);

    // 失败与真空可区分：错误条 + toast，而非静默空态。
    expect(
      await screen.findByText("Failed to load requirements"),
    ).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("Failed to load requirements");

    // 重试重新发起列表查询。
    const callsBefore = mockApi.listIssues.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(mockApi.listIssues.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });
});
