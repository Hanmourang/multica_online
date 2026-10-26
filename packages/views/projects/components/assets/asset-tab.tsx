"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { DatabaseZap, LayoutGrid, Link2, List, Plus, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  ASSET_CATEGORIES,
  ASSET_LIFECYCLE_STAGES,
  type AssetCandidate,
  type AssetCategory,
  type AssetBinding,
  type AssetLifecycleStage,
  type AssetRole,
  type BindAssetRequest,
} from "@multica/core/types";
import {
  assetCandidatesOptions,
  assetListOptions,
} from "@multica/core/assets/queries";
import {
  useBatchUpdateAssetMeta,
  useBindIssueAsset,
  useBindProjectAsset,
  useSyncAssetsFromArchive,
  useUnbindIssueAsset,
  useUnbindProjectAsset,
} from "@multica/core/assets/mutations";
import {
  assetFilterKey,
  useAssetFilters,
  useAssetFilterStore,
} from "@multica/core/assets/store";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { useT } from "../../../i18n";
import { QueryError, QueryLoading } from "../archive/query-states";
import { BatchImportPanel } from "./components/batch-import-panel";
import { AssetStatsBar } from "./components/asset-stats-bar";
import {
  AssetPreviewDialog,
  assetPreviewMode,
} from "./components/asset-preview-dialog";
import { AssetTable } from "./components/asset-table";
import { AssetCardGrid } from "./components/asset-card-grid";
import { AssetSelectionToolbar } from "./components/asset-selection-toolbar";
import { AssetBatchEditDialog } from "./components/asset-batch-edit-dialog";
import { pruneSelectedIds } from "./components/asset-batch-draft";

/**
 * 资产管理 TAB（对标 CoCo /projects/:id/assets，spec 03_资产管理模块.md）。
 *
 * 已绑定分页表 + 搜索候选（智能推荐）+ 解绑二次确认。React Query 拥有服务端态；
 * 过滤 / 分页是客户端 UI 态走 Zustand。解绑只删 binding 不动 resource，文案如实说明。
 * Feature-flag 门控在容器侧完成（flag off 时本 TAB 不渲染）。
 *
 * 双作用域（CoCo 双形态，spec §D1/§F3）：传 `issueId` 时列表 / 绑定 / 解绑走工作项级
 * endpoint（`/api/issues/{id}/assets`），搜索候选仍是项目级（候选源是项目仓库集合），
 * 绑定目标经 URL 落到该 issue。不传 issueId 时即项目级 TAB。
 */
