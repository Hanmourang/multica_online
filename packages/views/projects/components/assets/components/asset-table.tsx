"use client";

import { useMemo, type ReactNode } from "react";
import { Eye, ListTodo, Pencil, Sparkles, Unlink, Workflow } from "lucide-react";
import type { AssetBinding, AssetIssueLink } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multica/ui/components/ui/table";
import { useT } from "../../../../i18n";
import { AppLink } from "../../../../navigation";
import { cn } from "@multica/ui/lib/utils";
import { assetPreviewMode } from "./asset-preview-mode";
import {
  InlineIssueLinkEditor,
  InlineRoleSelect,
  InlineStageSelect,
  InlineTagsEditor,
  type InlineIssueCandidate,
} from "./asset-inline-edit";
import {
  REQUIREMENT_TONE_CLASS,
  TASK_TONE_CLASS,
  statusToneClass,
} from "./asset-status-tone";
import {
  AssetCategoryTile,
  AssetRoleBadge,
  AssetStageBadge,
  AssetTagChips,
} from "./asset-visuals";

/**
 * 共享资产表格（五阶段对齐 plan §7.1；关联列拆「需求 / 任务」轮）。
 *
 * 项目 / 工作项 / 工作区三个容器渲染同一套列结构与选择态；场景差异通过可选
 * 配置注入：工作区的 links / 归属深链 / Sheet 编辑入口，项目的行内即时编辑。
 * 行内编辑按行 `project_id` 提交（§7.2），loading/empty/error 状态仍归容器。
 * 「分类」列已按产品要求下线（数据字段保留，创建链路仍写默认分类）；
 * 原「关联」列拆为需求/任务两列，按 issue 是否顶层（issueInfoById）分桶并以
 * 各自色相徽标区分；徽标可点开 Popover 查看逐条明细（标题深链 + 状态色徽）。
 * 「来源」列同步下线（字段仅作数据属性，不再占列宽）。
 *
 * 布局：table-fixed + 按表宽比例定列——自动布局会把富余空间按「内容基准宽」摊分，
 * 名称列（长路径）会被撑到近半张表，且 max-w 只是基准不是硬上限；固定布局下
 * 百分比才是精确值。名称列 22%~28%、标签列 16%~22% 按容器查询分档，其余列定宽 px。
 * 长文件名只在名称单元格内 truncate，不再挤压右侧列。
 * 容器查询（@container）按面板真实宽度渐进显隐次要列——选择列 @3xl、归属 @4xl、
 * 绑定时间 @5xl；阶段/对象/标签/需求/任务恒显，保证任何宽度下行内编辑入口都在。
 * 空值入口（标签 / 需求 / 任务）改为行悬停或键盘聚焦才显形，避免整屏「＋」噪音。
 * 表头 sticky 吸顶，行内工具栏与分页不再被内容顶飞。
 */

/** 需求/任务明细展示所需的最小 issue 信息（工作区页从 overview 聚合注入）。 */
export type AssetIssueInfo = {
  title: string;
  status?: string;
  is_requirement?: boolean;
};

/** 行内关联候选（容器按 is_requirement 分桶预热，缺省时关联列只读）。 */
export type AssetLinkCandidates = {
  requirement: readonly InlineIssueCandidate[];
  task: readonly InlineIssueCandidate[];
};

export type AssetCollectionFeatures = {
  /** true 时阶段/对象/标签/需求/任务列为行内快编；false 为只读徽标。 */
  inlineEdit?: boolean;
  /** 显示「需求」「任务」两列（取代原单列关联）。 */
  showLinks?: boolean;
  showOwnership?: boolean;
  onEdit?: (row: AssetBinding) => void;
  /** 归属单元格内容（容器用 AppLink 构造深链，共享层不感知路由）。 */
  ownershipLabel?: (row: AssetBinding) => ReactNode;
  linksById?: ReadonlyMap<string, AssetIssueLink[]>;
  /** issue_id → 标题/状态/是否需求；未知一律归任务桶，明细弹窗取不到时退化为 id。 */
  issueInfoById?: ReadonlyMap<string, AssetIssueInfo>;
  /** 需求/任务明细行的深链构造器（容器侧注入，共享层不感知路由）。 */
  issueHref?: (issueId: string) => string;
  /** 需求/任务行内关联编辑的可选项；与 inlineEdit 同时提供才开启行内关联。 */
  linkCandidates?: AssetLinkCandidates;
};

