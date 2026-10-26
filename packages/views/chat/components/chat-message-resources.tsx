"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, LockKeyhole } from "lucide-react";
import type { Agent, AssetBinding, ChatMessage, ChatMessageResource, IssueAssigneeType, MemberWithUser, Squad } from "@multica/core/types";
import { formatDateOnly } from "@multica/core/issues/date";
import { useWorkspacePaths } from "@multica/core/paths";
import { useWorkspaceId } from "@multica/core/hooks";
import { childIssueProgressOptions, childIssuesOptions, issueDetailOptions } from "@multica/core/issues/queries";
import { projectListOptions } from "@multica/core/projects/queries";
import { agentListOptions, memberListOptions, squadListOptions } from "@multica/core/workspace/queries";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../../navigation";
import { AssetPreviewDialog } from "../../projects/components/assets/components/asset-preview-dialog";
import { formatBytes, formatTimestamp } from "../../projects/components/archive/query-states";
import { useStatusLabel } from "../../issues/utils/status-label";
import { priorityLabel } from "../../issues/utils/priority-label";
import { useLocale, useT } from "../../i18n";
import { chatResourceDraftKey, chatResourceMark } from "./chat-resource-drafts";

export function ChatMessageResources({ message }: { message: ChatMessage }) {
  const { t } = useT("chat");
  const [preview, setPreview] = useState<ChatMessageResource | null>(null);

  if (!message.resources && message.has_resources) {
    return (
      <div className="mt-2 flex items-center gap-2 text-caption text-muted-foreground" aria-live="polite">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <span>{t(($) => $.resources.loading_card)}</span>
      </div>
    );
  }
  if (!message.resources?.length) return null;

  const previewBinding = preview ? assetBindingFor(preview) : null;
  return (
    <div className="mt-2 grid w-full gap-2">
      {message.resources.map((resource) => (
        <ResourceCard
          key={chatResourceDraftKey(resource)}
          resource={resource}
          onPreview={() => setPreview(resource)}
        />
      ))}
      {previewBinding && (
        <AssetPreviewDialog
          projectId={previewBinding.project_id}
          bindings={[previewBinding]}
          index={0}
          onIndexChange={() => undefined}
          open
          onOpenChange={(open) => {
            if (!open) setPreview(null);
          }}
        />
      )}
    </div>
  );
}

function ResourceCard({
  resource,
  onPreview,
}: {
  resource: ChatMessageResource;
  onPreview: () => void;
}) {
  const { t } = useT("chat");
  if (resource.access !== "granted") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-3 py-2.5 text-caption text-muted-foreground">
        <LockKeyhole className="size-4 shrink-0" />
        {resource.access === "denied"
          ? resource.type === "issue"
            ? resource.kind === "requirement"
              ? t(($) => $.resources.denied_requirement)
              : t(($) => $.resources.denied_task)
            : t(($) => $.resources.denied_document)
          : resource.type === "issue"
            ? resource.kind === "requirement"
              ? t(($) => $.resources.missing_requirement)
              : t(($) => $.resources.missing_task)
            : t(($) => $.resources.missing_document)}
      </div>
    );
  }
  if (resource.type === "issue") {
    return <IssueResourceCard resource={resource} />;
  }

  return <DocumentResourceCard resource={resource} onPreview={onPreview} />;
}

