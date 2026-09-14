// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Issue } from "@multica/core/types";
import { paths } from "@multica/core/paths";
import { renderWithI18n } from "../../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../../navigation";
import { RequirementsManagementTab } from "./requirements-management-tab";

const REQ: Issue = {
  id: "req-1",
  workspace_id: "ws-1",
  number: 26,
  identifier: "SIRI-26",
  title: "购物车合并结算",
  description: "",
  status: "in_progress",
  priority: "medium",
  assignee_type: null,
  assignee_id: null,
  creator_type: "member",
  creator_id: "user-1",
  parent_issue_id: null,
  project_id: "proj-1",
  position: 0,
  stage: null,
  start_date: null,
  due_date: null,
  metadata: {},
  properties: {},
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  requirement_status: "执行中",
};

const TASK: Issue = {
  ...REQ,
  id: "task-1",
  number: 101,
  identifier: "TASK-101",
  title: "补齐结算单测",
  parent_issue_id: REQ.id,
  requirement_status: null,
  stage: 3,
};

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (options: { queryKey?: readonly unknown[] }) => {
    switch (options.queryKey?.[0]) {
      case "calendar-issues":
        return { data: [REQ], isPending: false, isError: false };
      case "modules":
        return { data: [], isPending: false, isError: false };
      case "artifacts":
        return { data: { artifacts: [] }, isPending: false, isError: false };
      case "resources":
        return { data: [], isPending: false, isError: false };
      case "children":
        return {
          data: new Map<string, Issue[]>([[REQ.id, [TASK]]]),
          isPending: false,
          isError: false,
        };
      case "issue-archive":
        return {
          data: {
            issue: {
              id: REQ.id,
              title: REQ.title,
              status: "in_progress",
              rollup: {
                tasks_done: 0,
                tasks_total: 1,
                todos_done: 2,
                todos_total: 5,
                runs_active: 1,
                runs_stalled: 0,
              },
            },
            tasks: [
              {
                id: "q-1",
                title: TASK.title,
                status: "running",
                agent_id: "agent-1",
                created_at: "2026-09-01T00:00:00Z",
                runs: [],
                todos_progress: { done: 2, total: 5 },
              },
            ],
            unmatched_runs: [],
            stall_distribution: {},
          },
          isPending: false,
          isError: false,
        };
      default:
        return { data: undefined, isPending: false, isError: false };
    }
  },
}));

vi.mock("@multica/core/issues/queries", () => ({
  calendarIssuesOptions: () => ({ queryKey: ["calendar-issues"] }),
  childrenByParentsOptions: () => ({ queryKey: ["children"] }),
  issueKeys: { all: () => ["issues"] },
}));

vi.mock("@multica/core/artifacts/queries", () => ({
  projectArtifactListOptions: () => ({ queryKey: ["artifacts"] }),
}));

vi.mock("@multica/core/modules", () => ({
  projectModulesOptions: () => ({ queryKey: ["modules"] }),
}));

vi.mock("@multica/core/projects", () => ({
  projectResourcesOptions: () => ({ queryKey: ["resources"] }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/paths")>();
  return {
    ...mod,
    useWorkspacePaths: () => mod.paths.workspace("acme"),
  };
});

vi.mock("../../../issues/utils/status-label", () => ({
  useStatusLabel: () => (status: string) => status,
}));

vi.mock("../../../calendar/requirement-drawer", () => ({
  RequirementDrawer: ({ issueId }: { issueId: string | null }) =>
    issueId ? <div data-testid="requirement-workbench">{issueId}</div> : null,
}));

function renderTab() {
  const adapter: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/projects/proj-1",
    searchParams: new URLSearchParams("view=requirements"),
    hash: "",
    getShareableUrl: (path: string) => path,
  };
  return renderWithI18n(
    <NavigationProvider value={adapter}>
      <RequirementsManagementTab
        projectId="proj-1"
        onOpenRequirement={vi.fn()}
        onOpenAcceptance={vi.fn()}
      />
    </NavigationProvider>,
  );
}

describe("RequirementsManagementTab id links", () => {
  it("renders requirement and task identifiers as real hrefs", async () => {
    const user = userEvent.setup();
    renderTab();

    const reqLink = screen.getByTestId("requirement-id-link");
    expect(reqLink).toHaveAttribute(
      "href",
      paths.workspace("acme").projectRequirement("proj-1", REQ.id),
    );
    expect(reqLink).toHaveTextContent("SIRI-26");

    await user.click(screen.getByTestId("requirement-expand"));
    const taskLink = screen.getByTestId("task-id-link");
    expect(taskLink).toHaveAttribute(
      "href",
      paths.workspace("acme").issueDetail(TASK.id),
    );
    expect(taskLink).toHaveTextContent("TASK-101");
    expect(screen.getByText("补齐结算单测")).toBeInTheDocument();
    expect(screen.getByText("in_progress")).toBeInTheDocument();
    const taskList = screen.getByTestId("requirement-task-list");
    expect(taskList).toHaveTextContent("S3");
    expect(screen.getByTestId("task-progress")).toHaveTextContent("2/5");
  });

  it("opens the workbench on the project page instead of jumping to the calendar", async () => {
    const user = userEvent.setup();
    renderTab();
    expect(screen.queryByTestId("requirement-workbench")).toBeNull();
    await user.click(screen.getByTestId("open-requirement-workbench"));
    expect(screen.getByTestId("requirement-workbench")).toHaveTextContent(REQ.id);
  });
});
