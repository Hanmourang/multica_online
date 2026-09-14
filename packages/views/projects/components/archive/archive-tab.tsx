"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, FileStack, FolderGit2, FolderSearch, Link2, MoreHorizontal, Package, Pencil, Play, Plus, Search, Settings2, ShieldCheck, SlidersHorizontal, Tags, Ticket } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { usePatchArtifact, useSyncProjectArtifacts } from "@multica/core/artifacts/mutations";
import {
  archiveSyncConfigOptions,
  projectArtifactListOptions,
} from "@multica/core/artifacts/queries";
import { calendarIssuesOptions } from "@multica/core/issues/queries";
import { projectDetailOptions, projectResourcesOptions } from "@multica/core/projects";
import type {
  ArtifactScope,
  ArtifactStage,
  ListArtifactsParams,
  LocalDirectoryResourceRef,
  ProjectArtifact,
} from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { cn } from "@multica/ui/lib/utils";
import { copyText } from "@multica/ui/lib/clipboard";
import { isDesktopShell } from "../../../platform";
import { useT } from "../../../i18n";
import { collectLocalArchiveSyncItems } from "./archive-sync-manifest";
import { AppLink } from "../../../navigation";
import { ArchiveActionDialog } from "./archive-action-dialog";
import { ArchiveImportDialog } from "./archive-import-dialog";
import { ArtifactEditorDialog, type ArtifactEditorSeed } from "./artifact-editor-dialog";
import { ArtifactListTable } from "./artifact-list";
import { ArtifactMatrix } from "./artifact-matrix";
import {
  artifactDisplayName,
  artifactModuleTag,
  resolveArchivePreviewRoots,
} from "./archive-display";
import { persistDocModuleValue } from "./archive-module";
import {
  PLANNING_SHELVES,
  writebackArtifactFrontmatter,
  type PlanningShelf,
} from "./archive-mapping";
import {
  relocateToShelf,
  writeRelocatedArchiveFile,
} from "./archive-relocate";
import {
  ArtifactModuleBadge,
  ArtifactModuleField,
} from "./artifact-module-tag";
import { ArtifactPreviewDialog } from "./artifact-preview";
import { ArtifactPreviewPane } from "./artifact-preview-pane";
import { ContractMapping } from "./contract-mapping";
import { SyncConsole } from "./sync-console";
import { formatTimestamp, QueryError, QueryLoading } from "./query-states";

/**
 * f4 项目档案主入口。
 *
 * Top-level tabs: 浏览（matrix + list）/ 同步控制台（f3）/ 映射说明（f1）。
 * The browser owns the filtered artifact query — scope/stage/doc_type ride
 * the request URL (and thus the query key), search + missing-only are client
 * side. Selecting a chip drives the right-hand summary panel; 预览 opens the
 * f5 dialog, 重新归类 opens the f6 dialog.
 */