// ──────────────────────────────────────────────
// 列度量：内容驱动宽度（min/max 封顶）+ 容器查询显隐（表头与单元格共用同一份常量）
// ──────────────────────────────────────────────

const COL_SELECT = "w-[40px] hidden @3xl:table-cell";
/**
 * 名称列：按表宽比例而不是按内容。自动布局会把富余空间按「内容基准宽」摊掉，
 * 长路径会把这一列撑到近半张表；固定布局下百分比是精确值，宽容器收紧到 27%、
 * 窄容器给 31% 弥补其他定宽列占比过高（按容器查询分档，非媒体查询）。
 * 各档都比标签列多给 5–9 个点：文件名/路径过长时被截断的信息量更大。
 */
const COL_NAME = "w-[27%] @4xl:w-[31%] @6xl:w-[27%]";
const COL_STAGE = "w-[120px]";
const COL_ROLE = "w-[96px]";
/**
 * 标签列：同样用比例（名称列的对称项）。固定布局里 `max-w` 不生效（实测被忽略，
 * 未定宽的列会被剩余空间胀到 800+），所以只能用百分比对照名称列给份额。
 */
const COL_TAGS = "w-[16%] @4xl:w-[18%] @6xl:w-[22%]";
const COL_LINK = "w-[64px]";
const COL_BOUND = "w-[180px] hidden @4xl:table-cell";
const COL_CREATED = "w-[92px] hidden @5xl:table-cell";
const COL_ACTIONS = "w-[96px] text-right";
/** 吸顶表头：横向滚动容器里也保持在顶部，底色必须不透明。 */
const HEAD = "sticky top-0 z-10 bg-background";

export function AssetTable({
  rows,
  features,
  selectedIds,
  onToggleSelect,
  onToggleAll,
  onPreview,
  onUnbind,
  unbindBusyId,
}: {
  rows: readonly AssetBinding[];
  features?: AssetCollectionFeatures;
  /** 传入选择态即渲染勾选列；全选只作用于当前页行集（§7.4.1）。 */
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
  onToggleAll?: () => void;
  onPreview?: (row: AssetBinding) => void;
  onUnbind?: (row: AssetBinding) => void;
  unbindBusyId?: string;
}) {
  const { t } = useT("assets");
  const f = features ?? {};
  const selectable = selectedIds !== undefined && onToggleSelect !== undefined;
  const allSelected =
    selectable && rows.length > 0 && rows.every((row) => selectedIds.has(row.id));
  // 关联行内编辑需要 inlineEdit + 候选两条都就绪；只读时退回明细弹窗。
  const inlineLinks = Boolean(f.inlineEdit && f.linkCandidates);

  return (
    <div className="@container w-full">
      <table className="w-full min-w-[720px] table-fixed caption-bottom text-body [&_td]:h-12 [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3 [&_th]:text-caption [&_th]:font-medium [&_th]:text-muted-foreground">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {selectable ? (
              <TableHead className={`${HEAD} ${COL_SELECT}`}>
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={() => onToggleAll?.()}
                  aria-label={t(($) => $.selection.select_all)}
                />
              </TableHead>
            ) : null}
            <TableHead className={`${HEAD} ${COL_NAME}`}>{t(($) => $.columns.name)}</TableHead>
            <TableHead className={`${HEAD} ${COL_STAGE}`}>{t(($) => $.columns.stage)}</TableHead>
            <TableHead className={`${HEAD} ${COL_ROLE}`}>{t(($) => $.columns.role)}</TableHead>
            <TableHead className={`${HEAD} ${COL_TAGS}`}>{t(($) => $.columns.tags)}</TableHead>
            {f.showLinks ? (
              <>
                <TableHead className={`${HEAD} ${COL_LINK}`}>
                  {t(($) => $.columns.requirement)}
                </TableHead>
                <TableHead className={`${HEAD} ${COL_LINK}`}>{t(($) => $.columns.task)}</TableHead>
              </>
            ) : null}
            {f.showOwnership ? (
              <TableHead className={`${HEAD} ${COL_BOUND}`}>
                {t(($) => $.columns.bound_to)}
              </TableHead>
            ) : null}
            <TableHead className={`${HEAD} ${COL_CREATED}`}>
              {t(($) => $.columns.created_at)}
            </TableHead>
            <TableHead className={`${HEAD} ${COL_ACTIONS}`}>
              {t(($) => $.columns.actions)}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <AssetTableRow
              key={row.id}
              row={row}
              features={f}
              inlineLinks={inlineLinks}
              selected={selectable ? selectedIds.has(row.id) : false}
              selectable={selectable}
              canPreview={assetPreviewMode(row) !== null}
              links={f.linksById?.get(row.id) ?? row.links ?? []}
              onToggleSelect={selectable ? () => onToggleSelect(row.id) : undefined}
              onPreview={onPreview ? () => onPreview(row) : undefined}
              onEdit={() => f.onEdit?.(row)}
              onUnbind={onUnbind ? () => onUnbind(row) : undefined}
              unbindBusy={unbindBusyId === row.id}
            />
          ))}
        </TableBody>
      </table>
    </div>
  );
}

