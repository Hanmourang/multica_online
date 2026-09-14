"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { api, dispatchReasonCode } from "@multica/core/api";
import {
  isTaskMessageTaskId,
  taskMessagesOptions,
} from "@multica/core/chat/queries";
import type { AgentTask } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import {
  AgentTranscriptDialog,
  buildTimeline,
} from "../../common/task-transcript";
import { useT } from "../../i18n";
import { useActorName } from "@multica/core/workspace/hooks";
import { formatDuration } from "../../agents/components/agent-activity-hover-content";
import {
  formatTokens,
  formatUsd,
  summarizeTaskUsage,
  summarizeTaskUsageAcross,
} from "../../runtimes/utils";
import { useStatusLabel, useTriggerText } from "./task-run-labels";
import { pickDefaultRun } from "./issue-detail-tab";
import type { LabeledTask } from "./use-issue-execution-tasks";

export function ExecutionLogPanel({
  issueId,
  labeledTasks,
  preferredRunId,
  onSelectRun,
  fill = false,
}: {
  issueId: string;
  labeledTasks: LabeledTask[];
  preferredRunId?: string | null;
  onSelectRun?: (runId: string) => void;
  fill?: boolean;
}) {
  const { t } = useT("issues");
  const tasks = useMemo(() => labeledTasks.map((item) => item.task), [labeledTasks]);
  const taskKey = tasks.map((task) => `${task.id}:${task.status}`).join(",");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => pickDefaultRun(tasks, preferredRunId)?.id ?? null,
  );

  useEffect(() => {
    const next = pickDefaultRun(tasks, preferredRunId);
    setSelectedId(next?.id ?? null);
  }, [preferredRunId, taskKey, tasks]);

  const selected = labeledTasks.find((item) => item.task.id === selectedId) ?? null;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const usageTotal = summarizeTaskUsageAcross(tasks.map((task) => task.usage));

  const showRail = labeledTasks.length > 1;

  return (
    <div
      data-testid="execution-log-panel"
      className={cn(
        "flex rounded-lg border bg-card",
        fill ? "h-full min-h-0 items-stretch overflow-hidden" : "items-start",
      )}
    >
      {showRail && (
      <aside className="flex w-52 shrink-0 flex-col self-stretch overflow-y-auto border-r bg-muted/20">
        <div className="flex items-center justify-between px-3 py-2 text-caption font-medium">
          <span>{t(($) => $.execution_log.panel_runs)}</span>
          <span className="font-normal text-muted-foreground">
            {tasks.length}
            {failed > 0 ? ` · ${t(($) => $.detail.tab_execution_failed, { count: failed })}` : ""}
            {usageTotal ? ` · ${formatUsd(usageTotal.cost)}` : ""}
          </span>
        </div>
        <div className="pb-2">
          {labeledTasks.map((item) => (
              <RunPickRow
                key={item.task.id}
                item={item}
                selected={item.task.id === selectedId}
                onSelect={() => {
                  setSelectedId(item.task.id);
                  onSelectRun?.(item.task.id);
                }}
              />
          ))}
        </div>
      </aside>
      )}
      <div className={cn("min-w-0 flex-1", fill && "flex min-h-0 flex-col overflow-hidden")}>
        {selected ? (
          <SelectedRunTrace
            issueId={selected.task.issue_id || issueId}
            task={selected.task}
            sourceTitle={selected.sourceTitle}
            fill={fill}
          />
        ) : (
          <p className="px-4 py-6 text-center text-caption text-muted-foreground">
            {labeledTasks.length === 0
              ? t(($) => $.execution_log.panel_empty)
              : t(($) => $.execution_log.select_run)}
          </p>
        )}
      </div>
    </div>
  );
}

