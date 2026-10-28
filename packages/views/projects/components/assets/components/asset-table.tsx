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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multica/ui/components/ui/table";
import { useT } from "../../../../i18n";
import { AppLink } from "../../../../navigation";
import { assetPreviewMode } from "./asset-preview-mode";
import {
  InlineRoleSelect,
  InlineStageSelect,
  InlineTagsEditor,
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
 */

/** 需求/任务明细展示所需的最小 issue 信息（工作区页从 overview 聚合注入）。 */
export type AssetIssueInfo = {
  title: string;
  status?: string;
  is_requirement?: boolean;
};

export type AssetCollectionFeatures = {
  /** true 时阶段/对象/标签列为行内快编；false 为只读徽标。 */
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
};

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

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {selectable ? (
            <TableHead className="w-8">
              <Checkbox
                checked={allSelected}
                onCheckedChange={() => onToggleAll?.()}
                aria-label={t(($) => $.selection.select_all)}
              />
            </TableHead>
          ) : null}
          <TableHead>{t(($) => $.columns.name)}</TableHead>
          <TableHead>{t(($) => $.columns.stage)}</TableHead>
          <TableHead>{t(($) => $.columns.role)}</TableHead>
          <TableHead>{t(($) => $.columns.tags)}</TableHead>
          {f.showLinks ? (
            <>
              <TableHead>{t(($) => $.columns.requirement)}</TableHead>
              <TableHead>{t(($) => $.columns.task)}</TableHead>
            </>
          ) : null}
          {f.showOwnership ? <TableHead>{t(($) => $.columns.bound_to)}</TableHead> : null}
          <TableHead>{t(($) => $.columns.created_at)}</TableHead>
          <TableHead className="text-right">{t(($) => $.columns.actions)}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <AssetTableRow
            key={row.id}
            row={row}
            features={f}
            selected={selectable ? selectedIds.has(row.id) : false}
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
    </Table>
  );
}

function AssetTableRow({
  row,
  features,
  selected,
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
  selected: boolean;
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
  return (
    <TableRow className={selected ? "bg-accent/30" : undefined}>
      {onToggleSelect ? (
        <TableCell className="w-8 p-0 pl-2">
          <Checkbox checked={selected} onCheckedChange={onToggleSelect} />
        </TableCell>
      ) : null}
      <TableCell>
        <div className="flex min-w-0 items-center gap-2">
          <AssetCategoryTile category={row.asset_category} subtype={row.asset_subtype} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              {canPreview ? (
                <button
                  type="button"
                  className="min-w-0 cursor-pointer truncate font-medium text-left hover:text-violet-600 hover:underline dark:hover:text-violet-400"
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
      <TableCell>
        {features.inlineEdit ? (
          <InlineStageSelect row={row} />
        ) : row.lifecycle_stage ? (
          <AssetStageBadge stage={row.lifecycle_stage} />
        ) : (
          <span className="text-caption text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {features.inlineEdit ? (
          <InlineRoleSelect row={row} />
        ) : row.asset_role ? (
          <AssetRoleBadge role={row.asset_role} />
        ) : (
          <span className="text-caption text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {features.inlineEdit ? <InlineTagsEditor row={row} /> : <AssetTagChips tags={row.tags} />}
      </TableCell>
      {features.showLinks ? (
        <>
          <TableCell>
            <LinkCountBadge links={requirementLinks} toneClass={REQUIREMENT_TONE_CLASS} icon={<Workflow className="size-3" />} label={t(($) => $.columns.requirement)} features={features} />
          </TableCell>
          <TableCell>
            <LinkCountBadge links={taskLinks} toneClass={TASK_TONE_CLASS} icon={<ListTodo className="size-3" />} label={t(($) => $.columns.task)} features={features} />
          </TableCell>
        </>
      ) : null}
      {features.showOwnership ? (
        <TableCell className="text-caption">{features.ownershipLabel?.(row) ?? null}</TableCell>
      ) : null}
      <TableCell className="text-caption text-muted-foreground">
        {formatAssetDate(row.created_at)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {canPreview ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={onPreview}
              aria-label={t(($) => $.actions.preview)}
            >
              <Eye />
              {t(($) => $.actions.preview)}
            </Button>
          ) : null}
          {features.onEdit ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={onEdit}
              aria-label={t(($) => $.actions.edit)}
            >
              <Pencil />
              {t(($) => $.actions.edit)}
            </Button>
          ) : null}
          {onUnbind ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={unbindBusy}
              onClick={onUnbind}
              aria-label={t(($) => $.actions.unbind)}
            >
              <Unlink />
              {t(($) => $.actions.unbind)}
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * 需求/任务徽标：非零时用各自色相（indigo/teal），零用破折号占位；
 * 点击展开 Popover 明细——逐行圆点 + 标题（可深链）+ 状态色徽 + 链型。
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
      >
        <Badge className={`gap-1 border-0 text-micro ${toneClass}`}>
          {icon}
          {label} {links.length}
        </Badge>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-h-72 overflow-y-auto">
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
