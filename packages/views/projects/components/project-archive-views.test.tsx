// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { ProjectArchiveViews } from "./project-archive-views";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined, isPending: false, isError: false }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("./archive", () => ({
  ArchiveTab: () => <div data-testid="archive-pane" />,
}));

vi.mock("./graph", () => ({
  GraphDataProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ProductFeaturesTab: () => <div data-testid="features-pane" />,
  BusMatrixTab: () => <div data-testid="data-model-pane" />,
}));

vi.mock("./filing", () => ({
  FilingReadinessTab: () => <div data-testid="filing-pane" />,
}));

vi.mock("./requirements/requirements-management-tab", () => ({
  RequirementsManagementTab: () => <div data-testid="requirements-pane" />,
}));

vi.mock("./requirements/requirement-detail-view", () => ({
  RequirementDetailView: () => <div data-testid="requirement-detail-pane" />,
}));

vi.mock("./acceptance/acceptance-tab", () => ({
  AcceptanceTab: () => <div data-testid="acceptance-pane" />,
}));

vi.mock("./deliverables/project-deliverables-tab", () => ({
  ProjectDeliverablesTab: () => <div data-testid="deliverables-pane" />,
}));

vi.mock("./tasks/task-tracking-tab", () => ({
  TaskTrackingToolbar: () => <div data-testid="tasks-toolbar" />,
}));

vi.mock("../../issues/components/project-task-tracking-context", () => ({
  ProjectTaskTrackingProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function renderViews(search = "", template?: string) {
  mocks.replace.mockReset();
  mocks.searchParams = new URLSearchParams(search);
  const adapter: NavigationAdapter = {
    push: vi.fn(),
    replace: mocks.replace,
    back: vi.fn(),
    pathname: "/test/projects/proj-1",
    searchParams: mocks.searchParams,
    hash: "",
    getShareableUrl: (path: string) => path,
  };
  return renderWithI18n(
    <NavigationProvider value={adapter}>
      <ProjectArchiveViews projectId="proj-1" template={template}>
        <div data-testid="issue-surface" />
      </ProjectArchiveViews>
    </NavigationProvider>,
  );
}

describe("ProjectArchiveViews C1 tabs", () => {
  it("renders the eight tabs in prototype order and defaults to archive", () => {
    renderViews();
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual([
      "Archive",
      "Product features",
      "Data model",
      "Requirements",
      "Task tracking",
      "Acceptance",
      "Deliverables",
      "Filing",
    ]);
    expect(screen.getByTestId("archive-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("issue-surface")).toBeNull();
  });

  it("maps legacy ?view=overview onto task tracking", () => {
    renderViews("view=overview");
    expect(screen.getByTestId("issue-surface")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-toolbar")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Task tracking" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("switches to requirements without pushing history", async () => {
    const user = userEvent.setup();
    renderViews();
    await user.click(screen.getByRole("tab", { name: "Requirements" }));
    expect(screen.getByTestId("requirements-pane")).toBeInTheDocument();
    expect(mocks.replace).toHaveBeenCalled();
    expect(mocks.replace.mock.calls[0]?.[0]).toContain("view=requirements");
  });

  it("shows only general-template tabs", () => {
    renderViews("", "general");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Archive",
      "Requirements",
      "Task tracking",
      "Deliverables",
    ]);
  });

  it("shows the R&D tab set without the data model", () => {
    renderViews("", "rd");
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toContain("Product features");
    expect(tabs).toContain("Filing");
    expect(tabs).not.toContain("Data model");
  });

  it("shows the data-template tabs without product features or filing", () => {
    renderViews("", "data");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Archive",
      "Data model",
      "Requirements",
      "Task tracking",
      "Acceptance",
      "Deliverables",
    ]);
  });

  it("falls back when a hidden tab is in the URL", () => {
    renderViews("view=filing", "general");
    expect(screen.getByTestId("archive-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("filing-pane")).toBeNull();
  });
});
