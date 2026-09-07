/**
 * @vitest-environment jsdom
 *
 * RequirementSchedulePanel（spec 画面 6）：执行阶段面板 —— 触发倒计时 / 已触发时刻、
 * stage3 子任务进度、互斥等待 banner（等待模块释放）、手动触发按钮（调注入的
 * triggerRequirement，409 时 toast 原因）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { RequirementSchedulePanel } from "./requirement-schedule-panel";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueExecLog: (id: string) => `/test/issues/${id}?tab=exec`,
  }),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function requirement(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "req-1",
    identifier: "REQ-101",
    stage_progress: "1/3",
    triggered_at: null,
    start_at: "2026-09-10T09:30:00Z",
    requirement_status: "待触发",
    ...overrides,
  } as unknown as Issue;
}

function child(id: string, status: string): Issue {
  return { id, identifier: `REQ-${id}`, title: `子任务 ${id}`, stage: 3, status } as unknown as Issue;
}

describe("RequirementSchedulePanel", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("未触发时渲染倒计时 + 手动触发按钮 + stage3 进度清单", () => {
    renderWithI18n(
      <RequirementSchedulePanel
        issue={requirement()}
        childIssues={[child("c1", "todo"), child("c2", "done")]}
        triggerRequirement={vi.fn()}
      />,
    );
    expect(screen.getByTestId("schedule-countdown").textContent).toMatch(/09:30/);
    expect(screen.getByTestId("schedule-trigger")).toBeTruthy();
    expect(screen.getByTestId("schedule-progress").textContent).toContain("1/3");
    expect(screen.getByTestId("schedule-child-c1")).toBeTruthy();
    expect(screen.getByTestId("schedule-child-c2")).toBeTruthy();
    expect(
      screen.getByTestId("schedule-child-c1").querySelector("a"),
    ).toHaveAttribute("href", "/test/issues/c1?tab=exec");
    expect(screen.getByTestId("schedule-preflight")).toBeTruthy();
  });

  it("links a failed child to the A3 execution log", () => {
    renderWithI18n(
      <RequirementSchedulePanel
        issue={requirement()}
        childIssues={[child("c3", "failed")]}
        triggerRequirement={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "View failure →" })).toHaveAttribute(
      "href",
      "/test/issues/c3?tab=exec",
    );
  });

  it("等待模块释放时渲染互斥 banner；无子任务时渲染空态", () => {
    renderWithI18n(
      <RequirementSchedulePanel
        issue={requirement({ requirement_status: "等待模块释放" })}
        childIssues={[]}
        triggerRequirement={vi.fn()}
      />,
    );
    expect(screen.getByTestId("schedule-waiting-lock")).toBeTruthy();
    expect(screen.getByTestId("schedule-progress").textContent).toContain("No execution subtasks yet");
  });

  it("已触发时显示已触发徽标、不渲染触发按钮", () => {
    renderWithI18n(
      <RequirementSchedulePanel
        issue={requirement({ triggered_at: "2026-09-10T09:30:05Z" })}
        childIssues={[]}
        triggerRequirement={vi.fn()}
      />,
    );
    expect(screen.getByTestId("schedule-triggered")).toBeTruthy();
    expect(screen.queryByTestId("schedule-trigger")).toBeNull();
    expect(screen.getByTestId("schedule-countdown").textContent).toMatch(/09:30/);
  });

  it("点击触发调用 triggerRequirement(issueId)", async () => {
    const trigger = vi.fn().mockResolvedValue({ triggered: true, enqueued: 2, issue_id: "req-1" });
    renderWithI18n(
      <RequirementSchedulePanel issue={requirement()} childIssues={[]} triggerRequirement={trigger} />,
    );
    fireEvent.click(screen.getByTestId("schedule-trigger"));
    await waitFor(() => expect(trigger).toHaveBeenCalledWith("req-1"));
  });

  it("触发被拒（409）时 toast 服务端原因", async () => {
    const trigger = vi.fn().mockRejectedValue(new Error("module_window_busy"));
    renderWithI18n(
      <RequirementSchedulePanel issue={requirement()} childIssues={[]} triggerRequirement={trigger} />,
    );
    fireEvent.click(screen.getByTestId("schedule-trigger"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("module_window_busy"));
  });
});
