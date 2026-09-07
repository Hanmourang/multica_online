import { cleanup, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@multica/core/types";
import { describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import { RequirementPropertyCard } from "./requirement-property-card";

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/paths")>(
    "@multica/core/paths",
  );
  return {
    ...actual,
    useWorkspacePaths: () => actual.paths.workspace("test"),
  };
});

vi.mock("../../navigation", () => ({
  AppLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    workspace_id: "ws-1",
    number: 1,
    identifier: "TES-1",
    title: "Ordinary task",
    description: "",
    status: "todo",
    priority: "medium",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    project_id: null,
    position: 0,
    stage: null,
    start_date: null,
    due_date: null,
    metadata: {},
    properties: {},
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function renderCard(target: Issue, children: Issue[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <RequirementPropertyCard issue={target} childIssues={children} />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("RequirementPropertyCard", () => {
  it("hides itself on an ordinary issue", () => {
    renderCard(issue());
    expect(screen.queryByTestId("requirement-property-card")).toBeNull();
  });

  it("shows identifier, goal, and jumps to the workbench and project detail", () => {
    renderCard(
      issue({
        id: "req-1",
        identifier: "SIRI-29",
        title: "Refund async",
        project_id: "proj-1",
        start_at: "2026-09-07T01:00:00.000Z",
        goal: "P99 30min → 5min",
      }),
    );

    const card = screen.getByTestId("requirement-property-card");
    expect(card).toHaveTextContent("SIRI-29");
    expect(card).toHaveTextContent("P99 30min → 5min");
    expect(screen.getByRole("link", { name: "Workbench" })).toHaveAttribute(
      "href",
      "/test/calendar?req=req-1&stage=2&from=issue",
    );
    expect(screen.getByRole("link", { name: "Requirement detail" })).toHaveAttribute(
      "href",
      "/test/projects/proj-1?view=requirements&req=req-1",
    );
  });
});
