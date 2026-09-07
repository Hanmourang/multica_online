"use client";

import { useQuery } from "@tanstack/react-query";
import { AppLink } from "../../navigation";
import { useWorkspacePaths } from "@multica/core/paths";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import type { Issue } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import {
  deriveFlowStage,
  isRequirementWorkbench,
  type FlowStage,
} from "./requirement-flow-section";
import { issueBehavesAsAny } from "@multica/core/issues";

/**
 * A2 属性栏「需求」卡：仅需求型任务或其子任务显示。
 * 跳转 B4 日历工作台、C6 项目侧需求详情。
 */
export function RequirementPropertyCard({
  issue,
  childIssues,
}: {
  issue: Issue;
  childIssues: Issue[];
}) {
  const { t } = useT("issues");
  const paths = useWorkspacePaths();
  const wsId = useWorkspaceId();
  const isSelf = isRequirementWorkbench(issue);
  const rootId =
    issue.root_requirement_id && issue.root_requirement_id !== issue.id
      ? issue.root_requirement_id
      : issue.parent_issue_id;
  const shouldShow = isSelf || Boolean(rootId);
  const { data: rootIssue } = useQuery({
    ...issueDetailOptions(wsId, rootId ?? ""),
    enabled: !isSelf && Boolean(rootId),
  });
  const requirement = isSelf ? issue : rootIssue;
  if (!shouldShow || !requirement) return null;
  if (!isSelf && !isRequirementWorkbench(requirement)) return null;

  const stage = deriveFlowStage({
    children: (isSelf ? childIssues : []).map((child) => ({
      stage: child.stage,
      terminal: issueBehavesAsAny(child, ["done", "cancelled"]),
    })),
    hasPrototyper: true,
    hasConfirmedPrototype: true,
    decompositionConfirmed: requirement.decomposition_confirmed_at != null,
  });
  const progress =
    requirement.stage_progress ??
    (isSelf
      ? `${childIssues.filter((c) => issueBehavesAsAny(c, ["done"])).length}/${childIssues.length || 0}`
      : "—");

  return (
    <div data-testid="requirement-property-card">
      <div className="mb-2 px-2 py-1 text-caption font-medium">
        {t(($) => $.detail.requirement_section)}
      </div>
      <div className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-caption font-semibold">
          <span className="font-mono text-micro text-primary">{requirement.identifier}</span>
          <span className="truncate">{requirement.title}</span>
        </div>
        {requirement.goal && (
          <p className="mt-1.5 line-clamp-3 text-micro leading-5 text-muted-foreground">
            {requirement.goal}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <StageDots current={stage} />
          <span className="text-micro text-muted-foreground">
            {t(($) => $.detail.requirement_stage, { n: stage, progress })}
          </span>
        </div>
        <div className="mt-2 flex gap-1.5">
          <AppLink
            href={paths.calendarRequirement(requirement.id, stage, "issue")}
            className="flex flex-1 items-center justify-center rounded-md border border-border bg-background px-2 py-1 text-micro hover:bg-accent"
          >
            {t(($) => $.detail.requirement_workbench)}
          </AppLink>
          {requirement.project_id && (
            <AppLink
              href={paths.projectRequirement(requirement.project_id, requirement.id)}
              className="flex flex-1 items-center justify-center rounded-md border border-border bg-background px-2 py-1 text-micro hover:bg-accent"
            >
              {t(($) => $.detail.requirement_detail)}
            </AppLink>
          )}
        </div>
      </div>
    </div>
  );
}

function StageDots({ current }: { current: FlowStage }) {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {([1, 2, 3, 4] as const).map((n) => (
        <span
          key={n}
          className={cn(
            "flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold",
            n < current && "bg-emerald-500/15 text-emerald-600",
            n === current && "bg-primary text-primary-foreground",
            n > current && "bg-muted text-muted-foreground",
          )}
        >
          {n < current ? "✓" : n}
        </span>
      ))}
    </span>
  );
}
