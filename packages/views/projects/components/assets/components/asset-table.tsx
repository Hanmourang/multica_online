"use client";

import type { ReactNode } from "react";
import { Eye, Link2, Pencil, Sparkles, Unlink } from "lucide-react";
import type { AssetBinding, AssetIssueLink } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multica/ui/components/ui/table";
import { useT } from "../../../../i18n";
import { assetPreviewMode } from "./asset-preview-mode";
import {
  InlineCategorySelect,
  InlineRoleSelect,
  InlineStageSelect,
  InlineTagsEditor,
} from "./asset-inline-edit";
import {
  AssetCategoryTile,
  AssetRoleBadge,
  AssetStageBadge,
  AssetTagChips,
} from "./asset-visuals";

/**
 * 共享资产表格（五阶段对齐 plan §7.1）。
 *
 * 项目 / 工作项 / 工作区三个容器渲染同一套列结构与选择态；场景差异通过可选
 * 配置注入：工作区的 links / 归属深链 / Sheet 编辑入口，项目的行内即时编辑。
 * 行内编辑按行 `project_id` 提交（§7.2），loading/empty/error 状态仍归容器。
 */

export type AssetCollectionFeatures = {
  /** true 时分类/阶段/对象/标签列为行内快编；false 为只读徽标。 */
  inlineEdit?: boolean;
  showLinks?: boolean;
  showOwnership?: boolean;
  onEdit?: (row: AssetBinding) => void;
  /** 归属单元格内容（容器用 AppLink 构造深链，共享层不感知路由）。 */
  ownershipLabel?: (row: AssetBinding) => ReactNode;
  linksById?: ReadonlyMap<string, AssetIssueLink[]>;
};

export function AssetTable({
  rows,
  categoryLabels,
  features,
  selectedIds,
  onToggleSelect,
  onToggleAll,
  onPreview,
  onUnbind,
  unbindBusyId,
}: {
  rows: readonly AssetBinding[];
  categoryLabels: Record<string, string>;
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
          <TableHead>{t(($) => $.columns.category)}</TableHead>
          <TableHead>{t(($) => $.columns.stage)}</TableHead>
          <TableHead>{t(($) => $.columns.role)}</TableHead>
          <TableHead>{t(($) => $.columns.tags)}</TableHead>
          {f.showLinks ? <TableHead>{t(($) => $.columns.links)}</TableHead> : null}
          {f.showOwnership ? <TableHead>{t(($) => $.columns.bound_to)}</TableHead> : null}
          <TableHead>{t(($) => $.columns.source)}</TableHead>
          <TableHead>{t(($) => $.columns.created_at)}</TableHead>
          <TableHead className="text-right">{t(($) => $.columns.actions)}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <AssetTableRow
            key={row.id}
            row={row}
            categoryLabel={categoryLabels[row.asset_category] ?? row.asset_category}
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
  categoryLabel,
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
  categoryLabel: string;
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
          <InlineCategorySelect row={row} />
        ) : (
          <span className="text-caption">
            {categoryLabel}
            {row.asset_subtype ? (
              <span className="ml-1 text-micro text-muted-foreground">· {row.asset_subtype}</span>
            ) : null}
          </span>
        )}
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
        <TableCell>
          {links.length > 0 ? (
            <Badge
              variant="outline"
              className="gap-1 text-micro"
              title={links.map((l) => `${l.issue_id.slice(0, 8)} (${l.link_type})`).join("\n")}
            >
              <Link2 className="size-3" />
              {links.length}
            </Badge>
          ) : (
            <span className="text-caption text-muted-foreground">—</span>
          )}
        </TableCell>
      ) : null}
      {features.showOwnership ? (
        <TableCell className="text-caption">{features.ownershipLabel?.(row) ?? null}</TableCell>
      ) : null}
      <TableCell className="text-caption text-muted-foreground">{row.source}</TableCell>
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

/** 绑定时间展示（项目/工作区原两份同实现合并到共享层）。 */
export function formatAssetDate(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}
