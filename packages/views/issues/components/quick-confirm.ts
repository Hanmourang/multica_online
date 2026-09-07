import { api } from "@multica/core/api";
import type { DecomposeDraftTask, Issue } from "@multica/core/types";
import {
  draftsAreConfirmable,
  synthesizeFallbackDrafts,
} from "./requirement-decompose-fallback";
import { resolveDraftAssignees } from "./requirement-flow-section";

export type QuickConfirmKind = "decompose" | "prototype" | "review";

export class QuickConfirmError extends Error {
  constructor(
    message: string,
    readonly code: "empty" | "incomplete" | "failed",
  ) {
    super(message);
    this.name = "QuickConfirmError";
  }
}

function isReviewStatus(issue: Issue): boolean {
  return issue.status === "in_review" || issue.status_category === "in_review";
}

function pickRequirement(issue: Issue, parent: Issue | null): Issue {
  if (issue.requirement_status) return issue;
  if (parent?.requirement_status) return parent;
  return parent ?? issue;
}

async function confirmDecompose(requirement: Issue): Promise<void> {
  const [decomp, roster] = await Promise.all([
    api.getDecomposition(requirement.id),
    api.listIssueRoleAssignments(requirement.id),
  ]);
  const source =
    decomp.drafts.length > 0
      ? decomp.drafts
      : synthesizeFallbackDrafts({
          title: requirement.title,
          goal: requirement.goal,
          plan: decomp.plan,
          roster: roster.roles,
        });
  const drafts = resolveDraftAssignees(source, roster.roles);
  if (!draftsAreConfirmable(drafts)) {
    throw new QuickConfirmError(
      decomp.drafts.length === 0 ? "empty" : "incomplete",
      decomp.drafts.length === 0 ? "empty" : "incomplete",
    );
  }
  await api.confirmDecomposition(requirement.id, drafts as DecomposeDraftTask[]);
}

async function confirmPrototype(issueId: string): Promise<void> {
  const { versions } = await api.listPrototypeVersions(issueId);
  const current =
    versions.find((version) => version.status === "pending") ?? versions[0];
  if (!current) {
    throw new QuickConfirmError("empty", "empty");
  }
  await api.confirmPrototype(issueId, current.version);
}

/** 拆解待确认 / 原型待确认优先；否则把审核中的任务标为通过。 */
export async function quickConfirmIssue(issueId: string): Promise<QuickConfirmKind> {
  const issue = await api.getIssue(issueId);
  const parent = issue.parent_issue_id
    ? await api.getIssue(issue.parent_issue_id)
    : null;
  const requirement = pickRequirement(issue, parent);

  if (requirement.requirement_status === "拆解待确认") {
    await confirmDecompose(requirement);
    return "decompose";
  }
  if (requirement.requirement_status === "原型待确认") {
    await confirmPrototype(requirement.id);
    return "prototype";
  }

  const reviewTarget = isReviewStatus(issue)
    ? issue
    : parent && isReviewStatus(parent)
      ? parent
      : null;
  if (reviewTarget) {
    await api.updateIssue(reviewTarget.id, { status: "done" });
    return "review";
  }

  throw new QuickConfirmError("empty", "empty");
}
