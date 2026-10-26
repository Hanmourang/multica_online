import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import type { ChatMessage, Issue } from "@multica/core/types";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import { ChatMessageResources } from "./chat-message-resources";

vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/issues/${id}`,
    projectView: (id: string, view: string) => `/projects/${id}?view=${view}`,
    assets: () => "/assets",
  }),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () => ({ entryOf: () => undefined }),
}));
vi.mock("@multica/core/api", () => ({
  api: {
    getIssue: vi.fn(),
    getChildIssueProgress: vi.fn(),
    listChildIssues: vi.fn(),
    listMembers: vi.fn(),
    listAgents: vi.fn(),
    listProjects: vi.fn(),
    listSquads: vi.fn(),
  },
}));
vi.mock("../../projects/components/assets/components/asset-preview-dialog", () => ({
  AssetPreviewDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="asset-preview" /> : null,
}));

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-1",
    chat_session_id: "session-1",
    role: "user",
    content: "",
    task_id: null,
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

function renderResources(value: ChatMessage) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues } }}>
      <QueryClientProvider client={queryClient}>
        <ChatMessageResources message={value} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function issueSnapshot(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "REQ-7",
    title: "Share product context",
    status: "in_progress",
    priority: "high",
    assignee_type: null,
    assignee_id: null,
    project_id: null,
    updated_at: "2026-10-20T10:00:00Z",
    ...overrides,
  } as Issue;
}

const getIssueMock = vi.mocked(api.getIssue);
const getChildIssueProgressMock = vi.mocked(api.getChildIssueProgress);
const listChildIssuesMock = vi.mocked(api.listChildIssues);
const listMembersMock = vi.mocked(api.listMembers);
const listAgentsMock = vi.mocked(api.listAgents);
const listProjectsMock = vi.mocked(api.listProjects);

describe("ChatMessageResources", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getIssueMock.mockRejectedValue(new Error("offline"));
    getChildIssueProgressMock.mockResolvedValue({ progress: [] });
    listChildIssuesMock.mockResolvedValue({ issues: [] });
    listMembersMock.mockResolvedValue([]);
    listAgentsMock.mockResolvedValue([]);
    listProjectsMock.mockResolvedValue({ projects: [], total: 0 });
  });
  it("renders a requirement card with its identifier, title and status", () => {
    renderResources(message({
      resources: [{
        type: "issue",
        id: "issue-1",
        kind: "requirement",
        access: "granted",
        issue: {
          id: "issue-1",
          identifier: "REQ-7",
          title: "Share product context",
          status: "in_progress",
          priority: "high",
        } as Issue,
      }],
    }));

    expect(screen.getByRole("link", { name: /REQ-7/ })).toHaveAttribute("href", "/issues/issue-1");
    expect(screen.getByText("Share product context")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
  });

  it("prefers the live issue detail over the authorized send snapshot", async () => {
    getIssueMock.mockResolvedValue(issueSnapshot({
      title: "Current requirement title",
      status: "done",
      priority: "urgent",
    }));
    renderResources(message({
      resources: [{
        type: "issue",
        id: "issue-1",
        kind: "requirement",
        access: "granted",
        issue: issueSnapshot(),
      }],
    }));

    expect(await screen.findByText("Current requirement title")).toBeInTheDocument();
    expect(screen.queryByText("Share product context")).not.toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(getIssueMock).toHaveBeenCalledWith("issue-1");
  });

  it("keeps the authorized snapshot after a detail failure and retries on demand", async () => {
    getIssueMock
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(issueSnapshot({ title: "Recovered live title" }));
    renderResources(message({
      resources: [{
        type: "issue",
        id: "issue-1",
        kind: "task",
        access: "granted",
        issue: issueSnapshot(),
      }],
    }));

    expect(screen.getByText("Share product context")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered live title")).toBeInTheDocument();
    expect(getIssueMock).toHaveBeenCalledTimes(2);
  });

  it("renders task assignee, project, child progress and update time", async () => {
    getIssueMock.mockResolvedValue(issueSnapshot({
      identifier: "MUL-42",
      title: "Ship resource sharing",
      assignee_type: "member",
      assignee_id: "user-1",
      project_id: "project-1",
      updated_at: "2026-10-24T12:30:00Z",
    }));
    listMembersMock.mockResolvedValue([{
      id: "member-1",
      workspace_id: "ws-1",
      user_id: "user-1",
      role: "member",
      name: "Alicia",
      email: "alicia@example.com",
      avatar_url: null,
      created_at: "2026-01-01T00:00:00Z",
    }]);
    listProjectsMock.mockResolvedValue({
      projects: [{ id: "project-1", title: "Apollo" } as never],
      total: 1,
    });
    getChildIssueProgressMock.mockResolvedValue({
      progress: [{ parent_issue_id: "issue-1", done: 2, total: 5 }],
    });
    renderResources(message({
      resources: [{
        type: "issue",
        id: "issue-1",
        kind: "task",
        access: "granted",
        issue: issueSnapshot(),
      }],
    }));

    expect(await screen.findByText("Alicia")).toBeInTheDocument();
    expect(screen.getByText("Apollo")).toBeInTheDocument();
    expect(screen.getByText("2/5")).toBeInTheDocument();
    expect(screen.getByText(new Date("2026-10-24T12:30:00Z").toLocaleString())).toBeInTheDocument();
  });

  it("renders requirement goal, status, stage and task completion progress", async () => {
    getIssueMock.mockResolvedValue(issueSnapshot({
      goal: "Increase activation",
      requirement_status: "Validating",
      stage_progress: "2/4",
    }));
    getChildIssueProgressMock.mockResolvedValue({
      progress: [{ parent_issue_id: "issue-1", done: 3, total: 6 }],
    });
    renderResources(message({
      resources: [{
        type: "issue",
        id: "issue-1",
        kind: "requirement",
        access: "granted",
        issue: issueSnapshot(),
      }],
    }));

    expect(await screen.findByText("Increase activation")).toBeInTheDocument();
    expect(screen.getByText("Validating")).toBeInTheDocument();
    expect(screen.getByText("2/4")).toBeInTheDocument();
    expect(screen.getByText("3/6")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("renders creator, labels and the first child issues", async () => {
    getIssueMock.mockResolvedValue(issueSnapshot({
      identifier: "MUL-42",
      title: "Ship resource sharing",
      creator_type: "member",
      creator_id: "user-2",
      description: "Keep the shared card useful after the message is sent.",
      labels: [{
        id: "label-1",
        workspace_id: "ws-1",
        name: "Chat",
        color: "#2563eb",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }],
    }));
    listMembersMock.mockResolvedValue([{
      id: "member-2",
      workspace_id: "ws-1",
      user_id: "user-2",
      role: "member",
      name: "Noah",
      email: "noah@example.com",
      avatar_url: null,
      created_at: "2026-01-01T00:00:00Z",
    }]);
    listChildIssuesMock.mockResolvedValue({
      issues: [
        issueSnapshot({ id: "child-1", identifier: "MUL-43", title: "Render the picker", status: "todo" }),
        issueSnapshot({ id: "child-2", identifier: "MUL-44", title: "Fill the card", status: "in_progress" }),
        issueSnapshot({ id: "child-3", identifier: "MUL-45", title: "Third", status: "todo" }),
        issueSnapshot({ id: "child-4", identifier: "MUL-46", title: "Fourth", status: "todo" }),
        issueSnapshot({ id: "child-5", identifier: "MUL-47", title: "Fifth", status: "todo" }),
      ],
    });
    renderResources(message({
      resources: [{
        type: "issue",
        id: "issue-1",
        kind: "task",
        access: "granted",
        issue: issueSnapshot(),
      }],
    }));

    expect(await screen.findByText("Noah")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Keep the shared card useful after the message is sent.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /MUL-43/ })).toHaveAttribute("href", "/issues/child-1");
    expect(screen.getByText("1 more")).toBeInTheDocument();
    expect(screen.queryByText("Fifth")).not.toBeInTheDocument();
  });

  it("opens the existing document preview from a granted document card", () => {
    renderResources(message({
      resources: [{
        type: "document",
        id: "artifact-1",
        source: "artifact",
        project_id: "project-1",
        access: "granted",
        artifact: { id: "artifact-1", project_id: "project-1", rel_path: "docs/prd.md" } as never,
      }],
    }));

    fireEvent.click(screen.getByRole("button", { name: "Preview document" }));
    expect(screen.getByTestId("asset-preview")).toBeInTheDocument();
    expect(screen.getByText("docs/prd.md")).toBeInTheDocument();
  });

  it("shows document metadata and opens the project asset library", async () => {
    listProjectsMock.mockResolvedValue({
      projects: [{ id: "project-1", title: "Apollo" } as never],
      total: 1,
    });
    renderResources(message({
      resources: [{
        type: "document",
        id: "artifact-1",
        source: "artifact",
        project_id: "project-1",
        access: "granted",
        artifact: {
          id: "artifact-1",
          project_id: "project-1",
          rel_path: "docs/prd.md",
          size_bytes: 2048,
          updated_at: "2026-10-24T12:30:00Z",
        } as never,
      }],
    }));

    expect(screen.getByText("docs/prd.md")).toBeInTheDocument();
    expect(screen.getByText("MD")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(await screen.findByText("Apollo")).toBeInTheDocument();
    expect(screen.getByText(new Date("2026-10-24T12:30:00Z").toLocaleString())).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open details" })).toHaveAttribute(
      "href",
      "/projects/project-1?view=assets",
    );
  });

  it("previews a project asset file from the picker title before the archive snapshot arrives", () => {
    renderResources(message({
      resources: [{
        type: "document",
        id: "artifact-1",
        source: "artifact",
        project_id: "project-1",
        access: "granted",
        title: "index.html",
      }],
    }));

    expect(screen.getByText("index.html")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview document" }));
    expect(screen.getByTestId("asset-preview")).toBeInTheDocument();
  });

  it("does not expose withheld titles, paths or ids for denied resources", () => {
    renderResources(message({
      resources: [{
        type: "issue",
        id: "secret-issue-id",
        kind: "task",
        access: "denied",
        issue: { title: "Secret title" } as Issue,
      }],
    }));

    expect(screen.getByText("You don't have access to this task.")).toBeInTheDocument();
    expect(screen.queryByText("Secret title")).not.toBeInTheDocument();
    expect(screen.queryByText(/secret-issue-id/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("distinguishes a missing document without exposing its stale snapshot", () => {
    renderResources(message({
      resources: [{
        type: "document",
        id: "deleted-artifact-id",
        source: "artifact",
        access: "missing",
        artifact: { rel_path: "docs/secret.md" } as never,
      }],
    }));

    expect(screen.getByText("This document is no longer available.")).toBeInTheDocument();
    expect(screen.queryByText("docs/secret.md")).not.toBeInTheDocument();
    expect(screen.queryByText(/deleted-artifact-id/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows a loading marker when realtime only carried has_resources", () => {
    renderResources(message({ has_resources: true }));
    expect(screen.getByText("Loading shared resource…")).toBeInTheDocument();
  });
});
