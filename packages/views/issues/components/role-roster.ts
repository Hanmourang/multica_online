import type { RoleAssignment } from "@multica/core/types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function persistableRosterEntries(
  entries: RoleAssignment[],
): RoleAssignment[] {
  return entries.filter(
    (entry) =>
      (entry.assignee_type === "member" || entry.assignee_type === "agent") &&
      UUID_RE.test(entry.assignee_id),
  );
}

export function hasEnabledRole(
  entries: Array<Pick<RoleAssignment, "role" | "enabled" | "assignee_id">>,
  role: RoleAssignment["role"],
): boolean {
  return entries.some(
    (entry) =>
      entry.role === role && entry.enabled && UUID_RE.test(entry.assignee_id),
  );
}

/** 拆解接口要求班底里有 enabled 的 PM；研发同为创建必选。 */
export function rosterHasRequiredAssignees(entries: RoleAssignment[]): boolean {
  return hasEnabledRole(entries, "pm") && hasEnabledRole(entries, "developer");
}

export function toRosterPutBody(entries: RoleAssignment[]) {
  return persistableRosterEntries(entries).map((entry) => ({
    role: entry.role,
    assignee_type: entry.assignee_type,
    assignee_id: entry.assignee_id,
    enabled: entry.enabled,
  }));
}
