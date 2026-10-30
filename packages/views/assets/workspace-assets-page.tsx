"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DatabaseZap,
  FolderKanban,
  LayoutGrid,
  Link2,
  List,
  Network,
  Pencil,
  Search,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  ASSET_LIFECYCLE_STAGES,
  type AssetBinding,
  type AssetCategory,
  type AssetIssueLink,
  type AssetLifecycleStage,
  type AssetLinkType,
  type AssetRole,
  type BatchUpdateAssetMetaRequest,
  type UpdateAssetMetaRequest,
  type WorkspaceAssetBinding,
} from "@multica/core/types";
import {
  workspaceAssetsOptions,
  workspaceOverviewOptions,
} from "@multica/core/assets/queries";
import { projectListOptions } from "@multica/core/projects";
import {
  useBatchUpdateAssetMeta,
  useSyncAssetsFromArchive,
  useUnbindWorkspaceAsset,
  useUpdateAssetMeta,
} from "@multica/core/assets/mutations";
import {
  assetFilterKey,
  useAssetFilters,
  useAssetFilterStore,
} from "@multica/core/assets/store";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Input } from "@multica/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@multica/ui/components/ui/sheet";
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
import { useT } from "../i18n";
import { AppLink } from "../navigation";
import {
  PAGE_GUTTER,
  PAGE_TOOLBAR,
  PageHeader,
} from "../layout/page-header";
import {
  REQUIREMENT_DOT_CLASS,
  TASK_DOT_CLASS,
  statusToneClass,
} from "../projects/components/assets/components/asset-status-tone";
import { QueryError, QueryLoading } from "../projects/components/archive/query-states";
import { BindAssetDialog } from "../projects/components/assets/asset-tab";
import { AssetStatsBar } from "../projects/components/assets/components/asset-stats-bar";
import {
  AssetPreviewDialog,
  assetPreviewMode,
} from "../projects/components/assets/components/asset-preview-dialog";
import { AssetTable, type AssetIssueInfo, type AssetLinkCandidates } from "../projects/components/assets/components/asset-table";
import type { InlineIssueCandidate } from "../projects/components/assets/components/asset-inline-edit";
import { AssetCardGrid } from "../projects/components/assets/components/asset-card-grid";
import { AssetSelectionToolbar } from "../projects/components/assets/components/asset-selection-toolbar";
import { AssetBatchEditDialog } from "../projects/components/assets/components/asset-batch-edit-dialog";
import {
  groupSelectedByProject,
  pruneSelectedIds,
  submitBatchByProject,
} from "../projects/components/assets/components/asset-batch-draft";
import {
  estimateFillPageSize,
  useFillPageSize,
} from "../projects/components/assets/hooks/use-fill-page-size";

/**
 * 工作区级「资产管理」独立模块（左侧栏 工作区 → 资产管理）。
 *
 * 对标原型 v2（assets-stage-archive-prototype-v2.html）：在 471 绑定层之上落到
 * 473 的「阶段 × 输入/产物 × 标签 × 需求/Bug 关联」，提供三个视图——
 *  1. 列表：服务端分页的浏览/检索/编辑/解绑主面（阶段/角色/标签/关联列），
 *     展示层与项目「资产管理」TAB 对齐：统计条 + 表格⇄卡片画廊切换 + 分类色块/
 *     阶段角色徽标/标签 chips + 预览对话框（复用 asset-visuals / stats-bar /
 *     preview-dialog 同一套组件）；
 *  2. 阶段矩阵：按 S1-S4/general/未标阶段分列，快速回答「这个阶段有哪些资产」；
 *  3. 工作项 × 资产：以需求/Bug 为主键反查关联资产及其链型。
 *
 * 项目下拉过滤：选中单项目时列表/矩阵/关联都按项目收窄（page 走服务端
 * projectId 参数，overview 走其 projectId 口径），并解锁项目 TAB 同款的绑定
 * 对话框与「档案 → 资产」同步入口（两者 endpoint 都是项目级，全域下无意义）。
 *
 * 数据面：列表走 GET /api/assets/page（服务端过滤 + 分页）；矩阵 / 关联视图与
 * 编辑抽屉的候选走 GET /api/assets/overview（全量含 links，上限 1000，前端内存
 * 分组，避免 N+1）。两互补：分页面省略 links（形状稳定），overview 不分页。
 *
 * 解绑 / 编辑复用项目级端点（binding 行自带 project_id）；编辑抽屉保存走
 * PUT .../meta 的 patch 语义（stage/role 空串 = 清除，links 数组 = 全量替换）。
 * 「档案关联」TAB 依赖档案文档 API，本轮暂缓。Feature-flag（asset_module）门控
 * 在侧栏入口完成。
 */
type AssetView = "list" | "matrix" | "issues";
type StageFilter = "all" | "none" | AssetLifecycleStage;
type RoleFilter = "all" | "none" | AssetRole;

const MATRIX_COLUMNS: readonly ("none" | AssetLifecycleStage)[] = [
  ...ASSET_LIFECYCLE_STAGES,
  "none",
];