function DocumentResourceCard({
  resource,
  onPreview,
}: {
  resource: ChatMessageResource;
  onPreview: () => void;
}) {
  const { t } = useT("chat");
  const paths = useWorkspacePaths();
  const wsId = useWorkspaceId();
  const artifact = resource.artifact;
  const attachment = resource.attachment;
  const projectId = resource.project_id || artifact?.project_id || "";
  const projectsQuery = useQuery({
    ...projectListOptions(wsId),
    enabled: Boolean(wsId && projectId),
  });
  const title = documentTitle(resource);
  if (!title) return <UnavailableResource />;

  const fileType = chatResourceMark(resource);
  const size = artifact?.size_bytes ?? attachment?.size_bytes;
  const updatedAt = artifact?.updated_at || attachment?.created_at;
  const project = projectsQuery.data?.find((item) => item.id === projectId)?.title;
  const detailsHref = projectId
    ? paths.projectView(projectId, "assets")
    : attachment?.issue_id
      ? paths.issueDetail(attachment.issue_id)
      : paths.assets();
  return (
    <article className="relative overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-xs before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-violet-500">
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2.5 px-3 py-3 pl-3.5">
        <span className="flex size-9 items-center justify-center rounded-lg bg-violet-500/10 font-mono text-[10px] font-extrabold text-violet-700">
          {fileType === "DOC" ? <FileText className="size-4" /> : fileType}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-micro text-muted-foreground">
            <span>{t(($) => $.resources.document)}</span>
          </div>
          <div className="mt-1 truncate text-caption font-semibold text-foreground" title={title}>{title}</div>
          <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-micro text-muted-foreground">
            {project && <span>{project}</span>}
            {size != null && size > 0 && <span>{formatBytes(size)}</span>}
            {updatedAt && <time dateTime={updatedAt}>{formatTimestamp(updatedAt)}</time>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <button
          type="button"
          aria-label={t(($) => $.resources.open_document)}
          onClick={onPreview}
          className="rounded-md border border-border px-2 py-0.5 text-micro font-medium text-foreground transition-colors hover:bg-muted"
        >
          {t(($) => $.resources.open_document)}
        </button>
        <AppLink
          href={detailsHref}
          className="ml-auto rounded-md px-2 py-0.5 text-micro font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t(($) => $.resources.open_details)}
        </AppLink>
      </div>
    </article>
  );
}

function plainExcerpt(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function IssueFact({ label, children }: { label: string; children: string }) {
  if (!children) return null;
  return (
    <div className="min-w-0">
      <div className="text-[10px] leading-4 text-current/70">{label}</div>
      <div className="truncate text-micro font-medium">{children}</div>
    </div>
  );
}

function IssueResourceCard({ resource }: { resource: ChatMessageResource }) {
  const paths = useWorkspacePaths();
  const wsId = useWorkspaceId();
  const locale = useLocale();
  const { t } = useT("chat");
  const { t: tIssues } = useT("issues");
  const statusLabel = useStatusLabel(wsId);
  const snapshot = resource.issue;
  const detailQuery = useQuery({
    ...issueDetailOptions(wsId, resource.id),
    enabled: Boolean(wsId && snapshot),
  });
  const progressQuery = useQuery({
    ...childIssueProgressOptions(wsId),
    enabled: Boolean(wsId && snapshot),
  });
  const actorTypes = [snapshot?.assignee_type, snapshot?.creator_type, detailQuery.data?.assignee_type, detailQuery.data?.creator_type];
  const membersQuery = useQuery({
    ...memberListOptions(wsId),
    enabled: Boolean(wsId && actorTypes.includes("member")),
  });
  const agentsQuery = useQuery({
    ...agentListOptions(wsId),
    enabled: Boolean(wsId && actorTypes.includes("agent")),
  });
  const squadsQuery = useQuery({
    ...squadListOptions(wsId),
    enabled: Boolean(wsId && actorTypes.includes("squad")),
  });
  const childrenQuery = useQuery({
    ...childIssuesOptions(wsId, resource.id),
    enabled: Boolean(wsId && snapshot),
  });
  const projectsQuery = useQuery({
    ...projectListOptions(wsId),
    enabled: Boolean(wsId && (detailQuery.data?.project_id ?? snapshot?.project_id)),
  });
  if (!snapshot) return <UnavailableResource />;

  // Detail/write responses may omit list-derived requirement fields, so an
  // omitted live value must not erase the already-authorized send snapshot.
  const live = detailQuery.data;
  const issue = {
    ...snapshot,
    ...live,
    goal: live?.goal ?? snapshot.goal,
    requirement_status: live?.requirement_status ?? snapshot.requirement_status,
    stage_progress: live?.stage_progress ?? snapshot.stage_progress,
  };
  const isRequirement = resource.kind === "requirement";
  const mark = chatResourceMark(resource);
  const assignee = actorName(issue.assignee_type, issue.assignee_id, membersQuery.data, agentsQuery.data, squadsQuery.data)
    || t(($) => $.resources.unassigned);
  const creator = actorName(issue.creator_type, issue.creator_id, membersQuery.data, agentsQuery.data, squadsQuery.data);
  const project = projectsQuery.data?.find((item) => item.id === issue.project_id)?.title;
  const progress = progressQuery.data?.get(issue.id);
  const progressRatio = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : null;
  const statusText = isRequirement
    ? issue.requirement_status || statusLabel(issue.status)
    : statusLabel(issue.status);
  const excerpt = plainExcerpt(issue.description);
  const startLabel = formatDateOnly(issue.start_date, { year: "numeric", month: "short", day: "numeric" }, locale);
  const dueLabel = formatDateOnly(issue.due_date, { year: "numeric", month: "short", day: "numeric" }, locale);
  const priorityText = issue.priority ? priorityLabel(issue.priority, tIssues) : "";
  const labels = issue.labels ?? [];
  const children = childrenQuery.data ?? [];
  const visibleChildren = children.slice(0, 4);
  return (
    <article
      className={cn(
        "relative w-full min-w-[20rem] overflow-hidden rounded-xl border text-foreground shadow-xs before:absolute before:inset-y-0 before:left-0 before:w-1",
        isRequirement
          ? "border-sky-200/90 bg-sky-50 text-sky-950 before:bg-sky-400 dark:border-sky-800/60 dark:bg-sky-950/35 dark:text-sky-50"
          : "border-amber-200/90 bg-amber-50 text-amber-950 before:bg-amber-400 dark:border-amber-800/60 dark:bg-amber-950/35 dark:text-amber-50",
      )}
      aria-busy={detailQuery.isPending}
    >
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2.5 px-3 py-3 pl-4">
        <span
          className={cn(
            "flex size-9 items-center justify-center rounded-lg font-mono text-[10px] font-extrabold",
            isRequirement ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700",
          )}
        >
          {mark}
        </span>
        <div className="min-w-0">
        <AppLink href={paths.issueDetail(issue.id)} className="block min-w-0">
          <div className="flex items-center gap-2 text-micro">
            <span className="opacity-70">
              {isRequirement
                ? t(($) => $.resources.requirement)
                : t(($) => $.resources.task)}
            </span>
            <span className="font-mono opacity-70">{issue.identifier}</span>
            <span
              className={cn(
                "ml-auto shrink-0 rounded-md px-1.5 py-0.5 font-medium",
                isRequirement ? "bg-sky-100 text-sky-800" : "bg-amber-100 text-amber-800",
              )}
            >
              {statusText}
            </span>
          </div>
          <div className="mt-1 text-caption font-semibold">{issue.title}</div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
            {isRequirement && issue.stage_progress && (
              <div className="min-w-0">
                <div className="text-[10px] leading-4 opacity-70">{t(($) => $.resources.stage)}</div>
                <div className="truncate text-micro font-medium">{issue.stage_progress}</div>
              </div>
            )}
            {priorityText && (
              <IssueFact label={t(($) => $.resources.priority)}>{priorityText}</IssueFact>
            )}
            <IssueFact label={t(($) => $.resources.assignee)}>{assignee}</IssueFact>
            {creator && (
              <IssueFact label={t(($) => $.resources.creator)}>{creator}</IssueFact>
            )}
            {project && (
              <IssueFact label={t(($) => $.resources.project)}>{project}</IssueFact>
            )}
            {startLabel && (
              <IssueFact label={t(($) => $.resources.start)}>{startLabel}</IssueFact>
            )}
            {dueLabel && (
              <IssueFact label={t(($) => $.resources.due)}>{dueLabel}</IssueFact>
            )}
            {progress && progress.total > 0 && (
              <div className="min-w-0">
                <div className="text-[10px] leading-4 opacity-70">{t(($) => $.resources.subtask_progress)}</div>
                <div className="truncate text-micro font-medium">{progress.done}/{progress.total}</div>
              </div>
            )}
          </div>
          {isRequirement && issue.goal && (
            <div className="mt-2 line-clamp-3 rounded-lg bg-white/70 px-2.5 py-1.5 text-micro leading-relaxed">
              <span className="mr-1 font-medium">{t(($) => $.resources.goal)}</span>
              <span>{issue.goal}</span>
            </div>
          )}
          {excerpt && (
            <p className="mt-2 line-clamp-4 text-micro leading-relaxed opacity-80">{excerpt}</p>
          )}
          {labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {labels.slice(0, 6).map((label) => (
                <span
                  key={label.id}
                  className="rounded-md bg-white/80 px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ color: label.color }}
                >
                  {label.name}
                </span>
              ))}
            </div>
          )}
          {progressRatio != null && (
            <div className={cn("mt-2 h-1 overflow-hidden rounded-full", isRequirement ? "bg-sky-100" : "bg-amber-100")} aria-hidden>
              <div
                className={cn("h-full rounded-full", isRequirement ? "bg-sky-400" : "bg-amber-400")}
                style={{ width: `${progressRatio}%` }}
              />
            </div>
          )}
        </AppLink>
        {visibleChildren.length > 0 && (
          <div className="mt-2">
            <div className="text-[10px] leading-4 opacity-70">{t(($) => $.resources.children)}</div>
            <ul className="mt-1 grid gap-1">
              {visibleChildren.map((child) => (
                <li key={child.id}>
                  <AppLink href={paths.issueDetail(child.id)} className="flex min-w-0 items-center gap-1.5 text-micro">
                    <span className="shrink-0 rounded bg-white/70 px-1 py-0.5 text-[10px]">{statusLabel(child.status)}</span>
                    <span className="shrink-0 font-mono opacity-70">{child.identifier}</span>
                    <span className="truncate font-medium">{child.title}</span>
                  </AppLink>
                </li>
              ))}
            </ul>
            {children.length > visibleChildren.length && (
              <div className="mt-1 text-[10px] opacity-70">
                {t(($) => $.resources.more_children, { count: children.length - visibleChildren.length })}
              </div>
            )}
          </div>
        )}
        </div>
      </div>
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 border-t px-3 py-2 text-micro",
          isRequirement ? "border-sky-200/80" : "border-amber-200/80",
        )}
      >
        {issue.updated_at && (
          <time className="opacity-70" dateTime={issue.updated_at}>{formatTimestamp(issue.updated_at)}</time>
        )}
        <AppLink
          href={paths.issueDetail(issue.id)}
          className={cn(
            "ml-auto rounded-md border bg-white/80 px-2 py-0.5 font-medium transition-colors hover:bg-white",
            isRequirement ? "border-sky-200 text-sky-800" : "border-amber-200 text-amber-800",
          )}
        >
          {t(($) => $.resources.open_details)}
        </AppLink>
        {detailQuery.isError && (
          <button
            type="button"
            className="font-medium underline-offset-2 hover:underline"
            onClick={() => void detailQuery.refetch()}
          >
            {t(($) => $.resources.retry)}
          </button>
        )}
      </div>
    </article>
  );
}

