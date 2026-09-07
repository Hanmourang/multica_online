import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentTask } from "@multica/core/types";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import { ExecutionLogPanel } from "./execution-log-panel";
import type { LabeledTask } from "./use-issue-execution-tasks";

const mockApi = vi.hoisted(() => ({
  listTaskMessages: vi.fn().mockResolvedValue([]),
  rerunIssue: vi.fn().mockResolvedValue({ id: "rerun-1" }),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
  dispatchReasonCode: () => "",
}));

vi.mock("@multica/core/chat/queries", () => ({
  isTaskMessageTaskId: () => false,
  taskMessagesOptions: (id: string) => ({
    queryKey: ["task-messages", id],
    queryFn: () => Promise.resolve([]),
  }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) =>
      id === "agent-1" ? "Orion" : "Agent",
  }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));

vi.mock("../../common/task-transcript", () => ({
  AgentTranscriptDialog: ({ embedded }: { embedded?: boolean }) =>
    embedded ? <div data-testid="agent-transcript-embedded" /> : null,
  buildTimeline: () => [],
}));

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "run-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "completed",
    priority: 0,
    dispatched_at: null,
    started_at: "2026-09-06T10:00:00Z",
    completed_at: "2026-09-06T10:18:00Z",
    result: null,
    error: null,
    created_at: "2026-09-06T10:00:00Z",
    ...overrides,
  };
}

function labeled(overrides: Partial<AgentTask> = {}, title?: string): LabeledTask {
  const item = task(overrides);
  return { task: item, sourceIssueId: item.issue_id, sourceTitle: title };
}

function renderPanel(labeledTasks: LabeledTask[], preferredRunId?: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <ExecutionLogPanel
        issueId="issue-1"
        labeledTasks={labeledTasks}
        preferredRunId={preferredRunId}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("ExecutionLogPanel", () => {
  beforeEach(() => {
    cleanup();
    mockApi.listTaskMessages.mockResolvedValue([]);
    mockApi.rerunIssue.mockResolvedValue({ id: "rerun-1" });
  });

  it("selects a failed run by default and shows duration metadata", async () => {
    renderPanel([
      labeled({ id: "done", status: "completed" }, "T1"),
      labeled({ id: "bad", status: "failed" }, "T3"),
    ]);

    const failed = await screen.findByTestId("exec-run-bad");
    expect(failed.className).toContain("border-l-foreground");
    expect(failed).toHaveTextContent("T3");
    expect(failed).toHaveTextContent("Failed");
    expect(failed).toHaveTextContent("18m");
    await screen.findByTestId("agent-transcript-embedded");
  });

  it("honors a deep-linked run id", async () => {
    renderPanel(
      [
        labeled({ id: "done", status: "completed" }, "T1"),
        labeled({ id: "bad", status: "failed" }, "T3"),
      ],
      "done",
    );

    expect(await screen.findByTestId("exec-run-done")).toHaveClass("border-l-foreground");
  });

  it("retries the selected failed run in its original context", async () => {
    renderPanel([labeled({ id: "bad", status: "failed" }, "T3")]);

    fireEvent.click(await screen.findByTestId("exec-retry"));
    await waitFor(() => {
      expect(mockApi.rerunIssue).toHaveBeenCalledWith("issue-1", "bad");
    });
  });
});