export function WorkspaceAssetsPage() {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();

  // Isolated filter state for the workspace-wide scope (never leaks a project
  // TAB's category / page selection).
  const storeKey = assetFilterKey(wsId, "__workspace__");
  const filters = useAssetFilters(storeKey);
  const { setName, setPage, setPageSize } = useAssetFilterStore();

  const [view, setView] = useState<AssetView>("list");
  // 列表视图内部形态：表格（默认，分页）⇄ 卡片画廊，口径同项目 TAB。
  const [listView, setListView] = useState<"table" | "grid">("table");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  // 首轮查询等首次测量落定（或超时兑底）再放行，见下方 useFillPageSize。
  const [pageSized, setPageSized] = useState(false);
  // 项目下拉过滤："all" = 全域；选中单项目时解锁绑定 / 档案同步等项目能力。
  const [projectFilter, setProjectFilter] = useState<string>("all");
  // 新增入口（上传 / 绑定）的目标项目 + 默认 TAB：本页是跨项目聚合面，
  // 端点仍是项目级，所以对话框内先选目标项目。
  const [bindOpen, setBindOpen] = useState(false);
  const [bindTab, setBindTab] = useState<"candidates" | "batch">("candidates");
  const [bindProjectId, setBindProjectId] = useState<string>("");
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  // binding 行自带 project_id，解绑 / 编辑只需 AssetBinding 形状（overview 数据源）。
  const [unbindTarget, setUnbindTarget] = useState<AssetBinding | null>(null);
  const [editTarget, setEditTarget] = useState<AssetBinding | null>(null);
  // 行内多选 + 跨项目批量（五阶段对齐 plan §7.3/§7.4）：选择只作用于当前已加载行集。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [batchPending, setBatchPending] = useState(false);
  const [batchNote, setBatchNote] = useState<string | undefined>(undefined);

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
  const stageLabels = useMemo<Record<AssetLifecycleStage, string>>(
    () => ({
      S0: t(($) => $.stages.S0),
      S1: t(($) => $.stages.S1),
      S2: t(($) => $.stages.S2),
      S3: t(($) => $.stages.S3),
      S4: t(($) => $.stages.S4),
      S5: t(($) => $.stages.S5),
      general: t(($) => $.stages.general),
    }),
    [t],
  );
  const linkTypeLabels = useMemo<Record<AssetLinkType, string>>(
    () => ({
      depends_on: t(($) => $.link_types.depends_on),
      produces: t(($) => $.link_types.produces),
      resolves: t(($) => $.link_types.resolves),
    }),
    [t],
  );

  const listFilters = useMemo(
    () => ({
      page: filters.page,
      pageSize: filters.pageSize,
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.name.trim() ? { name: filters.name.trim() } : {}),
      ...(projectFilter !== "all" ? { projectId: projectFilter } : {}),
      // 阶段 / 对象下推服务端：分页总数与筛选结果同口径，每页仍是“排满”的行数，
      // 不会因为页内二次过滤只剩几行而留白。
      ...(stageFilter !== "all" ? { stage: stageFilter } : {}),
      ...(roleFilter !== "all" ? { role: roleFilter } : {}),
    }),
    [
      filters.page,
      filters.pageSize,
      filters.category,
      filters.name,
      projectFilter,
      stageFilter,
      roleFilter,
    ],
  );

  const listQuery = useQuery({
    ...workspaceAssetsOptions(wsId, listFilters),
    // 首屏先量再取数：页尺寸是测出来的，不等一次测量就会先用 store 默认的
    // 20 取一轮、随后再跳成实测值（多一次请求 + 一次行数跳动）。
    enabled: pageSized && Boolean(wsId),
  });
  const page = listQuery.data;
  const rows = useMemo(() => page?.items ?? [], [page]);

  // 矩阵 / 工作项×资产视图与编辑抽屉的聚合面（含 links + 候选工作项）；
  // 选中项目时服务端按 projectId 收窄，与分页列表口径一致。声明在测量之前：
  // 统计条的终态高度取决于它（骨架与真实条在窄容器里差一行图例）。
  const overviewQuery = useQuery(
    workspaceOverviewOptions(wsId, projectFilter !== "all" ? projectFilter : undefined),
  );
  const overview = overviewQuery.data;

  // Fit-to-viewport paging（仅表格形态）：每页条数由表格盒子的实际高度决定，
  // 排满即换页。筛选都在服务端完成，所以量到的行数就是最终行数；等 overview
  // 落定再量，才能量到统计条定型后的高度。
  const tableBoxRef = useRef<HTMLDivElement | null>(null);
  useFillPageSize(
    tableBoxRef,
    (size) => {
      setPageSize(storeKey, size);
      setPageSized(true);
    },
    {
      enabled: view === "list" && listView === "table" && !overviewQuery.isPending,
      rowCount: rows.length,
      totalCount: page?.totalCount ?? 0,
    },
  );

  // 兑底：盒子迟迟量不到高（隐藏容器 / overview 未回）时不能永久停在骨架上。
  // 不用 store 默认的 20 直接放行——那样一屏会被 20 行撑出滚动；改用视口高度
  // 估一个保守值，测量一旦成功会用实测值覆盖。
  useEffect(() => {
    if (pageSized) return;
    const timer = setTimeout(() => {
      setPageSize(storeKey, estimateFillPageSize(window.innerHeight));
      setPageSized(true);
    }, 1500);
    return () => clearTimeout(timer);
  }, [pageSized, setPageSize, storeKey]);

  // 页尺寸变大 / 筛选收窄后页码可能越界，拉回末页避免空页。
  useEffect(() => {
    const totalPages = page?.totalPages ?? 0;
    if (totalPages > 0 && filters.page > totalPages) setPage(storeKey, totalPages);
  }, [page?.totalPages, filters.page, setPage, storeKey]);

  const filteredOverviewBindings = useMemo(() => {
    const items = overview?.bindings ?? [];
    const q = filters.name.trim().toLowerCase();
    return items.filter(
      (b) =>
        (!filters.category || b.asset_category === filters.category) &&
        (!q || b.asset_name.toLowerCase().includes(q)) &&
        (stageFilter === "all" ||
          (stageFilter === "none" ? !b.lifecycle_stage : b.lifecycle_stage === stageFilter)) &&
        (roleFilter === "all" ||
          (roleFilter === "none" ? !b.asset_role : b.asset_role === roleFilter)),
    );
  }, [overview, filters.category, filters.name, stageFilter, roleFilter]);

  // 可预览子集（对齐项目 TAB）：预览弹窗在此分组内 ←/→ 导航，链接类资产不入组。
  // 预览作用域逐行取 binding.project_id（asset-preview-dialog 已按行分流）。
  const previewable = useMemo(
    () => filteredOverviewBindings.filter((row) => assetPreviewMode(row) !== null),
    [filteredOverviewBindings],
  );
  const openPreview = (row: AssetBinding) => {
    const idx = previewable.findIndex((item) => item.id === row.id);
    if (idx >= 0) setPreviewIdx(idx);
  };

  // 分页列表省略 links（形状稳定），编辑 / 关联列从 overview 按 id 联查。
  const linksById = useMemo(() => {
    const map = new Map<string, AssetIssueLink[]>();
    for (const b of overview?.bindings ?? []) map.set(b.id, b.links ?? []);
    return map;
  }, [overview]);

  // issue_id → 标题/状态/是否需求：供共享表格分「需求 / 任务」两列，
  // 并支撑徽标点开 Popover 明细（标题深链 + 状态色徽）。
  const issueInfoById = useMemo(() => {
    const map = new Map<string, AssetIssueInfo>();
    for (const i of overview?.issues ?? []) {
      map.set(i.id, { title: i.title, status: i.status, is_requirement: i.is_requirement ?? false });
    }
    return map;
  }, [overview]);

  // 行内关联编辑的候选（按 is_requirement 分桶）：overview 未就绪时不开放
  // 行内关联——PUT meta 的 links 是全量替换，候选未知时写入会误删既有关联。
  const inlineLinkCandidates = useMemo<AssetLinkCandidates | undefined>(() => {
    if (!overview) return undefined;
    const requirement: InlineIssueCandidate[] = [];
    const task: InlineIssueCandidate[] = [];
    for (const i of overview.issues ?? []) {
      const candidate: InlineIssueCandidate = {
        id: i.id,
        title: i.title,
        status: i.status,
        project_id: i.project_id,
        is_requirement: i.is_requirement ?? false,
      };
      (i.is_requirement ? requirement : task).push(candidate);
    }
    return { requirement, task };
  }, [overview]);

  // 可选行集：表格形态 = 当前页行；卡片形态 = 筛选后全量 overview（与分页解耦）。
  const selectableRows = useMemo<AssetBinding[]>(
    () => (listView === "grid" ? filteredOverviewBindings : rows),
    [listView, filteredOverviewBindings, rows],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // 全选只作用于当前已加载行集（§7.4.1）。
  const toggleSelectAll = useCallback(() => {
    const allIds = selectableRows.map((r) => r.id);
    setSelectedIds((prev) => {
      if (allIds.length > 0 && allIds.every((id) => prev.has(id))) {
        const next = new Set(prev);
        allIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...allIds]);
    });
  }, [selectableRows]);

  // §7.4.1：筛选 / 分页 / 视图 / 作用域变化即清空选择，避免跨页幽灵选择。
  useEffect(() => {
    setSelectedIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [filters.category, filters.name, filters.page, view, listView, stageFilter, roleFilter, projectFilter]);

  // §7.4.2：解绑 / 刷新后剔除已不存在的选择 ID，批量提交只带存活行。
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const { ids, changed } = pruneSelectedIds(prev, selectableRows);
      return changed ? ids : prev;
    });
  }, [selectableRows]);

  const unbindMutation = useUnbindWorkspaceAsset(wsId);
  const handleUnbind = async () => {
    if (!unbindTarget) return;
    try {
      await unbindMutation.mutateAsync({
        projectId: unbindTarget.project_id,
        bindingId: unbindTarget.id,
      });
      toast.success(t(($) => $.toast.unbound));
    } catch {
      toast.error(t(($) => $.toast.unbind_failed));
    } finally {
      setUnbindTarget(null);
    }
  };

  // 项目下拉数据源 + id→标题映射（项目已删时卡片 / 表格的「绑定到」列兜底）。
  const projectsQuery = useQuery(projectListOptions(wsId));
  const projectItems = useMemo(
    () => [
      { value: "all", label: t(($) => $.project_filter.all) },
      ...(projectsQuery.data ?? []).map((pr) => ({ value: pr.id, label: pr.title })),
    ],
    [projectsQuery.data, t],
  );
  const projectTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const pr of projectsQuery.data ?? []) map.set(pr.id, pr.title);
    return map;
  }, [projectsQuery.data]);
  // 对话框内选项目用（不含「全部项目」）：上传 / 绑定必须落到具体项目。
  const projectOptions = useMemo(
    () => (projectsQuery.data ?? []).map((pr) => ({ value: pr.id, label: pr.title })),
    [projectsQuery.data],
  );

  /**
   * 新增入口：上传新增（目录导入 TAB）与绑定（候选/手动 TAB）共用同一对话框。
   * 目标项目缺省跟随顶部项目过滤；全域时取列表第一个，用户可在对话框内改。
   */
  const openIntake = (tab: "candidates" | "batch") => {
    const target = projectFilter !== "all" ? projectFilter : projectOptions[0]?.value ?? "";
    if (!target) {
      toast.error(t(($) => $.intake.no_project));
      return;
    }
    setBindProjectId(target);
    setBindTab(tab);
    setBindOpen(true);
  };

  // 档案 → 资产批量导入（对齐项目 TAB 空态）：endpoint 是项目级，仅选中单项目时可用。
  const syncProjectId = projectFilter === "all" ? "" : projectFilter;
  const syncArchive = useSyncAssetsFromArchive(wsId, syncProjectId);
  const handleSyncFromArchive = async () => {
    if (!syncProjectId) return;
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

  const commonProps = {
    categoryLabels,
    stageLabels,
    linkTypeLabels,
    paths: p,
    onEdit: setEditTarget,
  };

  // 跨项目批量（§7.4.4/§7.4.5）：按 project_id 分组顺序调用项目级事务端点，
  // 每项目组事务独立；部分失败时 Dialog 保持打开并保留失败组的选择与表单供重试。
  const batchMutation = useBatchUpdateAssetMeta(wsId);
  const handleBatchSubmit = async (request: BatchUpdateAssetMetaRequest) => {
    if (batchPending) return;
    setBatchPending(true);
    setBatchNote(undefined);
    const groups = groupSelectedByProject(selectableRows, new Set(request.binding_ids));
    const result = await submitBatchByProject(groups, (projectId, bindingIds) =>
      batchMutation.mutateAsync({ projectId, data: { ...request, binding_ids: bindingIds } }),
    );
    setBatchPending(false);
    if (result.failedGroups.length === 0) {
      toast.success(t(($) => $.toast.batch_updated, { count: result.succeededIds.length }));
      setSelectedIds(new Set());
      setBatchEditOpen(false);
      return;
    }
    if (result.succeededIds.length > 0) {
      toast.success(t(($) => $.toast.batch_updated, { count: result.succeededIds.length }));
    }
    // 成功组移除选择，失败组保留供重试；全失败时 Dialog 不关（由容器控制 open）。
    setSelectedIds(new Set(result.failedGroups.flatMap((g) => g.bindingIds)));
    setBatchNote(
      t(($) => $.batch_result.partial, {
        succeeded: groups.size - result.failedGroups.length,
        failed: result.failedGroups.length,
      }),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-assets-page">
      {/* 页头对齐全站 PageHeader 规范（h-12 + px-4 + border-b），不再自写大标题块；
          说明文案降为 micro 级别与标题同基线，省下的 44px 全给列表首屏。 */}
      <PageHeader>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link2 className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="shrink-0 text-title-sm font-semibold">{t(($) => $.workspace_title)}</h1>
          <span className="min-w-0 truncate text-micro text-muted-foreground">
            {t(($) => $.workspace_subtitle)}
          </span>
        </div>
        {/* 新增绑定在项目上下文完成；本页是聚合管理面，给一条回到项目的引导。 */}
        <AppLink
          href={p.projects()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-caption font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <FolderKanban className="size-3.5" />
          {t(($) => $.go_to_projects)}
        </AppLink>
      </PageHeader>

      {/* 一行 chrome：左 = 视图切换（列表 | 阶段矩阵 | 工作项 × 资产），
          右 = 项目过滤 / 表格⇄卡片 / 绑定（与 PageHeader 同栏高、同 gutter） */}
      <div className={PAGE_TOOLBAR}>
        <div className="flex min-w-0 items-center gap-1" role="tablist" aria-label={t(($) => $.views.list)}>
          <ViewTab active={view === "list"} onClick={() => setView("list")} icon={<List className="size-3.5" />}>
            {t(($) => $.views.list)}
          </ViewTab>
          <ViewTab active={view === "matrix"} onClick={() => setView("matrix")} icon={<LayoutGrid className="size-3.5" />}>
            {t(($) => $.views.matrix)}
          </ViewTab>
          <ViewTab active={view === "issues"} onClick={() => setView("issues")} icon={<Network className="size-3.5" />}>
            {t(($) => $.views.issues)}
          </ViewTab>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* 项目下拉过滤：page 端走服务端 projectId，overview 端走其同名口径。 */}
          <Select
            items={projectItems}
            value={projectFilter}
            onValueChange={(value) => {
              if (!value || value === projectFilter) return;
              setProjectFilter(value);
              setPage(storeKey, 1);
            }}
          >
            <SelectTrigger size="sm" className="w-40 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projectItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {view === "list" && filteredOverviewBindings.length > 0 ? (
            <div className="flex items-center gap-0.5 rounded-lg border border-surface-border p-0.5">
              <Button
                type="button"
                size="icon-sm"
                variant={listView === "table" ? "secondary" : "ghost"}
                aria-label={t(($) => $.view_switch.list)}
                title={t(($) => $.view_switch.list)}
                onClick={() => setListView("table")}
              >
                <List />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant={listView === "grid" ? "secondary" : "ghost"}
                aria-label={t(($) => $.view_switch.grid)}
                title={t(($) => $.view_switch.grid)}
                onClick={() => setListView("grid")}
              >
                <LayoutGrid />
              </Button>
            </div>
          ) : null}
          {projectFilter !== "all" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={syncArchive.isPending}
              onClick={() => void handleSyncFromArchive()}
            >
              <DatabaseZap />
              {t(($) => $.actions.sync_from_archive)}
            </Button>
          ) : null}
          {/* 新增入口常驻：全域下在对话框内选目标项目，不再依赖先选项目。 */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={projectOptions.length === 0}
            onClick={() => openIntake("candidates")}
          >
            <Link2 />
            {t(($) => $.actions.bind)}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={projectOptions.length === 0}
            onClick={() => openIntake("batch")}
          >
            <Upload />
            {t(($) => $.actions.upload)}
          </Button>
        </div>
      </div>

      {/* 检索 + 阶段 / 角色筛选：名称走服务端（列表）/内存（矩阵、关联）；
          stage / role 是 473 新维度，前端统一二次过滤两个数据面。「分类」维度
          已按产品要求从管理面下线（创建链路仍写默认分类）。 */}
      <div className={`${PAGE_GUTTER} flex flex-wrap items-center gap-2 pb-2`}>
        <div className="relative w-52 shrink-0">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.name}
            onChange={(event) => setName(storeKey, event.target.value)}
            placeholder={t(($) => $.search_placeholder)}
            aria-label={t(($) => $.search_placeholder)}
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <StageChip active={stageFilter === "all"} onClick={() => setStageFilter("all")}>
            {t(($) => $.stages.all)}
          </StageChip>
          {ASSET_LIFECYCLE_STAGES.map((stage) => (
            <StageChip key={stage} active={stageFilter === stage} onClick={() => setStageFilter(stage)}>
              {stageLabels[stage]}
            </StageChip>
          ))}
          <StageChip active={stageFilter === "none"} onClick={() => setStageFilter("none")}>
            {t(($) => $.stages.none)}
          </StageChip>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <RoleTab active={roleFilter === "all"} onClick={() => setRoleFilter("all")}>
            {t(($) => $.roles.all)}
          </RoleTab>
          <RoleTab active={roleFilter === "input"} onClick={() => setRoleFilter("input")}>
            {t(($) => $.roles.input)}
          </RoleTab>
          <RoleTab active={roleFilter === "output"} onClick={() => setRoleFilter("output")}>
            {t(($) => $.roles.output)}
          </RoleTab>
          <RoleTab active={roleFilter === "none"} onClick={() => setRoleFilter("none")}>
            {t(($) => $.roles.none)}
          </RoleTab>
        </div>
      </div>

      {/* 统计条对齐项目 TAB：单行紧凑条，数据为筛选后全量 overview */}
      {view === "list" && listView === "table" ? (
        <div className={`${PAGE_GUTTER} pb-2`}>
          <AssetStatsBar
            items={filteredOverviewBindings}
            pending={overviewQuery.isPending}
          />
        </div>
      ) : null}

      {/* 视图主体：列表/矩阵/关联各自吃掉剩余高度，分页与选择工具栏固定在底部 */}
      <div className={`${PAGE_GUTTER} flex min-h-0 flex-1 flex-col gap-2 pb-3`}>

      {/* View bodies */}
      {view === "list" ? (
        listView === "grid" ? (
          <AssetsGridView
            items={filteredOverviewBindings}
            loading={overviewQuery.isPending}
            error={overviewQuery.isError}
            onRetry={() => void overviewQuery.refetch()}
            {...commonProps}
            projectTitles={projectTitleById}
            onPreview={openPreview}
            onUnbind={setUnbindTarget}
            unbindBusyId={unbindMutation.isPending ? unbindTarget?.id : undefined}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
          />
        ) : (
          <AssetsListView
            rows={rows}
            pending={listQuery.isPending}
            error={listQuery.isError}
            errorMessage={String(listQuery.error ?? "")}
            onRetry={() => void listQuery.refetch()}
            containerRef={tableBoxRef}
            {...commonProps}
            onUnbind={setUnbindTarget}
            unbindBusyId={unbindMutation.isPending ? unbindTarget?.id : undefined}
            linksById={linksById}
            issueInfoById={issueInfoById}
            linkCandidates={inlineLinkCandidates}
            projectTitles={projectTitleById}
            onPreview={openPreview}
            showSync={Boolean(syncProjectId) && !filters.category && !filters.name.trim()}
            syncBusy={syncArchive.isPending}
            onSync={() => void handleSyncFromArchive()}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleAll={toggleSelectAll}
          />
        )
      ) : view === "matrix" ? (
        <AssetsMatrixView
          loading={overviewQuery.isPending}
          error={overviewQuery.isError}
          onRetry={() => void overviewQuery.refetch()}
          bindings={filteredOverviewBindings}
          {...commonProps}
        />
      ) : (
        <AssetsIssuesView
          loading={overviewQuery.isPending}
          error={overviewQuery.isError}
          onRetry={() => void overviewQuery.refetch()}
          bindings={filteredOverviewBindings}
          issues={overview?.issues ?? []}
          {...commonProps}
        />
      )}

      {/* 选择工具栏（共享）：只在列表视图出现；全选仅作用当前已加载行集。 */}
      {view === "list" ? (
        <AssetSelectionToolbar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          onBatchEdit={() => setBatchEditOpen(true)}
        />
      ) : null}

      {view === "list" && listView === "table" ? (
        <WorkspaceAssetsPager
          page={filters.page}
          totalPages={page?.totalPages ?? 0}
          totalCount={page?.totalCount ?? 0}
          pending={listQuery.isPending}
          onPrev={() => setPage(storeKey, filters.page - 1)}
          onNext={() => setPage(storeKey, filters.page + 1)}
        />
      ) : null}
      </div>

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

      {/* 绑定 / 上传对话框（项目 TAB 同款）：本页跨项目，需先选定目标项目；
          defaultTab 决定入口是「候选/手动」还是「目录导入（上传）」。 */}
      {bindProjectId ? (
        <BindAssetDialog
          projectId={bindProjectId}
          projectOptions={projectOptions}
          onProjectChange={setBindProjectId}
          defaultTab={bindTab}
          open={bindOpen}
          onOpenChange={setBindOpen}
          defaultCategory={
            bindTab === "batch" ? (filters.category ?? "other") : (filters.category ?? "code_repository")
          }
        />
      ) : null}

      <AssetPreviewDialog
        projectId={syncProjectId}
        bindings={previewable}
        index={previewIdx ?? 0}
        onIndexChange={setPreviewIdx}
        open={previewIdx !== null}
        onOpenChange={(next) => !next && setPreviewIdx(null)}
      />

      {/* 受控批量 Dialog：提交行为由上方 handleBatchSubmit 按项目分组顺序执行，
          部分失败时保持打开并回显 batch_result.partial，保留失败组选择与表单。 */}
      <AssetBatchEditDialog
        open={batchEditOpen}
        onOpenChange={setBatchEditOpen}
        selectedIds={Array.from(selectedIds)}
        isPending={batchPending}
        onSubmit={(request) => void handleBatchSubmit(request)}
        resultNote={batchNote}
      />

      {/* key=绑定 id：每次打开重挂载，草稿态（stage/role/tags/links）从当前行重置。
          links 草稿必须等 overview 就绪再允许保存——PUT meta 的 links 是全量替换，
          未知现状直接提交会误删既有关联。 */}
      {editTarget ? (
        <AssetMetaSheet
          key={editTarget.id}
          target={editTarget}
          links={linksById.get(editTarget.id) ?? (editTarget.links ?? [])}
          candidates={overview?.issues ?? []}
          overviewReady={!overviewQuery.isPending}
          wsId={wsId}
          stageLabels={stageLabels}
          linkTypeLabels={linkTypeLabels}
          onClose={() => setEditTarget(null)}
        />
      ) : null}
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Button type="button" size="sm" variant={active ? "default" : "outline"} aria-selected={active} onClick={onClick}>
      {icon}
      {children}
    </Button>
  );
}

function StageChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" size="sm" variant={active ? "default" : "outline"} aria-pressed={active} onClick={onClick}>
      {children}
    </Button>
  );
}

const RoleTab = StageChip;

type LabelsProps = {
  categoryLabels: Record<AssetCategory, string>;
  stageLabels: Record<AssetLifecycleStage, string>;
  linkTypeLabels: Record<AssetLinkType, string>;
  paths: ReturnType<typeof useWorkspacePaths>;
  onEdit: (binding: AssetBinding) => void;
};

/** 列表视图：473 列（阶段/角色/标签/关联）+ 项目 TAB 同款视觉（色块/徽标/预览）。 */
function AssetsListView({
  rows,
  pending,
  error,
  errorMessage,
  onRetry,
  containerRef,
  paths,
  onEdit,
  onUnbind,
  unbindBusyId,
  linksById,
  issueInfoById,
  linkCandidates,
  projectTitles,
  onPreview,
  showSync,
  syncBusy,
  onSync,
  selectedIds,
  onToggleSelect,
  onToggleAll,
}: {
  rows: WorkspaceAssetBinding[];
  pending: boolean;
  error: boolean;
  errorMessage: string;
  onRetry: () => void;
  /** 表格盒子：fit-to-viewport 分页在这里量高度（见 useFillPageSize）。 */
  containerRef: RefObject<HTMLDivElement | null>;
  onUnbind: (row: AssetBinding) => void;
  unbindBusyId?: string;
  linksById: Map<string, AssetIssueLink[]>;
  issueInfoById: Map<string, AssetIssueInfo>;
  linkCandidates?: AssetLinkCandidates;
  projectTitles: Map<string, string>;
  onPreview: (row: AssetBinding) => void;
  showSync: boolean;
  syncBusy: boolean;
  onSync: () => void;
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onToggleAll: () => void;
} & LabelsProps) {
  const { t } = useT("assets");
  const body = pending ? (
    <div className="p-3">
      <QueryLoading rows={6} />
    </div>
  ) : error ? (
    <div className="p-3">
      <QueryError onRetry={onRetry} message={errorMessage} />
    </div>
  ) : rows.length === 0 ? (
    <div className="p-8 text-center text-caption text-muted-foreground">
      {t(($) => $.empty.no_assets)}
      {/* 空态一键「档案 → 资产」导入，口径同项目 TAB（仅选中单项目且无其他筛选）。 */}
      {showSync ? (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={syncBusy}
            onClick={onSync}
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
        // 对齐项目 TAB：阶段/对象/标签/需求/任务均可行内直接编辑（之前只能开 Sheet）。
        inlineEdit: true,
        showLinks: true,
        showOwnership: true,
        onEdit,
        linksById,
        issueInfoById,
        linkCandidates,
        issueHref: (issueId) => paths.issueDetail(issueId),
        ownershipLabel: (row) => (
          <AssetBoundToCell
            row={row}
            paths={paths}
            projectTitle={projectTitles.get(row.project_id) ?? null}
          />
        ),
      }}
      selectedIds={selectedIds}
      onToggleSelect={onToggleSelect}
      onToggleAll={onToggleAll}
      onPreview={onPreview}
      onUnbind={onUnbind}
      unbindBusyId={unbindBusyId}
    />
  );
  return <div ref={containerRef} className="min-h-0 flex-1 overflow-auto rounded-lg border border-surface-border">{body}</div>;
}

