/**
 * @vitest-environment jsdom
 *
 * Requirement calendar view: month grid lays requirement blocks across
 * start_at ~ due_date (minute-granularity floored to days), with the derived
 * pipeline status badge and stage progress on the block; the week grid greys
 * weekends and clips cross-week ranges at the grid edge; tooltips keep the
 * minute component.
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
import { renderWithI18n } from "../../test/i18n";

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
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Tooltip content renders inline so the minute-granularity times are
// assertable without hover timing (same pattern as gantt-view.test.tsx).
vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../../navigation", () => ({
  AppLink: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
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

function renderCalendar(issues: Issue[], zoom?: "week" | "month") {
  const store = createStore<IssueViewState>()(viewStoreSlice);
  if (zoom) store.getState().setCalendarZoom(zoom);
  return renderWithI18n(
    <ViewStoreProvider store={store}>
      <CalendarView issues={issues} />
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
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("month view spans a requirement across start_at ~ due_date with status badge and progress", () => {
    renderCalendar([
      requirement({
        start_at: "2026-09-15T09:30:00Z",
        due_date: "2026-09-17T18:00:00Z",
        requirement_status: "执行中",
        stage_progress: "2/5",
      }),
    ]);

    // The block lands on all three days; only the first segment carries the
    // title.
    const startSeg = screen.getByTestId("req-block-req-1-2026-09-15");
    expect(startSeg.getAttribute("data-segment")).toBe("start");
    expect(startSeg.textContent).toContain("会员积分重构");
    expect(
      screen.getByTestId("req-block-req-1-2026-09-16").getAttribute("data-segment"),
    ).toBe("mid");
    expect(
      screen.getByTestId("req-block-req-1-2026-09-17").getAttribute("data-segment"),
    ).toBe("end");
    // Nothing spills onto the day after the due date.
    expect(screen.queryByTestId("req-block-req-1-2026-09-18")).toBeNull();

    // Derived pipeline status + stage progress ride the first segment.
    expect(startSeg.textContent).toContain("执行中");
    expect(startSeg.textContent).toContain("2/5");
  });

  it("week view greys weekend cells and clips a cross-week range at the grid edge", () => {
    renderCalendar(
      [
        requirement({
          id: "req-2",
          identifier: "REQ-2",
          start_at: "2026-09-11T09:00:00Z", // previous week (Fri)
          due_date: "2026-09-16T18:00:00Z", // this week (Wed)
          requirement_status: "执行中",
          stage_progress: "1/3",
        }),
      ],
      "week",
    );

    // Saturday / Sunday of the current week render greyed.
    expect(screen.getByTestId("cal-cell-2026-09-19").getAttribute("data-weekend")).toBe("true");
    expect(screen.getByTestId("cal-cell-2026-09-20").getAttribute("data-weekend")).toBe("true");
    expect(screen.getByTestId("cal-cell-2026-09-15").getAttribute("data-weekend")).not.toBe("true");

    // The range started before this week: Monday's segment is a clipped
    // continuation, not a rounded start.
    expect(
      screen.getByTestId("req-block-req-2-2026-09-14").getAttribute("data-segment"),
    ).toBe("mid");
    expect(
      screen.getByTestId("req-block-req-2-2026-09-16").getAttribute("data-segment"),
    ).toBe("end");
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
    expect(payload.due_date).toBe("2026-09-24");

    // The reschedule toast names the auto-trigger linkage (spec §7.2).
    expect(toast.success).toHaveBeenCalledWith(
      "Rescheduled — the auto-trigger time moved with it",
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
});
