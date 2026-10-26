// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { Sprint } from "@multica/core/types";
import { renderWithI18n } from "../../../test/i18n";
import { SprintPicker } from "./sprint-picker";

// Issue-side sprint attach (CoCo 对标 02 §F). The data layer is mocked: what
// this suite pins is the picker's contract with the issue detail sidebar —
// project scoping, the backlog empty value, and the frozen completed scope.

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

const fetched: { ws: string; project: string }[] = [];

vi.mock("@multica/core/sprints", () => ({
  projectSprintsOptions: (ws: string, projectId: string) => {
    fetched.push({ ws, project: projectId });
    return { queryKey: ["sprints", "list", projectId] };
  },
}));

const base: Omit<Sprint, "id" | "name" | "status"> = {
  workspace_id: "ws-1",
  project_id: "p-1",
  goal: null,
  start_date: null,
  end_date: null,
  capacity: null,
  created_by_type: "member",
  created_by_id: "u-1",
  started_at: null,
  completed_at: null,
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
  issue_count: 0,
  done_count: 0,
};

const PLANNED: Sprint = { ...base, id: "sp-1", name: "Sprint 01", status: "planned" };
const ACTIVE: Sprint = { ...base, id: "sp-2", name: "Sprint 02", status: "active" };
const COMPLETED: Sprint = {
  ...base,
  id: "sp-3",
  name: "Sprint 00",
  status: "completed",
};

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({
    data: { sprints: [PLANNED, ACTIVE, COMPLETED], total: 3 },
    isPending: false,
    isError: false,
  }),
}));

/** The list rows carry `data-picker-item`; the trigger doesn't. */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("button[data-picker-item]"));
}

function rowFor(label: string): HTMLElement {
  const row = rows().find((el) => el.textContent?.includes(label));
  if (!row) throw new Error(`no sprint row for "${label}"`);
  return row;
}

afterEach(() => {
  cleanup();
  fetched.length = 0;
});

describe("SprintPicker", () => {
  it("scopes the list to the issue's project and renders every status", () => {
    renderWithI18n(
      <SprintPicker projectId="p-1" value={null} onChange={() => {}} defaultOpen />,
    );

    expect(fetched[0]).toEqual({ ws: "ws-1", project: "p-1" });
    expect(rowFor("Sprint 01")).toBeDefined();
    expect(rowFor("Sprint 02").textContent).toContain("Active");
    expect(rowFor("No sprint (backlog)")).toBeDefined();
  });

  it("writes the picked sprint", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithI18n(<SprintPicker projectId="p-1" value="sp-1" onChange={onChange} defaultOpen />);

    // The issue's current sprint reads as selected, so the checkmark and the
    // trigger agree on one value.
    expect(rowFor("Sprint 01").querySelector("svg")?.getAttribute("class")).not.toContain(
      "invisible",
    );

    await user.click(rowFor("Sprint 02"));
    expect(onChange).toHaveBeenCalledWith("sp-2");
  });

  it("writes null for the backlog empty value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithI18n(<SprintPicker projectId="p-1" value="sp-1" onChange={onChange} defaultOpen />);

    // Picking a row closes the popover, so the clear path gets its own render:
    // the empty row must stay reachable while a sprint is selected.
    await user.click(rowFor("No sprint (backlog)"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps a completed sprint visible but unselectable", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithI18n(
      <SprintPicker projectId="p-1" value={PLANNED.id} onChange={onChange} defaultOpen />,
    );

    const row = rowFor("Sprint 00");
    expect(row).toBeDisabled();
    await user.click(row);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("falls back to the field label when the issue has no sprint", () => {
    const { container } = renderWithI18n(
      <SprintPicker projectId="p-1" value={null} onChange={() => {}} />,
    );

    expect(container.textContent).toContain("Sprint");
    expect(container.textContent).not.toContain("Sprint 01");
  });

  it("shows the selected sprint name on the trigger", () => {
    const { container } = renderWithI18n(
      <SprintPicker projectId="p-1" value="sp-2" onChange={() => {}} />,
    );

    expect(container.textContent).toContain("Sprint 02");
  });
});
