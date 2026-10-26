import { describe, expect, it } from "vitest";

import { extractMentionsFromContent } from "./mention-extract";

const AGENT_A = "11111111-1111-1111-1111-111111111111";
const AGENT_B = "22222222-2222-2222-2222-222222222222";
const MEMBER_A = "33333333-3333-3333-3333-333333333333";

describe("extractMentionsFromContent", () => {
  it("derives structured mentions from the serialized markdown links", () => {
    const content = `hi [@Ann](mention://agent/${AGENT_A}) and [@Bob](mention://member/${MEMBER_A})`;
    expect(extractMentionsFromContent(content)).toEqual([
      { type: "agent", id: AGENT_A },
      { type: "member", id: MEMBER_A },
    ]);
  });

  it("dedupes a repeated target, keeping first-occurrence order", () => {
    const content = `[@A](mention://agent/${AGENT_A}) … [@A again](mention://agent/${AGENT_A}) … [@B](mention://agent/${AGENT_B})`;
    expect(extractMentionsFromContent(content)).toEqual([
      { type: "agent", id: AGENT_A },
      { type: "agent", id: AGENT_B },
    ]);
  });

  it("ignores non-member/agent mention targets (issue/project input chrome)", () => {
    const content = `see [issue](mention://issue/${AGENT_A}) and [proj](mention://project/${AGENT_B})`;
    expect(extractMentionsFromContent(content)).toEqual([]);
  });

  it("skips a malformed id that is not a uuid", () => {
    expect(extractMentionsFromContent("mention://agent/not-a-uuid")).toEqual([]);
  });

  it("short-circuits to empty when there is no mention marker at all", () => {
    expect(extractMentionsFromContent("plain message, no links")).toEqual([]);
  });
});
