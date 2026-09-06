/**
 * @vitest-environment jsdom
 *
 * CalendarPage — 工作区级需求日历页（spec §2）：页面负责数据/过滤/抽屉接线，
 * CalendarView 纯受控渲染。仅顶层需求（有排期或派生状态）进入日历；项目过滤
 * chip 收窄范围；点色块开 RequirementDrawer（statusBadge 由列表投影数据供给，
 * 因 GetIssue 不返回 requirement_status）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { Issue, Project } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";
import { CalendarPage } from "./calendar-page";

const mockApi = vi.hoisted(() => ({
  listIssues: vi.fn(),
  listProjects: vi.fn(),
  listProjectModules: vi.fn(),
  getIssue: vi.fn(),
  listChildIssues: vi.fn(),
  listIssueRoleAssignments: vi.fn(),
  listPrototypeVersions: vi.fn(),
  getDecomposition: vi.fn(),
  listProjectResources: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
  ApiError: class ApiError extends Error {},
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `actor-${id}`,
  }),
}));
vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));

// 拖拽改期走共享 update mutation；本页测试不触发拖拽，stub 掉避免拉入
// 真实 mutation hook 的依赖面（同 calendar-view.test.tsx 约定）。
vi.mock("@multica/core/issues/mutations", () => ({
  useUpdateIssue: () => ({ mutate: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../navigation", () => ({
  AppLink: ({
    children,
    href,
    className,
    onClick,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  }) => (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  ),
  useNavigation: () => ({ push: vi.fn(), pathname: "/calendar" }),
  resolveClickIntent: () => "push",
  useIntentNavigate: () => () => {},
  NavigationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@multica/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/paths")>();
  return {
    ...actual,
    useWorkspaceSlug: () => "acme",
    useRequiredWorkspaceSlug: () => "acme",
    useWorkspacePaths: () => actual.paths.workspace("acme"),
  };
});

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

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    workspace_id: "workspace-1",
    title: "项目A",
    description: null,
    icon: null,
    status: "in_progress",
    priority: "medium",
    lead_type: null,
    lead_id: null,
    start_date: null,
    due_date: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    issue_count: 0,
    done_count: 0,
    resource_count: 0,
    ...overrides,
  };
}

function renderPage(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// issueListOptions 的 fixture 入口：beforeEach 里的 mockImplementation 读它
// （模块级 let，非 hoisted 工厂引用，无 hoisting 风险）。
let currentIssues: Issue[] = [];

beforeEach(() => {
  // 锚定月网格覆盖 2026-09：8/31 – 10/4。shouldAdvanceTime 让定时器随真实
  // 时间走（Date 保持冻结），否则 TanStack Query / waitFor 的轮询永不前进。
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));

  // issueListOptions 按 7 个 status_category 并发拉取后 flatten；只在首个
  // 响应里放 fixture，其余空桶，避免同一批 issue 被铺 7 份。
  let served = false;
  mockApi.listIssues.mockImplementation(() => {
    if (served) return Promise.resolve({ issues: [], total: 0 });
    served = true;
    return Promise.resolve({ issues: currentIssues, total: currentIssues.length });
  });
  mockApi.listProjects.mockResolvedValue({
    projects: [project(), project({ id: "proj-2", title: "项目B" })],
    total: 2,
  });
  mockApi.listProjectModules.mockResolvedValue([]);
  mockApi.getIssue.mockResolvedValue(requirement());
  mockApi.listChildIssues.mockResolvedValue({ issues: [] });
  mockApi.listIssueRoleAssignments.mockResolvedValue({ roles: [], total: 0 });
  mockApi.listPrototypeVersions.mockResolvedValue({ versions: [] });
  mockApi.getDecomposition.mockResolvedValue({
    plan: null,
    drafts: [],
    source_comment_id: null,
  });
  mockApi.listProjectResources.mockResolvedValue({ resources: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("CalendarPage", () => {
  it("renders only top-level requirements (no children, no dateless non-requirements)", async () => {
    currentIssues = [
      requirement(),
      requirement({
        id: "child-1",
        identifier: "REQ-102",
        number: 102,
        title: "子任务不应出现",
        parent_issue_id: "req-1",
        start_at: "2026-09-15T10:00:00Z",
        due_date: "2026-09-16",
        requirement_status: undefined,
      }),
      requirement({
        id: "plain-1",
        identifier: "REQ-103",
        number: 103,
        title: "无排期无状态普通任务",
        parent_issue_id: null,
        start_at: null,
        due_date: null,
        requirement_status: undefined,
      }),
    ];
    renderPage(<CalendarPage />);

    // 顶层需求渲染成色块；子任务与「无排期且无派生状态」的普通任务被过滤。
    expect(
      await screen.findByTestId("req-block-req-1-2026-09-15"),
    ).toBeTruthy();
    expect(screen.queryByTestId(/^req-block-child-1/)).toBeNull();
    expect(screen.queryByTestId(/^req-block-plain-1/)).toBeNull();
  });

  it("opens the requirement drawer with the list-projected status badge when a block is clicked", async () => {
    currentIssues = [requirement()];
    renderPage(<CalendarPage />);

    const block = await screen.findByTestId("req-block-req-1-2026-09-15");
    fireEvent.click(block.closest("a")!);

    // 抽屉打开：概要头 + 宿主传入的派生状态徽标。
    expect(
      await screen.findByRole("heading", { name: /积分体系重构/ }),
    ).toBeTruthy();
    expect(mockApi.getIssue).toHaveBeenCalledWith("req-1");
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("原型待确认");
  });

  it("filters requirements by the project toolbar chip", async () => {
    currentIssues = [
      requirement(),
      requirement({
        id: "req-2",
        identifier: "REQ-201",
        number: 201,
        title: "他项目需求",
        project_id: "proj-2",
        start_at: "2026-09-16T09:00:00Z",
        due_date: "2026-09-16",
      }),
    ];
    renderPage(<CalendarPage />);

    expect(
      await screen.findByTestId("req-block-req-1-2026-09-15"),
    ).toBeTruthy();
    expect(screen.getByTestId("req-block-req-2-2026-09-16")).toBeTruthy();

    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter by project" }),
      { target: { value: "proj-1" } },
    );

    expect(screen.getByTestId("req-block-req-1-2026-09-15")).toBeTruthy();
    expect(screen.queryByTestId(/^req-block-req-2/)).toBeNull();
  });

  it("surfaces list query failures with a toast and a page-level retry (spec §5)", async () => {
    // 7 个 status_category 桶全部拒绝 → 聚合 Promise.all 失败。
    mockApi.listIssues.mockReset();
    mockApi.listIssues.mockRejectedValue(new Error("boom"));
    renderPage(<CalendarPage />);

    // 失败不再与「真空工作区」不可区分：页面级错误条 + toast。
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("Failed to load requirements");

    // 页面级重试：点击后重新发起列表查询。
    const callsBefore = mockApi.listIssues.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(mockApi.listIssues.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });
});