function UnavailableResource() {
  const { t } = useT("chat");
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/30 px-3 py-2.5 text-caption text-muted-foreground">
      {t(($) => $.resources.unavailable)}
    </div>
  );
}

function actorName(
  type: IssueAssigneeType | null | undefined,
  id: string | null | undefined,
  members: MemberWithUser[] | undefined,
  agents: Agent[] | undefined,
  squads: Squad[] | undefined,
): string | undefined {
  if (!type || !id) return undefined;
  if (type === "member") return members?.find((member) => member.user_id === id)?.name;
  if (type === "agent") return agents?.find((agent) => agent.id === id)?.name;
  if (type === "squad") return squads?.find((squad) => squad.id === id)?.name;
  return undefined;
}

function documentTitle(resource: ChatMessageResource): string {
  return resource.artifact?.rel_path || resource.attachment?.filename || resource.title || "";
}

function assetBindingFor(resource: ChatMessageResource): AssetBinding | null {
  if (resource.type !== "document" || resource.access !== "granted") return null;
  const artifact = resource.artifact;
  const attachment = resource.attachment;
  const title = documentTitle(resource);
  if (!title || !resource.id) return null;
  return {
    id: `chat-resource-${resource.id}`,
    workspace_id: artifact?.workspace_id || attachment?.workspace_id || "",
    project_id: resource.project_id || artifact?.project_id || "",
    issue_id: artifact?.issue_id || attachment?.issue_id || null,
    asset_category: "other",
    external_ref: resource.source === "artifact"
      ? { artifact_id: resource.id, rel_path: title }
      : { attachment_id: resource.id, filename: title },
    asset_name: title,
    asset_subtype: "document",
    source: "chat",
    recommended: false,
    created_by_type: "member",
    created_by_id: "",
    created_at: artifact?.created_at || attachment?.created_at || "",
  };
}
