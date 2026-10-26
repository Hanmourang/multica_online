"use client";

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { SPRINT_STATUSES, type Sprint, type SprintStatus } from "@multica/core/types";
import { useActorName } from "@multica/core/workspace/hooks";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { ActorAvatar } from "../../../common/actor-avatar";
import { ProgressRing } from "../../../issues/components/progress-ring";
import { QueryError, QueryLoading } from "../archive/query-states";
import { SprintStatusBadge, formatRange } from "./sprint-shared";

/**
 * 迭代列表侧边栏（对标 CoCo 迭代页第二列：迭代卡片流 + 搜索 + 状态过滤）。
 *
 * master-detail 的 master：卡片自带 done/total 进度环（ListSprints 的
 * issue_count/done_count 聚合，避免逐迭代调 /progress 的 N+1）与创建者头像，
 * 点击切换右侧详情。数据与过滤态都在编排层（sprint-tab）持有——状态过滤要
 * 回落到服务端查询参数，侧栏只做展示，故这里不碰 query。
 */
export function SprintSidebar({
  sprints,
  total,
  selectedId,
  onSelect,
  statusFilter,
  onStatusFilter,
  isPending,
  isError,
  onRetry,
  onCreate,
}: {
  sprints: Sprint[];
  /** 服务端过滤后的总数（搜索是客户端二次过滤，故空态要区分「被搜索挡住」）。 */
  total: number;
  selectedId: string | null;
  onSelect: (sprintId: string) => void;
  statusFilter: SprintStatus | null;
  onStatusFilter: (status: SprintStatus | null) => void;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  onCreate: () => void;
}) {
  const { t } = useT("sprints");
  const { getActorName } = useActorName();
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sprints;
    return sprints.filter((sprint) =>
      `${sprint.name} ${sprint.goal ?? ""}`.toLowerCase().includes(needle),
    );
  }, [query, sprints]);

  const isEmptyState = !isPending && !isError && visible.length === 0;

  return (
    <aside
      aria-label={t(($) => $.sidebar.list_label)}
      className="flex min-h-0 w-full shrink-0 flex-col gap-2 border-b border-surface-border pb-2 md:w-64 md:border-b-0 md:border-r md:pb-0"
      data-testid="sprint-sidebar"
    >
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-body font-semibold">{t(($) => $.title)}</h2>
        <Button type="button" size="xs" onClick={onCreate}>
          <Plus />
          {t(($) => $.actions.create)}
        </Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t(($) => $.sidebar.search_placeholder)}
          aria-label={t(($) => $.sidebar.search_placeholder)}
          className="pl-7"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1" aria-label={t(($) => $.filter.by_status)}>
        <Button
          type="button"
          size="xs"
          variant={statusFilter === null ? "default" : "outline"}
          aria-pressed={statusFilter === null}
          onClick={() => onStatusFilter(null)}
        >
          {t(($) => $.filter.all)}
        </Button>
        {SPRINT_STATUSES.map((status) => (
          <Button
            key={status}
            type="button"
            size="xs"
            variant={statusFilter === status ? "default" : "outline"}
            aria-pressed={statusFilter === status}
            onClick={() => onStatusFilter(statusFilter === status ? null : status)}
          >
            {t(($) => $.status[status])}
          </Button>
        ))}
      </div>

      {isPending ? (
        <div className="px-1">
          <QueryLoading rows={3} />
        </div>
      ) : isError ? (
        <QueryError onRetry={onRetry} message={t(($) => $.sidebar.load_failed)} />
      ) : isEmptyState ? (
        <div className="rounded-lg border border-surface-border p-4 text-center text-caption text-muted-foreground">
          {query.trim()
            ? t(($) => $.sidebar.no_match_search, { query: query.trim() })
            : statusFilter || total > 0
              ? t(($) => $.empty.no_match)
              : t(($) => $.empty.no_sprints)}
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
          {visible.map((sprint) => (
            <SprintCard
              key={sprint.id}
              sprint={sprint}
              active={sprint.id === selectedId}
              ownerName={getActorName(sprint.created_by_type, sprint.created_by_id)}
              onSelect={() => onSelect(sprint.id)}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function SprintCard({
  sprint,
  active,
  ownerName,
  onSelect,
}: {
  sprint: Sprint;
  active: boolean;
  ownerName: string;
  onSelect: () => void;
}) {
  const { t } = useT("sprints");
  const range = formatRange(sprint.start_date, sprint.end_date);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      data-testid={`sprint-card-${sprint.id}`}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors",
        active
          ? "border-primary/40 bg-surface-selected"
          : "border-surface-border hover:bg-surface-hover",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-caption font-medium" title={sprint.name}>
          {sprint.name}
        </span>
        <SprintStatusBadge sprint={sprint} />
      </span>

      <span className="text-micro text-muted-foreground tabular-nums">
        {range ?? t(($) => $.dates.unscheduled)}
      </span>

      <span className="flex items-center gap-1.5">
        <ProgressRing done={sprint.done_count} total={sprint.issue_count} />
        <span className="text-micro text-muted-foreground tabular-nums">
          {t(($) => $.progress.done, { done: sprint.done_count, total: sprint.issue_count })}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-1 text-micro text-muted-foreground">
          <ActorAvatar
            actorType={sprint.created_by_type}
            actorId={sprint.created_by_id}
            size="xs"
          />
          <span className="max-w-24 truncate" title={ownerName}>
            {ownerName}
          </span>
        </span>
      </span>

      {sprint.goal ? (
        <span className="truncate text-micro text-muted-foreground" title={sprint.goal}>
          {sprint.goal}
        </span>
      ) : null}
    </button>
  );
}
