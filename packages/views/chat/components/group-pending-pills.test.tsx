import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import type { ChatMessageDispatch, GroupPendingAgentTask } from "@multica/core/types";
import {
  GroupDispatchPills,
  GroupPendingPills,
  visibleGroupPendingTasks,
} from "./group-pending-pills";
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

  // A terminated run is a settled outcome, not a queued one. It used to render
  // as "Queued" because `cancelled` was absent from the stage map and every
  // unmapped status fell through to the queued label.
  describe("terminated runs", () => {
    it("labels a cancelled task as terminated, not queued", () => {
      renderWithI18n(
        <GroupPendingPills
          tasks={[task("agent-a", "t1", "cancelled")]}
          agentNames={new Map([["agent-a", "Ann"]])}
          variant="dock"
        />,
      );
      expect(screen.getByText(/Terminated/)).toBeInTheDocument();
      expect(screen.queryByText(/Queued/)).not.toBeInTheDocument();
    });

    it("uses 已终止 in Chinese", () => {
      renderWithI18n(
        <GroupPendingPills tasks={[task("agent-a", "t1", "cancelled")]} variant="dock" />,
        { locale: "zh-Hans" },
      );
      expect(screen.getByText(/已终止/)).toBeInTheDocument();
      expect(screen.queryByText(/排队中/)).not.toBeInTheDocument();
    });

    it("offers no stop control once the run is settled", () => {
      renderWithI18n(
        <GroupPendingPills
          tasks={[task("agent-a", "t1", "cancelled")]}
          onStop={vi.fn()}
          variant="dock"
        />,
      );
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("does not spin a settled outcome in the list variant", () => {
      const { container } = renderWithI18n(
        <GroupPendingPills tasks={[task("agent-a", "t1", "cancelled")]} />,
      );
      expect(container.querySelector(".animate-spin")).toBeNull();
    });
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

  describe("per-agent stop", () => {
    it("renders no stop control when the surface cannot cancel", () => {
      renderWithI18n(
        <GroupPendingPills tasks={[task("agent-a", "t1", "running")]} variant="dock" />,
      );
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("cancels exactly the clicked agent's task", () => {
      const onStop = vi.fn();
      renderWithI18n(
        <GroupPendingPills
          tasks={[task("agent-a", "t1", "running"), task("agent-b", "t2", "running")]}
          agentNames={new Map([["agent-a", "Ann"], ["agent-b", "Bob"]])}
          onStop={onStop}
          variant="dock"
        />,
      );

      // One affordance per in-flight agent: a runaway run must be stoppable
      // without killing the peers still producing useful work.
      const buttons = screen.getAllByRole("button");
      expect(buttons).toHaveLength(2);
      // The control states the verb instead of being a bare ×, which read as
      // "dismiss this pill" rather than "stop this run".
      expect(buttons[0]).toHaveTextContent("Stop");
      fireEvent.click(screen.getByRole("button", { name: "Stop Bob" }));

      expect(onStop).toHaveBeenCalledTimes(1);
      expect(onStop).toHaveBeenCalledWith("t2");
    });
  });
});

// The persisted per-agent outcome is what a reader sees after the live pill is
// gone — including after a terminate, whose row keeps status=cancelled forever.
describe("GroupDispatchPills", () => {
  const dispatch = (status: string): ChatMessageDispatch => ({
    agent_id: "agent-a",
    task_id: "t1",
    status,
  });

  it("renders a terminated dispatch as 已终止 instead of 排队中", () => {
    renderWithI18n(<GroupDispatchPills dispatches={[dispatch("cancelled")]} />, {
      locale: "zh-Hans",
    });
    expect(screen.getByText(/已终止/)).toBeInTheDocument();
    expect(screen.queryByText(/排队中/)).not.toBeInTheDocument();
  });

  it("renders a cancelled dispatch as Terminated in English", () => {
    renderWithI18n(<GroupDispatchPills dispatches={[dispatch("cancelled")]} />);
    expect(screen.getByText(/Terminated/)).toBeInTheDocument();
    expect(screen.queryByText(/Queued/)).not.toBeInTheDocument();
  });

  it("keeps the queued label for a dispatch that really is queued", () => {
    renderWithI18n(<GroupDispatchPills dispatches={[dispatch("queued")]} />);
    expect(screen.getByText(/Queued/)).toBeInTheDocument();
  });
});
