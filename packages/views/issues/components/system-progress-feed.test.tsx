import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import { SystemProgressFeed } from "./system-progress-feed";

const mockDynamics = vi.hoisted(() =>
  vi.fn(async () => ({
    issue: { id: "issue-1", title: "Req", status: "in_progress" },
    days: [
      {
        date: "2026-09-06",
        events: [
          {
            id: "e1",
            type: "progress",
            actor: "agent-1",
            actor_name: "Orion",
            content: "heartbeat: still working on T3",
            ts: "2026-09-06T10:00:00Z",
          },
          {
            id: "e2",
            type: "conversation",
            actor: "user-1",
            actor_name: "Lin",
            content: "please ignore",
            ts: "2026-09-06T11:00:00Z",
          },
        ],
      },
    ],
    summary: {
      task_total: 1,
      task_dispatched: 1,
      message_count: 1,
      progress_event_count: 1,
      artifact_count: 0,
      artifact_archived_count: 0,
    },
    filters: { tasks: [], agents: [], types: [] },
  })),
);

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/agent-runs/queries", () => ({
  issueDynamicsOptions: () => ({
    queryKey: ["issue-archive", "ws-1", "issue-1", "dynamics"],
    queryFn: mockDynamics,
  }),
}));

function renderFeed(enabled: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <SystemProgressFeed issueId="issue-1" enabled={enabled} timeWindow="all" />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("SystemProgressFeed", () => {
  it("does not fetch while the system filter is off", () => {
    renderFeed(false);
    expect(screen.queryByTestId("system-progress-feed")).toBeNull();
    expect(mockDynamics).not.toHaveBeenCalled();
  });

  it("renders progress events and skips conversation", async () => {
    renderFeed(true);
    await waitFor(() => {
      expect(screen.getByTestId("system-progress-feed")).toHaveTextContent(
        "heartbeat: still working on T3",
      );
    });
    expect(screen.getByTestId("system-progress-feed")).not.toHaveTextContent(
      "please ignore",
    );
  });
});
