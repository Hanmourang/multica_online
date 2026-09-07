"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, FileStack, FolderGit2, FolderSearch, Link2, Package, Pencil, Play, Plus, Search, Settings2, ShieldCheck, SlidersHorizontal, Ticket } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useSyncProjectArtifacts } from "@multica/core/artifacts/mutations";
import { projectArtifactListOptions } from "@multica/core/artifacts/queries";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { copyText } from "@multica/ui/lib/clipboard";
import { useT } from "../../../i18n";
import { AppLink } from "../../../navigation";
import { ArchiveActionDialog } from "./archive-action-dialog";
import { ArchiveImportDialog } from "./archive-import-dialog";
import { ArtifactEditorDialog, type ArtifactEditorSeed } from "./artifact-editor-dialog";
import { ArtifactListTable } from "./artifact-list";
import { ArtifactMatrix } from "./artifact-matrix";
import { artifactDisplayName, resolveArchivePreviewRoots } from "./archive-display";
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

  const filters: ListArtifactsParams | undefined = useMemo(
    () =>
      scope || stage || docType
        ? {
            ...(scope ? { scope } : {}),
            ...(stage ? { stage } : {}),
            ...(docType ? { doc_type: docType } : {}),
          }
        : undefined,
    [scope, stage, docType],
  );

  const listQuery = useQuery(projectArtifactListOptions(wsId, projectId, filters));
  const projectQuery = useQuery(projectDetailOptions(wsId, projectId));
  const resourcesQuery = useQuery(projectResourcesOptions(wsId, projectId));
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
  const handleSync = () => {
    syncMutation.mutate(
      { artifacts: [] },
      {
        onSuccess: (result) => {
          // 空清单 no-op：服务端跳过了软删（skipped_soft_delete=true，
          // skip_reason 通常为 "empty_manifest"）。此时 deleted_count 恒为 0，
          // 报绿色的「同步完成」是谎言——用 info 如实说明本次没有任何写入。
          if (result.skipped_soft_delete) {
            toast.info(t(($) => $.sync.revalidate_noop), {
              description: t(($) => $.sync.revalidate_hint),
            });
            return;
          }
          // 真正发生了 diff（仅当服务端返回非跳过结果时）才报计数。
          toast.success(
            t(($) => $.sync.result, {
              created: result.created_count,
              updated: result.updated_count,
              deleted: result.deleted_count,
            }),
          );
        },
        onError: (error) => {
          toast.error(String(error));
        },
      },
    );
  };

  const artifacts = useMemo(() => {
    const rows = listQuery.data?.artifacts ?? [];
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(
      (a) =>
        a.rel_path.toLowerCase().includes(query) ||
        a.doc_type.toLowerCase().includes(query) ||
        (a.requirement_key ?? "").toLowerCase().includes(query) ||
        (a.rel_path.split("/").pop() ?? "").toLowerCase().includes(query),
    );
  }, [listQuery.data, search]);

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

  const scopeItems = [
    { value: "project", label: t(($) => $.browser.scope_project) },
    { value: "requirement", label: t(($) => $.browser.scope_requirement) },
    { value: "shared", label: t(($) => $.browser.scope_shared) },
  ];
  const stageItems = [
    { value: "1", label: t(($) => $.browser.stage_s1) },
    { value: "2", label: t(($) => $.browser.stage_s2) },
    { value: "3", label: t(($) => $.browser.stage_s3) },
    { value: "4", label: t(($) => $.browser.stage_s4) },
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
            onImport={() => setImportOpen(true)}
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

        <TabsContent value="browser" className="flex min-h-0 flex-col gap-3">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t(($) => $.browser.search_placeholder)}
                aria-label={t(($) => $.browser.search_placeholder)}
                className="pl-8"
              />
            </div>
            <Select
              items={scopeItems}
              value={scope}
              onValueChange={(value) => setScope((value as ArtifactScope) ?? null)}
            >
              <SelectTrigger aria-label={t(($) => $.browser.scope_all)}>
                <SelectValue placeholder={t(($) => $.browser.scope_all)} />
              </SelectTrigger>
              <SelectContent>
                {scopeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              items={stageItems}
              value={stage ? String(stage) : null}
              onValueChange={(value) => setStage(value ? (Number(value) as ArtifactStage) : null)}
            >
              <SelectTrigger aria-label={t(($) => $.browser.stage_all)}>
                <SelectValue placeholder={t(($) => $.browser.stage_all)} />
              </SelectTrigger>
              <SelectContent>
                {stageItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              items={docTypeItems}
              value={docType}
              onValueChange={(value) => setDocType(value ?? null)}
            >
              <SelectTrigger aria-label={t(($) => $.browser.doc_type_all)}>
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
              variant={missingOnly ? "default" : "outline"}
              size="sm"
              onClick={() => setMissingOnly((v) => !v)}
              aria-pressed={missingOnly}
            >
              <SlidersHorizontal />
              {t(($) => $.browser.missing_only)}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncMutation.isPending}
              aria-label={t(($) => $.sync.revalidate)}
            >
              <ShieldCheck className={syncMutation.isPending ? "animate-pulse" : undefined} />
              {syncMutation.isPending
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setImportOpen(true)}
            >
              <FolderSearch />
              {t(($) => $.import.action)}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPane("mapping")}
            >
              <Settings2 />
              {t(($) => $.archive_toolbar.settings)}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPane("sync")}
            >
              <Link2 />
              {t(($) => $.archive_toolbar.sync_relate)}
              {unboundCount > 0 && (
                <Badge variant="secondary" className="ml-1 tabular-nums">
                  {t(($) => $.archive_toolbar.unbound_count, { n: unboundCount })}
                </Badge>
              )}
            </Button>
            {onExportFiling && (
              <Button type="button" variant="outline" size="sm" onClick={onExportFiling}>
                <Package />
                {t(($) => $.archive_toolbar.export_filing)}
              </Button>
            )}
            <Badge variant="secondary" className="tabular-nums">
              {listQuery.data?.total ?? 0}
            </Badge>
          </div>

          {/* Body: list view (left) + selection panel (right) */}
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(360px,480px)]">
            <div className="min-h-0">
              {listQuery.isPending ? (
                <QueryLoading rows={6} />
              ) : listQuery.isError ? (
                <QueryError
                  onRetry={() => void listQuery.refetch()}
                  message={String(listQuery.error)}
                />
              ) : (
                <Tabs value={view} onValueChange={(value) => setView(value as "matrix" | "list")}>
                  <TabsList className="mb-3">
                    <TabsTrigger value="matrix">{t(($) => $.browser.view_matrix)}</TabsTrigger>
                    <TabsTrigger value="list">{t(($) => $.browser.view_list)}</TabsTrigger>
                  </TabsList>
                  <TabsContent value="matrix">
                    <ArtifactMatrix
                      artifacts={artifacts}
                      selectedId={selectedId}
                      onSelect={openPreview}
                      onOpenRequirement={onOpenRequirement}
                      onCreateMissing={(seed) => {
                        setEditorArtifact(null);
                        setEditorSeed(seed);
                        setEditorOpen(true);
                      }}
                      missingOnly={missingOnly}
                    />
                  </TabsContent>
                  <TabsContent value="list">
                    <ArtifactListTable
                      artifacts={artifacts}
                      selectedId={selectedId}
                      onSelect={openPreview}
                    />
                  </TabsContent>
                </Tabs>
              )}
            </div>

            {/* Right-hand selection panel (f4 ar-aside). */}
            <aside className="space-y-2 overflow-y-auto rounded-lg border border-surface-border bg-surface p-3">
              {selected ? (
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
              ) : (
                <p className="py-8 text-center text-caption leading-relaxed text-muted-foreground">
                  {t(($) => $.browser.select_hint)}
                </p>
              )}
            </aside>
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
