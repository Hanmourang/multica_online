"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Filter,
  MessageSquare,
  Package,
  Send,
  TrendingUp,
  Users,
} from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueArchiveKeys, issueDynamicsOptions } from "@multica/core/agent-runs/queries";
import { useCreateComment } from "@multica/core/issues/mutations";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  displayTaskTitle,
  runStatusKey,
  truncateLabel,
} from "./requirement-display";
import type {
  DynamicsDay,
  DynamicsEvent,
  DynamicsEventType,
  DynamicsTaskFacet,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { useT, useTimeAgo } from "../../../i18n";
import { AppLink } from "../../../navigation";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../archive/query-states";
import {
  countEventTypes,
  eventsForTask,
  filterDays,
  latestEventTs,
  taskEventStats,
  type TimeWindow,
} from "./requirement-drill-helpers";

const TASK_COLORS = [
  "bg-blue-500",
  "bg-rose-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-cyan-500",
  "bg-orange-500",
  "bg-pink-500",
] as const;

const ALL_TYPES = new Set<DynamicsEventType>([
  "conversation",
  "progress",
  "status",
  "artifact",
]);

export function RequirementDynamics({
  issueId,
  projectId,
  onOpenAcceptance,
}: {
  issueId: string;
  projectId?: string | null;
  onOpenAcceptance?: () => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const queryClient = useQueryClient();

  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<Set<DynamicsEventType>>(
    () => new Set(ALL_TYPES),
  );
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("all");
  const [draft, setDraft] = useState("");
  const [composerNote, setComposerNote] = useState<string | null>(null);

  const dynamicsQuery = useQuery(issueDynamicsOptions(wsId, issueId));
  const createComment = useCreateComment(issueId);

  const data = dynamicsQuery.data;
  const selectedTasks = useMemo(
    () => (focusedTaskId ? new Set([focusedTaskId]) : new Set<string>()),
    [focusedTaskId],
  );

  const taskColorMap = useMemo(() => {
    const map = new Map<string, number>();
    data?.filters.tasks.forEach((task, idx) => {
      map.set(task.id, idx % TASK_COLORS.length);
    });
    return map;
  }, [data]);

  const filteredDays = useMemo(() => {
    if (!data) return [];
    return filterDays(data.days, {
      selectedTasks,
      selectedTypes,
      selectedAgent,
      timeWindow,
      taskAgentMap: data.filters.tasks,
    });
  }, [data, selectedTasks, selectedTypes, selectedAgent, timeWindow]);

  if (dynamicsQuery.isPending) {
    return <QueryLoading rows={6} />;
  }
  if (dynamicsQuery.isError) {
    return (
      <QueryError
        onRetry={() => dynamicsQuery.refetch()}
        message={dynamicsQuery.error.message}
      />
    );
  }
  if (!data) {
    return <QueryLoading rows={6} />;
  }

  const totalFilteredEvents = filteredDays.reduce(
    (acc, day) => acc + day.events.length,
    0,
  );
  const typeCounts = countEventTypes(data.days);
  const latestTs = latestEventTs(data.days);
  const focusedTask = focusedTaskId
    ? data.filters.tasks.find((task) => task.id === focusedTaskId) ?? null
    : null;
  const threadEvents = focusedTaskId
    ? eventsForTask(data.days, focusedTaskId).filter(
        (event) => event.type === "conversation",
      )
    : [];
  const focusedRunId =
    threadEvents.find((event) => event.run_id)?.run_id ??
    eventsForTask(data.days, focusedTaskId ?? "").find((event) => event.run_id)
      ?.run_id ??
    null;

  const streamBare =
    data.days.length === 0 &&
    data.summary.message_count === 0 &&
    data.filters.tasks.length === 0;

  const submitComment = () => {
    const content = draft.trim();
    if (!content || createComment.isPending) return;
    setComposerNote(null);
    void createComment
      .mutateAsync({ content })
      .then(() => {
        setDraft("");
        setComposerNote(t(($) => $.dynamics.composer_ok));
        void queryClient.invalidateQueries({
          queryKey: issueArchiveKeys.dynamics(wsId, issueId),
        });
      })
      .catch(() => {
        setComposerNote(t(($) => $.dynamics.composer_failed));
      });
  };

  if (streamBare) {
    return (
      <div className="space-y-3" data-testid="dynamics-empty">
        <ArchiveEmpty
          title={t(($) => $.dynamics.title)}
          description={t(($) => $.dynamics.stream_empty)}
          icon={<Activity className="size-5" />}
        />
        <div className="space-y-1.5 rounded-lg border bg-card/30 px-3 py-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t(($) => $.dynamics.composer_placeholder)}
            rows={2}
            className="min-h-[64px] resize-none text-caption"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-micro text-muted-foreground">
              {composerNote ?? t(($) => $.dynamics.composer_hint)}
            </p>
            <Button
              size="xs"
              disabled={!draft.trim() || createComment.isPending}
              onClick={submitComment}
            >
              <Send className="size-3.5" />
              {t(($) => $.dynamics.composer_send)}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard
          icon={<TrendingUp className="size-3.5" />}
          label={t(($) => $.dynamics.metric_tasks)}
          value={`${data.summary.task_total}`}
          sub={t(($) => $.dynamics.metric_tasks_sub, { n: data.summary.task_dispatched })}
        />
        <MetricCard
          icon={<Users className="size-3.5" />}
          label={t(($) => $.dynamics.metric_agents)}
          value={`${data.filters.agents.length}`}
          sub={<AgentNamesSub agentIds={data.filters.agents} />}
        />
        <MetricCard
          icon={<MessageSquare className="size-3.5" />}
          label={t(($) => $.dynamics.metric_messages)}
          value={`${data.summary.message_count}`}
        />
        <MetricCard
          icon={<Activity className="size-3.5" />}
          label={t(($) => $.dynamics.metric_progress)}
          value={`${data.summary.progress_event_count}`}
        />
        <MetricCard
          icon={<Package className="size-3.5" />}
          label={t(($) => $.dynamics.metric_artifacts)}
          value={`${data.summary.artifact_count}`}
          sub={t(($) => $.dynamics.metric_artifacts_sub, { n: data.summary.artifact_archived_count })}
        />
        <div className="flex items-center gap-2 rounded-lg border bg-card/40 px-3 py-2">
          <span className="size-2 shrink-0 rounded-full bg-emerald-500 animate-pulse" />
          <div className="min-w-0">
            <div className="text-caption text-muted-foreground">
              {t(($) => $.dynamics.live)}
            </div>
            <div className="truncate text-micro text-muted-foreground">
              {latestTs
                ? t(($) => $.dynamics.live_ago, { time: timeAgo(latestTs) })
                : t(($) => $.dynamics.live_idle)}
            </div>
          </div>
        </div>
      </div>

      <FilterBar
        tasks={data.filters.tasks}
        agents={data.filters.agents}
        fallbackTitle={data.issue.title}
        focusedTaskId={focusedTaskId}
        onFocusTask={setFocusedTaskId}
        selectedTypes={selectedTypes}
        onToggleType={(type) => {
          setSelectedTypes((prev) => {
            const next = new Set(prev);
            if (next.has(type)) next.delete(type);
            else next.add(type);
            if (next.size === 0) return new Set(ALL_TYPES);
            return next;
          });
        }}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        timeWindow={timeWindow}
        onTimeWindow={setTimeWindow}
        typeCounts={typeCounts}
      />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-3">
          {totalFilteredEvents === 0 ? (
            <ArchiveEmpty
              title={t(($) => $.dynamics.no_filtered_events)}
              description={t(($) => $.dynamics.no_filtered_events_hint)}
              icon={<Filter className="size-5" />}
            />
          ) : (
            <div className="space-y-4">
              {filteredDays.map((day) => (
                <DayGroup
                  key={day.date}
                  day={day}
                  issueId={issueId}
                  projectId={projectId}
                  taskColorMap={taskColorMap}
                  taskMap={data.filters.tasks}
                  onOpenAcceptance={onOpenAcceptance}
                  onFocusTask={setFocusedTaskId}
                />
              ))}
            </div>
          )}

          <div className="space-y-1.5 rounded-lg border bg-card/30 px-3 py-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t(($) => $.dynamics.composer_placeholder)}
              rows={2}
              className="min-h-[64px] resize-none text-caption"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-micro text-muted-foreground">
                {composerNote ?? t(($) => $.dynamics.composer_hint)}
              </p>
              <Button
                size="xs"
                disabled={!draft.trim() || createComment.isPending}
                onClick={submitComment}
              >
                <Send className="size-3.5" />
                {t(($) => $.dynamics.composer_send)}
              </Button>
            </div>
          </div>
        </div>

        <aside className="space-y-3 lg:sticky lg:top-2 lg:self-start">
          <div className="rounded-lg border bg-card/30">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-caption font-medium">
                {t(($) => $.dynamics.task_sidebar)}
              </span>
              <span className="text-micro text-muted-foreground">
                {t(($) => $.dynamics.task_sidebar_hint)}
              </span>
            </div>
            <div className="space-y-1.5 p-2">
              {data.filters.tasks.length === 0 ? (
                <p className="px-1 py-2 text-micro text-muted-foreground">
                  {t(($) => $.dynamics.stream_empty)}
                </p>
              ) : (
                data.filters.tasks.map((task) => (
                  <TaskSummaryCard
                    key={task.id}
                    task={task}
                    fallbackTitle={data.issue.title}
                    stats={taskEventStats(data.days, task.id)}
                    colorClass={
                      TASK_COLORS[(taskColorMap.get(task.id) ?? 0) % TASK_COLORS.length] ??
                      "bg-blue-500"
                    }
                    selected={focusedTaskId === task.id}
                    onSelect={() =>
                      setFocusedTaskId((prev) => (prev === task.id ? null : task.id))
                    }
                  />
                ))
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card/30" data-testid="dynamics-thread">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-caption font-medium">
                {focusedTask
                  ? `${displayTaskTitle(focusedTask.title, data.issue.title)} · ${t(($) => $.dynamics.thread_title)}`
                  : t(($) => $.dynamics.thread_title)}
              </span>
              {focusedRunId && (
                <span className="font-mono text-micro text-muted-foreground">
                  {focusedRunId.slice(0, 8)}
                </span>
              )}
            </div>
            <div className="space-y-2 p-3">
              {!focusedTask ? (
                <p className="text-micro text-muted-foreground">
                  {t(($) => $.dynamics.thread_empty)}
                </p>
              ) : threadEvents.length === 0 ? (
                <p className="text-micro text-muted-foreground">
                  {t(($) => $.dynamics.thread_empty_task)}
                </p>
              ) : (
                threadEvents.slice(0, 8).map((event) => (
                  <ConversationBubble key={event.id} event={event} />
                ))
              )}
              <div className="flex flex-wrap gap-1.5 pt-1">
                <AppLink href={paths.issueDetail(issueId)}>
                  <Button size="xs" variant="ghost">
                    {t(($) => $.dynamics.open_task)}
                  </Button>
                </AppLink>
                {focusedRunId && (
                  <AppLink href={paths.issueExecLog(issueId, focusedRunId)}>
                    <Button size="xs" variant="ghost">
                      {t(($) => $.dynamics.open_exec)}
                    </Button>
                  </AppLink>
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <TypeDistribution counts={typeCounts} />
        <div className="rounded-lg border bg-card/30 px-3 py-2.5">
          <div className="mb-1.5 text-caption font-medium">
            {t(($) => $.dynamics.merge_title)}
          </div>
          <dl className="space-y-1 text-micro text-muted-foreground">
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{t(($) => $.dynamics.merge_source)}</dt>
              <dd>{t(($) => $.dynamics.merge_source_v)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{t(($) => $.dynamics.merge_rule)}</dt>
              <dd>{t(($) => $.dynamics.merge_rule_v)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{t(($) => $.dynamics.merge_grain)}</dt>
              <dd>{t(($) => $.dynamics.merge_grain_v)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{t(($) => $.dynamics.merge_artifact)}</dt>
              <dd>{t(($) => $.dynamics.merge_artifact_v)}</dd>
            </div>
          </dl>
        </div>
      </div>

      {data.summary.progress_event_count === 0 && data.summary.message_count > 0 && (
        <p className="rounded border border-dashed px-3 py-2 text-micro text-muted-foreground">
          {t(($) => $.dynamics.progress_degraded)}
        </p>
      )}
    </div>
  );
}

function AgentNamesSub({ agentIds }: { agentIds: string[] }) {
  const { getActorName } = useActorName();
  const names = agentIds
    .slice(0, 3)
    .map((id) => getActorName("agent", id))
    .filter(Boolean);
  if (names.length === 0) return null;
  return <>{names.join(" / ")}</>;
}

function DynamicsStatusLabel({ status }: { status: string }) {
  const { t } = useT("archive");
  switch (runStatusKey(status)) {
    case "queued":
      return t(($) => $.progress.status_queued);
    case "dispatched":
      return t(($) => $.progress.status_dispatched);
    case "running":
      return t(($) => $.progress.status_running);
    case "completed":
      return t(($) => $.progress.status_completed);
    case "failed":
      return t(($) => $.progress.status_failed);
    case "stalled":
      return t(($) => $.progress.status_stalled);
    case "cancelled":
      return t(($) => $.progress.status_cancelled);
    case "in_review":
      return t(($) => $.progress.status_in_review);
    case "in_progress":
      return t(($) => $.progress.status_in_progress);
    case "todo":
      return t(($) => $.progress.status_todo);
    case "done":
      return t(($) => $.progress.status_done);
    case "blocked":
      return t(($) => $.progress.status_blocked);
    default:
      return status;
  }
}

function MetricCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 text-title-sm font-semibold tabular-nums">{value}</div>
      {sub && (
        <div className="mt-0.5 truncate text-micro text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}

function FilterBar({
  tasks,
  agents,
  fallbackTitle,
  focusedTaskId,
  onFocusTask,
  selectedTypes,
  onToggleType,
  selectedAgent,
  onSelectAgent,
  timeWindow,
  onTimeWindow,
  typeCounts,
}: {
  tasks: DynamicsTaskFacet[];
  agents: string[];
  fallbackTitle: string;
  focusedTaskId: string | null;
  onFocusTask: (id: string | null) => void;
  selectedTypes: Set<DynamicsEventType>;
  onToggleType: (type: DynamicsEventType) => void;
  selectedAgent: string | null;
  onSelectAgent: (agent: string | null) => void;
  timeWindow: TimeWindow;
  onTimeWindow: (window: TimeWindow) => void;
  typeCounts: Record<DynamicsEventType, number>;
}) {
  const { t } = useT("archive");
  const { getActorName } = useActorName();
  const eventTypeLabels: { key: DynamicsEventType; label: string }[] = [
    { key: "conversation", label: t(($) => $.dynamics.type_conversation) },
    { key: "progress", label: t(($) => $.dynamics.type_progress) },
    { key: "status", label: t(($) => $.dynamics.type_status) },
    { key: "artifact", label: t(($) => $.dynamics.type_artifact) },
  ];
  const timeWindowLabels: { key: TimeWindow; label: string }[] = [
    { key: "today", label: t(($) => $.dynamics.window_today) },
    { key: "7days", label: t(($) => $.dynamics.window_7days) },
    { key: "all", label: t(($) => $.dynamics.window_all) },
  ];
  const total = Object.values(typeCounts).reduce((sum, n) => sum + n, 0);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        aria-pressed={!focusedTaskId}
        onClick={() => onFocusTask(null)}
        className={cn(
          "rounded-full border px-2 py-0.5 text-micro font-medium",
          !focusedTaskId
            ? "border-primary/40 bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-accent/60",
        )}
      >
        {t(($) => $.dynamics.filter_all)} {total}
      </button>
      {eventTypeLabels.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={selectedTypes.has(item.key)}
          onClick={() => onToggleType(item.key)}
          className={cn(
            "rounded-full border px-2 py-0.5 text-micro font-medium",
            selectedTypes.has(item.key)
              ? "border-primary/40 bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent/60",
          )}
        >
          {item.label} {typeCounts[item.key]}
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-border" />
      {tasks.slice(0, 8).map((task) => {
        const trouble = task.status === "failed" || task.status === "stalled";
        return (
          <button
            key={task.id}
            type="button"
            aria-pressed={focusedTaskId === task.id}
            onClick={() => onFocusTask(focusedTaskId === task.id ? null : task.id)}
            className={cn(
              "rounded-full border px-2 py-0.5 text-micro font-medium",
              focusedTaskId === task.id
                ? "border-primary/40 bg-primary/10 text-primary"
                : trouble
                  ? "border-destructive/40 text-destructive"
                  : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            {truncateLabel(
              displayTaskTitle(task.title, fallbackTitle),
              16,
            )}
            {trouble ? " ✕" : ""}
          </button>
        );
      })}
      {agents.length > 1 && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <select
            value={selectedAgent ?? ""}
            onChange={(event) => onSelectAgent(event.target.value || null)}
            className="rounded border bg-background px-1.5 py-0.5 text-micro text-muted-foreground"
            aria-label={t(($) => $.dynamics.filter_agent)}
          >
            <option value="">{t(($) => $.dynamics.filter_agent_all)}</option>
            {agents.map((agent) => (
              <option key={agent} value={agent}>
                {getActorName("agent", agent)}
              </option>
            ))}
          </select>
        </>
      )}
      <span className="mx-1 h-4 w-px bg-border" />
      <div className="flex gap-0.5" role="group">
        {timeWindowLabels.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={timeWindow === item.key}
            onClick={() => onTimeWindow(item.key)}
            className={cn(
              "rounded px-1.5 py-0.5 text-micro font-medium",
              timeWindow === item.key
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TaskSummaryCard({
  task,
  fallbackTitle,
  stats,
  colorClass,
  selected,
  onSelect,
}: {
  task: DynamicsTaskFacet;
  fallbackTitle: string;
  stats: ReturnType<typeof taskEventStats>;
  colorClass: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useT("archive");
  const { getActorName } = useActorName();
  const title = displayTaskTitle(task.title, fallbackTitle);
  const agentName = task.agent ? getActorName("agent", task.agent) : "";
  const pct =
    task.status === "completed" || task.status === "done"
      ? 100
      : task.status === "failed" || task.status === "stalled"
        ? 35
        : task.status === "queued" || task.status === "pending"
          ? 0
          : 60;
  const tone =
    task.status === "failed" || task.status === "stalled"
      ? "border-destructive/40"
      : selected
        ? "border-primary/50 bg-primary/5"
        : "border-border/60";

  return (
    <button
      type="button"
      data-testid="dynamics-task-card"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn("w-full rounded-md border px-2.5 py-2 text-left", tone)}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn("rounded px-1 py-0.5 text-[10px] font-semibold text-white", colorClass)}>
          {truncateLabel(title, 4)}
        </span>
        <span className="min-w-0 flex-1 truncate text-caption font-medium">{title}</span>
        <span className="shrink-0 text-micro text-muted-foreground">
          <DynamicsStatusLabel status={task.status} />
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-2 text-micro text-muted-foreground">
        <span>{t(($) => $.dynamics.conversation_n, { n: stats.conversation })}</span>
        <span>{t(($) => $.dynamics.progress_n, { n: stats.progress })}</span>
        <span>{t(($) => $.dynamics.artifact_n, { n: stats.artifact })}</span>
        <span className="truncate">{agentName || "—"}</span>
      </div>
      {stats.latest && (
        <div className="mt-1 truncate text-micro text-muted-foreground">
          {`${t(($) => $.dynamics.latest)}：${stats.latest.content || t(($) => $.dynamics.event_no_content)}`}
        </div>
      )}
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", colorClass)} style={{ width: `${pct}%` }} />
      </div>
    </button>
  );
}

function DayGroup({
  day,
  issueId,
  projectId,
  taskColorMap,
  taskMap,
  onOpenAcceptance,
  onFocusTask,
}: {
  day: DynamicsDay;
  issueId: string;
  projectId?: string | null;
  taskColorMap: Map<string, number>;
  taskMap: DynamicsTaskFacet[];
  onOpenAcceptance?: () => void;
  onFocusTask: (id: string) => void;
}) {
  const { t } = useT("archive");
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-caption font-semibold text-foreground">
          {formatDayLabel(day.date, t(($) => $.dynamics.day_today))}
        </span>
        <span className="h-px flex-1 bg-border" />
        <span className="text-micro tabular-nums text-muted-foreground">
          {t(($) => $.dynamics.day_event_count, { n: day.events.length })}
        </span>
      </div>
      <div className="space-y-1">
        {day.events.map((event) => (
          <EventRow
            key={event.id}
            event={event}
            issueId={issueId}
            projectId={projectId}
            taskColorMap={taskColorMap}
            taskMap={taskMap}
            onOpenAcceptance={onOpenAcceptance}
            onFocusTask={onFocusTask}
          />
        ))}
      </div>
    </div>
  );
}

function EventRow({
  event,
  issueId,
  projectId,
  taskColorMap,
  taskMap,
  onOpenAcceptance,
  onFocusTask,
}: {
  event: DynamicsEvent;
  issueId: string;
  projectId?: string | null;
  taskColorMap: Map<string, number>;
  taskMap: DynamicsTaskFacet[];
  onOpenAcceptance?: () => void;
  onFocusTask: (id: string) => void;
}) {
  const { t } = useT("archive");
  const paths = useWorkspacePaths();
  const colorIdx = event.task_id ? (taskColorMap.get(event.task_id) ?? 0) : 0;
  const dotColor = TASK_COLORS[colorIdx % TASK_COLORS.length] ?? "bg-blue-500";
  const taskTitle = event.task_id
    ? taskMap.find((task) => task.id === event.task_id)?.title
    : null;
  const looksAcceptance =
    event.type === "status" && /验收|acceptance/i.test(event.content);

  return (
    <div className="group flex items-start gap-2 rounded px-2 py-1.5 transition-colors hover:bg-accent/30">
      <span className="mt-0.5 w-14 shrink-0 font-mono text-micro tabular-nums text-muted-foreground">
        {formatTime(event.ts)}
      </span>
      <span className="mt-1.5 flex shrink-0 flex-col items-center gap-0.5">
        <span className={cn("size-2 rounded-full", dotColor)} />
        <span className="h-full w-px bg-border/50" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {taskTitle && event.task_id && (
            <button
              type="button"
              onClick={() => onFocusTask(event.task_id!)}
              className={cn(
                "inline-flex items-center rounded px-1 py-0.5 text-micro font-semibold text-white",
                dotColor,
              )}
            >
              {taskTitle.length > 12 ? `${taskTitle.slice(0, 12)}…` : taskTitle}
            </button>
          )}
          <EventTypeBadge type={event.type} />
          {event.type === "conversation" ? (
            <ConversationBubble event={event} />
          ) : (
            <span className="text-caption text-foreground">
              {event.content || t(($) => $.dynamics.event_no_content)}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {event.run_id && (
            <AppLink href={paths.issueExecLog(issueId, event.run_id)}>
              <span className="text-micro text-primary hover:underline">
                {t(($) => $.dynamics.open_exec)} →
              </span>
            </AppLink>
          )}
          {event.task_id && (
            <AppLink href={paths.issueDetail(issueId)}>
              <span className="text-micro text-primary hover:underline">
                {t(($) => $.dynamics.open_task)} →
              </span>
            </AppLink>
          )}
          {event.type === "artifact" && projectId && (
            <>
              <AppLink href={paths.projectView(projectId, "deliverables")}>
                <span className="text-micro text-primary hover:underline">
                  {t(($) => $.dynamics.open_deliverables)} →
                </span>
              </AppLink>
              <AppLink href={paths.projectView(projectId, "archive")}>
                <span className="text-micro text-primary hover:underline">
                  {t(($) => $.dynamics.open_archive)} →
                </span>
              </AppLink>
            </>
          )}
          {looksAcceptance && onOpenAcceptance && (
            <button
              type="button"
              className="text-micro text-primary hover:underline"
              onClick={onOpenAcceptance}
            >
              {t(($) => $.dynamics.open_acceptance)} →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EventTypeBadge({ type }: { type: DynamicsEventType }) {
  const { t } = useT("archive");
  const config: Record<DynamicsEventType, { label: string; className: string }> = {
    conversation: {
      label: t(($) => $.dynamics.type_conversation),
      className: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    },
    progress: {
      label: t(($) => $.dynamics.type_progress),
      className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    },
    status: {
      label: t(($) => $.dynamics.type_status),
      className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    },
    artifact: {
      label: t(($) => $.dynamics.type_artifact),
      className: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    },
  };
  const item = config[type];
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-micro font-medium", item.className)}>
      {item.label}
    </span>
  );
}

function ConversationBubble({ event }: { event: DynamicsEvent }) {
  const { t } = useT("archive");
  if (event.actor === "tool") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-2 py-0.5 font-mono text-micro text-muted-foreground">
        {event.tool_name && <span className="font-semibold">{event.tool_name}</span>}
        {event.content && <span className="max-w-[200px] truncate">{event.content}</span>}
      </span>
    );
  }
  if (event.actor === "user") {
    return (
      <span className="inline-flex items-start gap-1.5 rounded-lg rounded-tl-none bg-primary/10 px-2 py-1 text-caption text-foreground">
        <span className="shrink-0 text-micro font-semibold text-primary">
          {t(($) => $.dynamics.actor_user)}
        </span>
        <span className="line-clamp-2">{event.content}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-start gap-1.5 rounded-lg rounded-tr-none bg-accent/60 px-2 py-1 text-caption text-foreground">
      <span className="shrink-0 text-micro font-semibold text-muted-foreground">
        {event.actor_name ? event.actor_name.slice(0, 12) : t(($) => $.dynamics.actor_agent)}
      </span>
      <span className="line-clamp-2">{event.content}</span>
    </span>
  );
}

function TypeDistribution({
  counts,
}: {
  counts: Record<DynamicsEventType, number>;
}) {
  const { t } = useT("archive");
  const total = Math.max(1, Object.values(counts).reduce((sum, n) => sum + n, 0));
  const rows: { key: DynamicsEventType; label: string; color: string }[] = [
    { key: "conversation", label: t(($) => $.dynamics.type_conversation), color: "bg-blue-500" },
    { key: "progress", label: t(($) => $.dynamics.type_progress), color: "bg-emerald-500" },
    { key: "status", label: t(($) => $.dynamics.type_status), color: "bg-amber-500" },
    { key: "artifact", label: t(($) => $.dynamics.type_artifact), color: "bg-violet-500" },
  ];
  return (
    <div className="rounded-lg border bg-card/30 px-3 py-2.5">
      <div className="mb-2 text-caption font-medium">
        {t(($) => $.dynamics.distribution)}
      </div>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-micro text-muted-foreground">{row.label}</span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", row.color)}
                style={{ width: `${(counts[row.key] / total) * 100}%` }}
              />
            </div>
            <span className="w-6 shrink-0 text-right text-micro tabular-nums">
              {counts[row.key]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatDayLabel(dateStr: string, todayLabel: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr === today) return todayLabel;
  if (dateStr.length >= 10) return dateStr.slice(5);
  return dateStr;
}

function formatTime(iso: string): string {
  if (!iso) return "--:--";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "--:--";
  return parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
