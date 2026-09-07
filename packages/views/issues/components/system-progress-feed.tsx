"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { issueDynamicsOptions } from "@multica/core/agent-runs/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import { useT } from "../../i18n";
import { isWithinTimeWindow, type ActivityTimeWindow } from "./issue-detail-tab";

/**
 * A2 系统进展：heartbeat / todo_change 等 progress 事件。
 * 默认过滤关闭，打开「系统进展」芯片后才请求。
 */
export function SystemProgressFeed({
  issueId,
  enabled,
  timeWindow,
}: {
  issueId: string;
  enabled: boolean;
  timeWindow: ActivityTimeWindow;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const query = useQuery({
    ...issueDynamicsOptions(wsId, issueId),
    enabled: enabled && Boolean(wsId && issueId),
  });

  const events = useMemo(() => {
    if (!query.data) return [];
    return query.data.days
      .flatMap((day) => day.events)
      .filter(
        (event) =>
          event.type === "progress" &&
          isWithinTimeWindow(event.ts, timeWindow),
      )
      .toSorted(
        (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime(),
      );
  }, [query.data, timeWindow]);

  if (!enabled) return null;
  if (query.isPending) {
    return (
      <p
        data-testid="system-progress-feed"
        className="mb-3 text-caption text-muted-foreground"
      >
        {t(($) => $.detail.system_progress_loading)}
      </p>
    );
  }
  if (events.length === 0) return null;

  return (
    <div data-testid="system-progress-feed" className="mb-3 space-y-1.5">
      {events.map((event) => (
        <div
          key={event.id}
          className="flex items-start gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-caption text-muted-foreground"
        >
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-micro font-medium">
            {t(($) => $.detail.filter_system)}
          </span>
          <span className="min-w-0 flex-1 truncate">{event.content}</span>
          {event.actor_name && (
            <span className="shrink-0 text-micro">{event.actor_name}</span>
          )}
        </div>
      ))}
    </div>
  );
}
