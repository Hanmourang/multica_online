"use client";

import { memo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Shield, Hourglass } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import type { AgentTask } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { selectIssueTasks, type IssueTaskGroups } from "../surface/activity";
import { useT } from "../../i18n";

/**
 * ModuleBadge renders an issue's project module as a colored dot + name chip
 * (prototype E legend). When the issue opted into cross-module conflict
 * avoidance (avoid_conflict), a shield icon trails the name, with the reason
 * in a tooltip so the dense chip stays scannable.
 *
 * Renders nothing when the issue has no module — a module-less task joins no
 * lock at all (spec §5), so an empty badge is the honest representation.
 */
export function ModuleBadge({
  name,
  color,
  avoidConflict,
  className,
}: {
  name: string;
  color: string;
  avoidConflict?: boolean;
  className?: string;
}) {
  const { t } = useT("issues");
  const chip = (
    <span
      className={cn(
        "inline-flex max-w-40 min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        className,
      )}
      style={{
        background: `color-mix(in oklch, ${color} 10%, transparent)`,
        color,
      }}
    >
      <i
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: color }}
      />
      <span className="min-w-0 truncate">{name}</span>
      {avoidConflict && <Shield className="size-2.5 shrink-0" />}
    </span>
  );
  if (!avoidConflict) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipContent>
        {t(($) => $.module.badge_avoid_conflict_tooltip)}
      </TooltipContent>
    </Tooltip>
  );
}

const EMPTY_GROUPS: IssueTaskGroups = { running: [], queued: [] };

/**
 * Blue "waiting for module lock" chip (prototype E). Rides the same shared
 * agent-task snapshot as IssueAgentActivityIndicator — the select narrows to
 * this issue, so only cards whose own tasks move re-render. Renders nothing
 * unless one of the issue's queued tasks is parked on the module lock; a
 * plain queued task already reads as "Queued" in the activity indicator.
 */
export const ModuleWaitBadge = memo(function ModuleWaitBadge({
  issueId,
}: {
  issueId: string;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const select = useCallback(
    (snapshot: AgentTask[]) => selectIssueTasks(snapshot, issueId),
    [issueId],
  );
  const { data: groups = EMPTY_GROUPS } = useQuery({
    ...agentTaskSnapshotOptions(wsId),
    select,
  });
  const waiting = groups.queued.some(
    (task) => task.status === "waiting_module_lock",
  );
  if (!waiting) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-micro text-blue-600 dark:text-blue-400">
      <Hourglass className="size-3" />
      {t(($) => $.module.waiting_badge)}
    </span>
  );
});
