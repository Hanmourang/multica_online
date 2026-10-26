// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Sprint } from "@multica/core/types";
import { renderWithI18n } from "../../../test/i18n";
import { SprintSidebar } from "./sprint-sidebar";

// 侧边栏是纯展示件（数据与过滤态都在编排层持有），这里直接喂 props 测它的
// 四条边界：选中态回写、搜索是客户端二次过滤、加载/失败/空态各自的文案。

const { handlers } = vi.hoisted(() => ({
  handlers: {
    onSelect: vi.fn(),
    onStatusFilter: vi.fn(),
    onCreate: vi.fn(),
    onRetry: vi.fn(),
  },
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `actor-${id}`,
  }),
}));
vi.mock("../../../common/actor-avatar", () => ({ ActorAvatar: () => null }));

const PLANNED: Sprint = {
  id: "sp-1",
  workspace_id: "ws-1",
  project_id: "p-1",
  name: "Sprint 01",
  goal: "打地基",
  status: "planned",
  start_date: "2026-10-24",
  end_date: "2026-11-07",
  capacity: null,
  created_by_type: "member",
  created_by_id: "u-1",
  started_at: null,
  completed_at: null,
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
  issue_count: 1,
  done_count: 0,
};

const COMPLETED: Sprint = {
  ...PLANNED,
  id: "sp-9",
  name: "Sprint 09",
  goal: null,
  status: "completed",
  issue_count: 4,
  done_count: 4,
};

type SidebarProps = ComponentProps<typeof SprintSidebar>;

function renderSidebar(over: Partial<SidebarProps> = {}) {
  const props: SidebarProps = {
    sprints: [PLANNED, COMPLETED],
    total: 2,
    selectedId: PLANNED.id,
    onSelect: handlers.onSelect,
    statusFilter: null,
    onStatusFilter: handlers.onStatusFilter,
    isPending: false,
    isError: false,
    onRetry: handlers.onRetry,
    onCreate: handlers.onCreate,
    ...over,
  };
  return renderWithI18n(<SprintSidebar {...props} />);
}

describe("SprintSidebar", () => {
  it("marks the selected card and reports clicks plus the create action", async () => {
    const user = userEvent.setup();
    renderSidebar();

    const selected = screen.getByTestId("sprint-card-sp-1");
    expect(selected).toHaveAttribute("aria-current", "true");
    // 卡片进度直接读列表聚合，日期区间与创建者名同屏（对标 CoCo 卡片信息密度）。
    expect(within(selected).getByText("2026-10-24 → 2026-11-07")).toBeInTheDocument();
    expect(within(selected).getByText("actor-u-1")).toBeInTheDocument();
    expect(screen.getByTestId("sprint-card-sp-9")).not.toHaveAttribute("aria-current");

    await user.click(screen.getByTestId("sprint-card-sp-9"));
    expect(handlers.onSelect).toHaveBeenCalledWith("sp-9");

    await user.click(screen.getByRole("button", { name: "New sprint" }));
    expect(handlers.onCreate).toHaveBeenCalled();
  });

  it("pushes status chips up to the orchestrator (the filter is a server query param)", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "Completed" }));
    expect(handlers.onStatusFilter).toHaveBeenCalledWith("completed");
  });

  it("searches client-side and distinguishes a search miss from a genuinely empty list", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.type(screen.getByLabelText("Search sprints"), "nothing");
    expect(screen.getByText('No sprint matches "nothing"')).toBeInTheDocument();
    expect(screen.queryByTestId("sprint-card-sp-1")).toBeNull();
  });

  it("falls back to the no-data copy when the server really has no sprints", () => {
    renderSidebar({ sprints: [], total: 0 });
    expect(screen.getByText("No sprints yet. Create one to start planning iterations.")).toBeInTheDocument();
  });

  it("renders loading and error frames instead of an empty list", async () => {
    const user = userEvent.setup();
    const { unmount } = renderSidebar({ isPending: true, sprints: [], total: 0 });
    expect(screen.getByTestId("archive-loading")).toBeInTheDocument();
    unmount();

    renderSidebar({ isError: true, sprints: [], total: 0 });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(handlers.onRetry).toHaveBeenCalled();
  });
});
