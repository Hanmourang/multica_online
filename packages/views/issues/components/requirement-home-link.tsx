"use client";

import { Home } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { calendarIssuesOptions } from "@multica/core/issues/queries";
import type { Issue } from "@multica/core/types";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { useProjectTaskTrackingId } from "./project-task-tracking-context";

/** C7 卡片「需求归属」：仅项目任务追踪面显示，跳 C6。 */
export function RequirementHomeLink({ issue }: { issue: Issue }) {
  const projectId = useProjectTaskTrackingId();
  const { t } = useT("issues");
  const paths = useWorkspacePaths();
  const wsId = useWorkspaceId();
  const { data: calendar } = useQuery({
    ...calendarIssuesOptions(wsId),
    enabled: Boolean(projectId),
  });

  if (!projectId) return null;

  const reqId = !issue.parent_issue_id
    ? issue.requirement_status
      ? issue.id
      : null
    : (issue.root_requirement_id ?? issue.parent_issue_id);
  if (!reqId) return null;

  const requirement =
    reqId === issue.id ? issue : calendar?.find((row) => row.id === reqId);
  const label = requirement?.identifier ?? reqId.slice(0, 8);

  return (
    <AppLink
      href={paths.projectRequirement(projectId, reqId)}
      className="mt-1 inline-flex max-w-full items-center gap-1 text-micro text-muted-foreground hover:text-primary"
      onClick={(event) => event.stopPropagation()}
      data-testid="requirement-home-link"
    >
      <Home className="size-3 shrink-0" aria-hidden />
      <span className="truncate font-mono">
        {t(($) => $.card.requirement_home, { id: label })}
      </span>
    </AppLink>
  );
}
