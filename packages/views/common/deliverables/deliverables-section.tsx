import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, Check, FileText, PackageOpen } from "lucide-react";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import { useArchiveDeliverable } from "@multica/core/artifacts/mutations";
import type { ProjectArtifact } from "@multica/core/types";
import { useT } from "../../i18n";
import { ArchiveActionDialog } from "../../projects/components/archive/archive-action-dialog";
import { buildTimeline } from "../task-transcript/build-timeline";
import { buildSteps } from "../task-transcript/build-steps";
import { buildDeliverables, shortenDeliverablePath, type Deliverable } from "./build-deliverables";
import { DeliverablePreviewDialog } from "./deliverable-preview-dialog";

/**
 * A run's final deliverables as a card wall, pinned to the task_completed
 * activity entry in an issue timeline. Reads the run's transcript through the
 * shared `taskMessages` query cache — the same cache the live chat view and
 * transcript button observe — so reopening a wall (or reading a task that is
 * still streaming in) costs no extra request and sees realtime frames.
 *
 * Renders nothing while loading (the wall popping in under a collapsed
 * activity block is better than a skeleton that mostly flashes by) and
 * nothing at all when the run produced no deliverables; a failed load leaves
 * a small inline error with retry rather than breaking the timeline.
 */
export function DeliverablesSection({
  taskId,
  replyText,
  projectId,
}: {
  taskId: string;
  replyText?: string | null;
  /** 所属项目；提供时才开启 f6 归档接线（归档需 projectId 驱动 ArchiveActionDialog）。 */
  projectId?: string | null;
}) {
  const { t } = useT("issues");
  const query = useQuery(taskMessagesOptions(taskId));
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  // f6 归档接线：已归档路径集（卡片显示✓已归档）+ 当前归档弹窗目标。
  // 归档 mutation（依赖 workspace 上下文）下沉到仅在 projectId 存在时才
  // 挂载的子组件，避免无 workspace 场景（如单元测试）触发 useWorkspaceId。
  const canArchive = Boolean(projectId);
  const [archivedPaths, setArchivedPaths] = useState<Set<string>>(() => new Set());
  const [archiveTarget, setArchiveTarget] = useState<Deliverable | null>(null);

  const items = useMemo<Deliverable[] | null | undefined>(
    () =>
      query.data === undefined
        ? undefined
        : buildDeliverables(buildSteps(buildTimeline(query.data)), replyText),
    [query.data, replyText],
  );

  if (query.isError) {
    return (
      <div
        data-testid="deliverables-error"
        className="px-4 pb-3 text-caption text-muted-foreground max-md:px-3"
      >
        {t(($) => $.deliverables.load_error)}
        <button
          type="button"
          className="ml-2 underline underline-offset-2 hover:text-foreground"
          onClick={() => void query.refetch()}
        >
          {t(($) => $.deliverables.retry)}
        </button>
      </div>
    );
  }
  if (!items) return null;
  let added = 0;
  let removed = 0;
  for (const d of items) {
    added += d.addedLines;
    removed += d.removedLines;
  }

  const archivable = items.filter((d) => !archivedPaths.has(d.path));
  const markArchived = (path: string) =>
    setArchivedPaths((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });

  return (
    <div data-testid="deliverables-section" className="px-4 pb-3 max-md:px-3">
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
          <PackageOpen className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-caption font-medium">
            {t(($) => $.deliverables.section_title)}
          </span>
          <span className="rounded-full border px-1.5 text-micro tabular-nums text-muted-foreground">
            {items.length}
          </span>
          <span className="ml-auto font-mono text-micro tabular-nums text-muted-foreground">
            {added > 0 && <span className="text-success">+{added}</span>}
            {removed > 0 && (
              <span className="text-destructive">
                {added > 0 ? " " : ""}−{removed}
              </span>
            )}
          </span>
          {canArchive && projectId && (
            <ArchiveAllButton
              projectId={projectId}
              targets={archivable}
              onArchived={markArchived}
            />
          )}
        </div>
        <ul className="divide-y divide-border/60">
          {items.map((d, i) => {
            const isArchived = archivedPaths.has(d.path);
            return (
              <li key={d.path} className="group flex items-center gap-3 px-3 py-2.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => setPreviewIndex(i)}
                        className="min-w-0 flex-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent/50"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <FileText
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="truncate text-caption font-medium">{d.name}</span>
                          {d.kind === "added" ? (
                            <span className="shrink-0 rounded bg-success/10 px-1.5 py-0.5 text-micro text-success">
                              {t(($) => $.deliverables.badge_added)}
                            </span>
                          ) : (
                            <span className="shrink-0 rounded bg-info/10 px-1.5 py-0.5 text-micro text-info">
                              {t(($) => $.deliverables.badge_modified)}
                            </span>
                          )}
                        </div>
                        <div
                          className="mt-0.5 truncate pl-6 font-mono text-micro text-muted-foreground"
                          title={d.path}
                        >
                          {shortenDeliverablePath(d.path)}
                        </div>
                      </button>
                    }
                  />
                  <TooltipContent>{t(($) => $.deliverables.open_hint)}</TooltipContent>
                </Tooltip>
                <span className="shrink-0 font-mono text-micro tabular-nums">
                  {d.addedLines > 0 && <span className="text-success">+{d.addedLines}</span>}
                  {d.removedLines > 0 && (
                    <span className="text-destructive">
                      {d.addedLines > 0 ? " " : ""}−{d.removedLines}
                    </span>
                  )}
                </span>
                {canArchive &&
                  (isArchived ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-success/15 px-1.5 py-0.5 text-micro text-success">
                      <Check className="h-2.5 w-2.5" aria-hidden />
                      {t(($) => $.deliverables.archived)}
                    </span>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setArchiveTarget(d);
                            }}
                            aria-label={t(($) => $.deliverables.archive)}
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border bg-card text-muted-foreground opacity-0 transition-opacity hover:border-primary/60 hover:text-foreground group-hover:opacity-100"
                          >
                            <Archive className="h-3 w-3" aria-hidden />
                          </button>
                        }
                      />
                      <TooltipContent>{t(($) => $.deliverables.archive)}</TooltipContent>
                    </Tooltip>
                  ))}
              </li>
            );
          })}
        </ul>
      </div>
      {previewIndex !== null && (
        <DeliverablePreviewDialog
          deliverables={items}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
      {canArchive && archiveTarget && (
        <ArchiveActionDialog
          projectId={projectId ?? ""}
          artifact={deliverableToArtifact(archiveTarget, projectId ?? "")}
          open={archiveTarget !== null}
          onOpenChange={(open) => {
            if (!open) {
              // 弹窗内部持有归档 mutation，成功时 toast + 关闭（onOpenChange(false)）。
              // 弹窗未暴露成功回调，故在关闭时乐观标记✓已归档（取消路径影响仅限本地徽标）。
              markArchived(archiveTarget.path);
              setArchiveTarget(null);
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * 「全部归档」按钮。独立成子组件是为了把依赖 workspace 上下文的
 * useArchiveDeliverable 限制在“projectId 存在”时才挂载（无 workspace 的
 * 单元测试不会渲染它）。逐个提交可归档项，成功后回调标记卡片✓已归档。
 */
function ArchiveAllButton({
  projectId,
  targets,
  onArchived,
}: {
  projectId: string;
  targets: Deliverable[];
  onArchived: (path: string) => void;
}) {
  const { t } = useT("issues");
  const mutation = useArchiveDeliverable(projectId);
  const handleArchiveAll = () => {
    for (const d of targets) {
      mutation.mutate(
        { artifactId: d.path, scope: "requirement", doc_type: docTypeOf(d) },
        {
          onSuccess: () => onArchived(d.path),
          onError: (error) => toast.error(String(error)),
        },
      );
    }
  };
  return (
    <button
      type="button"
      onClick={handleArchiveAll}
      disabled={targets.length === 0 || mutation.isPending}
      className="ml-2 inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-micro text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      aria-label={t(($) => $.deliverables.archive_all)}
    >
      <Archive className="h-3 w-3" aria-hidden />
      {mutation.isPending
        ? t(($) => $.deliverables.archive_all_pending)
        : t(($) => $.deliverables.archive_all)}
    </button>
  );
}

/** 从交付物推导归档默认 doc_type（去扩展名的文件名）。 */
function docTypeOf(d: Deliverable): string {
  const dot = d.name.lastIndexOf(".");
  return dot > 0 ? d.name.slice(0, dot) : d.name;
}

/**
 * 把交付卡适配成 ArchiveActionDialog 需要的 ProjectArtifact 形状。
 * 交付物来自 run transcript，没有独立的 artifact id / blob_sha；这里用
 * rel_path 作为标识、doc_type 取文件名，供弹窗预填 scope/stage/doc_type。
 * 服务端在下次 CLI 同步时按契约落地实际文件（见 archive-action-dialog cli_hint）。
 */
function deliverableToArtifact(d: Deliverable, projectId: string): ProjectArtifact {
  const now = new Date().toISOString();
  return {
    id: d.path,
    workspace_id: "",
    project_id: projectId,
    resource_id: "",
    scope: "requirement",
    stage: null,
    doc_type: docTypeOf(d),
    version: 1,
    rel_path: d.path,
    requirement_key: null,
    blob_sha: "",
    attachment_id: null,
    size_bytes: d.content?.length ?? 0,
    source: "agent",
    synced_at: now,
    created_at: now,
    updated_at: now,
  };
}
