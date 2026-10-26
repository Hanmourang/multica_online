// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Issue, Sprint } from "@multica/core/types";
import { renderWithI18n } from "../../../test/i18n";
import { SprintTab } from "./sprint-tab";
import { SprintDetailPlaceholder } from "./sprint-detail";

// 迭代 TAB 组件测（spec 02_迭代模块.md §G + CoCo 迭代页双栏形态）。数据层整体
// mock：这里验证 master-detail 的编排——侧栏卡片选择/搜索、深链带入的选中项、
// 详情头部的 CAS 迁移入口、范围内的纳入流程，以及建迭代表单。

const { spies, toastDouble } = vi.hoisted(() => {
  const ok = async () => ({});
  return {
    spies: {
      create: vi.fn(ok),
      update: vi.fn(ok),
      del: vi.fn(ok),
      start: vi.fn(ok),
      complete: vi.fn(ok),
      reopen: vi.fn(ok),
      assign: vi.fn(ok),
      remove: vi.fn(ok),
    },
    toastDouble: { success: vi.fn(), error: vi.fn() },
  };
});

const PLANNED: Sprint = {
  id: "sp-1",
  workspace_id: "ws-1",
  project_id: "p-1",
  name: "Sprint 01",
  goal: "打地基",
  status: "planned",
  start_date: "2026-10-01",
  end_date: "2026-10-14",
  capacity: null,
  created_by_type: "member",
  created_by_id: "u-1",
  started_at: null,
  completed_at: null,
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
  issue_count: 0,
  done_count: 0,
};

const ACTIVE: Sprint = {
  ...PLANNED,
  id: "sp-2",
  name: "Sprint 02",
  status: "active",
  start_date: null,
  end_date: null,
  issue_count: 2,
  done_count: 1,
};

const MEMBER: Issue = {
  id: "i-1",
  workspace_id: "ws-1",
  number: 1,
  identifier: "MUL-1",
  title: "迁移 470 落库",
  description: "",
  status: "done",
  priority: "medium",
  assignee_type: null,
  assignee_id: null,
  creator_type: "member",
  creator_id: "u-1",
  parent_issue_id: null,
  project_id: "p-1",
  position: 0,
  stage: null,
  start_date: null,
  due_date: null,
  metadata: {},
  properties: {},
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  sprint_id: "sp-2",
};

const BACKLOG: Issue = {
  ...MEMBER,
  id: "i-9",
  number: 9,
  identifier: "MUL-9",
  title: "补迭代单测",
  status: "todo",
  sprint_id: null,
};

vi.mock("sonner", () => ({ toast: toastDouble }));

vi.mock("@multica/core/api", () => ({ api: { listIssues: vi.fn() } }));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

// 侧栏卡片的创建者头像依赖 workspace 班底查询，按 calendar 测试同一约定 stub。
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `actor-${id}`,
  }),
}));
vi.mock("../../../common/actor-avatar", () => ({ ActorAvatar: () => null }));

vi.mock("@multica/core/issues/queries", () => ({
  issueKeys: { all: (wsId: string) => ["issues", wsId] },
}));

vi.mock("@multica/core/sprints/queries", () => ({
  projectSprintsOptions: (_ws: string, _pid: string, status?: string) => ({
    queryKey: ["sprints", "list", status ?? "all"],
  }),
  sprintProgressOptions: (_ws: string, _pid: string, sprintId: string) => ({
    queryKey: ["sprint-progress", sprintId],
  }),
}));

