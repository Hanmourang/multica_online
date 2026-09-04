// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMessagePayload } from "@multica/core/types/events";

vi.mock("@multica/core/api", () => ({
  api: { listTaskMessages: vi.fn() },
}));

// Same tooltip stub the other view tests use — content renders inline so the
// hint can be asserted without simulating hover delays.
vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));

import { api } from "@multica/core/api";
import { renderWithI18n } from "../../test/i18n";
import { DeliverablesSection } from "./deliverables-section";

const mockList = vi.mocked(api.listTaskMessages);

afterEach(cleanup);
beforeEach(() => mockList.mockReset());

// taskMessagesOptions only enables for real UUID task ids.
const T1 = "11111111-1111-4111-8111-111111111111";
const T0 = "2026-08-15T10:00:00.000Z";
let seq = 0;
function writeMsg(path: string, content: string): TaskMessagePayload[] {
  return [
    { task_id: T1, issue_id: "i1", seq: ++seq, type: "tool_use", tool: "Write", input: { file_path: path, content }, created_at: T0 },
    { task_id: T1, issue_id: "i1", seq: ++seq, type: "tool_result", tool: "Write", output: "ok", created_at: T0 },
  ];
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderSection(ui: ReactElement, qc = newClient()) {
  return renderWithI18n(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("DeliverablesSection", () => {
  it("renders the card wall with summary after loading", async () => {
    mockList.mockResolvedValue(writeMsg("docs/a.md", "# A"));
    renderSection(<DeliverablesSection taskId={T1} replyText={null} />);
    await waitFor(() => expect(screen.getByText("a.md")).toBeInTheDocument());
    expect(screen.getByTestId("deliverables-section")).toBeInTheDocument();
    expect(screen.getByText("docs/a.md")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
  });

  it("shares the taskMessages cache — a second wall for the same task issues no new request", async () => {
    mockList.mockResolvedValue(writeMsg("docs/a.md", "# A"));
    const qc = newClient();
    renderSection(
      <>
        <DeliverablesSection taskId={T1} replyText={null} />
        <DeliverablesSection taskId={T1} replyText={null} />
      </>,
      qc,
    );
    await waitFor(() => expect(screen.getAllByText("a.md")).toHaveLength(2));
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledWith(T1);
  });

  it("renders nothing when the run produced no deliverables", async () => {
    mockList.mockResolvedValue([]);
    const { container } = renderSection(<DeliverablesSection taskId={T1} replyText={null} />);
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(T1));
    await waitFor(() => {
      expect(container.querySelector("[data-testid=deliverables-section]")).toBeNull();
    });
  });

  it("shows a click-to-preview hint on each card", async () => {
    mockList.mockResolvedValue(writeMsg("docs/a.md", "# A"));
    renderSection(<DeliverablesSection taskId={T1} replyText="归档 `logs/c.md`" />);
    await waitFor(() => expect(screen.getByText("c.md")).toBeInTheDocument());
    const hints = screen.getAllByRole("tooltip");
    expect(hints).toHaveLength(2);
    for (const hint of hints) expect(hint).toHaveTextContent("Click to preview");
  });

  it("shows an error state with retry when loading fails", async () => {
    mockList.mockRejectedValue(new Error("boom"));
    renderSection(<DeliverablesSection taskId={T1} replyText={null} />);
    await waitFor(() => expect(screen.getByTestId("deliverables-error")).toBeInTheDocument());
    mockList.mockResolvedValue(writeMsg("docs/a.md", "# A"));
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.getByTestId("deliverables-section")).toBeInTheDocument());
  });

  it("merges reply-declared paths and previews across cards", async () => {
    mockList.mockResolvedValue(writeMsg("docs/a.md", "# A"));
    renderSection(<DeliverablesSection taskId={T1} replyText="归档 `logs/c.md`" />);
    await waitFor(() => expect(screen.getByText("c.md")).toBeInTheDocument());
    expect(screen.getByText("Referenced")).toBeInTheDocument();

    fireEvent.click(screen.getByText("c.md"));
    expect(await screen.findByTestId("deliverable-reference-note")).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("deliverable-prev"));
    expect(screen.getByText("1/2")).toBeInTheDocument();
    // The full-text card previews its markdown content.
    expect(screen.getByText("A")).toBeInTheDocument();
  });
});
