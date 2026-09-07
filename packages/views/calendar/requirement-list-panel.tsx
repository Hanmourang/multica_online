"use client";

/**
 * RequirementListPanel — 项目维度需求列表（spec §4b 需求详情 TAB）。
 * 卡片：编号/标题/时间窗/派生状态徽标（10 态中文字面量，服务端投影）；
 * 点击开 RequirementDrawer。与 CalendarPage 同一过滤语义：仅顶层需求、
 * 需有排期或派生状态——列表场景的 requirement_status 析取项不是死代码：
 * 无排期但有派生状态的需求在日历上不渲染（无格子可放），在列表里正常成卡。
 */
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { calendarIssuesOptions } from "@multica/core/issues/queries";
import { useModalStore } from "@multica/core/modals";
import { useT } from "../i18n";
import { RequirementDrawer } from "./requirement-drawer";
import { useRequirementWorkbench } from "./use-requirement-workbench";
import { Button } from "@multica/ui/components/ui/button";
import { Plus } from "lucide-react";
import { ProgressRing } from "../issues/components/progress-ring";
import { parseStageProgress, stageForRequirementStatus } from "./calendar-helpers";
import { isTopLevelRequirement } from "../projects/components/requirements/requirement-helpers";

export function RequirementListPanel({ projectId }: { projectId: string }) {
  const wsId = useWorkspaceId();
  const { issueId: drawerIssueId, open, close } = useRequirementWorkbench();
  const { t } = useT("calendar");
  // isPending 区分「加载中」与「真空」：查询 pending 期间不闪空态文案。
  // isError 同理区分「失败」与「真空」（spec §5：toast + 重试）。
  const {
    data: issues = [],
    isPending,
    isError,
    refetch,
  } = useQuery(calendarIssuesOptions(wsId));
  useEffect(() => {
    if (isError) toast.error(t(($) => $.list.load_failed));
  }, [isError, t]);

  const requirements = useMemo(
    () =>
      issues
        .filter(
          (i) =>
            i.project_id === projectId &&
            isTopLevelRequirement(i) &&
            (i.start_at || i.due_date || i.requirement_status),
        )
        .sort((a, b) => (a.start_at ?? "").localeCompare(b.start_at ?? "")),
    [issues, projectId],
  );

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-caption text-destructive">
        <p>{t(($) => $.list.load_failed)}</p>
        <button
          type="button"
          className="rounded-md border border-surface-border px-2 py-1 text-foreground hover:bg-muted/50"
          onClick={() => refetch()}
        >
          {t(($) => $.list.retry)}
        </button>
      </div>
    );
  }

  if (requirements.length === 0) {
    if (isPending) return null;
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <p className="text-center text-caption text-muted-foreground">
          {t(($) => $.list.empty)}
        </p>
        <Button
          size="sm"
          data-testid="list-new-requirement"
          onClick={() =>
            useModalStore.getState().open("create-issue", {
              project_id: projectId,
              source: "calendar",
            })
          }
        >
          <Plus className="h-3.5 w-3.5" /> {t(($) => $.page.new_requirement)}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          size="sm"
          data-testid="list-new-requirement"
          onClick={() =>
            useModalStore.getState().open("create-issue", {
              project_id: projectId,
              source: "calendar",
            })
          }
        >
          <Plus className="h-3.5 w-3.5" /> {t(($) => $.page.new_requirement)}
        </Button>
      </div>
      {requirements.map((r) => {
        const parsed = parseStageProgress(r.stage_progress);
        return (
        <button
          key={r.id}
          type="button"
          onClick={() => {
            open(r.id, stageForRequirementStatus(r.requirement_status));
          }}
          className="flex w-full items-center gap-3 rounded-lg border border-surface-border px-3 py-2 text-left hover:bg-muted/50"
        >
          <span className="text-caption text-muted-foreground">#{r.number}</span>
          <span className="min-w-0 flex-1 truncate text-body">{r.title}</span>
          <span className="text-caption text-muted-foreground">
            {r.start_at?.slice(0, 10) ?? "—"} ~ {r.due_date ?? "—"}
          </span>
          {(parsed || r.stage_progress) && (
            <span className="flex items-center gap-1 text-caption text-muted-foreground">
              {parsed && <ProgressRing done={parsed.done} total={parsed.total} />}
              {r.stage_progress}
            </span>
          )}
          {r.requirement_status && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-caption">
              {r.requirement_status}
            </span>
          )}
        </button>
        );
      })}
      <RequirementDrawer
        issueId={drawerIssueId}
        // requirement_status 是列表端投影列，GetIssue 不返回——徽标由本列
        // 表数据供给（同 CalendarPage 的接线约定）。
        statusBadge={
          issues.find((i) => i.id === drawerIssueId)?.requirement_status
        }
        initialViewedStage={stageForRequirementStatus(
          issues.find((i) => i.id === drawerIssueId)?.requirement_status,
        )}
        onOpenChange={(isOpen) => {
          if (!isOpen) close();
        }}
      />
    </div>
  );
}
