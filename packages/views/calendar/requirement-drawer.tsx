"use client";

/**
 * RequirementDrawer — 需求五阶段抽屉（spec §3）：
 * 概要头（编号/标题/时间窗/派生状态徽标）+ RequirementFlowSection 复用。
 * 与 issue 详情页共享 issueKeys 缓存；日历页与项目需求 tab 双场景复用。
 */
import { useQuery } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@multica/ui/components/ui/sheet";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  issueDetailOptions,
  childIssuesOptions,
} from "@multica/core/issues/queries";
import { RequirementFlowSection } from "../issues/components/requirement-flow-section";
import { useT } from "../i18n";

export function RequirementDrawer({
  issueId,
  statusBadge,
  onOpenChange,
}: {
  /** 打开中的需求 id；null 时抽屉关闭且不发起任何查询。 */
  issueId: string | null;
  /**
   * 派生状态徽标文案（10 态）。requirement_status 是列表端投影列，
   * GetIssue 不返回——由持有列表数据的宿主（日历页/需求列表）传入。
   */
  statusBadge?: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const wsId = useWorkspaceId();
  const { t } = useT("calendar");
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, issueId ?? ""),
    enabled: !!issueId,
  });
  const { data: childIssues = [] } = useQuery({
    ...childIssuesOptions(wsId, issueId ?? ""),
    enabled: !!issueId,
  });

  return (
    <Sheet open={!!issueId} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        // 宽度覆盖必须与基座 sheet.tsx 同 variant 栈（data-[side=right]），
        // 否则属性选择器特异性 0,2,0 压过单类 0,1,0，覆盖永远不生效。
        className="overflow-y-auto p-4 data-[side=right]:w-[55%] data-[side=right]:min-w-[420px] data-[side=right]:max-w-[760px] data-[side=right]:sm:max-w-[760px]"
      >
        {issue ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className="text-muted-foreground">#{issue.number}</span>
                {issue.title}
                {statusBadge && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-caption font-normal">
                    {statusBadge}
                  </span>
                )}
              </SheetTitle>
              <p className="text-caption text-muted-foreground">
                {issue.start_at ? issue.start_at.slice(0, 16).replace("T", " ") : "—"}
                {" ~ "}
                {issue.due_date ?? "—"}
              </p>
            </SheetHeader>
            <RequirementFlowSection issue={issue} childIssues={childIssues} />
          </>
        ) : (
          <SheetHeader>
            <SheetTitle>{t(($) => $.drawer.loading)}</SheetTitle>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}