function AssetTableRow({
  row,
  features,
  inlineLinks,
  selected,
  selectable,
  canPreview,
  links,
  onToggleSelect,
  onPreview,
  onEdit,
  onUnbind,
  unbindBusy,
}: {
  row: AssetBinding;
  features: AssetCollectionFeatures;
  inlineLinks: boolean;
  selected: boolean;
  selectable: boolean;
  canPreview: boolean;
  links: AssetIssueLink[];
  onToggleSelect?: () => void;
  onPreview?: () => void;
  onEdit: () => void;
  onUnbind?: () => void;
  unbindBusy: boolean;
}) {
  const { t } = useT("assets");
  const url = row.external_ref?.url;
  // 需求/任务分桶：类型未知的 issue 一律计任务（候选面已全量下发，正常不会未知）。
  const { requirementLinks, taskLinks } = useMemo(() => {
    const requirements: AssetIssueLink[] = [];
    const tasks: AssetIssueLink[] = [];
    for (const l of links) {
      if (features.issueInfoById?.get(l.issue_id)?.is_requirement ?? false) requirements.push(l);
      else tasks.push(l);
    }
    return { requirementLinks: requirements, taskLinks: tasks };
  }, [links, features.issueInfoById]);

  const renderLinks = (
    bucket: "requirement" | "task",
    bucketLinks: AssetIssueLink[],
    otherLinks: AssetIssueLink[],
  ) =>
    inlineLinks && features.linkCandidates ? (
      <InlineIssueLinkEditor
        row={row}
        bucket={bucket}
        bucketLinks={bucketLinks}
        otherLinks={otherLinks}
        candidates={features.linkCandidates[bucket]}
      />
    ) : (
      <LinkCountBadge
        links={bucketLinks}
        toneClass={bucket === "requirement" ? REQUIREMENT_TONE_CLASS : TASK_TONE_CLASS}
        icon={
          bucket === "requirement" ? <Workflow className="size-3" /> : <ListTodo className="size-3" />
        }
        label={t(($) => (bucket === "requirement" ? $.columns.requirement : $.columns.task))}
        features={features}
      />
    );

  return (
    <TableRow className={cn("group/row", selected && "bg-accent/30")}>
      {selectable ? (
        <TableCell className={COL_SELECT}>
          <Checkbox checked={selected} onCheckedChange={onToggleSelect} />
        </TableCell>
      ) : null}
      <TableCell className={`${COL_NAME} overflow-hidden`}>
        <div className="flex min-w-0 items-center gap-2">
          <AssetCategoryTile category={row.asset_category} subtype={row.asset_subtype} />
          {/* 列宽已由 table-fixed 钉死，文本块只负责在剩余宽度内截断。 */}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              {canPreview ? (
                <button
                  type="button"
                  className="min-w-0 cursor-pointer truncate text-left font-medium hover:text-violet-600 hover:underline dark:hover:text-violet-400"
                  title={row.asset_name}
                  onClick={onPreview}
                >
                  {row.asset_name}
                </button>
              ) : (
                <span className="min-w-0 truncate font-medium" title={row.asset_name}>
                  {row.asset_name}
                </span>
              )}
              {row.recommended ? (
                <Badge variant="secondary" className="shrink-0 gap-1">
                  <Sparkles className="size-3" />
                  {t(($) => $.recommended_label)}
                </Badge>
              ) : null}
            </div>
            {url ? (
              <div className="truncate text-micro text-muted-foreground" title={url}>
                {url}
              </div>
            ) : null}
          </div>
        </div>
      </TableCell>
      <TableCell className={COL_STAGE}>
        {features.inlineEdit ? (
          <InlineStageSelect row={row} />
        ) : row.lifecycle_stage ? (
          <AssetStageBadge stage={row.lifecycle_stage} />
        ) : (
          <span className="text-caption text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className={COL_ROLE}>
        {features.inlineEdit ? (
          <InlineRoleSelect row={row} />
        ) : row.asset_role ? (
          <AssetRoleBadge role={row.asset_role} />
        ) : (
          <span className="text-caption text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className={`${COL_TAGS} overflow-hidden`}>
        {features.inlineEdit ? (
          <InlineTagsEditor row={row} />
        ) : (
          <AssetTagChips tags={row.tags} max={2} />
        )}
      </TableCell>
      {features.showLinks ? (
        <>
          <TableCell className={COL_LINK}>
            {renderLinks("requirement", requirementLinks, taskLinks)}
          </TableCell>
          <TableCell className={COL_LINK}>
            {renderLinks("task", taskLinks, requirementLinks)}
          </TableCell>
        </>
      ) : null}
      {features.showOwnership ? (
        <TableCell className={`${COL_BOUND} overflow-hidden text-caption`}>
          {features.ownershipLabel?.(row) ?? null}
        </TableCell>
      ) : null}
      <TableCell className={`${COL_CREATED} text-caption text-muted-foreground`}>
        {formatAssetDate(row.created_at)}
      </TableCell>
      <TableCell className={COL_ACTIONS}>
        <div className="flex items-center justify-end gap-0.5">
          {canPreview ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={onPreview}
              aria-label={t(($) => $.actions.preview)}
              title={t(($) => $.actions.preview)}
            >
              <Eye />
            </Button>
          ) : null}
          {features.onEdit ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={onEdit}
              aria-label={t(($) => $.actions.edit)}
              title={t(($) => $.actions.edit)}
            >
              <Pencil />
            </Button>
          ) : null}
          {onUnbind ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={unbindBusy}
              onClick={onUnbind}
              aria-label={t(($) => $.actions.unbind)}
              title={t(($) => $.actions.unbind)}
            >
              <Unlink />
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * 需求/任务徽标（只读态）：非零时用各自色相（indigo/teal）并显示条数，
 * 零用破折号占位；点击展开 Popover 明细——逐行圆点 + 标题（可深链）+ 状态色徽 + 链型。
 * 列宽只有 48px，因此徽标只保留「图标 + 计数」，列头已说明语义。
 */
function LinkCountBadge({
  links,
  toneClass,
  icon,
  label,
  features,
}: {
  links: AssetIssueLink[];
  toneClass: string;
  icon: ReactNode;
  label: string;
  features: AssetCollectionFeatures;
}) {
  const { t } = useT("assets");
  if (links.length === 0) {
    return <span className="text-caption text-muted-foreground">—</span>;
  }
  return (
    <Popover>
      <PopoverTrigger
        className="cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={t(($) => $.columns.view_links, { count: links.length })}
        aria-label={`${label} ${links.length}`}
      >
        <Badge className={`gap-1 border-0 px-1.5 text-micro ${toneClass}`}>
          {icon}
          <span className="tabular-nums">{links.length}</span>
        </Badge>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 w-80 overflow-y-auto">
        <ul className="flex flex-col gap-0.5">
          {links.map((l) => {
            const info = features.issueInfoById?.get(l.issue_id);
            const title = info?.title || l.issue_id.slice(0, 8);
            const href = features.issueHref?.(l.issue_id);
            const lt = l.link_type;
            return (
              <li key={`${l.issue_id}-${l.link_type}`} className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 hover:bg-accent/50">
                <span className={`size-1.5 shrink-0 rounded-full ${toneClass.includes("indigo") ? "bg-indigo-500" : "bg-teal-500"}`} />
                {href ? (
                  <AppLink href={href} className="min-w-0 flex-1 truncate text-caption font-medium hover:underline" title={title}>
                    {title}
                  </AppLink>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-caption" title={title}>{title}</span>
                )}
                {info?.status ? (
                  <Badge className={`shrink-0 border-0 text-micro ${statusToneClass(info.status)}`}>
                    {info.status}
                  </Badge>
                ) : null}
                <span className="shrink-0 text-micro text-muted-foreground">
                  {lt === "depends_on" || lt === "produces" || lt === "resolves"
                    ? t(($) => $.link_types[lt])
                    : lt}
                </span>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** 绑定时间展示（项目/工作区原两份同实现合并到共享层）。 */
export function formatAssetDate(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}