vi.mock("@multica/core/sprints/mutations", () => ({
  useCreateSprint: () => ({ mutateAsync: spies.create, isPending: false }),
  useUpdateSprint: () => ({ mutateAsync: spies.update, isPending: false }),
  useDeleteSprint: () => ({ mutateAsync: spies.del, isPending: false }),
  useStartSprint: () => ({ mutateAsync: spies.start, isPending: false, variables: null }),
  useCompleteSprint: () => ({ mutateAsync: spies.complete, isPending: false, variables: null }),
  useReopenSprint: () => ({ mutateAsync: spies.reopen, isPending: false, variables: null }),
  useAssignSprintIssues: () => ({ mutateAsync: spies.assign, isPending: false }),
  useRemoveSprintIssues: () => ({ mutateAsync: spies.remove, isPending: false }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (options: { queryKey?: readonly unknown[] }) => {
    // 成员/待办池键形如 ["issues", wsId, "sprint-members"|"sprint-backlog", ...]。
    const [head, , second] = options.queryKey ?? [];
    if (head === "sprints") {
      return {
        data: { sprints: [PLANNED, ACTIVE], total: 2 },
        isPending: false,
        isError: false,
        refetch: vi.fn(),
      };
    }
    if (head === "sprint-progress") {
      return {
        data: {
          done_count: 1,
          cancelled_count: 0,
          total_count: 2,
          capacity: null,
          sprint_id: "sp-2",
          sprint_status: "active",
        },
        isPending: false,
        isError: false,
      };
    }
    if (head === "issues" && second === "sprint-members") {
      return { data: { issues: [MEMBER], total: 1 }, isPending: false, isError: false };
    }
    if (head === "issues" && second === "sprint-backlog") {
      return { data: { issues: [BACKLOG], total: 1 }, isPending: false, isError: false };
    }
    return { data: undefined, isPending: false, isError: false };
  },
}));

function renderTab(props: { selectedSprintId?: string | null; onSelectSprint?: (id: string) => void } = {}) {
  return renderWithI18n(
    <SprintTab projectId="p-1" selectedSprintId={props.selectedSprintId} onSelectSprint={props.onSelectSprint} />,
  );
}

describe("SprintTab", () => {
  it("renders the two-column shell: sidebar cards, status filter, timeline and the auto-selected detail", () => {
    renderTab();

    const sidebar = screen.getByTestId("sprint-sidebar");
    expect(within(sidebar).getByText("Sprints")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New sprint" })).toBeInTheDocument();
    for (const label of ["All statuses", "Planned", "Active", "Completed"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }

    const plannedCard = screen.getByTestId("sprint-card-sp-1");
    expect(within(plannedCard).getByText("Sprint 01")).toBeInTheDocument();
    expect(within(plannedCard).getByText("打地基")).toBeInTheDocument();
    // 卡片进度环直接吃列表聚合的 done_count/issue_count，不逐条打 /progress。
    expect(within(plannedCard).getByText("0 / 0 done")).toBeInTheDocument();

    // 未排期的 active 迭代显示占位语。
    const activeCard = screen.getByTestId("sprint-card-sp-2");
    expect(within(activeCard).getByText("No dates set")).toBeInTheDocument();
    expect(within(activeCard).getByText("1 / 2 done")).toBeInTheDocument();

    // 泳道只画有日期的迭代：Sprint 01 在、Sprint 02 不在。
    const timeline = screen.getByTestId("sprint-timeline");
    expect(within(timeline).getByText("Sprint 01")).toBeInTheDocument();
    expect(within(timeline).queryByText("Sprint 02")).toBeNull();

    // 无深链时默认落在列表第一条（CoCo 进页面即选中首个迭代）。
    const detail = screen.getByTestId("sprint-detail-sp-1");
    expect(within(detail).getByText("Sprint 01")).toBeInTheDocument();
    expect(screen.queryByTestId("sprint-detail-sp-2")).toBeNull();
  });

  it("selecting a sidebar card swaps the detail and writes the id back for the ?sprint= deep link", async () => {
    const user = userEvent.setup();
    const onSelectSprint = vi.fn();
    renderTab({ onSelectSprint });

    await user.click(screen.getByTestId("sprint-card-sp-2"));

    expect(onSelectSprint).toHaveBeenCalledWith("sp-2");
    const detail = screen.getByTestId("sprint-detail-sp-2");
    expect(within(detail).getByText("MUL-1")).toBeInTheDocument();
    expect(screen.queryByTestId("sprint-detail-sp-1")).toBeNull();
  });

  it("honours an incoming ?sprint= deep link without a click", () => {
    renderTab({ selectedSprintId: "sp-2" });

    expect(screen.getByTestId("sprint-detail-sp-2")).toBeInTheDocument();
    expect(screen.queryByTestId("sprint-detail-sp-1")).toBeNull();
  });

  it("runs the planned→active CAS transition from the detail header", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(within(screen.getByTestId("sprint-detail-sp-1")).getByRole("button", { name: "Start" }));

    expect(spies.start).toHaveBeenCalledWith("sp-1");
    expect(toastDouble.success).toHaveBeenCalledWith("Sprint started");
  });

  it("shows derived progress and runs the backlog add flow inside the detail scope panel", async () => {
    const user = userEvent.setup();
    renderTab({ selectedSprintId: "sp-2" });

    const panel = screen.getByTestId("sprint-members-sp-2");
    expect(within(panel).getByText("MUL-1")).toBeInTheDocument();

    // 待办池勾选 → 纳入：整单批量接口，issueIds 透传。
    await user.click(within(panel).getByLabelText("补迭代单测"));
    const addButton = within(panel).getByRole("button", { name: "Add issues" });
    expect(addButton).toBeEnabled();
    await user.click(addButton);

    expect(spies.assign).toHaveBeenCalledWith({ sprintId: "sp-2", issueIds: ["i-9"] });
    expect(toastDouble.success).toHaveBeenCalledWith("Issues added to sprint");
  });

  it("filters the sidebar cards by the search box without touching the server query", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.type(screen.getByLabelText("Search sprints"), "02");

    expect(screen.queryByTestId("sprint-card-sp-1")).toBeNull();
    expect(screen.getByTestId("sprint-card-sp-2")).toBeInTheDocument();
  });

  it("guides the user when no sprint is available to open", () => {
    renderWithI18n(<SprintDetailPlaceholder />);
    expect(screen.getByTestId("sprint-detail-placeholder")).toHaveTextContent(
      "Select a sprint on the left",
    );
  });

  it("creates a sprint through the dialog with name validation", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole("button", { name: "New sprint" }));
    const dialog = screen.getByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Create sprint" });
    // 空名时提交禁用（errors.name_required 前置校验）。
    expect(submit).toBeDisabled();

    await user.type(within(dialog).getByPlaceholderText("e.g. Sprint 01"), "Sprint 05");
    await user.click(submit);

    expect(spies.create).toHaveBeenCalledWith({
      name: "Sprint 05",
      goal: "",
      capacity: null,
    });
    expect(toastDouble.success).toHaveBeenCalledWith("Sprint created");
  });
});
