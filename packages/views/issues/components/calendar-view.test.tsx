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
import { cleanup, screen } from "@testing-library/react";
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
});
