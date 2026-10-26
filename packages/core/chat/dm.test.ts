import { describe, expect, it } from "vitest";

import type { ChatParticipant } from "../types";
import { chatParticipantsOptions, selectDMPeer } from "./dm";

const member = (id: string, display_name = id): ChatParticipant => ({
  chat_session_id: "dm-1",
  participant_type: "member",
  participant_id: id,
  display_name,
  admin: false,
  joined_at: new Date(0).toISOString(),
  last_read_at: "",
});

describe("selectDMPeer", () => {
  it("returns the member that is not the current viewer", () => {
    const roster = [member("user-1", "Me"), member("user-2", "Bob")];
    expect(selectDMPeer(roster, "user-1")?.participant_id).toBe("user-2");
    expect(selectDMPeer(roster, "user-2")?.participant_id).toBe("user-1");
  });

  it("ignores agent participants so a mixed roster still resolves the peer", () => {
    const roster = [
      member("user-1"),
      { ...member("agent-9"), participant_type: "agent" as const },
      member("user-2", "Bob"),
    ];
    expect(selectDMPeer(roster, "user-1")?.participant_id).toBe("user-2");
  });

  it("returns undefined before the roster hydrates (undefined participants)", () => {
    expect(selectDMPeer(undefined, "user-1")).toBeUndefined();
  });

  it("returns undefined when every member is the viewer (no peer yet)", () => {
    expect(selectDMPeer([member("user-1")], "user-1")).toBeUndefined();
  });
});

describe("chatParticipantsOptions", () => {
  it("keys the roster under the session-scoped participants query key", () => {
    const opts = chatParticipantsOptions("dm-1");
    expect(opts.queryKey.slice(-2)).toEqual(["participants", "dm-1"]);
  });

  it("stays disabled for an empty session id even when enabled is requested", () => {
    expect(chatParticipantsOptions("", true).enabled).toBe(false);
  });

  it("respects the caller's enabled gate for a real session", () => {
    expect(chatParticipantsOptions("dm-1", false).enabled).toBe(false);
    expect(chatParticipantsOptions("dm-1", true).enabled).toBe(true);
  });
});