export function ArchiveTab({
  projectId,
  onOpenRequirement,
  onExportFiling,
}: {
  projectId: string;
  onOpenRequirement?: (issueId: string, drill?: string) => void;
  onExportFiling?: () => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();

  const [pane, setPane] = useState<"browser" | "sync" | "mapping">("browser");
  const [scope, setScope] = useState<ArtifactScope | null>(null);
  const [stage, setStage] = useState<ArtifactStage | null>(null);
  const [docType, setDocType] = useState<string | null>(null);
  const [docClass, setDocClass] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
  const [view, setView] = useState<"matrix" | "list">("matrix");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [archiveArtifact, setArchiveArtifact] = useState<ProjectArtifact | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorArtifact, setEditorArtifact] = useState<ProjectArtifact | null>(null);
  const [editorSeed, setEditorSeed] = useState<ArtifactEditorSeed | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [archiveRoot, setArchiveRoot] = useState<string | null>(null);
  const [localSyncing, setLocalSyncing] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [batchDraft, setBatchDraft] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const desktop = isDesktopShell();
  const patchMutation = usePatchArtifact(wsId, projectId);

  const filters: ListArtifactsParams | undefined = useMemo(() => {
    const next: ListArtifactsParams = {
      ...(scope ? { scope } : {}),
      ...(stage ? { stage } : {}),
      ...(docType ? { doc_type: docType } : {}),
      ...(docClass ? { doc_class: docClass } : {}),
      ...(search.trim() ? { q: search.trim() } : {}),
    };
    return Object.keys(next).length > 0 ? next : undefined;
  }, [scope, stage, docType, docClass, search]);

  const listQuery = useQuery(projectArtifactListOptions(wsId, projectId, filters));
  const allQuery = useQuery(projectArtifactListOptions(wsId, projectId));
  const syncConfigQuery = useQuery(archiveSyncConfigOptions(wsId, projectId));
  const scopeCounts = useMemo(() => {
    const rows = allQuery.data?.artifacts ?? [];
    return {
      all: rows.length,
      project: rows.filter((row) => row.scope === "project").length,
      requirement: rows.filter((row) => row.scope === "requirement").length,
      shared: rows.filter((row) => row.scope === "shared").length,
    };
  }, [allQuery.data]);
  const projectQuery = useQuery(projectDetailOptions(wsId, projectId));
  const resourcesQuery = useQuery(projectResourcesOptions(wsId, projectId));
  const issuesQuery = useQuery(calendarIssuesOptions(wsId));
  const projectIssues = useMemo(
    () => (issuesQuery.data ?? []).filter((issue) => issue.project_id === projectId),
    [issuesQuery.data, projectId],
  );
  const boundPath = useMemo(() => {
    const boundId = projectQuery.data?.archive_resource_id;
    if (!boundId) return null;
    const resource = (resourcesQuery.data ?? []).find((item) => item.id === boundId);
    if (resource?.resource_type !== "local_directory") return null;
    return (resource.resource_ref as LocalDirectoryResourceRef).local_path ?? null;
  }, [projectQuery.data, resourcesQuery.data]);

  useEffect(() => {
    if (!archiveRoot && boundPath) setArchiveRoot(boundPath);
  }, [archiveRoot, boundPath]);

  const archiveRoots = useMemo(
    () => resolveArchivePreviewRoots(archiveRoot, boundPath),
    [archiveRoot, boundPath],
  );

  /**
   * f4 档案状态「校验」入口（非真实同步）。Web 端读不到档案目录，能提交的
   * 清单只有 `[]`；服务端把空清单当 no-op（不软删任何行，返回
   * skipped_soft_delete=true / skip_reason="empty_manifest"），mutation 的
   * onSettled 仍会失效整个项目档案切片，列表 / 矩阵据此重新读取服务端状态。
   * 因此这里不再报「同步完成：新增0·更新0·删除0」——那会让用户以为档案已对
   * 过账；空清单 no-op 走 toast.info 如实说明「未提交清单、未做变更」，与
   * sync-console.tsx 方案(a)「校验同步链路」的语义与用词保持一致。真实全量同步
   * 只能由能读档案目录的 CLI / 本地 daemon 产出清单后提交。
   */
  const syncMutation = useSyncProjectArtifacts(projectId);
  const syncBusy = localSyncing || syncMutation.isPending;
  const handleSyncSuccess = (result: {
    skipped_soft_delete?: boolean;
    created_count: number;
    updated_count: number;
    deleted_count: number;
  }) => {
    if (result.skipped_soft_delete) {
      toast.info(t(($) => $.sync.revalidate_noop), {
        description: t(($) => $.sync.revalidate_hint),
      });
      return;
    }
    toast.success(
      t(($) => $.sync.result, {
        created: result.created_count,
        updated: result.updated_count,
        deleted: result.deleted_count,
      }),
    );
  };
  const handleSync = () => {
    const root = archiveRoot ?? boundPath;
    if (desktop && root) {
      setLocalSyncing(true);
      void collectLocalArchiveSyncItems(root, {
        conflictPolicy: syncConfigQuery.data?.conflict_policy ?? "path_first",
      })
        .then((collected) => {
          if (collected.error) {
            toast.error(collected.error);
            return;
          }
          if (collected.items.length === 0) {
            toast.info(t(($) => $.sync.empty_local));
            return;
          }
          return new Promise<void>((resolve, reject) => {
            syncMutation.mutate(
              { artifacts: collected.items },
              {
                onSuccess: (result) => {
                  handleSyncSuccess(result);
                  resolve();
                },
                onError: (error) => {
                  toast.error(String(error));
                  reject(error);
                },
              },
            );
          });
        })
        .finally(() => setLocalSyncing(false));
      return;
    }
    if (desktop && !root) {
      toast.info(t(($) => $.sync.desktop_need_root));
      return;
    }
    syncMutation.mutate(
      { artifacts: [] },
      {
        onSuccess: (result) => handleSyncSuccess(result),
        onError: (error) => {
          toast.error(String(error));
        },
      },
    );
  };

  const artifacts = listQuery.data?.artifacts ?? [];

  const unboundCount = useMemo(
    () =>
      (listQuery.data?.artifacts ?? []).filter(
        (artifact) => artifact.scope === "requirement" && !artifact.issue_id,
      ).length,
    [listQuery.data],
  );

  const selected = useMemo(
    () => artifacts.find((a) => a.id === selectedId) ?? null,
    [artifacts, selectedId],
  );

  const persistModule = async (artifact: ProjectArtifact, raw: string) => {
    const next = persistDocModuleValue(artifact.rel_path, raw);
    const current = artifact.doc_module?.trim() ?? "";
    if (next === current) return false;
    const updated = await patchMutation.mutateAsync({
      artifactId: artifact.id,
      patch: { doc_module: next },
    });
    if ((updated.doc_module ?? "") !== next) {
      throw new Error(t(($) => $.browser.tag_not_persisted));
    }
    const root = archiveRoot ?? boundPath;
    if (root) {
      const written = await writebackArtifactFrontmatter({
        archiveRoot: root,
        relPath: artifact.rel_path,
        docModule: next || null,
      });
      if (!written.ok && written.reason !== "unsupported") {
        toast.info(t(($) => $.manage.written_db_only));
      }
    }
    return true;
  };

  const handleSaveTag = async (artifact: ProjectArtifact, raw: string) => {
    setTagBusy(true);
    try {
      const changed = await persistModule(artifact, raw);
      if (changed) toast.success(t(($) => $.browser.tag_saved));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.browser.tag_failed));
    } finally {
      setTagBusy(false);
    }
  };

  const handleBatchTag = async () => {
    const rows = artifacts.filter((artifact) => pickedIds.has(artifact.id));
    if (rows.length === 0) return;
    setTagBusy(true);
    try {
      for (const row of rows) {
        await persistModule(row, batchDraft);
      }
      toast.success(t(($) => $.browser.tag_batch_saved, { n: rows.length }));
      setPickedIds(new Set());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.browser.tag_failed));
    } finally {
      setTagBusy(false);
    }
  };

  const togglePick = (id: string, next: boolean) => {
    setPickedIds((current) => {
      const copy = new Set(current);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  };

  const pickMany = (ids: string[], additive: boolean) => {
    setPickedIds((current) => {
      const next = additive ? new Set(current) : new Set<string>();
      for (const id of ids) next.add(id);
      return next;
    });
  };

  const relocateOne = async (artifact: ProjectArtifact, shelf: PlanningShelf) => {
    const dest = relocateToShelf(artifact.rel_path, shelf);
    if (artifact.doc_type === shelf && dest === artifact.rel_path) return "skip";
    if (
      artifacts.some(
        (row) => row.id !== artifact.id && row.rel_path === dest && !row.deleted_at,
      )
    ) {
      return "exists";
    }
    const root = archiveRoot ?? boundPath;
    let content: string | undefined;
    let pointerOnly = false;
    if (root) {
      const written = await writeRelocatedArchiveFile({
        archiveRoot: root,
        fromPath: artifact.rel_path,
        toPath: dest,
        docType: shelf,
      });
      if (written.ok) {
        content = written.content;
      } else if (written.reason === "exists") {
        return "exists";
      } else if (written.reason !== "unsupported" && written.reason !== "not_found") {
        pointerOnly = true;
      }
    }
    await patchMutation.mutateAsync({
      artifactId: artifact.id,
      patch: {
        doc_type: shelf,
        rel_path: dest,
        ...(content ? { content } : {}),
      },
    });
    return pointerOnly ? "pointer" : "ok";
  };

  const handleRelocate = async (ids: string[], shelf: PlanningShelf) => {
    const targetIds = ids.length > 0 ? ids : selectedId ? [selectedId] : [];
    const rows = artifacts.filter((artifact) => targetIds.includes(artifact.id));
    if (rows.length === 0) {
      toast.info(t(($) => $.browser.move_need_pick));
      return;
    }
    setTagBusy(true);
    let moved = 0;
    let exists = 0;
    let skipped = 0;
    let pointer = 0;
    try {
      for (const row of rows) {
        const result = await relocateOne(row, shelf);
        if (result === "ok") moved += 1;
        else if (result === "pointer") pointer += 1;
        else if (result === "exists") exists += 1;
        else skipped += 1;
      }
      if (moved > 0) toast.success(t(($) => $.browser.moved, { n: moved }));
      if (pointer > 0) toast.info(t(($) => $.browser.move_pointer_only, { n: pointer }));
      if (exists > 0) toast.error(t(($) => $.browser.move_exists, { n: exists }));
      if (moved === 0 && pointer === 0 && exists === 0 && skipped > 0) {
        toast.info(t(($) => $.browser.move_same_shelf));
      }
      setPickedIds(new Set());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.browser.move_failed));
    } finally {
      setTagBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pickedIds.size > 0) setPickedIds(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickedIds.size]);

  /** f5 navigation group: same requirement (or same non-requirement scope), stage-ordered. */
  const previewGroup = useMemo(
    () => (selected ? previewGroupOf(artifacts, selected) : []),
    [artifacts, selected],
  );

  const openPreview = (artifact: ProjectArtifact) => {
    setSelectedId(artifact.id);
    const group = previewGroupOf(artifacts, artifact);
    setPreviewIndex(Math.max(0, group.findIndex((row) => row.id === artifact.id)));
  };

  const stageItems = [
    { value: 1 as ArtifactStage, label: t(($) => $.browser.stage_s1) },
    { value: 2 as ArtifactStage, label: t(($) => $.browser.stage_s2) },
    { value: 3 as ArtifactStage, label: t(($) => $.browser.stage_s3) },
    { value: 4 as ArtifactStage, label: t(($) => $.browser.stage_s4) },
  ];

  const docTypeItems = useMemo(() => {
    const seen = new Set<string>(["change-log", "work-plan"]);
    for (const a of listQuery.data?.artifacts ?? []) seen.add(a.doc_type);
    return [...seen].sort().map((value) => ({ value, label: value }));
  }, [listQuery.data]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="archive-tab">
      <Tabs
        value={pane}
        onValueChange={(next) => setPane(next as "browser" | "sync" | "mapping")}
        className="gap-3"
      >
        <TabsList variant="line">
          <TabsTrigger value="browser">{t(($) => $.tabs.archive)}</TabsTrigger>
          <TabsTrigger value="sync">{t(($) => $.sync.title)}</TabsTrigger>
          <TabsTrigger value="mapping">{t(($) => $.mapping.title)}</TabsTrigger>
        </TabsList>

        <TabsContent value="sync" className="min-h-0 overflow-y-auto px-1 pb-6">
          <SyncConsole
            projectId={projectId}
            archiveRoot={archiveRoot ?? boundPath}
            onImport={() => setImportOpen(true)}
            onDesktopSync={desktop ? handleSync : undefined}
            desktopSyncPending={syncBusy}
            onEdit={(artifact) => {
              setEditorSeed(null);
              setEditorArtifact(artifact);
              setEditorOpen(true);
            }}
          />
        </TabsContent>
        <TabsContent value="mapping" className="min-h-0 overflow-y-auto px-1 pb-6">
          <ContractMapping
            projectId={projectId}
            archiveRoot={archiveRoot ?? boundPath}
            onImport={() => setImportOpen(true)}
            onCreate={() => {
              setEditorArtifact(null);
              setEditorSeed({ scope: "project", docType: "architecture" });
              setEditorOpen(true);
            }}
            onEdit={(artifact) => {
              setEditorSeed(null);
              setEditorArtifact(artifact);
              setEditorOpen(true);
            }}
          />
        </TabsContent>

        <TabsContent value="browser" className="flex min-h-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-surface-border p-0.5">
              {(
                [
                  ["matrix", t(($) => $.browser.view_matrix)],
                  ["list", t(($) => $.browser.view_list)],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="xs"
                  variant={view === value ? "default" : "ghost"}
                  aria-pressed={view === value}
                  onClick={() => setView(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <div className="relative min-w-48 max-w-sm flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t(($) => $.browser.search_placeholder)}
                aria-label={t(($) => $.browser.search_placeholder)}
                className="pl-8"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  [null, t(($) => $.browser.scope_all), scopeCounts.all],
                  ["project", t(($) => $.browser.scope_project), scopeCounts.project],
                  ["requirement", t(($) => $.browser.scope_requirement), scopeCounts.requirement],
                  ["shared", t(($) => $.browser.scope_shared), scopeCounts.shared],
                ] as const
              ).map(([value, label, count]) => (
                <Button
                  key={label}
                  type="button"
                  size="xs"
                  variant={scope === value ? "default" : "outline"}
                  onClick={() => setScope(value)}
                >
                  {t(($) => $.browser.scope_count, { label, count })}
                </Button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleSync}
                disabled={syncBusy}
                aria-label={
                  desktop
                    ? t(($) => $.sync.trigger)
                    : t(($) => $.sync.revalidate)
                }
              >
                <ShieldCheck className={syncBusy ? "animate-pulse" : undefined} />
                {desktop
                  ? syncBusy
                    ? t(($) => $.sync.trigger_pending)
                    : t(($) => $.sync.trigger)
                  : syncBusy
                    ? t(($) => $.sync.revalidate_pending)
                    : t(($) => $.sync.revalidate)}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setEditorArtifact(null);
                  setEditorSeed({ scope: "project", docType: "architecture" });
                  setEditorOpen(true);
                }}
              >
                <Plus />
                {t(($) => $.manage.create)}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button type="button" variant="outline" size="sm" />
                  }
                >
                  <MoreHorizontal className="size-3.5" />
                  {t(($) => $.archive_toolbar.more)}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setImportOpen(true)}>
                    <FolderSearch />
                    {t(($) => $.import.action)}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setPane("mapping")}>
                    <Settings2 />
                    {t(($) => $.archive_toolbar.settings)}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setPane("sync")}>
                    <Link2 />
                    {t(($) => $.archive_toolbar.sync_relate)}
                    {unboundCount > 0
                      ? ` · ${t(($) => $.archive_toolbar.unbound_count, { n: unboundCount })}`
                      : null}
                  </DropdownMenuItem>
                  {onExportFiling ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={onExportFiling}>
                        <Package />
                        {t(($) => $.archive_toolbar.export_filing)}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {stageItems.map((item) => (
              <Button
                key={item.value}
                type="button"
                size="xs"
                variant={stage === item.value ? "default" : "outline"}
                aria-pressed={stage === item.value}
                onClick={() =>
                  setStage((current) => (current === item.value ? null : item.value))
                }
              >
                {item.label}
              </Button>
            ))}
            <Select
              items={docTypeItems}
              value={docType}
              onValueChange={(value) => setDocType(value ?? null)}
            >
              <SelectTrigger
                size="sm"
                className="w-40"
                aria-label={t(($) => $.browser.doc_type_all)}
              >
                <SelectValue placeholder={t(($) => $.browser.doc_type_all)} />
              </SelectTrigger>
              <SelectContent>
                {docTypeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant={docClass === "planning" ? "default" : "outline"}
              size="xs"
              onClick={() =>
                setDocClass((current) => (current === "planning" ? null : "planning"))
              }
              aria-pressed={docClass === "planning"}
            >
              {t(($) => $.browser.planning_group)}
            </Button>
            <Button
              type="button"
              variant={missingOnly ? "default" : "outline"}
              size="xs"
              onClick={() => setMissingOnly((v) => !v)}
              aria-pressed={missingOnly}
            >
              <SlidersHorizontal />
              {t(($) => $.browser.missing_only)}
            </Button>
            <Button
              type="button"
              variant={tagging ? "default" : "outline"}
              size="xs"
              onClick={() => {
                setTagging((current) => {
                  if (current) setPickedIds(new Set());
                  return !current;
                });
              }}
              aria-pressed={tagging}
            >
              <Tags />
              {tagging
                ? t(($) => $.browser.tag_batch_exit)
                : t(($) => $.browser.tag_batch)}
            </Button>
            <Badge variant="secondary" className="ml-auto tabular-nums">
              {listQuery.data?.total ?? 0}
            </Badge>
          </div>
          {tagging || pickedIds.size > 0 || selected ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-400/10 px-3 py-2">
              <span className="text-caption text-amber-950 dark:text-amber-50">
                {pickedIds.size > 0
                  ? t(($) => $.browser.picked_count, { n: pickedIds.size })
                  : t(($) => $.browser.tag_batch_hint)}
              </span>
              <Input
                value={batchDraft}
                onChange={(event) => setBatchDraft(event.target.value)}
                placeholder={t(($) => $.browser.tag_placeholder)}
                className="max-w-52"
                aria-label={t(($) => $.browser.tag_placeholder)}
              />
              <Button
                type="button"
                size="sm"
                disabled={pickedIds.size === 0 || tagBusy || !batchDraft.trim()}
                onClick={() => void handleBatchTag()}
              >
                {t(($) => $.browser.tag_batch_apply, { n: pickedIds.size })}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {t(($) => $.browser.move_to)}
              </span>
              {PLANNING_SHELVES.map((shelf) => (
                <Button
                  key={shelf}
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={tagBusy || (pickedIds.size === 0 && !selectedId)}
                  onClick={() => void handleRelocate([...pickedIds], shelf)}
                >
                  {shelf}
                </Button>
              ))}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={pickedIds.size === 0}
                onClick={() => setPickedIds(new Set())}
              >
                {t(($) => $.browser.clear_picks)}
              </Button>
            </div>
          ) : null}

          <div
            className={cn(
              "grid min-h-0 flex-1 gap-3",
              selected && "lg:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]",
            )}
          >
            <div className="min-h-0 overflow-y-auto">
              {listQuery.isPending ? (
                <QueryLoading rows={6} />
              ) : listQuery.isError ? (
                <QueryError
                  onRetry={() => void listQuery.refetch()}
                  message={String(listQuery.error)}
                />
              ) : view === "matrix" ? (
                <ArtifactMatrix
                  artifacts={artifacts}
                  issues={projectIssues}
                  requirementHref={(issueId) => paths.projectRequirement(projectId, issueId)}
                  selectedId={selectedId}
                  onSelect={openPreview}
                  onOpenRequirement={onOpenRequirement}
                  onCreateMissing={(seed) => {
                    setEditorArtifact(null);
                    setEditorSeed(seed);
                    setEditorOpen(true);
                  }}
                  missingOnly={missingOnly}
                  tagging={tagging || pickedIds.size > 0}
                  pickedIds={pickedIds}
                  onTogglePick={togglePick}
                  onSaveTag={handleSaveTag}
                  tagBusy={tagBusy}
                  onPickMany={pickMany}
                  onRelocate={(ids, shelf) => void handleRelocate(ids, shelf)}
                />
              ) : (
                <ArtifactListTable
                  artifacts={artifacts}
                  selectedId={selectedId}
                  onSelect={openPreview}
                  tagging={tagging || pickedIds.size > 0}
                  pickedIds={pickedIds}
                  onTogglePick={togglePick}
                  onSaveTag={handleSaveTag}
                  tagBusy={tagBusy}
                />
              )}
            </div>

            {selected ? (
            <aside className="hidden min-h-0 space-y-2 overflow-y-auto rounded-lg border border-surface-border bg-surface p-3 lg:block">
                <>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 text-left"
                    onClick={() => openPreview(selected)}
                  >
                    <FileStack className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-caption font-medium">
                      {artifactDisplayName(selected.rel_path)}
                    </span>
                    <ArtifactModuleBadge
                      tag={artifactModuleTag(selected.rel_path, selected.doc_module)}
                      title={t(($) => $.browser.module)}
                    />
                  </button>
                  <ArtifactPreviewPane
                    artifact={selected}
                    projectId={projectId}
                    archiveRoots={archiveRoots}
                    onArchiveRootChange={setArchiveRoot}
                    compact
                  />
                  <dl className="space-y-1.5 text-caption">
                    <MetaRow label={t(($) => $.preview.field_scope)} value={selected.scope} />
                    <MetaRow
                      label={t(($) => $.preview.field_stage)}
                      value={selected.stage ? `S${selected.stage}` : t(($) => $.browser.stage_missing)}
                    />
                    <MetaRow label={t(($) => $.preview.field_doc_type)} value={selected.doc_type} />
                    {selected.doc_class ? (
                      <MetaRow label={t(($) => $.mapping.col_class)} value={selected.doc_class} />
                    ) : null}
                    <div className="space-y-1">
                      <div className="text-micro text-muted-foreground">
                        {t(($) => $.browser.module)}
                      </div>
                      <ArtifactModuleField
                        artifact={selected}
                        onSave={(value) => handleSaveTag(selected, value)}
                        busy={tagBusy}
                      />
                    </div>
                    <MetaRow label={t(($) => $.preview.field_version)} value={`v${selected.version}`} />
                    <MetaRow label={t(($) => $.preview.field_source)} value={selected.source} />
                    <MetaRow label={t(($) => $.preview.field_blob_sha)} value={selected.blob_sha.slice(0, 12)} />
                    <MetaRow
                      label={t(($) => $.preview.field_synced_at)}
                      value={formatTimestamp(selected.synced_at)}
                    />
                  </dl>
                  {/* Association links — jump to the source requirement / run, copy the git path. */}
                  <div className="space-y-1 border-t border-surface-border pt-2.5">
                    <h4 className="px-1.5 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                      {t(($) => $.preview.links_title)}
                    </h4>
                    {selected.issue_id && (
                      <LinkRow
                        icon={<Ticket className="size-3" />}
                        label={t(($) => $.preview.link_issue)}
                        value={selected.issue_id.slice(0, 8)}
                        href={paths.issueDetail(selected.issue_id)}
                      />
                    )}
                    {selected.task_id && (
                      <LinkRow
                        icon={<Play className="size-3" />}
                        label={t(($) => $.preview.link_run)}
                        value={selected.task_id.slice(0, 8)}
                      />
                    )}
                    <LinkRow
                      icon={<FolderGit2 className="size-3" />}
                      label={t(($) => $.preview.link_path)}
                      value={selected.rel_path}
                      onClick={() => {
                        void copyText(selected.rel_path).then((ok) => {
                          if (ok) toast.success(t(($) => $.common.copied));
                        });
                      }}
                    />
                  </div>
                  <div className="flex flex-col gap-2 pt-1">
                    <Button
                      type="button"
                      size="xs"
                      onClick={() => openPreview(selected)}
                    >
                      <Eye />
                      {t(($) => $.preview.open)}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        setEditorSeed(null);
                        setEditorArtifact(selected);
                        setEditorOpen(true);
                      }}
                    >
                      <Pencil />
                      {t(($) => $.manage.edit)}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => setArchiveArtifact(selected)}
                    >
                      {t(($) => $.archive_action.trigger)}
                    </Button>
                  </div>
                </>
            </aside>
            ) : null}
          </div>
        </TabsContent>
      </Tabs>

      {/* f5 preview dialog */}
      <ArtifactPreviewDialog
        projectId={projectId}
        artifacts={previewGroup}
        index={previewIndex ?? -1}
        onIndexChange={setPreviewIndex}
        open={previewIndex !== null && previewIndex >= 0}
        archiveRoots={archiveRoots}
        onArchiveRootChange={setArchiveRoot}
        onOpenChange={(open) => {
          if (!open) setPreviewIndex(null);
        }}
        onRequestArchive={(artifact) => {
          setPreviewIndex(null);
          setArchiveArtifact(artifact);
        }}
      />

      {/* f6 archive action dialog */}
      <ArchiveActionDialog
        projectId={projectId}
        artifact={archiveArtifact}
        open={archiveArtifact !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveArtifact(null);
        }}
      />

      <ArtifactEditorDialog
        projectId={projectId}
        artifact={editorArtifact}
        seed={editorSeed}
        open={editorOpen}
        archiveRoot={archiveRoot}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) {
            setEditorArtifact(null);
            setEditorSeed(null);
          }
        }}
      />

      <ArchiveImportDialog
        projectId={projectId}
        artifacts={listQuery.data?.artifacts ?? []}
        open={importOpen}
        archiveRoot={archiveRoot}
        onArchiveRootChange={setArchiveRoot}
        onOpenChange={setImportOpen}
      />
    </div>
  );
}

