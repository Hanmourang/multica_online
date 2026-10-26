import { describe, expect, it } from "vitest";

import type { ChatParticipant } from "../types";
import { selectGroupAgents, selectGroupStillMember } from "./group";

const participant = (
  id: string,
  type: "member" | "agent",
  display_name = id,
  admin = false,
): ChatParticipant => ({
  chat_session_id: "group-1",
  participant_type: type,
  participant_id: id,
  display_name,
  admin,
  joined_at: new Date(0).toISOString(),
  last_read_at: "",
});

describe("selectGroupAgents", () => {
  it("returns only the agent participants of a mixed roster", () => {
    const roster = [
      participant("user-1", "member"),
      participant("agent-a", "agent"),
      participant("user-2", "member"),
      participant("agent-b", "agent"),
    ];
    expect(selectGroupAgents(roster).map((p) => p.participant_id)).toEqual([
      "agent-a",
      "agent-b",
    ]);
  });

  it("returns an empty list before the roster hydrates", () => {
    expect(selectGroupAgents(undefined)).toEqual([]);
  });

  it("returns an empty list for an all-human roster", () => {
    expect(selectGroupAgents([participant("user-1", "member")])).toEqual([]);
  });
});

describe("selectGroupStillMember", () => {
  it("keeps the viewer when the roster lists them as a member", () => {
    const roster = [participant("user-1", "member"), participant("agent-a", "agent")];
    expect(selectGroupStillMember(roster, "user-1")).toBe(true);
  });

  it("drops the viewer once a remove demotes them to a non-member", () => {
    const roster = [participant("user-2", "member"), participant("agent-a", "agent")];
    expect(selectGroupStillMember(roster, "user-1")).toBe(false);
  });

  it("only counts member participants, not an agent id that matches the user id", () => {
    const roster = [participant("user-1", "agent")];
    expect(selectGroupStillMember(roster, "user-1")).toBe(false);
  });

  it("stays optimistic (true) before the roster or viewer identity hydrates", () => {
    expect(selectGroupStillMember(undefined, "user-1")).toBe(true);
    expect(selectGroupStillMember([participant("user-1", "member")], undefined)).toBe(true);
  });
});
