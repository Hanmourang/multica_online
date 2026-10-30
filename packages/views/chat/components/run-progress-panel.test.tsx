import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import type { TaskMessagePayload } from "@multica/core/types";
import enChat from "../../locales/en/chat.json";
import { RunProgressPanel } from "./run-progress-panel";

const TEST_RESOURCES = { en: { chat: enChat } };

function msg(
  seq: number,
  type: TaskMessagePayload["type"],
  extra: Partial<TaskMessagePayload> = {},
): TaskMessagePayload {
  return { task_id: "task-1", issue_id: "issue-1", seq, type, ...extra };
}

const MESSAGES: TaskMessagePayload[] = [
  msg(1, "tool_use", { tool: "skill", input: { name: "multica-feature-modules" } }),
  msg(2, "tool_result", { tool: "skill" }),
  msg(3, "tool_use", { tool: "bash", input: { command: "multica module list --project p1" } }),
  msg(4, "tool_result", { tool: "bash" }),
  msg(5, "tool_use", { tool: "read", input: { file_path: "packages/views/chat/x.tsx" } }),
];

function renderPanel(taskMessages: TaskMessagePayload[]) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <RunProgressPanel
        pendingTask={{ task_id: "task-1", status: "running" }}
        taskMessages={taskMessages}
        availability="online"
      />
    </I18nProvider>,
  );
}

describe("RunProgressPanel", () => {
  it("shows the step count, the current action and the active skill", () => {
    renderPanel(MESSAGES);

    expect(screen.getByText("2/3 steps")).toBeInTheDocument();
    // 摘要行只放当前步骤的目标；动作词已经在 pill 里。
    const header = screen.getByRole("button", { expanded: true });
    expect(within(header).getByText("packages/views/chat/x.tsx")).toBeInTheDocument();
    // 摘要行的 skill 徽章 + 步骤组的 skill 分隔行。
    expect(screen.getAllByText("Skill multica-feature-modules").length).toBeGreaterThan(0);
  });

  it("lists finished and running steps, then collapses on click", () => {
    renderPanel(MESSAGES);

    expect(screen.getByText("multica module list --project p1")).toBeInTheDocument();
    // 目标同时出现在摘要行与步骤行。
    expect(screen.getAllByText("packages/views/chat/x.tsx").length).toBeGreaterThan(1);

    const header = screen.getByRole("button", { expanded: true });
    fireEvent.click(header);

    expect(screen.queryByText("multica module list --project p1")).not.toBeInTheDocument();
    expect(screen.getByText("2/3 steps")).toBeInTheDocument();
  });

  it("falls back to the plain status pill before any tool call lands", () => {
    renderPanel([msg(1, "thinking", { content: "先看看模块" })]);

    expect(screen.getByText(/Thinking/)).toBeInTheDocument();
    expect(screen.queryByText(/steps/)).not.toBeInTheDocument();
  });
});