function RunPickRow({
  item,
  selected,
  onSelect,
}: {
  item: LabeledTask;
  selected: boolean;
  onSelect: () => void;
}) {
  const { getActorName } = useActorName();
  const trigger = useTriggerText(item.task);
  const label = useStatusLabel(item.task.status);
  const title = item.sourceTitle ?? trigger;
  const agentName = item.task.agent_id
    ? getActorName("agent", item.task.agent_id)
    : "";
  const usage = summarizeTaskUsage(item.task.usage);
  const endMs = item.task.completed_at
    ? new Date(item.task.completed_at).getTime()
    : Date.now();
  const duration = item.task.started_at
    ? formatDuration(item.task.started_at, endMs)
    : null;
  const meta = [
    label,
    duration,
    usage ? formatTokens(usage.tokens) : null,
    usage ? formatUsd(usage.cost) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      data-testid={`exec-run-${item.task.id}`}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 border-l-2 px-2.5 py-2 text-left transition-colors",
        selected
          ? "border-l-foreground bg-accent/60"
          : "border-l-transparent hover:bg-accent/40",
      )}
    >
      {item.task.agent_id ? (
        <ActorAvatar actorType="agent" actorId={item.task.agent_id} size="sm" />
      ) : (
        <span className="mt-0.5 inline-block h-5 w-5 shrink-0 rounded-full bg-muted" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-caption font-medium">
          {agentName ? `${agentName} · ${title}` : title}
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate text-micro",
            item.task.status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {meta}
        </span>
      </span>
    </button>
  );
}

function SelectedRunTrace({
  issueId,
  task,
  sourceTitle,
  fill = false,
}: {
  issueId: string;
  task: AgentTask;
  sourceTitle?: string;
  fill?: boolean;
}) {
  const { t } = useT("issues");
  const { getActorName } = useActorName();
  const [retrying, setRetrying] = useState(false);
  const live =
    task.status === "running" ||
    task.status === "dispatched" ||
    task.status === "queued";
  const liveCache = live && isTaskMessageTaskId(task.id);
  const messagesQuery = useQuery({
    ...taskMessagesOptions(task.id),
    enabled: liveCache,
  });
  const [loadedItems, setLoadedItems] = useState<ReturnType<typeof buildTimeline> | null>(
    null,
  );
  const [loading, setLoading] = useState(!liveCache);

  useEffect(() => {
    if (liveCache) return;
    let cancelled = false;
    setLoading(true);
    api
      .listTaskMessages(task.id)
      .then((msgs) => {
        if (!cancelled) setLoadedItems(buildTimeline(msgs));
      })
      .catch(() => {
        if (!cancelled) setLoadedItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [liveCache, task.id]);

  const items = useMemo(() => {
    if (liveCache) return buildTimeline(messagesQuery.data ?? []);
    return loadedItems ?? [];
  }, [liveCache, messagesQuery.data, loadedItems]);

  const canRetry = task.status === "failed" || task.status === "cancelled";
  const agentName = task.agent_id ? getActorName("agent", task.agent_id) : "";

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await api.rerunIssue(issueId, task.id);
    } catch (error) {
      toast.error(
        dispatchReasonCode(error) === "invocation_not_allowed"
          ? t(($) => $.execution_log.retry_blocked)
          : error instanceof Error
            ? error.message
            : t(($) => $.execution_log.retry_failed),
      );
    } finally {
      setRetrying(false);
    }
  };

  if (loading && items.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col", fill && "h-full")}>
      {canRetry && (
        <div className="flex shrink-0 items-center justify-end border-b px-3 py-1.5">
          <button
            type="button"
            data-testid="exec-retry"
            disabled={retrying}
            onClick={() => void handleRetry()}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-caption text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {retrying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
            {t(($) => $.execution_log.retry_task_tooltip)}
          </button>
        </div>
      )}
      <div className={cn(fill && "min-h-0 flex-1 overflow-hidden")}>
        <AgentTranscriptDialog
          open
          onOpenChange={() => undefined}
          task={task}
          items={items}
          agentName={
            sourceTitle && agentName
              ? `${agentName} · ${sourceTitle}`
              : agentName || sourceTitle || ""
          }
          isLive={live}
          embedded
        />
      </div>
    </div>
  );
}
