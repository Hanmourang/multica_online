import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import type { GroupPendingAgentTask } from "@multica/core/types";
import { GroupPendingPills, visibleGroupPendingTasks } from "./group-pending-pills";
import { renderWithI18n } from "../../test/i18n";

const task = (
  agent_id: string,
  task_id: string,
  status: string,
): GroupPendingAgentTask => ({
  agent_id,
  task_id,
  status,
  created_at: new Date(0).toISOString(),
});

describe("GroupPendingPills", () => {
  it("renders nothing when there are no in-flight tasks", () => {
    const { container } = renderWithI18n(<GroupPendingPills tasks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one labelled row per agent, resolving names from the roster map", () => {
    const names = new Map([["agent-a", "Ann"]]);
    renderWithI18n(
      <GroupPendingPills
        tasks={[task("agent-a", "t1", "running"), task("agent-b", "t2", "queued")]}
        agentNames={names}
      />,
    );
    // Named agent shows its display name; an unresolved id degrades to the
    // generic "Agent" fallback rather than leaking a raw id.
    expect(screen.getByText("Ann")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.queryByText("agent-b")).not.toBeInTheDocument();
    // running → "Working", queued → "Queued" (en stage copy).
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("maps an unknown status to the queued stage instead of crashing", () => {
    renderWithI18n(<GroupPendingPills tasks={[task("agent-a", "t1", "some_future_state")]} />);
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("hides a task once an assistant reply already carries its id", () => {
    const tasks = [task("agent-a", "t1", "running"), task("agent-b", "t2", "running")];
    expect(
      visibleGroupPendingTasks(tasks, [
        { role: "user", task_id: null },
        { role: "assistant", task_id: "t1" },
      ]),
    ).toEqual([tasks[1]]);
  });

  it("localizes stage copy for a non-English locale", () => {
    renderWithI18n(
      <GroupPendingPills tasks={[task("agent-a", "t1", "running")]} />,
      { locale: "zh-Hans" },
    );
    expect(screen.getByText("处理中")).toBeInTheDocument();
  });
});