export function AssetTab({
  projectId,
  issueId,
}: {
  projectId: string;
  issueId?: string;
}) {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  // Filter state is isolated per scope so a work-item view never leaks the
  // project TAB's category / page choice (and vice versa).
  const storeKey = assetFilterKey(wsId, issueId ? `${projectId}#issue:${issueId}` : projectId);
  const filters = useAssetFilters(storeKey);
  const { setCategory, setName, setPage } = useAssetFilterStore();

  const [bindOpen, setBindOpen] = useState(false);
  const [unbindTarget, setUnbindTarget] = useState<AssetBinding | null>(null);
  // 展示形态：表格（默认，分页）⇄ 卡片画廊（全量平铺）。工作项窄栏只保留表格。
  const [view, setView] = useState<"table" | "grid">("table");
  // 行内多选 + 批量编辑
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchEditOpen, setBatchEditOpen] = useState(false);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // §7.4.1：筛选 / 分页 / 视图 / 作用域变化即清空选择，避免跨页幽灵选择。
  useEffect(() => {
    setSelectedIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [filters.category, filters.name, filters.page, view, issueId]);

  const categoryLabels = useMemo<Record<AssetCategory, string>>(
    () => ({
      code_repository: t(($) => $.categories.code_repository),
      application: t(($) => $.categories.application),
      package: t(($) => $.categories.package),
      knowledge_repo: t(($) => $.categories.knowledge_repo),
      knowledge_group: t(($) => $.categories.knowledge_group),
      other: t(($) => $.categories.other),
    }),
    [t],
  );

  const listFilters = useMemo(
    () => ({
      page: filters.page,
      pageSize: filters.pageSize,
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.name.trim() ? { name: filters.name.trim() } : {}),
    }),
    [filters.page, filters.pageSize, filters.category, filters.name],
  );

  // Single options object (see core assetListOptions) so useQuery overload
  // inference stays stable across the project / issue scope switch.
  const listQuery = useQuery(assetListOptions(wsId, projectId, listFilters, issueId));
  const page = listQuery.data;
  const rows = useMemo(() => page?.items ?? [], [page]);

  // §7.4.2：解绑 / 刷新后剔除已不存在的选择 ID，批量提交只带存活行。
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const { ids, changed } = pruneSelectedIds(prev, rows);
      return changed ? ids : prev;
    });
  }, [rows]);

  const toggleSelectAll = useCallback(() => {
    const allIds = rows.map((r) => r.id);
    setSelectedIds((prev) => {
      if (allIds.length > 0 && allIds.every((id) => prev.has(id))) {
        const next = new Set(prev);
        allIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...allIds]);
    });
  }, [rows]);

  // 统计条 / 卡片视图的全量数据（同筛选条件，pageSize 拉满）；与分页列表互不影响。
  const statsFilters = useMemo(
    () => ({
      page: 1,
      pageSize: 500,
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.name.trim() ? { name: filters.name.trim() } : {}),
    }),
    [filters.category, filters.name],
  );
  const fullQuery = useQuery(assetListOptions(wsId, projectId, statsFilters, issueId));
  const allItems = useMemo(() => fullQuery.data?.items ?? [], [fullQuery.data]);

  // 可预览子集（档案导入带 artifact_id / 批量上传带 attachment_id）：
  // 预览弹窗在此分组内 ←/→ 导航，链接类资产不入组。
  const previewable = useMemo(
    () => allItems.filter((row) => assetPreviewMode(row) !== null),
    [allItems],
  );
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const openPreview = (row: AssetBinding) => {
    const idx = previewable.findIndex((item) => item.id === row.id);
    if (idx >= 0) setPreviewIdx(idx);
  };

  // Both scope mutations are constructed unconditionally (hooks can't branch);
  // the one matching the current scope is used at the call sites.
  const unbindProject = useUnbindProjectAsset(wsId, projectId);
  const unbindIssue = useUnbindIssueAsset(wsId, issueId ?? "");
  const unbindMutation = issueId ? unbindIssue : unbindProject;
  // 档案 → 资产批量导入（仅项目级空态提供；幂等，重复点击只增量导入）。
  const syncArchive = useSyncAssetsFromArchive(wsId, projectId);
  const handleSyncFromArchive = async () => {
    try {
      const res = await syncArchive.mutateAsync(undefined);
      if (res.imported > 0) {
        toast.success(t(($) => $.toast.archive_synced, { imported: res.imported }));
      } else {
        toast.info(t(($) => $.toast.archive_sync_noop));
      }
    } catch {
      toast.error(t(($) => $.toast.archive_sync_failed));
    }
  };
  const handleUnbind = async () => {
    if (!unbindTarget) return;
    const target = unbindTarget;
    try {
      await unbindMutation.mutateAsync(target.id);
      toast.success(t(($) => $.toast.unbound));
    } catch {
      toast.error(t(($) => $.toast.unbind_failed));
    } finally {
      setUnbindTarget(null);
    }
  };

  // 批量提交：项目/工作项作用域固定为本项目，一次调用项目级事务端点（§7.4.4）。
  const batchMutation = useBatchUpdateAssetMeta(wsId);
  const handleBatchSubmit = (request: Parameters<typeof batchMutation.mutate>[0]["data"]) => {
    batchMutation.mutate(
      { projectId, data: request },
      {
        onSuccess: (res) => {
          toast.success(t(($) => $.toast.batch_updated, { count: res.updated }));
          setSelectedIds(new Set());
          setBatchEditOpen(false);
        },
        onError: () => toast.error(t(($) => $.toast.batch_update_failed)),
      },
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="asset-tab">
      <div>
        <h2 className="text-body font-semibold">{t(($) => $.title)}</h2>
        <p className="text-caption text-muted-foreground">{t(($) => $.subtitle)}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant={filters.category === null ? "default" : "outline"}
            onClick={() => setCategory(storeKey, null)}
          >
            {t(($) => $.categories.all)}
          </Button>
          {ASSET_CATEGORIES.map((cat) => (
            <Button
              key={cat}
              type="button"
              size="xs"
              variant={filters.category === cat ? "default" : "outline"}
              aria-pressed={filters.category === cat}
              onClick={() => setCategory(storeKey, filters.category === cat ? null : cat)}
            >
              {categoryLabels[cat]}
            </Button>
          ))}
        </div>
        <div className="relative min-w-48 max-w-sm flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.name}
            onChange={(event) => setName(storeKey, event.target.value)}
            placeholder={t(($) => $.search_placeholder)}
            aria-label={t(($) => $.search_placeholder)}
            className="pl-8"
          />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {!issueId && allItems.length > 0 ? (
            <div className="flex items-center gap-0.5 rounded-lg border border-surface-border p-0.5">
              <Button
                type="button"
                size="xs"
                variant={view === "table" ? "secondary" : "ghost"}
                aria-label={t(($) => $.view_switch.list)}
                title={t(($) => $.view_switch.list)}
                onClick={() => setView("table")}
              >
                <List />
              </Button>
              <Button
                type="button"
                size="xs"
                variant={view === "grid" ? "secondary" : "ghost"}
                aria-label={t(($) => $.view_switch.grid)}
                title={t(($) => $.view_switch.grid)}
                onClick={() => setView("grid")}
              >
                <LayoutGrid />
              </Button>
            </div>
          ) : null}
          <Button type="button" size="sm" onClick={() => setBindOpen(true)}>
            <Plus />
            {t(($) => $.actions.bind)}
          </Button>
        </div>
      </div>

      {!issueId && view === "table" ? <AssetStatsBar items={allItems} /> : null}

      {view === "grid" && !issueId ? (
        allItems.length === 0 ? (
          <div className="rounded-lg border border-surface-border p-8 text-center">
            <p className="text-caption text-muted-foreground">{t(($) => $.empty.no_assets)}</p>
          </div>
        ) : (
          <AssetCardGrid
            rows={allItems}
            categoryLabels={categoryLabels}
            onPreview={openPreview}
            onUnbind={(row) => setUnbindTarget(row)}
            unbindBusyId={unbindMutation.isPending ? unbindTarget?.id : undefined}
          />
        )
      ) : (
      <div className="min-h-0 overflow-y-auto rounded-lg border border-surface-border">
        {listQuery.isPending ? (
          <div className="p-3">
            <QueryLoading rows={5} />
          </div>
        ) : listQuery.isError ? (
          <div className="p-3">
            <QueryError onRetry={() => void listQuery.refetch()} message={String(listQuery.error)} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-caption text-muted-foreground">{t(($) => $.empty.no_assets)}</p>
            {!issueId && !filters.category && !filters.name.trim() ? (
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  disabled={syncArchive.isPending}
                  onClick={() => void handleSyncFromArchive()}
                >
                  <DatabaseZap />
                  {t(($) => $.actions.sync_from_archive)}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <AssetTable
            rows={rows}
            categoryLabels={categoryLabels}
            features={{ inlineEdit: true }}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleAll={toggleSelectAll}
            onPreview={openPreview}
            onUnbind={(row) => setUnbindTarget(row)}
            unbindBusyId={unbindMutation.isPending ? unbindTarget?.id : undefined}
          />
        )}
      </div>
      )}

      {view === "table" ? (
      <>
      <AssetSelectionToolbar
        count={selectedIds.size}
        onClear={() => setSelectedIds(new Set())}
        onBatchEdit={() => setBatchEditOpen(true)}
      />
      <AssetPager
        page={filters.page}
        totalPages={page?.totalPages ?? 0}
        totalCount={page?.totalCount ?? 0}
        onPrev={() => setPage(storeKey, filters.page - 1)}
        onNext={() => setPage(storeKey, filters.page + 1)}
      />
      </>
      ) : null}

      <BindAssetDialog
        projectId={projectId}
        issueId={issueId}
        open={bindOpen}
        onOpenChange={setBindOpen}
        defaultCategory={filters.category ?? "code_repository"}
      />

      <AlertDialog open={unbindTarget !== null} onOpenChange={(open) => !open && setUnbindTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.confirm_unbind.title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.confirm_unbind.desc)}
              {unbindTarget ? (
                <span className="mt-1 block font-medium text-foreground">{unbindTarget.asset_name}</span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.confirm_unbind.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleUnbind();
              }}
            >
              {t(($) => $.confirm_unbind.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AssetPreviewDialog
        projectId={projectId}
        bindings={previewable}
        index={previewIdx ?? 0}
        onIndexChange={setPreviewIdx}
        open={previewIdx !== null}
        onOpenChange={(next) => !next && setPreviewIdx(null)}
      />

      <AssetBatchEditDialog
        open={batchEditOpen}
        onOpenChange={setBatchEditOpen}
        selectedIds={Array.from(selectedIds)}
        isPending={batchMutation.isPending}
        onSubmit={handleBatchSubmit}
      />
    </div>
  );
}

function AssetPager({
  page,
  totalPages,
  totalCount,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  totalCount: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useT("assets");
  if (totalCount === 0) return null;
  return (
    <div className="flex items-center justify-end gap-2">
      <Button type="button" size="xs" variant="outline" disabled={page <= 1} onClick={onPrev}>
        {t(($) => $.pager.prev)}
      </Button>
      <span className="text-caption text-muted-foreground tabular-nums">
        {t(($) => $.pager.page_of, { page, totalPages: Math.max(totalPages, 1) })}
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={page >= totalPages}
        onClick={onNext}
      >
        {t(($) => $.pager.next)}
      </Button>
    </div>
  );
}

/**
 * 绑定资产对话框：搜索候选（智能推荐）/ 手动新增两个入口。候选来自库内既有
 * github_repo 资源 + workspace.repos（后端不新建外部连接），已绑定的禁用。
 */
export function BindAssetDialog({
  projectId,
  issueId,
  open,
  onOpenChange,
  defaultCategory,
}: {
  projectId: string;
  issueId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCategory: AssetCategory;
}) {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const [category, setCategory] = useState<AssetCategory>(defaultCategory);
  const [query, setQuery] = useState("");
  const [relatedOnly, setRelatedOnly] = useState(false);

  const [manualName, setManualName] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualSubtype, setManualSubtype] = useState("");
  // 473：手动录入也能直接打标（阶段 / 角色 / 标签），免二次编辑。
  const [manualStage, setManualStage] = useState<"none" | AssetLifecycleStage>("none");
  const [manualRole, setManualRole] = useState<"none" | AssetRole>("none");
  const [manualTags, setManualTags] = useState("");

  // Candidates are always project-scoped (the source pool is the project's
  // repos); the bind target switches by scope — issue URL carries issue_id.
  const bindProject = useBindProjectAsset(wsId, projectId);
  const bindIssue = useBindIssueAsset(wsId, issueId ?? "");
  const bindMutation = issueId ? bindIssue : bindProject;

  const candidatesQuery = useQuery({
    ...assetCandidatesOptions(wsId, projectId, {
      category,
      ...(query.trim() ? { q: query.trim() } : {}),
      relatedToMe: relatedOnly,
    }),
    enabled: open,
  });

  const categoryLabels = useMemo<Record<AssetCategory, string>>(
    () => ({
      code_repository: t(($) => $.categories.code_repository),
      application: t(($) => $.categories.application),
      package: t(($) => $.categories.package),
      knowledge_repo: t(($) => $.categories.knowledge_repo),
      knowledge_group: t(($) => $.categories.knowledge_group),
      other: t(($) => $.categories.other),
    }),
    [t],
  );

  const reasonLabel = (key: string): string => {
    if (key === "recent") return t(($) => $.reason.recent);
    if (key === "joint") return t(($) => $.reason.joint);
    if (key === "hot") return t(($) => $.reason.hot);
    return "";
  };

  const submit = async (data: BindAssetRequest) => {
    try {
      await bindMutation.mutateAsync(data);
      toast.success(t(($) => $.toast.bound));
      onOpenChange(false);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      toast.error(code === "asset_already_bound" ? t(($) => $.toast.already_bound) : t(($) => $.toast.bind_failed));
    }
  };

  const bindCandidate = (candidate: AssetCandidate) =>
    submit({
      asset_category: candidate.asset_category,
      asset_name: candidate.asset_name,
      asset_subtype: candidate.subtype || null,
      source: candidate.source,
      external_ref: candidate.external_ref,
      resource_id: candidate.resource_id ?? undefined,
      recommended: candidate.recommended,
      recommend_reason: candidate.recommend_reason || null,
    });

  const bindManual = () => {
    const name = manualName.trim();
    if (!name) return;
    const url = manualUrl.trim();
    const tags = manualTags
      .split(/[,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
    submit({
      asset_category: category,
      asset_name: name,
      asset_subtype: manualSubtype.trim() || null,
      source: "manual",
      ...(manualStage !== "none" ? { lifecycle_stage: manualStage } : {}),
      ...(manualRole !== "none" ? { asset_role: manualRole } : {}),
      ...(tags.length ? { tags } : {}),
      external_ref: url ? { url } : {},
    });
  };

  // 回车即提交：表单字段少，避免用户来回点保存按钮。
  const onManualKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (manualName.trim() && !bindMutation.isPending) bindManual();
  };

  const stageItems = useMemo(
    () => [
      { value: "none" as const, label: t(($) => $.stages.none) },
      ...ASSET_LIFECYCLE_STAGES.map((s) => ({ value: s, label: t(($) => $.stages[s]) })),
    ],
    [t],
  );
  const roleItems = useMemo(
    () => [
      { value: "none" as const, label: t(($) => $.roles.none) },
      { value: "input" as const, label: t(($) => $.roles.input) },
      { value: "output" as const, label: t(($) => $.roles.output) },
    ],
    [t],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.actions.bind)}</DialogTitle>
          <DialogDescription>{t(($) => $.subtitle)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1">
          {ASSET_CATEGORIES.map((cat) => (
            <Button
              key={cat}
              type="button"
              size="xs"
              variant={category === cat ? "default" : "outline"}
              onClick={() => setCategory(cat)}
            >
              {categoryLabels[cat]}
            </Button>
          ))}
        </div>

        <Tabs defaultValue="candidates">
          <TabsList variant="line">
            <TabsTrigger value="candidates">{t(($) => $.tabs.candidates)}</TabsTrigger>
            <TabsTrigger value="manual">{t(($) => $.actions.add_manual)}</TabsTrigger>
            <TabsTrigger value="batch">{t(($) => $.tabs.batch)}</TabsTrigger>
          </TabsList>

          <TabsContent value="candidates" className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t(($) => $.search_placeholder)}
                  aria-label={t(($) => $.search_placeholder)}
                  className="pl-8"
                />
              </div>
              <Button
                type="button"
                size="xs"
                variant={relatedOnly ? "default" : "outline"}
                aria-pressed={relatedOnly}
                onClick={() => setRelatedOnly((v) => !v)}
              >
                {t(($) => $.related_to_me)}
              </Button>
            </div>

            <div className="max-h-80 min-h-24 overflow-y-auto rounded-md border border-surface-border">
              {candidatesQuery.isPending ? (
                <div className="p-3">
                  <QueryLoading rows={3} />
                </div>
              ) : (candidatesQuery.data?.candidates ?? []).length === 0 ? (
                <div className="p-6 text-center text-caption text-muted-foreground">
                  {category === "knowledge_repo" || category === "knowledge_group"
                    ? t(($) => $.empty.no_source)
                    : t(($) => $.empty.no_candidates)}
                </div>
              ) : (
                <ul className="divide-y divide-surface-border">
                  {candidatesQuery.data?.candidates.map((candidate, idx) => (
                    <CandidateRow
                      key={`${candidate.resource_id ?? candidate.asset_name}-${idx}`}
                      candidate={candidate}
                      reasonLabel={reasonLabel}
                      busy={bindMutation.isPending}
                      onBind={() => bindCandidate(candidate)}
                    />
                  ))}
                </ul>
              )}
            </div>
          </TabsContent>

          <TabsContent value="manual" className="space-y-3">
            <label className="block space-y-1">
              <span className="text-caption text-muted-foreground">{t(($) => $.manual_form.name_label)}</span>
              <Input
                value={manualName}
                onChange={(event) => setManualName(event.target.value)}
                onKeyDown={onManualKeyDown}
                placeholder={t(($) => $.manual_form.name_placeholder)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-caption text-muted-foreground">{t(($) => $.manual_form.url_label)}</span>
              <Input
                value={manualUrl}
                onChange={(event) => setManualUrl(event.target.value)}
                onKeyDown={onManualKeyDown}
                placeholder={t(($) => $.manual_form.url_placeholder)}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="text-caption text-muted-foreground">{t(($) => $.manual_form.subtype_label)}</span>
                <Input
                  value={manualSubtype}
                  onChange={(event) => setManualSubtype(event.target.value)}
                  onKeyDown={onManualKeyDown}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-caption text-muted-foreground">{t(($) => $.manual_form.tags_label)}</span>
                <Input
                  value={manualTags}
                  onChange={(event) => setManualTags(event.target.value)}
                  onKeyDown={onManualKeyDown}
                  placeholder={t(($) => $.manual_form.tags_placeholder)}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-caption text-muted-foreground">{t(($) => $.manual_form.stage_label)}</span>
                <Select
                  items={stageItems}
                  value={manualStage}
                  onValueChange={(value) => value && setManualStage(value as "none" | AssetLifecycleStage)}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {stageItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="block space-y-1">
                <span className="text-caption text-muted-foreground">{t(($) => $.manual_form.role_label)}</span>
                <Select
                  items={roleItems}
                  value={manualRole}
                  onValueChange={(value) => value && setManualRole(value as "none" | AssetRole)}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roleItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t(($) => $.actions.cancel)}
              </Button>
              <Button type="button" disabled={!manualName.trim() || bindMutation.isPending} onClick={bindManual}>
                <Link2 />
                {t(($) => $.actions.save)}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="batch" className="pt-1">
            <BatchImportPanel projectId={projectId} category={category} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function CandidateRow({
  candidate,
  reasonLabel,
  busy,
  onBind,
}: {
  candidate: AssetCandidate;
  reasonLabel: (key: string) => string;
  busy: boolean;
  onBind: () => void;
}) {
  const { t } = useT("assets");
  const url = candidate.external_ref?.url;
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-caption font-medium" title={candidate.asset_name}>
            {candidate.asset_name}
          </span>
          {candidate.recommended ? (
            <Badge variant="secondary" className="shrink-0 gap-1">
              <Sparkles className="size-3" />
              {t(($) => $.recommended_label)}
            </Badge>
          ) : null}
        </div>
        <div className="truncate text-micro text-muted-foreground">
          {reasonLabel(candidate.recommend_reason) || url || candidate.source}
        </div>
      </div>
      <Button
        type="button"
        size="xs"
        variant={candidate.already_bound ? "ghost" : "outline"}
        disabled={candidate.already_bound || busy}
        onClick={onBind}
      >
        {candidate.already_bound ? (
          t(($) => $.already_bound)
        ) : (
          <>
            <Plus />
            {t(($) => $.actions.bind_now)}
          </>
        )}
      </Button>
    </li>
  );
}
