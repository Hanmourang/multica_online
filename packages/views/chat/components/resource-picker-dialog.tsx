"use client";

import { useDeferredValue, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { workspaceAssetsOptions } from "@multica/core/assets/queries";
import { projectModulesOptions } from "@multica/core/modules/queries";
import type { ChatMessageResource, Issue, ProjectModule, WorkspaceAssetBinding } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Check, Search } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { formatTimestamp } from "../../projects/components/archive/query-states";
import { useStatusLabel } from "../../issues/utils/status-label";
import { priorityLabel } from "../../issues/utils/priority-label";
import { useT } from "../../i18n";
import { CHAT_RESOURCE_DRAFT_LIMIT, chatModuleResource, chatResourceDraftKey, chatResourceMark } from "./chat-resource-drafts";

export type ResourceTab = "task" | "requirement" | "document" | "module";

export function ResourcePickerDialog({
  open,
  onOpenChange,
  selected,
  onApply,
  projectId,
  initialTab = "task",
  moduleTabEnabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: ChatMessageResource[];
  onApply: (resources: ChatMessageResource[]) => void;
  /** 当前对话挂的项目；「模块」tab 只在有项目时可列。 */
  projectId?: string | null;
  initialTab?: ResourceTab;
  /** FF_MODULE_PROTOTYPE_CHAT 关闭时不渲染「模块」tab（与「+」菜单第 4 组同源）。 */
  moduleTabEnabled?: boolean;
}) {
  const { t } = useT("chat");
  const wsId = useWorkspaceId();
  const [tab, setTab] = useState<ResourceTab>(initialTab);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<ChatMessageResource[]>(selected);
  const deferredQuery = useDeferredValue(query.trim());
  const issueQuery = useQuery({
    queryKey: ["chat-resource-issues", wsId, tab, deferredQuery],
    queryFn: async () => {
      if (tab === "document" || tab === "module") return { issues: [] as Issue[] };
      // Search rejects an empty query. The open picker should still list the
      // workspace's recent tasks or requirements before the user types.
      if (!deferredQuery) {
        const listed = await api.listIssues({
          kind: tab,
          limit: 30,
          sort_by: "updated_at",
          sort_direction: "desc",
        });
        return { issues: listed.issues };
      }
      return api.searchIssues({
        q: deferredQuery,
        kind: tab,
        limit: 30,
        include_closed: true,
      });
    },
    enabled: open && (tab === "task" || tab === "requirement") && Boolean(wsId),
  });
  const documentQuery = useQuery({
    ...workspaceAssetsOptions(wsId, { name: deferredQuery || undefined, pageSize: 50 }),
    enabled: open && tab === "document" && Boolean(wsId),
  });
  const modulesQuery = useQuery({
    ...projectModulesOptions(wsId, projectId ?? ""),
    enabled: open && tab === "module" && Boolean(wsId && projectId),
  });

  useEffect(() => {
    if (open) setPending(selected);
  }, [open, selected]);

  // 重新打开时回到调用方要求的分区（「+」菜单的「模块」入口直接落在模块 tab）。
  // flag 关闭时调用方仍可能带着 "module" 进来，这里降级到 task。
  useEffect(() => {
    if (!open) return;
    setTab(initialTab === "module" && !moduleTabEnabled ? "task" : initialTab);
  }, [open, initialTab, moduleTabEnabled]);

  const pendingKeys = new Set(pending.map(chatResourceDraftKey));
  const issues = tab === "document" || tab === "module" ? [] : issueQuery.data?.issues ?? [];
  const documents = tab === "document" ? documentQuery.data?.items ?? [] : [];
  const moduleItems = tab === "module" ? moduleResources(modulesQuery.data, deferredQuery) : [];
  const loading = tab === "document"
    ? documentQuery.isPending
    : tab === "module"
      ? modulesQuery.isPending
      : issueQuery.isPending;
  const atLimit = pending.length >= CHAT_RESOURCE_DRAFT_LIMIT;

  const toggle = (resource: ChatMessageResource) => {
    const key = chatResourceDraftKey(resource);
    setPending((current) => {
      if (current.some((item) => chatResourceDraftKey(item) === key)) {
        return current.filter((item) => chatResourceDraftKey(item) !== key);
      }
      if (current.length >= CHAT_RESOURCE_DRAFT_LIMIT) return current;
      return [...current, resource];
    });
  };

  const selectIssue = (issue: Issue, kind: "task" | "requirement") => {
    toggle({ type: "issue", id: issue.id, kind, access: "granted", issue });
  };
  const selectDocument = (binding: WorkspaceAssetBinding) => {
    const artifactId = binding.external_ref.artifact_id;
    const attachmentId = binding.external_ref.attachment_id;
    if (typeof artifactId === "string" && artifactId) {
      toggle({
        type: "document",
        id: artifactId,
        source: "artifact",
        project_id: binding.project_id,
        access: "granted",
        title: binding.asset_name,
      });
    } else if (typeof attachmentId === "string" && attachmentId) {
      toggle({
        type: "document",
        id: attachmentId,
        source: "attachment",
        project_id: binding.project_id,
        access: "granted",
        title: binding.asset_name,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(86vh,760px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{t(($) => $.resources.picker_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.resources.picker_description)}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
          <div className="mb-3 flex gap-1.5" role="tablist">
            {(["task", "requirement", "document", "module"] as const)
              .filter((value) => value !== "module" || moduleTabEnabled)
              .map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-caption font-semibold transition-colors",
                    tab === value
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-muted/60 text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setTab(value)}
                >
                  {t(($) => $.resources[value])}
                </button>
              ))}
          </div>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t(($) => $.resources.search_placeholder)}
              className="h-10 rounded-lg border-border bg-muted/40 pl-9"
              aria-label={t(($) => $.resources.search_placeholder)}
            />
          </div>
          <div className="flex min-h-56 flex-1 flex-col gap-1.5 overflow-y-auto" aria-live="polite">
            {tab === "module" && !projectId ? (
              <p className="rounded-lg border border-dashed border-border p-8 text-center text-caption text-muted-foreground">
                {t(($) => $.resources.module_needs_project)}
              </p>
            ) : loading ? (
              <p className="p-6 text-center text-caption text-muted-foreground">{t(($) => $.resources.loading)}</p>
            ) : tab === "module" && modulesQuery.isError ? (
              <button
                type="button"
                className="rounded-lg border border-dashed border-border p-8 text-center text-caption text-muted-foreground"
                onClick={() => void modulesQuery.refetch()}
              >
                {t(($) => $.resources.retry)}
              </button>
            ) : tab === "module" ? (
              moduleItems.length > 0 ? moduleItems.map((ref) => {
                const isSelected = pendingKeys.has(chatResourceDraftKey(ref));
                const meta = [
                  t(($) => $.resources.module),
                  ref.module?.spec_version
                    ? t(($) => $.resources.spec_version, { version: ref.module.spec_version })
                    : t(($) => $.resources.no_spec),
                ].join(" · ");
                return (
                  <ResourceOption
                    key={ref.id}
                    mark={chatResourceMark(ref)}
                    tone="module"
                    title={ref.module?.name ?? ref.id}
                    meta={meta}
                    selected={isSelected}
                    disabled={!isSelected && atLimit}
                    onClick={() => toggle(ref)}
                  />
                );
              }) : (
                <p className="rounded-lg border border-dashed border-border p-8 text-center text-caption text-muted-foreground">
                  {t(($) => $.resources.empty_module)}
                </p>
              )
            ) : tab !== "document" && issueQuery.isError ? (
              <button
                type="button"
                className="rounded-lg border border-dashed border-border p-8 text-center text-caption text-muted-foreground"
                onClick={() => void issueQuery.refetch()}
              >
                {t(($) => $.resources.retry)}
              </button>
            ) : tab === "document" ? (
              documents.length > 0 ? documents.map((binding) => {
                const artifactId = binding.external_ref.artifact_id;
                const attachmentId = binding.external_ref.attachment_id;
                const ref: ChatMessageResource = typeof artifactId === "string" && artifactId
                  ? { type: "document", id: artifactId, source: "artifact", project_id: binding.project_id, access: "granted", title: binding.asset_name }
                  : { type: "document", id: typeof attachmentId === "string" ? attachmentId : "", source: "attachment", project_id: binding.project_id, access: "granted", title: binding.asset_name };
                if (!ref.id) return null;
                const isSelected = pendingKeys.has(chatResourceDraftKey(ref));
                const meta = [t(($) => $.resources.document), binding.project_title, formatTimestamp(binding.created_at)]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <ResourceOption
                    key={binding.id}
                    mark={chatResourceMark(ref)}
                    tone="document"
                    // Resource-kind prefix (DOC/CHAT), not copy.
                    // eslint-disable-next-line no-restricted-syntax
                    title={`DOC · ${binding.asset_name}`}
                    meta={meta}
                    selected={isSelected}
                    disabled={!isSelected && atLimit}
                    onClick={() => selectDocument(binding)}
                  />
                );
              }) : <EmptyResources />
            ) : issues.length > 0 ? issues.map((issue) => (
              <IssueOption
                key={issue.id}
                issue={issue}
                kind={tab}
                selected={pendingKeys.has(chatResourceDraftKey({ type: "issue", id: issue.id, kind: tab, access: "granted" }))}
                disabled={!pendingKeys.has(chatResourceDraftKey({ type: "issue", id: issue.id, kind: tab, access: "granted" })) && atLimit}
                onClick={() => selectIssue(issue, tab)}
              />
            )) : <EmptyResources />}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <span className="mr-auto text-micro text-muted-foreground">{t(($) => $.resources.picker_limit)}</span>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t(($) => $.resources.picker_cancel)}
          </Button>
          <Button
            type="button"
            onClick={() => {
              onApply(pending.slice(0, CHAT_RESOURCE_DRAFT_LIMIT));
              onOpenChange(false);
            }}
          >
            {pending.length > 0
              ? t(($) => $.resources.picker_add_count, { count: pending.length })
              : t(($) => $.resources.picker_add)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function IssueOption({
  issue,
  kind,
  selected,
  disabled,
  onClick,
}: {
  issue: Issue;
  kind: "task" | "requirement";
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useT("chat");
  const { t: tIssues } = useT("issues");
  const wsId = useWorkspaceId();
  const statusLabel = useStatusLabel(wsId);
  const resource: ChatMessageResource = { type: "issue", id: issue.id, kind, access: "granted", issue };
  const meta = [
    t(($) => $.resources[kind]),
    issue.identifier,
    statusLabel(issue.status),
    issue.priority ? priorityLabel(issue.priority, tIssues) : "",
  ].filter(Boolean).join(" · ");
  return (
    <ResourceOption
      mark={chatResourceMark(resource)}
      tone={kind === "requirement" ? "requirement" : "task"}
      title={`${issue.identifier} · ${issue.title}`}
      meta={meta}
      selected={selected}
      disabled={disabled}
      onClick={onClick}
    />
  );
}

function ResourceOption({
  mark,
  tone,
  title,
  meta,
  selected,
  disabled,
  onClick,
}: {
  mark: string;
  tone: "task" | "requirement" | "document" | "module";
  title: string;
  meta: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-brand bg-brand/10 ring-2 ring-brand/15"
          : "border-border hover:bg-muted/50",
        disabled && "cursor-not-allowed opacity-50",
      )}
      onClick={onClick}
    >
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-lg font-mono text-[10px] font-extrabold",
          tone === "requirement" && "bg-emerald-500/10 text-emerald-700",
          tone === "document" && "bg-violet-500/10 text-violet-700",
          tone === "module" && "bg-emerald-500/10 text-emerald-700",
          tone === "task" && "bg-primary/10 text-primary",
        )}
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-caption font-semibold">{title}</span>
        <span className="mt-0.5 block truncate text-micro text-muted-foreground">{meta}</span>
      </span>
      <span
        className={cn(
          "grid size-[18px] shrink-0 place-items-center rounded-full border",
          selected ? "border-brand bg-brand text-white" : "border-border",
        )}
        aria-hidden
      >
        {selected && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  );
}

function EmptyResources() {
  const { t } = useT("chat");
  return <p className="rounded-lg border border-dashed border-border p-8 text-center text-caption text-muted-foreground">{t(($) => $.resources.empty)}</p>;
}

/** 模块列表 → 可直接进输入区的资源对象。 */
function moduleResources(
  modules: ProjectModule[] | undefined,
  query: string,
): ChatMessageResource[] {
  const needle = query.trim().toLowerCase();
  return (modules ?? [])
    .filter((module) => !needle || `${module.name} ${module.description ?? ""}`.toLowerCase().includes(needle))
    .map(chatModuleResource);
}
