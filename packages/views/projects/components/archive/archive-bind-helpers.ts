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

export function suggestRequirement(
  artifact: ProjectArtifact,
  issues: Issue[],
): Issue | null {
  const hay = `${artifact.rel_path} ${artifact.requirement_key ?? ""}`.toLowerCase();
  const reqKey = artifact.requirement_key?.toLowerCase() ?? "";
  let best: { issue: Issue; score: number } | null = null;
  for (const issue of issues) {
    let score = 0;
    const identifier = issue.identifier.toLowerCase();
    const title = issue.title.toLowerCase();
    if (identifier && reqKey && (reqKey === identifier || reqKey.includes(identifier))) {
      score += 4;
    }
    if (identifier && hay.includes(identifier)) score += 3;
    const titleHead = title.slice(0, 16).trim();
    if (titleHead.length >= 4 && hay.includes(titleHead)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { issue, score };
  }
  return best?.issue ?? null;
}
