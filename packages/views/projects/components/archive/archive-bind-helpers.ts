import type { Issue, ProjectArtifact } from "@multica/core/types";

export function groupUnboundArtifacts(artifacts: ProjectArtifact[]) {
  const map = new Map<string, ProjectArtifact[]>();
  for (const artifact of artifacts) {
    const key = artifact.requirement_key || "__none__";
    const bucket = map.get(key);
    if (bucket) bucket.push(artifact);
    else map.set(key, [artifact]);
  }
  return [...map.entries()]
    .map(([key, items]) => ({ key, items }))
    .sort((a, b) => b.items.length - a.items.length);
}

export const HIGH_BIND_CONFIDENCE = 85;

export type RequirementMatch = {
  issue: Issue;
  score: number;
  confidence: number;
};

export function scoreToConfidence(score: number): number {
  if (score >= 4) return 92;
  if (score >= 3) return 75;
  if (score >= 1) return 40;
  return 0;
}

export function scoreRequirementMatch(artifact: ProjectArtifact, issue: Issue): number {
  const hay = `${artifact.rel_path} ${artifact.requirement_key ?? ""}`.toLowerCase();
  const reqKey = artifact.requirement_key?.toLowerCase() ?? "";
  let score = 0;
  const identifier = issue.identifier.toLowerCase();
  const title = issue.title.toLowerCase();
  if (identifier && reqKey && (reqKey === identifier || reqKey.includes(identifier))) {
    score += 4;
  }
  if (identifier && hay.includes(identifier)) score += 3;
  const titleHead = title.slice(0, 16).trim();
  if (titleHead.length >= 4 && hay.includes(titleHead)) score += 1;
  return score;
}

export function rankRequirementMatches(
  artifact: ProjectArtifact,
  issues: Issue[],
): RequirementMatch[] {
  return issues
    .map((issue) => {
      const score = scoreRequirementMatch(artifact, issue);
      return { issue, score, confidence: scoreToConfidence(score) };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence);
}

export function suggestRequirement(
  artifact: ProjectArtifact,
  issues: Issue[],
): Issue | null {
  return rankRequirementMatches(artifact, issues)[0]?.issue ?? null;
}
