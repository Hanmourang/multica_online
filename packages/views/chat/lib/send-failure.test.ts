import { describe, expect, it } from "vitest";

import { ApiError } from "@multica/core/api";

import { chatSendFailureKind } from "./send-failure";

function apiError(message: string, status = 400, body?: unknown) {
  return new ApiError(message, status, "", body);
}

describe("chatSendFailureKind", () => {
  it("names a revoked invoke permission from the structured reason code", () => {
    const err = apiError("forbidden", 403, { reason_code: "invocation_not_allowed" });
    expect(chatSendFailureKind(err)).toBe("blocked");
  });

  it("names a missing runtime from the structured reason code", () => {
    const err = apiError("precondition", 422, { reason_code: "agent_runtime_required" });
    expect(chatSendFailureKind(err)).toBe("runtime_required");
  });

  // The group handler answers a 400 with no reason_code when the composer still
  // carries a mention for an agent that was never added to the group. This is
  // the case that used to collapse into "Failed to send message".
  it("recognises a mention for an agent outside the group", () => {
    const err = apiError("mention is not a group agent participant", 400, {
      error: "mention is not a group agent participant",
    });
    expect(chatSendFailureKind(err)).toBe("mention_agent_not_in_group");
  });

  it("recognises a mention for a non-participant member", () => {
    const err = apiError("mention is not a participant", 400, {
      error: "mention is not a participant",
    });
    expect(chatSendFailureKind(err)).toBe("mention_not_in_group");
  });

  it("falls back to generic for an unrecognised client error", () => {
    const err = apiError("content, attachments, or resources are required", 400, {
      error: "content, attachments, or resources are required",
    });
    expect(chatSendFailureKind(err)).toBe("generic");
  });

  // MUL-6472: a 5xx body is internal detail; clientErrorMessage drops it, so
  // the predicate must not surface it either.
  it("falls back to generic for a 5xx even when the message looks known", () => {
    const err = apiError("mention is not a group agent participant", 500);
    expect(chatSendFailureKind(err)).toBe("generic");
  });

  it("falls back to generic for a transport failure", () => {
    expect(chatSendFailureKind(new Error("Failed to fetch"))).toBe("generic");
  });
});
