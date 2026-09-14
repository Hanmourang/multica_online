/**
 * @vitest-environment jsdom
 *
 * Requirement calendar view: month/week grids place each requirement on its
 * start day only (a later due_date does not paint extra cells); weekends
 * grey; tooltips keep the minute component.
 */
import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { toast } from "sonner";
import {
  type IssueViewState,
  viewStoreSlice,
} from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: [] }),
  useQueries: () => [],
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

// Drag rescheduling funnels into the shared update mutation; capture the
// payload here.
const mockUpdateMutate = vi.fn();
vi.mock("@multica/core/issues/mutations", () => ({
  useUpdateIssue: () => ({ mutate: mockUpdateMutate }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));

// Tooltip content renders inline so the minute-granularity times are
// assertable without hover timing (same pattern as gantt-view.test.tsx).
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
  useNavigation: () => ({ push: vi.fn(), pathname: "/issues" }),
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

import { CalendarView } from "./calendar-view";

function requirement(overrides: Partial<Issue>): Issue {
  return {
    id: "req-1",
    identifier: "REQ-1",
    number: 1,
    title: "会员积分重构",
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
    due_date: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  } as unknown as Issue;
}

function renderCalendar(
  issues: Issue[],
  zoom?: "week" | "month",
  onOpenRequirement?: (issueId: string) => void,
) {
  const store = createStore<IssueViewState>()(viewStoreSlice);
  if (zoom) store.getState().setCalendarZoom(zoom);
  return renderWithI18n(
    <ViewStoreProvider store={store}>
      <CalendarView issues={issues} onOpenRequirement={onOpenRequirement} />
    </ViewStoreProvider>,
  );
}

describe("CalendarView", () => {
  beforeEach(() => {
    // Tuesday of the fixture week: week view spans Mon 9/14 – Sun 9/20.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    mockUpdateMutate.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("calls onOpenRequirement instead of navigating when provided", () => {
    const onOpen = vi.fn();
    renderCalendar(
      [
        requirement({
          start_at: "2026-09-15T09:00:00Z",
          due_date: "2026-09-16",
        }),
      ],
      undefined,
      onOpen,
    );

    const anchor = screen
      .getByTestId("req-block-req-1-2026-09-15")
      .closest("a");
    expect(anchor).not.toBeNull();
    fireEvent.click(anchor!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("req-1");
    // Intercepted: the anchor keeps its href for open-in-new-tab, but the
    // default navigation is prevented.
    expect(anchor!.getAttribute("href")).toBe("/acme/issues/req-1");
  });

  it("month view paints only the start day even when due_date is later", () => {
    renderCalendar([
      requirement({
        start_at: "2026-09-15T09:30:00Z",
        due_date: "2026-09-17T18:00:00Z",
        requirement_status: "执行中",
        stage_progress: "2/5",
      }),
    ]);

    const startSeg = screen.getByTestId("req-block-req-1-2026-09-15");
    expect(startSeg.getAttribute("data-segment")).toBe("start");
    expect(startSeg.textContent).toContain("会员积分重构");
    expect(screen.queryByTestId("req-block-req-1-2026-09-16")).toBeNull();
    expect(screen.queryByTestId("req-block-req-1-2026-09-17")).toBeNull();
    expect(screen.queryByTestId("req-block-req-1-2026-09-18")).toBeNull();

    expect(startSeg.textContent).toContain("执行中");
    expect(startSeg.textContent).toContain("2/5");
  });

  it("week view greys weekend cells and keeps a same-day block on its start day", () => {
    renderCalendar(
      [
        requirement({
          id: "req-2",
          identifier: "REQ-2",
          start_at: "2026-09-16T09:00:00Z",
          due_date: "2026-09-20T18:00:00Z",
          requirement_status: "执行中",
          stage_progress: "1/3",
        }),
      ],
      "week",
    );

    expect(screen.getByTestId("cal-cell-2026-09-19").getAttribute("data-weekend")).toBe("true");
    expect(screen.getByTestId("cal-cell-2026-09-20").getAttribute("data-weekend")).toBe("true");
    expect(screen.getByTestId("cal-cell-2026-09-15").getAttribute("data-weekend")).not.toBe("true");

    const block = screen.getByTestId("req-block-req-2-2026-09-16");
    expect(block.getAttribute("data-segment")).toBe("start");
    expect(block.textContent).toContain("REQ-2");
    expect(screen.queryByTestId("req-block-req-2-2026-09-14")).toBeNull();
    expect(screen.queryByTestId("req-block-req-2-2026-09-17")).toBeNull();
    expect(screen.queryByTestId("req-block-req-2-2026-09-20")).toBeNull();
  });

  it("tooltip keeps the minute-granularity times", () => {
    renderCalendar([
      requirement({
        start_at: "2026-09-15T09:30:00Z",
        due_date: "2026-09-17T18:00:00Z",
        requirement_status: "待触发",
      }),
    ]);

    // The block's hover data spells out the minute component the day cells
    // floored away. The mocked tooltip renders inline as a sibling of the
    // block (same pattern as the gantt tests) — one copy per day segment,
    // so assert at screen level with getAllByText.
    expect(screen.getAllByText(/09:30/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/18:00/).length).toBeGreaterThan(0);
  });

  it("dragging a block onto a later cell PATCHes start_at/due_date shifted by the day delta and toasts the trigger linkage", () => {
    renderCalendar([
      requirement({
        start_at: "2026-09-15T09:30:00Z",
        due_date: "2026-09-17",
        requirement_status: "待触发",
        auto_trigger: true,
      }),
    ]);

    const block = screen.getByTestId("req-block-req-1-2026-09-15");
    expect(block.getAttribute("draggable")).toBe("true");

    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => "req-1"),
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(block, { dataTransfer });
    const target = screen.getByTestId("cal-cell-2026-09-22");
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    // 9/15 → 9/22 is +7 days: the minute component survives on start_at,
    // due_date stays a calendar day.
    expect(mockUpdateMutate).toHaveBeenCalledTimes(1);
    const [payload] = mockUpdateMutate.mock.calls[0]!;
    expect(payload.id).toBe("req-1");
    expect(payload.start_at).toBe("2026-09-22T09:30:00.000Z");
    expect(payload.due_date).toBe("2026-09-22");

    // The reschedule toast names the auto-trigger linkage (spec §7.2).
    expect(toast.success).toHaveBeenCalledWith(
      "Rescheduled — the auto-trigger time moved with it",
      expect.objectContaining({ duration: 5000 }),
    );
  });

  it("running or finished requirements are not draggable and explain why", () => {
    renderCalendar([
      requirement({
        id: "req-run",
        identifier: "REQ-2",
        start_at: "2026-09-15T09:00:00Z",
        due_date: "2026-09-16",
        requirement_status: "执行中",
      }),
      requirement({
        id: "req-done",
        identifier: "REQ-3",
        start_at: "2026-09-16T09:00:00Z",
        due_date: "2026-09-16",
        requirement_status: "已完成",
      }),
    ]);

    const running = screen.getByTestId("req-block-req-run-2026-09-15");
    expect(running.getAttribute("draggable")).toBe("false");
    expect(running.getAttribute("title")).toBe(
      "Already triggered — cancel the run before rescheduling",
    );
    const done = screen.getByTestId("req-block-req-done-2026-09-16");
    expect(done.getAttribute("draggable")).toBe("false");
    expect(done.getAttribute("title")).toBe(
      "Already triggered — cancel the run before rescheduling",
    );
  });

  it("第10态「验收失败」渲染✗色块且锁改期（终态不可拖拽）", () => {
    renderCalendar([
      requirement({
        id: "req-fail",
        identifier: "REQ-9",
        start_at: "2026-09-15T09:00:00Z",
        due_date: "2026-09-16",
        requirement_status: "验收失败",
      }),
    ]);

    const block = screen.getByTestId("req-block-req-fail-2026-09-15");
    // 派生态文案 + ✗ 图标（STATUS_ICON["验收失败"]）都落在 start 段。
    expect(block.textContent).toContain("验收失败");
    expect(block.textContent).toContain("✗");
    // 终态锁改期：与「执行中/已完成」同款不可拖拽 + title 说明。
    expect(block.getAttribute("draggable")).toBe("false");
    expect(block.getAttribute("title")).toBe(
      "Already triggered — cancel the run before rescheduling",
    );
  });

  it("shows the auto-trigger time on a confirmed-but-not-fired block", () => {
    renderCalendar([
      requirement({
        start_at: "2026-09-15T09:00:00Z",
        due_date: "2026-09-16",
        requirement_status: "待触发",
      }),
    ]);
    expect(screen.getByTestId("req-trigger-req-1").textContent).toMatch(/9\/15 09:00/);
  });

  it("names the occupying requirement in the waiting-lock tooltip", () => {
    renderCalendar([
      requirement({
        id: "req-wait",
        identifier: "REQ-W",
        number: 2,
        title: "等待中",
        start_at: "2026-09-16T09:00:00Z",
        due_date: "2026-09-16",
        requirement_status: "等待模块释放",
        module_id: "mod-1",
      }),
      requirement({
        id: "req-hold",
        identifier: "REQ-H",
        number: 7,
        title: "占用模块",
        start_at: "2026-09-15T09:00:00Z",
        due_date: "2026-09-17",
        requirement_status: "执行中",
        module_id: "mod-1",
      }),
    ]);
    expect(screen.getAllByText(/held by requirement #7 占用模块/).length).toBeGreaterThan(0);
  });

  it("dims the source block and shows a floating date preview while dragging", () => {
    renderCalendar([
      requirement({
        start_at: "2026-09-15T09:30:00Z",
        due_date: "2026-09-17",
        requirement_status: "待触发",
      }),
    ]);
    const block = screen.getByTestId("req-block-req-1-2026-09-15");
    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => "req-1"),
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(block, { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("cal-cell-2026-09-22"), { dataTransfer });
    expect(block.className).toContain("opacity-40");
    expect(screen.getByTestId("calendar-drag-preview").textContent).toBe(
      "2026-09-15 → 2026-09-22",
    );
  });

  it("drop onto an occupying module day refuses and names a free window", () => {
    renderCalendar([
      requirement({
        start_at: "2026-09-15T09:30:00Z",
        due_date: "2026-09-16",
        requirement_status: "待触发",
        module_id: "mod-1",
      }),
      requirement({
        id: "req-busy",
        identifier: "REQ-B",
        number: 9,
        title: "占窗需求",
        start_at: "2026-09-18T09:00:00Z",
        due_date: "2026-09-20",
        requirement_status: "执行中",
        module_id: "mod-1",
      }),
    ]);

    const block = screen.getByTestId("req-block-req-1-2026-09-15");
    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => "req-1"),
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(block, { dataTransfer });
    fireEvent.drop(screen.getByTestId("cal-cell-2026-09-18"), { dataTransfer });

    expect(mockUpdateMutate).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("#9"),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
