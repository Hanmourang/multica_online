import type { Issue } from "@multica/core/types";

export type MatrixRequirementDisplay = {
  identifier: string;
  title: string | null;
  issueId: string | null;
  status: string | null;
};

/** 矩阵左列：identifier 对齐 C5；标题来自 issue，对不上就不编造。 */
export function matrixRequirementDisplay(
  row: { key: string; label: string; issueId: string | null },
  issues: Issue[],
): MatrixRequirementDisplay {
  const byId = row.issueId
    ? issues.find((issue) => issue.id === row.issueId)
    : undefined;
  if (byId) return fromIssue(byId);

  const key = row.key.trim().toLowerCase();
  if (key && key !== "__unassigned__") {
    const byIdentifier = issues.find((issue) => issue.identifier.toLowerCase() === key);
    if (byIdentifier) return fromIssue(byIdentifier);
    const byNumber = issues.find((issue) => `req-${issue.number}` === key);
    if (byNumber) return fromIssue(byNumber);
  }

  if (row.key && row.key !== "__unassigned__") {
    return { identifier: row.label, title: null, issueId: row.issueId, status: null };
  }
  return { identifier: row.label, title: null, issueId: row.issueId, status: null };
}

function fromIssue(issue: Issue): MatrixRequirementDisplay {
  const title = issue.title.trim();
  const status = issue.requirement_status?.trim() || null;
  return {
    identifier: issue.identifier,
    title: title && title !== issue.identifier ? title : null,
    issueId: issue.id,
    status,
  };
}