/**
 * 归属深链单元格（容器侧构造，共享层不引路由库）：工作项优先，
 * 否则项目；标题取服务端下发 / 下拉映射，项目已删时兜底 id。
 */
function AssetBoundToCell({
  row,
  paths,
  projectTitle,
}: {
  row: AssetBinding;
  paths: ReturnType<typeof useWorkspacePaths>;
  projectTitle: string | null;
}) {
  const { t } = useT("assets");
  const w = row as Partial<WorkspaceAssetBinding>;
  const isWorkItem = Boolean(w.issue_id);
  const boundLabel = isWorkItem
    ? w.issue_title ?? w.issue_id ?? row.project_id
    : w.project_title ?? projectTitle ?? row.project_id;
  const boundHref =
    isWorkItem && w.issue_id ? paths.issueDetail(w.issue_id) : paths.projectDetail(row.project_id);
  return (
    <AppLink href={boundHref} className="inline-flex max-w-full items-center gap-1 hover:underline">
      <span className="truncate" title={boundLabel}>
        {boundLabel}
      </span>
      <Badge variant="outline" className="shrink-0">
        {isWorkItem ? t(($) => $.bound_kind.work_item) : t(($) => $.bound_kind.project)}
      </Badge>
    </AppLink>
  );
}

/**
 * 卡片画廊视图：共享 AssetCardGrid 的工作区装配（归属深链 + Sheet 编辑入口）；
 * 数据源为筛选后全量 overview，与分页解耦。
 */
