/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { RequirementConfigEditor } from "./requirement-config-editor";

const mockUpdate = vi.fn();

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/issues/mutations", () => ({
  useUpdateIssue: () => ({ mutateAsync: mockUpdate }),
}));

vi.mock("@multica/core/projects", () => ({
  projectResourcesOptions: () => ({
    queryKey: ["project-resources", "ws-1", "proj-1"],
    queryFn: async () => [],
  }),
  // The repo field is the shared RepoResourcePicker, which binds a pasted
  // GitHub URL by creating a project resource.
  useCreateProjectResource: () => ({ mutateAsync: vi.fn() }),
}));

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "req-1",
    workspace_id: "ws-1",
    number: 9,
    identifier: "TASK-9",
    title: "本体能力评估",
    description: "",
    status: "todo",
    priority: "medium",
    project_id: "proj-1",
    parent_issue_id: null,
    goal: "出具评估结论",
    decompose_mode: "confirm",
    auto_trigger: true,
    start_at: "2026-09-10T09:30:00Z",
    due_date: "2026-09-17",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  } as Issue;
}

function renderEditor(target: Issue = issue()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <RequirementConfigEditor issue={target} showTitle />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUpdate.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RequirementConfigEditor", () => {
  it("saves goal and decompose mode", async () => {
    renderEditor();
    const goal = screen.getByTestId("requirement-config-goal") as HTMLTextAreaElement;
    fireEvent.change(goal, { target: { value: "新目标" } });
    fireEvent.blur(goal);
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "req-1", goal: "新目标" }),
      );
    });

    fireEvent.click(screen.getByTestId("requirement-config-mode-auto"));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "req-1", decompose_mode: "auto" }),
      );
    });
  });

  it("saves start_at and due_date as soon as the picker value changes", async () => {
    renderEditor();

    fireEvent.change(screen.getByTestId("requirement-config-start-at"), {
      target: { value: "2026-09-12T10:30" },
    });
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "req-1",
          start_at: new Date("2026-09-12T10:30").toISOString(),
        }),
      );
    });

    fireEvent.change(screen.getByTestId("requirement-config-due-date"), {
      target: { value: "2026-09-20" },
    });
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "req-1", due_date: "2026-09-20" }),
      );
    });
  });

  it("locks start_at after the requirement is triggered", () => {
    renderEditor(issue({ triggered_at: "2026-09-07T00:00:00Z" }));
    expect(
      (screen.getByTestId("requirement-config-start-at") as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
