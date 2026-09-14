import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@multica/core/types";
import { fanOutChatMessage, selectedSendAgentIds } from "./fanout-agents";

describe("selectedSendAgentIds", () => {
  it("keeps the primary first and drops it from extras", () => {
    expect(selectedSendAgentIds("a", ["b", "a", "c"])).toEqual(["a", "b", "c"]);
  });

  it("returns extras only when there is no primary", () => {
    expect(selectedSendAgentIds(undefined, ["b"])).toEqual(["b"]);
  });
});

describe("fanOutChatMessage", () => {
  it("creates a session and sends for each extra agent", async () => {
    const sendChatMessage = vi.fn();
    const createSession = vi.fn(async ({ agent_id }: { agent_id: string }) => ({
      id: `session-${agent_id}`,
    }));
    const result = await fanOutChatMessage({
      extraAgentIds: ["b", "missing"],
      agents: [{ id: "b", name: "Cursor" } as Agent],
      content: "看一下原型",
      projectId: "p1",
      pageSurface: null,
      api: { sendChatMessage, uploadFile: vi.fn() },
      createSession,
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sendChatMessage).toHaveBeenCalledWith("session-b", "看一下原型", undefined);
    expect(result).toEqual({ sent: 1, failed: 0, sessionIds: ["session-b"] });
  });
});