function AssetsGridView({
  items,
  loading,
  error,
  onRetry,
  categoryLabels,
  paths,
  onEdit,
  onUnbind,
  unbindBusyId,
  projectTitles,
  onPreview,
  selectedIds,
  onToggleSelect,
}: {
  items: AssetBinding[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onUnbind: (row: AssetBinding) => void;
  unbindBusyId?: string;
  projectTitles: Map<string, string>;
  onPreview: (row: AssetBinding) => void;
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
} & LabelsProps) {
  const { t } = useT("assets");
  if (loading) {
    return (
      <div className="p-3">
        <QueryLoading rows={6} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-3">
        <QueryError onRetry={onRetry} />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="min-h-0 flex-1 rounded-lg border border-surface-border p-8 text-center">
        <p className="text-caption text-muted-foreground">{t(($) => $.empty.no_assets)}</p>
      </div>
    );
  }
  return (
    <AssetCardGrid
      rows={items}
      categoryLabels={categoryLabels}
      features={{
        showOwnership: true,
        onEdit,
        ownershipLabel: (row) => (
          <AssetBoundToCell
            row={row}
            paths={paths}
            projectTitle={projectTitles.get(row.project_id) ?? null}
          />
        ),
      }}
      selectedIds={selectedIds}
      onToggleSelect={onToggleSelect}
      onPreview={onPreview}
      onUnbind={onUnbind}
      unbindBusyId={unbindBusyId}
      className="grid min-h-0 flex-1 grid-cols-1 content-start gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3"
    />
  );
}

/** 阶段矩阵：S1-S5 / general / 未标阶段分列（原型 v2「按阶段查找」视图）。 */
function AssetsMatrixView({
  loading,
  error,
  onRetry,
  bindings,
  categoryLabels,
  stageLabels,
  paths,
  onEdit,
}: {
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  bindings: AssetBinding[];
} & LabelsProps) {
  const { t } = useT("assets");
  const grouped = useMemo(() => {
    const map = new Map<"none" | AssetLifecycleStage, AssetBinding[]>();
    for (const col of MATRIX_COLUMNS) map.set(col, []);
    for (const b of bindings) map.get(b.lifecycle_stage ?? "none")?.push(b);
    return map;
  }, [bindings]);

  if (loading) {
    return (
      <div className="p-3">
        <QueryLoading rows={6} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-3">
        <QueryError onRetry={onRetry} />
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 auto-cols-fr grid-flow-col gap-2 overflow-x-auto" data-testid="assets-matrix">
      {MATRIX_COLUMNS.map((col) => {
        const items = grouped.get(col) ?? [];
        return (
          <div key={col} className="flex min-w-52 flex-col rounded-lg border border-surface-border bg-surface/40">
            <div className="flex items-center justify-between gap-1 border-b border-surface-border px-2.5 py-2">
              <span className="truncate text-caption font-semibold">
                {col === "none" ? t(($) => $.stages.none) : stageLabels[col]}
              </span>
              <Badge variant="outline" className="shrink-0 text-micro tabular-nums">
                {t(($) => $.matrix.count, { count: items.length })}
              </Badge>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
              {items.length === 0 ? (
                <div className="py-6 text-center text-caption text-muted-foreground">
                  {t(($) => $.matrix.empty_col)}
                </div>
              ) : (
                items.map((b) => (
                  <MatrixAssetCard
                    key={b.id}
                    binding={b}
                    categoryLabel={categoryLabels[b.asset_category] ?? b.asset_category}
                    projectHref={paths.projectDetail(b.project_id)}
                    onEdit={() => onEdit(b)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MatrixAssetCard({
  binding,
  categoryLabel,
  projectHref,
  onEdit,
}: {
  binding: AssetBinding;
  categoryLabel: string;
  projectHref: string;
  onEdit: () => void;
}) {
  const { t } = useT("assets");
  const tags = binding.tags ?? [];
  const linkCount = binding.links?.length ?? 0;
  return (
    <div className="rounded-md border border-surface-border bg-background p-2">
      <div className="flex items-start justify-between gap-1">
        <AppLink href={projectHref} className="min-w-0 truncate text-caption font-medium hover:underline" title={binding.asset_name}>
          {binding.asset_name}
        </AppLink>
        <Button type="button" size="xs" variant="ghost" className="size-6 p-0" onClick={onEdit} aria-label={t(($) => $.actions.edit)}>
          <Pencil className="size-3" />
        </Button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="text-micro">
          {categoryLabel}
        </Badge>
        {binding.asset_role ? (
          <Badge variant={binding.asset_role === "output" ? "secondary" : "outline"} className="text-micro">
            {binding.asset_role === "output" ? t(($) => $.roles.output) : t(($) => $.roles.input)}
          </Badge>
        ) : null}
        {linkCount > 0 ? (
          <Badge variant="outline" className="gap-1 text-micro">
            <Link2 className="size-2.5" />
            {linkCount}
          </Badge>
        ) : null}
      </div>
      {tags.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {tags.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded bg-accent/60 px-1 text-micro text-muted-foreground">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 工作项 × 资产：以有链接的 issue 为主键反查（原型 v2「需求×资产」视图）。 */
function AssetsIssuesView({
  loading,
  error,
  onRetry,
  bindings,
  issues,
  linkTypeLabels,
  paths,
  onEdit,
  stageLabels,
  categoryLabels,
}: {
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  bindings: AssetBinding[];
  issues: { id: string; title: string; status: string }[];
} & LabelsProps) {
  const { t } = useT("assets");
  const rows = useMemo(() => {
    const bindingById = new Map(bindings.map((b) => [b.id, b]));
    const issueMeta = new Map(issues.map((i) => [i.id, i]));
    const byIssue = new Map<string, { binding: AssetBinding; linkType: string }[]>();
    for (const b of bindings) {
      for (const l of b.links ?? []) {
        if (!bindingById.has(b.id)) continue;
        const list = byIssue.get(l.issue_id) ?? [];
        list.push({ binding: b, linkType: l.link_type });
        byIssue.set(l.issue_id, list);
      }
    }
    return [...byIssue.entries()]
      .map(([issueId, entries]) => ({
        issueId,
        title: issueMeta.get(issueId)?.title ?? issueId,
        status: issueMeta.get(issueId)?.status ?? "",
        entries,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [bindings, issues]);

  if (loading) {
    return (
      <div className="p-3">
        <QueryLoading rows={6} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-3">
        <QueryError onRetry={onRetry} />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-surface-border">
        <div className="p-8 text-center text-caption text-muted-foreground">
          {t(($) => $.issues_view.no_rows)}
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-auto" data-testid="assets-issues-view">
      {rows.map((row) => (
        <div key={row.issueId} className="rounded-lg border border-surface-border p-3">
          <div className="flex items-center gap-2">
            <AppLink href={paths.issueDetail(row.issueId)} className="min-w-0 truncate text-caption font-medium hover:underline">
              {row.title}
            </AppLink>
            {row.status ? (
              <Badge variant="outline" className="shrink-0 text-micro">
                {row.status}
              </Badge>
            ) : null}
            <span className="ml-auto shrink-0 text-micro text-muted-foreground">
              {t(($) => $.issues_view.asset_count, { count: row.entries.length })}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {row.entries.map(({ binding, linkType }) => (
              <button
                key={`${binding.id}-${linkType}`}
                type="button"
                onClick={() => onEdit(binding)}
                className="inline-flex items-center gap-1 rounded-md border border-surface-border px-1.5 py-0.5 text-micro hover:bg-accent/60"
                title={binding.lifecycle_stage ? stageLabels[binding.lifecycle_stage] ?? binding.lifecycle_stage : undefined}
              >
                <span className="max-w-40 truncate font-medium">{binding.asset_name}</span>
                <Badge variant={linkType === "resolves" ? "secondary" : "outline"} className="text-micro">
                  {linkTypeLabels[linkType as AssetLinkType] ?? linkType}
                </Badge>
                {categoryLabels[binding.asset_category] ? (
                  <span className="text-muted-foreground">{categoryLabels[binding.asset_category]}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 需求 / 任务关联分区（编辑抽屉内复用）：行首圆点按类型分色（需求 indigo /
 * 任务 teal），状态徽标按状态类别分色；勾选后可选链型。候选由父级按
 * is_requirement 分桶传入（已全量下发，含已关闭）。
 */
function IssueLinkSection({
  title,
  dotClass,
  candidates,
  query,
  onQueryChange,
  placeholder,
  emptyText,
  linkSel,
  onToggle,
  linkTypeItems,
  onLinkType,
}: {
  title: string;
  dotClass: string;
  candidates: { id: string; title: string; status: string }[];
  query: string;
  onQueryChange: (value: string) => void;
  placeholder: string;
  emptyText: string;
  linkSel: Record<string, AssetLinkType>;
  onToggle: (issueId: string, on: boolean) => void;
  linkTypeItems: { value: string; label: string }[];
  onLinkType: (issueId: string, linkType: AssetLinkType) => void;
}) {
  const q = query.trim().toLowerCase();
  const rows = candidates
    .filter((i) => !q || i.title.toLowerCase().includes(q) || Boolean(linkSel[i.id]))
    .sort(
      (a, b) =>
        Number(Boolean(linkSel[b.id])) - Number(Boolean(linkSel[a.id])) ||
        a.title.localeCompare(b.title),
    );
  const linkedCount = candidates.filter((i) => linkSel[i.id]).length;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-caption font-medium">
          <span className={`size-2 rounded-full ${dotClass}`} />
          {title}
        </label>
        <span className="text-micro text-muted-foreground">{linkedCount}</span>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          className="pl-8"
        />
      </div>
      {rows.length === 0 ? (
        <p className="py-2 text-center text-caption text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="max-h-60 space-y-1 overflow-y-auto rounded-md border border-surface-border p-1.5">
          {rows.map((issue) => {
            const checked = Boolean(linkSel[issue.id]);
            return (
              <div key={issue.id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-accent/40">
                <Checkbox
                  id={`link-${issue.id}`}
                  checked={checked}
                  onCheckedChange={(value) => onToggle(issue.id, value === true)}
                />
                <label
                  htmlFor={`link-${issue.id}`}
                  className="min-w-0 flex-1 cursor-pointer truncate text-caption"
                  title={issue.title}
                >
                  {issue.title}
                </label>
                {issue.status ? (
                  <Badge className={`shrink-0 border-0 text-micro ${statusToneClass(issue.status)}`}>
                    {issue.status}
                  </Badge>
                ) : null}
                {checked ? (
                  <Select
                    items={linkTypeItems}
                    value={linkSel[issue.id]}
                    onValueChange={(value) => value && onLinkType(issue.id, value as AssetLinkType)}
                  >
                    <SelectTrigger size="sm" className="w-30 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {linkTypeItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 编辑抽屉（473 meta）：阶段 / 角色 / 标签 / 需求与任务关联（分区展示全量候选，
 * 行首圆点 + 状态徽标分色）。
 * stage/role 的 "none" 选项映射为 ""（服务端 = 清除）；links 全量替换，
 * 因此 overview 未就绪前禁止保存。
 */
function AssetMetaSheet({
  target,
  links,
  candidates,
  overviewReady,
  wsId,
  stageLabels,
  linkTypeLabels,
  onClose,
}: {
  target: AssetBinding;
  links: AssetIssueLink[];
  candidates: { id: string; title: string; status: string; is_requirement?: boolean }[];
  overviewReady: boolean;
  wsId: string;
  stageLabels: Record<AssetLifecycleStage, string>;
  linkTypeLabels: Record<AssetLinkType, string>;
  onClose: () => void;
}) {
  const { t } = useT("assets");
  const [stage, setStage] = useState<"none" | AssetLifecycleStage>(target.lifecycle_stage ?? "none");
  const [role, setRole] = useState<"none" | AssetRole>(target.asset_role ?? "none");
  const [tagsText, setTagsText] = useState((target.tags ?? []).join(", "));
  const [linkSel, setLinkSel] = useState<Record<string, AssetLinkType>>(() => {
    const init: Record<string, AssetLinkType> = {};
    for (const l of links) init[l.issue_id] = l.link_type as AssetLinkType;
    return init;
  });
  const [reqQuery, setReqQuery] = useState("");
  const [taskQuery, setTaskQuery] = useState("");

  const toggleLink = useCallback((issueId: string, on: boolean) => {
    setLinkSel((prev) => {
      const next = { ...prev };
      if (on) next[issueId] = "produces";
      else delete next[issueId];
      return next;
    });
  }, []);

  const mutation = useUpdateAssetMeta(wsId);

  // 候选兼容集：已关联但不在候选集（如候选上限截断）的 issue 也要可见，
  // 否则勾选态会丢；类型未知一律归任务桶。
  const knownIssues = useMemo(() => {
    const known = new Map(candidates.map((i) => [i.id, i]));
    for (const l of links) {
      if (!known.has(l.issue_id)) {
        known.set(l.issue_id, {
          id: l.issue_id,
          title: l.issue_id.slice(0, 8),
          status: "",
          is_requirement: false,
        });
      }
    }
    return known;
  }, [candidates, links]);
  const requirementCandidates = useMemo(
    () => [...knownIssues.values()].filter((i) => i.is_requirement ?? false),
    [knownIssues],
  );
  const taskCandidates = useMemo(
    () => [...knownIssues.values()].filter((i) => !(i.is_requirement ?? false)),
    [knownIssues],
  );

  const linkedCount = Object.keys(linkSel).length;
  const stageItems = useMemo(
    () => [
      { value: "none", label: t(($) => $.stages.none) },
      ...ASSET_LIFECYCLE_STAGES.map((s) => ({ value: s, label: stageLabels[s] })),
    ],
    [t, stageLabels],
  );
  const roleItems = useMemo(
    () => [
      { value: "none", label: t(($) => $.roles.none) },
      { value: "input", label: t(($) => $.roles.input) },
      { value: "output", label: t(($) => $.roles.output) },
    ],
    [t],
  );
  const linkTypeItems = useMemo(
    () => (Object.keys(linkTypeLabels) as AssetLinkType[]).map((lt) => ({ value: lt, label: linkTypeLabels[lt] })),
    [linkTypeLabels],
  );
  const handleSave = async () => {
    const data: UpdateAssetMetaRequest = {
      lifecycle_stage: stage === "none" ? "" : stage,
      asset_role: role === "none" ? "" : role,
      tags: tagsText
        .split(/[,，;；]/)
        .map((s) => s.trim())
        .filter(Boolean),
      links: Object.entries(linkSel).map(([issue_id, link_type]) => ({ issue_id, link_type })),
    };
    try {
      await mutation.mutateAsync({ projectId: target.project_id, bindingId: target.id, data });
      toast.success(t(($) => $.toast.meta_saved));
      onClose();
    } catch {
      toast.error(t(($) => $.toast.meta_save_failed));
    }
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full max-w-md flex-col gap-0">
        <SheetHeader className="border-b border-surface-border px-6">
          <SheetTitle>{t(($) => $.edit.title)}</SheetTitle>
          <SheetDescription>{t(($) => $.edit.desc, { name: target.asset_name })}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          <div className="space-y-1.5">
            <label className="text-caption font-medium">{t(($) => $.edit.stage_label)}</label>
            <Select items={stageItems} value={stage} onValueChange={(value) => value && setStage(value as "none" | AssetLifecycleStage)}>
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
          </div>
          <div className="space-y-1.5">
            <label className="text-caption font-medium">{t(($) => $.edit.role_label)}</label>
            <Select items={roleItems} value={role} onValueChange={(value) => value && setRole(value as "none" | AssetRole)}>
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
          </div>
          <div className="space-y-1.5">
            <label className="text-caption font-medium">{t(($) => $.edit.tags_label)}</label>
            <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder={t(($) => $.edit.tags_placeholder)} />
            <p className="text-micro text-muted-foreground">{t(($) => $.edit.tags_help)}</p>
          </div>
          <IssueLinkSection
            title={t(($) => $.edit.requirements_label)}
            dotClass={REQUIREMENT_DOT_CLASS}
            candidates={requirementCandidates}
            query={reqQuery}
            onQueryChange={setReqQuery}
            placeholder={t(($) => $.edit.requirements_search)}
            emptyText={reqQuery ? t(($) => $.edit.none_linked) : t(($) => $.edit.no_candidates)}
            linkSel={linkSel}
            onToggle={toggleLink}
            linkTypeItems={linkTypeItems}
            onLinkType={(id, lt) => setLinkSel((prev) => ({ ...prev, [id]: lt }))}
          />
          <IssueLinkSection
            title={t(($) => $.edit.tasks_label)}
            dotClass={TASK_DOT_CLASS}
            candidates={taskCandidates}
            query={taskQuery}
            onQueryChange={setTaskQuery}
            placeholder={t(($) => $.edit.tasks_search)}
            emptyText={taskQuery ? t(($) => $.edit.none_linked) : t(($) => $.edit.no_task_candidates)}
            linkSel={linkSel}
            onToggle={toggleLink}
            linkTypeItems={linkTypeItems}
            onLinkType={(id, lt) => setLinkSel((prev) => ({ ...prev, [id]: lt }))}
          />
        </div>
        <SheetFooter className="border-t border-surface-border sm:justify-between">
          <span className="text-micro text-muted-foreground">
            {overviewReady
              ? t(($) => $.issues_view.asset_count, { count: linkedCount })
              : t(($) => $.edit.requirements_label)}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" size="xs" variant="outline" onClick={onClose}>
              {t(($) => $.actions.cancel)}
            </Button>
            <Button type="button" size="xs" disabled={mutation.isPending || !overviewReady} onClick={() => void handleSave()}>
              {t(($) => $.actions.save)}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function WorkspaceAssetsPager({
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
  return (
    <div className={`flex items-center justify-end gap-2${pending ? " invisible" : ""}`}>
      <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={onPrev}>
        {t(($) => $.pager.prev)}
      </Button>
      <span className="text-caption text-muted-foreground tabular-nums">
        {t(($) => $.pager.page_of, { page, totalPages: Math.max(totalPages, 1) })}
      </span>
      <Button type="button" size="sm" variant="outline" disabled={page >= totalPages} onClick={onNext}>
        {t(($) => $.pager.next)}
      </Button>
    </div>
  );
}
