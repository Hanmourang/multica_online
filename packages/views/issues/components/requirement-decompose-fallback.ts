/**
 * When the PM finishes stage 2 without a machine-readable decomposition
 * fence, the workbench still needs confirmable drafts. Build them from the
 * plan list / goal / title so confirm (and auto-mode) can materialize
 * execution tasks instead of treating the PM child as the implementation.
 */
import type { DecomposeDraftTask, RoleAssignment } from "@multica/core/types";
import { extractPlanWorkItems } from "./requirement-plan";

const EXEC_ROLES = ["developer", "data"] as const;

export function isFallbackDraftId(tempId: string): boolean {
  return tempId.startsWith("fallback-");
}

export function pickRosterRole(
  roster: RoleAssignment[],
  roles: readonly string[],
): RoleAssignment | undefined {
  for (const role of roles) {
    const hit = roster.find((row) => row.enabled && row.role === role);
    if (hit) return hit;
  }
  return (
    roster.find(
      (row) => row.enabled && row.role !== "pm" && row.role !== "prototyper",
    ) ?? roster.find((row) => row.enabled)
  );
}

export function draftsAreConfirmable(drafts: DecomposeDraftTask[]): boolean {
  if (!drafts.some((draft) => draft.stage === 3)) return false;
  return !drafts.some((draft) => {
    if (!draft.title.trim()) return true;
    if (draft.stage !== 3) return false;
    const points = draft.feature_points ?? [];
    if (points.length === 0) return true;
    if (
      points.some(
        (fp) =>
          !fp.title.trim() || (fp.kind !== "new" && fp.kind !== "modify"),
      )
    ) {
      return true;
    }
    return !draft.assignee_id;
  });
}

export function synthesizeFallbackDrafts(input: {
  title: string;
  goal?: string | null;
  plan?: string | null;
  roster: RoleAssignment[];
}): DecomposeDraftTask[] {
  const items = extractPlanWorkItems(input.plan);
  const titles = items.length > 0 ? items : [fallbackExecTitle(input.title)];
  const developer = pickRosterRole(input.roster, EXEC_ROLES);
  const execDrafts: DecomposeDraftTask[] = titles.map((title, index) => ({
    temp_id: `fallback-${index + 1}`,
    title,
    description: input.goal?.trim() || undefined,
    stage: 3,
    assignee_role: developer?.role,
    assignee_type: developer?.assignee_type,
    assignee_id: developer?.assignee_id,
    feature_points: [
      {
        title: input.goal?.trim() || title,
        kind: "modify",
      },
    ],
    graph_context: { note: "archive-unready: system fallback decomposition" },
  }));
  return [
    ...execDrafts,
    {
      temp_id: "fallback-accept",
      title: `验收：${input.title.trim() || "需求"}`,
      stage: 4,
      depends_on: execDrafts.map((draft) => draft.temp_id),
    },
  ];
}

function fallbackExecTitle(title: string): string {
  const value = title.trim() || "执行任务";
  return value.startsWith("完成") ? value : `完成${value}`;
}
