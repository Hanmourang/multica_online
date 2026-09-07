import { describe, expect, it } from "vitest";
import type { RoleAssignment } from "@multica/core/types";
import {
  hasEnabledRole,
  persistableRosterEntries,
  rosterHasRequiredAssignees,
} from "./role-roster";

function row(
  role: RoleAssignment["role"],
  assigneeId: string,
  enabled = true,
): RoleAssignment {
  return {
    id: `${role}-${assigneeId}`,
    role,
    assignee_type: "agent",
    assignee_id: assigneeId,
    enabled,
    ordinal: 0,
  };
}

const PM = "aaaaaaaa-1111-2222-3333-444444444444";
const DEV = "bbbbbbbb-1111-2222-3333-444444444444";

describe("role roster helpers", () => {
  it("treats a locked-on PM toggle without an assignee as not ready", () => {
    expect(hasEnabledRole([], "pm")).toBe(false);
    expect(
      rosterHasRequiredAssignees([row("pm", "not-a-uuid"), row("developer", DEV)]),
    ).toBe(false);
  });

  it("accepts enabled PM + developer with real assignees", () => {
    expect(rosterHasRequiredAssignees([row("pm", PM), row("developer", DEV)])).toBe(
      true,
    );
  });

  it("drops rows the roles API would 400", () => {
    expect(
      persistableRosterEntries([
        row("pm", PM),
        row("prototyper", ""),
      ]).map((entry) => entry.role),
    ).toEqual(["pm"]);
  });
});
