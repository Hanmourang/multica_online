"use client";

import type { ReactNode } from "react";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink } from "../navigation";

type ActorMentionType = "member" | "agent" | "squad";

/**
 * @member / @agent / @squad rendered as a real link to that actor's page.
 * AppLink owns plain click, modifier click, and middle click, matching issue
 * and project mention chips. The wrapper keeps the click off surrounding
 * handlers (collapsed comments, message rows).
 */
export function ActorMentionLink({
  type,
  id,
  children,
  newTabTitle,
}: {
  type: ActorMentionType;
  id: string;
  children: ReactNode;
  newTabTitle?: string;
}) {
  const paths = useWorkspacePaths();
  const href =
    type === "member"
      ? paths.memberDetail(id)
      : type === "agent"
        ? paths.agentDetail(id)
        : paths.squadDetail(id);

  return (
    <span className="inline" onClick={(e) => e.stopPropagation()}>
      <AppLink href={href} className="mention" newTabTitle={newTabTitle}>
        {children}
      </AppLink>
    </span>
  );
}
