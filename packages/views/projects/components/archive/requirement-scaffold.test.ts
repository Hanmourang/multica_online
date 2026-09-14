import { describe, expect, it } from "vitest";
import { nextRequirementKey, resolveInboxRoots } from "./requirement-scaffold";

describe("nextRequirementKey", () => {
  it("increments today's sequence and ignores other days", () => {
    const now = new Date("2026-09-13T12:00:00");
    expect(nextRequirementKey([], now)).toBe("REQ-20260913-01");
    expect(
      nextRequirementKey(["REQ-20260913-02", "REQ-20260912-09", "not-a-key"], now),
    ).toBe("REQ-20260913-03");
  });
});

describe("resolveInboxRoots", () => {
  it("walks up from a project bind to _shared/inbox", () => {
    expect(
      resolveInboxRoots("/Users/me/workspace/projects_mgmt/projects/multica"),
    ).toContain("/Users/me/workspace/projects_mgmt/_shared/inbox");
  });
});