function previewGroupOf(artifacts: ProjectArtifact[], selected: ProjectArtifact) {
  const groupKey = (artifact: ProjectArtifact) =>
    artifact.requirement_key ?? artifact.issue_id ?? "__unassigned__";
  return artifacts
    .filter((artifact) =>
      selected.scope !== "requirement"
        ? artifact.scope === selected.scope
        : groupKey(artifact) === groupKey(selected),
    )
    .sort((a, b) => (a.stage ?? 9) - (b.stage ?? 9));
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * One association row in the aside's 关联 section. Renders as an AppLink when
 * `href` is set (jump to the requirement), a button when `onClick` is set
 * (copy the git path), or a static line otherwise (run id has no deep route).
 */
function LinkRow({
  icon,
  label,
  value,
  href,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href?: string;
  onClick?: () => void;
}) {
  const base = "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-caption";
  const inner = (
    <>
      <span className="shrink-0 text-muted-foreground/70">{icon}</span>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className="min-w-0 flex-1 truncate text-right font-mono font-medium"
        title={value}
      >
        {value}
      </span>
    </>
  );
  if (href) {
    return (
      <AppLink
        href={href}
        title={value}
        className={`${base} transition-colors hover:bg-accent/50 hover:text-foreground`}
      >
        {inner}
      </AppLink>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={value}
        className={`${base} text-left transition-colors hover:bg-accent/50`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={`${base} cursor-default`} title={value}>
      {inner}
    </div>
  );
}
