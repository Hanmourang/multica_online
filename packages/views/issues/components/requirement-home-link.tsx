"use client";

import { Home } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { calendarIssuesOptions } from "@multica/core/issues/queries";
import type { Issue } from "@multica/core/types";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { useProjectTaskTrackingId } from "./project-task-tracking-context";

const LINK_CLASS =
  "mt-1 inline-flex max-w-full items-center gap-1 text-micro text-muted-foreground hover:text-primary";

/** C7 卡片「需求归属」：仅项目任务追踪面显示，跳 C6。 */
export function RequirementHomeLink({
  issue,
  asLink = true,
}: {
  issue: Issue;
  /**
   * 卡片整体已经包在指向详情的 `<AppLink>` 里时传 `false`：HTML 不允许
   * `<a>` 嵌 `<a>`（React 会因此报 hydration 错误）。此时退化成
   * `role="link"` 的 span——点击与键盘 Enter/Space 走同一条路由，只是不再
   * 具备右键/中键开新标签页的原生能力，那本来就属于外层卡片链接。
   */
  asLink?: boolean;
}) {
  const projectId = useProjectTaskTrackingId();
  const { t } = useT("issues");
  const paths = useWorkspacePaths();
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
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

  const href = paths.projectRequirement(projectId, reqId);
  const content = (
    <>
      <Home className="size-3 shrink-0" aria-hidden />
      <span className="truncate font-mono">
        {t(($) => $.card.requirement_home, { id: label })}
      </span>
    </>
  );

  if (asLink) {
    return (
      <AppLink
        href={href}
        className={LINK_CLASS}
        onClick={(event) => event.stopPropagation()}
        data-testid="requirement-home-link"
      >
        {content}
      </AppLink>
    );
  }

  return (
    <span
      role="link"
      tabIndex={0}
      className={`${LINK_CLASS} cursor-pointer`}
      onClick={(event) => {
        // 外层卡片链接就在冒泡路径上：取消它的跳转，改由这里接管。
        event.preventDefault();
        event.stopPropagation();
        navigation.push(href);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        navigation.push(href);
      }}
      data-testid="requirement-home-link"
    >
      {content}
    </span>
  );
}
