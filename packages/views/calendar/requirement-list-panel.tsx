"use client";

/**
 * RequirementListPanel — 项目维度需求列表（spec §4b 需求详情 TAB）。
 * 卡片：编号/标题/时间窗/派生状态徽标（10 态中文字面量，服务端投影）；
 * 点击开 RequirementDrawer。与 CalendarPage 同一过滤语义：仅顶层需求、
 * 需有排期或派生状态——列表场景的 requirement_status 析取项不是死代码：
 * 无排期但有派生状态的需求在日历上不渲染（无格子可放），在列表里正常成卡。
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueListOptions } from "@multica/core/issues/queries";
import { useT } from "../i18n";
import { RequirementDrawer } from "./requirement-drawer";

export function RequirementListPanel({ projectId }: { projectId: string }) {
  const wsId = useWorkspaceId();
  const { t } = useT("calendar");
  // isPending 区分「加载中」与「真空」：查询 pending 期间不闪空态文案。
  const { data: issues = [], isPending } = useQuery(issueListOptions(wsId));
  const [drawerIssueId, setDrawerIssueId] = useState<string | null>(null);

  const requirements = useMemo(
    () =>
      issues
        .filter(
          (i) =>
            i.project_id === projectId &&
            !i.parent_issue_id &&
            (i.start_at || i.due_date || i.requirement_status),
        )
        .sort((a, b) => (a.start_at ?? "").localeCompare(b.start_at ?? "")),
    [issues, projectId],
  );

  if (requirements.length === 0) {
    if (isPending) return null;
    return (
      <p className="py-8 text-center text-caption text-muted-foreground">
        {t(($) => $.list.empty)}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {requirements.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => setDrawerIssueId(r.id)}
          className="flex w-full items-center gap-3 rounded-lg border border-surface-border px-3 py-2 text-left hover:bg-muted/50"
        >
          <span className="text-caption text-muted-foreground">#{r.number}</span>
          <span className="min-w-0 flex-1 truncate text-body">{r.title}</span>
          <span className="text-caption text-muted-foreground">
            {r.start_at?.slice(0, 10) ?? "—"} ~ {r.due_date ?? "—"}
          </span>
          {r.requirement_status && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-caption">
              {r.requirement_status}
            </span>
          )}
        </button>
      ))}
      <RequirementDrawer
        issueId={drawerIssueId}
        // requirement_status 是列表端投影列，GetIssue 不返回——徽标由本列
        // 表数据供给（同 CalendarPage 的接线约定）。
        statusBadge={
          issues.find((i) => i.id === drawerIssueId)?.requirement_status
        }
        onOpenChange={(open) => !open && setDrawerIssueId(null)}
      />
    </div>
  );
}
