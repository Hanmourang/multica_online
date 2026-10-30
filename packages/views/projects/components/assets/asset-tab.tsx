"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DatabaseZap,
  FolderKanban,
  LayoutGrid,
  Link2,
  List,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  ASSET_CATEGORIES,
  ASSET_LIFECYCLE_STAGES,
  type AssetCandidate,
  type AssetCategory,
  type AssetBinding,
  type AssetIssueLink,
  type AssetLifecycleStage,
  type AssetRole,
  type BindAssetRequest,
} from "@multica/core/types";
import {
  assetCandidatesOptions,
  assetListOptions,
  workspaceOverviewOptions,
} from "@multica/core/assets/queries";
import { useWorkspacePaths } from "@multica/core/paths";
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
import { AssetTable, type AssetIssueInfo } from "./components/asset-table";
import type { InlineIssueCandidate } from "./components/asset-inline-edit";
import { AssetCardGrid } from "./components/asset-card-grid";
import { AssetSelectionToolbar } from "./components/asset-selection-toolbar";
import { AssetBatchEditDialog } from "./components/asset-batch-edit-dialog";
import { pruneSelectedIds } from "./components/asset-batch-draft";
import { estimateFillPageSize, useFillPageSize } from "./hooks/use-fill-page-size";

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
  const { setName, setPage, setPageSize } = useAssetFilterStore();

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

  // 首屏先量再取数：页尺寸是测出来的，而查询在渲染期就会发出，不等一次
  // 测量就会先用 store 默认的 20 先取一轮、随后再跳成实测值（多一次请求 +
  // 一次行数跳动）。这里等测量落定（或超时兑底）再放行首轮查询。
  const [pageSized, setPageSized] = useState(false);

  // Single options object (see core assetListOptions) so useQuery overload
  // inference stays stable across the project / issue scope switch.
  const listQuery = useQuery({
    ...assetListOptions(wsId, projectId, listFilters, issueId),
    enabled: pageSized && Boolean(wsId && projectId),
  });
  const page = listQuery.data;
  const rows = useMemo(() => page?.items ?? [], [page]);

  // 关联面（需求 / 任务）：列表端点不保证携带 links，而行内编辑必须同时知道
  // 「当前关联」与「可选候选」，因此复用工作区同源的 overview 聚合面（projectId
  // 过滤后只含本项目工作项）。overview 未就绪时不下发候选，关联列退回只读，
  // 因为 PUT meta 的 links 是全量替换，候选未知时写入会误删既有关联。
  const paths = useWorkspacePaths();
  const overviewQuery = useQuery(workspaceOverviewOptions(wsId, projectId));

  // Fit-to-viewport paging (只表格视图量）：分页尺寸由表格盒子的实际高度决定，
  // 不写死每页条数——排满就换页，盒子变高/变矮自动重算。项目级要等 overview
  // 落定再量：统计条用的是 overview 的全量数据，未就绪时它只有骨架高度，
  // 两者在窄容器里相差一行图例，提前量会多算一行行。
  const tableBoxRef = useRef<HTMLDivElement | null>(null);
  useFillPageSize(
    tableBoxRef,
    (size) => {
      setPageSize(storeKey, size);
      setPageSized(true);
    },
    {
      enabled: (!issueId ? view === "table" : true) && !overviewQuery.isPending,
      rowCount: rows.length,
      totalCount: page?.totalCount ?? 0,
    },
  );

  // 兑底：盒子迟迟量不到高（隐藏容器 / overview 未回）时不能永久停在骨架上。
  // 这里不用 store 默认的 20 直接放行——那样一屏会被 20 行撑出滚动；改用视口
  // 高度估一个保守值，测量一旦成功会用实测值覆盖。
  useEffect(() => {
    if (pageSized) return;
    const timer = setTimeout(() => {
      setPageSize(storeKey, estimateFillPageSize(window.innerHeight));
      setPageSized(true);
    }, 1500);
    return () => clearTimeout(timer);
  }, [pageSized, setPageSize, storeKey]);

  // 页尺寸变大或筛选收窄后，页码可能越过末页；拉回末页，避免出现空页。
  useEffect(() => {
    const totalPages = page?.totalPages ?? 0;
    if (totalPages > 0 && filters.page > totalPages) setPage(storeKey, totalPages);
  }, [page?.totalPages, filters.page, setPage, storeKey]);

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

  // 统计条 / 卡片视图 / 预览导航的全量数据源。项目级直接复用 overview 聚合面
  // （不分页，同一个请求），不再单独打一次大页列表——列表端点对 pageSize > 200
  // 会静默回落到 20，统计条就会只数到第一页。工作项级 overview 是项目全量，
  // 不适用于该工作项的预览导航，故退回列表端点的大页读（单个工作项的绑定数
  // 远低于上限）。
  const issueWideQuery = useQuery({
    ...assetListOptions(wsId, projectId, { page: 1, pageSize: 200 }, issueId),
    enabled: Boolean(wsId && issueId),
  });
  const allItems = useMemo<AssetBinding[]>(() => {
    if (issueId) return issueWideQuery.data?.items ?? [];
    const items = overviewQuery.data?.bindings ?? [];
    const q = filters.name.trim().toLowerCase();
    return items.filter(
      (b) =>
        (!filters.category || b.asset_category === filters.category) &&
        (!q || b.asset_name.toLowerCase().includes(q)),
    );
  }, [issueId, issueWideQuery.data, overviewQuery.data, filters.category, filters.name]);

  // 关联面（需求 / 任务）的 overview 聚合面已在测量之前声明，这里只取跨页的
  // links 映射。
  const linksById = useMemo(() => {
    const map = new Map<string, AssetIssueLink[]>();
    for (const binding of overviewQuery.data?.bindings ?? []) {
      if (binding.links?.length) map.set(binding.id, binding.links);
    }
    return map;
  }, [overviewQuery.data]);

  const issueInfoById = useMemo(() => {
    const map = new Map<string, AssetIssueInfo>();
    for (const issue of overviewQuery.data?.issues ?? []) {
      map.set(issue.id, {
        title: issue.title,
        status: issue.status,
        is_requirement: issue.is_requirement,
      });
    }
    return map;
  }, [overviewQuery.data]);

  const linkCandidates = useMemo(() => {
    const requirement: InlineIssueCandidate[] = [];
    const task: InlineIssueCandidate[] = [];
    for (const issue of overviewQuery.data?.issues ?? []) {
      const candidate: InlineIssueCandidate = {
        id: issue.id,
        title: issue.title,
        status: issue.status,
        project_id: issue.project_id,
        is_requirement: issue.is_requirement,
      };
      (issue.is_requirement ? requirement : task).push(candidate);
    }
    return { requirement, task };
  }, [overviewQuery.data]);

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
      {/* 标题与说明并成一行：TAB 本身已叫「资产管理」，再堆两行会白吃首屏高度 */}
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="shrink-0 text-label font-semibold">{t(($) => $.title)}</h2>
        <p className="min-w-0 truncate text-micro text-muted-foreground">{t(($) => $.subtitle)}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* 「分类」筛选已随字段下线移除（后端字段保留，创建链路写默认分类）；
            名称检索与视图切换不变。 */}
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
                size="icon-sm"
                variant={view === "table" ? "secondary" : "ghost"}
                aria-label={t(($) => $.view_switch.list)}
                title={t(($) => $.view_switch.list)}
                onClick={() => setView("table")}
              >
                <List />
              </Button>
              <Button
                type="button"
                size="icon-sm"
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

      {!issueId && view === "table" ? (
        <AssetStatsBar items={allItems} pending={overviewQuery.isPending} />
      ) : null}

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
      <div ref={tableBoxRef} className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-surface-border">
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
            features={{
              inlineEdit: true,
              showLinks: true,
              linksById,
              issueInfoById,
              // overview 未就绪时不给候选：关联列保持只读，避免全量替换写入误删。
              linkCandidates: overviewQuery.data ? linkCandidates : undefined,
              issueHref: (issueId) => paths.issueDetail(issueId),
            }}
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
        pending={listQuery.isPending}
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
  pending = false,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  totalCount: number;
  /** 首轮数据未到：占位但不移除，免得分页条消失时表格盒子临时变高。 */
  pending?: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useT("assets");
  if (totalCount === 0 && !pending) return null;
  // `pe-chat-launcher`：分页条贴在右下角，而全局聊天入口（FloatingChat）就浮在
  // 那个角上；不避让的话「下一页」会被它盖住，点击落空（表现为要点两次才翻页）。
  return (
    <div className={`pe-chat-launcher flex items-center justify-end gap-2${pending ? " invisible" : ""}`}>
      <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={onPrev}>
        {t(($) => $.pager.prev)}
      </Button>
      <span className="text-caption text-muted-foreground tabular-nums">
        {t(($) => $.pager.page_of, { page, totalPages: Math.max(totalPages, 1) })}
      </span>
      <Button
        type="button"
        size="sm"
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
 * 绑定资产对话框：搜索候选（智能推荐）/ 手动新增 / 目录导入（上传新增）三个入口。
 * 候选来自库内既有 github_repo 资源 + workspace.repos（后端不新建外部连接），
 * 已绑定的禁用。
 *
 * 工作区级「资产管理」页也复用本对话框（该页是跨项目聚合面，没有固定项目上下文），
 * 因此额外支持两个可选能力：`projectOptions` 在对话框内选择目标项目（上传/绑定
 * 都落该项目），`defaultTab` 让「上传新增」直接落在目录导入页、「绑定」落在候选页。
 */
export function BindAssetDialog({
  projectId,
  issueId,
  open,
  onOpenChange,
  defaultCategory,
  defaultTab = "candidates",
  projectOptions,
  onProjectChange,
}: {
  projectId: string;
  issueId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCategory: AssetCategory;
  /** 打开时默认落在哪个 TAB；仅初始化时生效，每次重新打开会重置。 */
  defaultTab?: "candidates" | "manual" | "batch";
  /** 跨项目作用域（工作区页）传入：对话框内选目标项目；不传则不渲染选择器。 */
  projectOptions?: readonly { value: string; label: string }[];
  onProjectChange?: (projectId: string) => void;
}) {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const [category, setCategory] = useState<AssetCategory>(defaultCategory);
  const [query, setQuery] = useState("");
  const [relatedOnly, setRelatedOnly] = useState(false);
  // 候选为空时要能把人送进手动表单，Tabs 必须受控（原先非受控，等于没有去路）。
  const [tab, setTab] = useState<"candidates" | "manual" | "batch">(defaultTab);

  // 同一份对话框实例会被「上传新增」与「绑定」两个入口复用：每次打开回到入口
  // 对应的 TAB 并把分类重置为该入口的默认值，避免上次的分类/关键词残留。
  useEffect(() => {
    if (!open) return;
    setTab(defaultTab);
    setCategory(defaultCategory);
  }, [open, defaultTab, defaultCategory]);

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

  const candidates = candidatesQuery.data?.candidates ?? [];
  // 整列都是置灰行时同样无法绑定：除了把未绑定项提上来（后端排序），还要说清楚原因。
  const allBound = candidates.length > 0 && candidates.every((item) => item.already_bound);

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

  // 「上传新增」入口直接落在目录导入页，此时标题/说明换成上传口径：
  // 两入口共用同一实例，点「上传」却看到「绑定」标题会读成点错了。
  const isUpload = tab === "batch";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* DialogContent 基类带 sm:max-w-sm：裸写 max-w-2xl 在 ≥sm 会被它压回 384px，
          内部两列表单随即横向溢出错出弹窗边界 —— 宽度必须写在同档位前缀上。 */}
      <DialogContent className="max-h-[calc(100vh-3rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isUpload ? t(($) => $.intake.title_batch) : t(($) => $.actions.bind)}
          </DialogTitle>
          <DialogDescription>
            {isUpload ? t(($) => $.intake.desc_batch) : t(($) => $.subtitle)}
          </DialogDescription>
        </DialogHeader>

        {/* 跨项目作用域（工作区页）：绑定/上传都必须落到具体项目，先选目标。 */}
        {projectOptions && projectOptions.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-surface-border bg-surface-hover/50 px-3 py-2">
            <span className="flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground">
              <FolderKanban className="size-3.5" />
              {t(($) => $.intake.project_label)}
            </span>
            <Select
              items={projectOptions as { value: string; label: string }[]}
              value={projectId}
              onValueChange={(value) => value && onProjectChange?.(value)}
            >
              <SelectTrigger size="sm" className="w-44 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projectOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
              {t(($) => $.intake.project_hint)}
            </span>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="mr-0.5 shrink-0 text-caption text-muted-foreground">
            {t(($) => $.manual_form.category_label)}
          </span>
          {ASSET_CATEGORIES.map((cat) => (
            <Button
              key={cat}
              type="button"
              size="xs"
              variant={category === cat ? "default" : "outline"}
              aria-pressed={category === cat}
              className="rounded-full"
              onClick={() => setCategory(cat)}
            >
              {categoryLabels[cat]}
            </Button>
          ))}
        </div>

        <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)} className="min-w-0">
          <TabsList variant="line">
            <TabsTrigger value="candidates">{t(($) => $.tabs.candidates)}</TabsTrigger>
            <TabsTrigger value="manual">{t(($) => $.actions.add_manual)}</TabsTrigger>
            <TabsTrigger value="batch">{t(($) => $.tabs.batch)}</TabsTrigger>
          </TabsList>

          <TabsContent value="candidates" className="min-w-0 space-y-2">
            <div className="flex min-w-0 items-center gap-2">
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

            <div className="max-h-80 min-h-24 overflow-y-auto rounded-lg border border-surface-border">
              {candidatesQuery.isPending ? (
                <div className="p-3">
                  <QueryLoading rows={3} />
                </div>
              ) : candidates.length === 0 ? (
                <div className="flex flex-col items-center gap-2 p-6 text-center text-caption text-muted-foreground">
                  <span>
                    {category === "knowledge_repo" || category === "knowledge_group"
                      ? t(($) => $.empty.no_source)
                      : t(($) => $.empty.no_candidates)}
                  </span>
                  <Button type="button" size="xs" variant="outline" onClick={() => setTab("manual")}>
                    <Plus />
                    {t(($) => $.empty.go_manual)}
                  </Button>
                </div>
              ) : (
                <ul className="divide-y divide-surface-border">
                  {candidates.map((candidate, idx) => (
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

            {allBound ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-surface-border bg-muted/40 px-3 py-2 text-caption text-muted-foreground">
                <span>{t(($) => $.empty.all_bound)}</span>
                <Button type="button" size="xs" variant="outline" onClick={() => setTab("manual")}>
                  <Plus />
                  {t(($) => $.empty.go_manual)}
                </Button>
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="manual" className="min-w-0 space-y-3">
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

          <TabsContent value="batch" className="min-w-0">
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
    <li className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-surface-hover/50">
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
