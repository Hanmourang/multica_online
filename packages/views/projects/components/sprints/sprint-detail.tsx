"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Play, Plus, RotateCcw, Square, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueKeys } from "@multica/core/issues/queries";
import type { Issue, Sprint } from "@multica/core/types";
import { sprintProgressOptions } from "@multica/core/sprints/queries";
import {
  useAssignSprintIssues,
  useRemoveSprintIssues,
} from "@multica/core/sprints/mutations";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../../i18n";
import { SprintStatusBadge, formatRange } from "./sprint-shared";

export type SprintTransitionKind = "start" | "complete" | "reopen";

/**
 * 迭代详情（master-detail 的 detail）：头部（名称/状态/区间/容量/目标 + CAS
 * 迁移与编辑删除入口）+ 派生进度条 + 成员与待办池。
 *
 * 列表侧的 issue_count/done_count 是聚合快照，这里仍读 GET /progress 拿精确
 * 口径（含 cancelled 与容量），两块职责不同不合并。
 */
export function SprintDetail({
  projectId,
  sprint,
  busy,
  onEdit,
  onDelete,
  onTransition,
}: {
  projectId: string;
  sprint: Sprint;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onTransition: (kind: SprintTransitionKind) => void;
}) {
  const { t } = useT("sprints");
  const wsId = useWorkspaceId();
  const range = formatRange(sprint.start_date, sprint.end_date);

  const progressQuery = useQuery(sprintProgressOptions(wsId, projectId, sprint.id));
  const progress = progressQuery.data;
  const percent =
    progress && progress.total_count > 0
      ? Math.round((progress.done_count / progress.total_count) * 100)
      : 0;

  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid={`sprint-detail-${sprint.id}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-body font-semibold" title={sprint.name}>
              {sprint.name}
            </h3>
            <SprintStatusBadge sprint={sprint} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground tabular-nums">
            <span>{range ?? t(($) => $.dates.unscheduled)}</span>
            <span>
              {t(($) => $.columns.capacity)}: {sprint.capacity ?? "—"}
            </span>
            <span>
              {t(($) => $.columns.issues)}: {sprint.issue_count}
            </span>
          </div>
          {sprint.goal ? (
            <p className="mt-1 text-caption">
              <span className="text-muted-foreground">{t(($) => $.detail.goal_label)}: </span>
              {sprint.goal}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {sprint.status === "planned" ? (
            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => onTransition("start")}>
              <Play />
              {t(($) => $.actions.start)}
            </Button>
          ) : null}
          {sprint.status === "active" ? (
            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => onTransition("complete")}>
              <Square />
              {t(($) => $.actions.complete)}
            </Button>
          ) : null}
          {sprint.status === "completed" ? (
            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => onTransition("reopen")}>
              <RotateCcw />
              {t(($) => $.actions.reopen)}
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="ghost" aria-label={t(($) => $.actions.edit)} onClick={onEdit}>
            <Pencil />
          </Button>
          {sprint.status === "planned" ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label={t(($) => $.actions.delete)}
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {progress && progress.total_count > 0 ? (
          <>
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
            </div>
            <span className="text-caption text-muted-foreground tabular-nums">
              {t(($) => $.progress.done, { done: progress.done_count, total: progress.total_count })}
            </span>
            {progress.cancelled_count > 0 ? (
              <span className="text-caption text-muted-foreground tabular-nums">
                {t(($) => $.progress.cancelled, { count: progress.cancelled_count })}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-caption text-muted-foreground">{t(($) => $.progress.no_members)}</span>
        )}
      </div>

      <SprintScopePanel projectId={projectId} sprint={sprint} />
    </section>
  );
}

/**
 * 范围面板：成员列表（/api/issues?sprint_id）+ 待办池（项目级结果集内
 * sprint_id 为空的 issue，客户端过滤）勾选纳入。queryKey 挂 issueKeys.all
 * 前缀下——迭代 mutations 会连带 issue 缓存一起失效。
 */
function SprintScopePanel({ projectId, sprint }: { projectId: string; sprint: Sprint }) {
  const { t } = useT("sprints");
  const wsId = useWorkspaceId();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const membersQuery = useQuery({
    queryKey: [...issueKeys.all(wsId), "sprint-members", projectId, sprint.id],
    queryFn: () => api.listIssues({ project_id: projectId, sprint_id: sprint.id, limit: 200 }),
  });
  const backlogQuery = useQuery({
    queryKey: [...issueKeys.all(wsId), "sprint-backlog", projectId],
    queryFn: () => api.listIssues({ project_id: projectId, limit: 200 }),
  });

  const assignMutation = useAssignSprintIssues(projectId);
  const removeMutation = useRemoveSprintIssues(projectId);

  const members = membersQuery.data?.issues ?? [];
  const backlog = useMemo(
    () => (backlogQuery.data?.issues ?? []).filter((issue) => !issue.sprint_id),
    [backlogQuery.data],
  );

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addSelected = async () => {
    try {
      await assignMutation.mutateAsync({ sprintId: sprint.id, issueIds: [...selected] });
      toast.success(t(($) => $.toast.issues_assigned));
      setSelected(new Set());
    } catch (error) {
      const code = (error as { code?: string })?.code;
      toast.error(code === "sprint_completed" ? t(($) => $.errors.sprint_completed) : t(($) => $.errors.assign_failed));
    }
  };

  const removeOne = async (issue: Issue) => {
    try {
      await removeMutation.mutateAsync({ sprintId: sprint.id, issueIds: [issue.id] });
      toast.success(t(($) => $.toast.issues_removed));
    } catch {
      toast.error(t(($) => $.errors.remove_failed));
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid={`sprint-members-${sprint.id}`}>
      {members.length > 0 ? (
        <ul className="divide-y divide-surface-border rounded-md border border-surface-border bg-background">
          {members.map((issue) => (
            <li key={issue.id} className="flex items-center gap-2 px-3 py-1.5">
              <Badge variant="secondary" className="shrink-0 font-normal tabular-nums">
                {issue.identifier}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-caption" title={issue.title}>
                {issue.title}
              </span>
              <span className="shrink-0 text-micro text-muted-foreground">{issue.status}</span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={t(($) => $.actions.remove_issue)}
                disabled={removeMutation.isPending}
                onClick={() => void removeOne(issue)}
              >
                <Undo2 />
                {t(($) => $.actions.remove_issue)}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div>
        <div className="text-caption font-medium">{t(($) => $.backlog.title)}</div>
        <div className="text-micro text-muted-foreground">{t(($) => $.backlog.desc)}</div>
        {backlog.length > 0 ? (
          <>
            <ul className="max-h-56 mt-1 divide-y divide-surface-border overflow-y-auto rounded-md border border-surface-border bg-background">
              {backlog.map((issue) => (
                <li key={issue.id} className="flex items-center gap-2 px-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={selected.has(issue.id)}
                    onChange={() => toggle(issue.id)}
                    aria-label={issue.title}
                  />
                  <Badge variant="secondary" className="shrink-0 font-normal tabular-nums">
                    {issue.identifier}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-caption" title={issue.title}>
                    {issue.title}
                  </span>
                  <span className="shrink-0 text-micro text-muted-foreground">{issue.status}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="button"
                size="xs"
                disabled={selected.size === 0 || assignMutation.isPending || sprint.status === "completed"}
                onClick={() => void addSelected()}
              >
                <Plus />
                {t(($) => $.actions.add_issues)}
              </Button>
              <span className="text-micro text-muted-foreground">{t(($) => $.backlog.add_hint)}</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** 未选中迭代时的引导（侧边栏为空/首屏未点选时占住右侧）。 */
export function SprintDetailPlaceholder() {
  const { t } = useT("sprints");
  return (
    <div
      className="rounded-lg border border-surface-border p-8 text-center text-caption text-muted-foreground"
      data-testid="sprint-detail-placeholder"
    >
      {t(($) => $.detail.select_hint)}
    </div>
  );
}
