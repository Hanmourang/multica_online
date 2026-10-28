"use client";

import { Eye, Pencil, Sparkles, Unlink } from "lucide-react";
import type { AssetBinding } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { useT } from "../../../../i18n";
import { assetPreviewMode } from "./asset-preview-mode";
import { formatAssetDate } from "./asset-table";
import type { AssetCollectionFeatures } from "./asset-table";
import {
  AssetCategoryTile,
  AssetStageRoleBadges,
  AssetTagChips,
} from "./asset-visuals";

/**
 * 共享资产卡片画廊（五阶段对齐 plan §7.1）：与表格同构的选择 / 预览 / 解绑
 * 能力；工作区的归属深链与 Sheet 编辑入口通过 features 插槽注入。
 */

export function AssetCardGrid({
  rows,
  categoryLabels,
  features,
  selectedIds,
  onToggleSelect,
  onPreview,
  onUnbind,
  unbindBusyId,
  className,
}: {
  rows: readonly AssetBinding[];
  categoryLabels: Record<string, string>;
  features?: AssetCollectionFeatures;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
  onPreview?: (row: AssetBinding) => void;
  onUnbind?: (row: AssetBinding) => void;
  unbindBusyId?: string;
  className?: string;
}) {
  const f = features ?? {};
  return (
    <div
      className={
        className ??
        "grid min-h-0 grid-cols-1 content-start gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3"
      }
      data-testid="asset-card-grid"
    >
      {rows.map((row) => {
        const rowOnEdit = f.onEdit ? () => f.onEdit?.(row) : undefined;
        return (
          <AssetCard
            key={row.id}
            row={row}
            categoryLabel={categoryLabels[row.asset_category] ?? row.asset_category}
            features={f}
            selected={selectedIds?.has(row.id) ?? false}
            showSelect={selectedIds !== undefined && onToggleSelect !== undefined}
            onSelect={() => onToggleSelect?.(row.id)}
            canPreview={assetPreviewMode(row) !== null}
            onPreview={onPreview ? () => onPreview?.(row) : undefined}
            onEdit={rowOnEdit}
            onUnbind={onUnbind ? () => onUnbind?.(row) : undefined}
            unbindBusy={unbindBusyId === row.id}
          />
        );
      })}
    </div>
  );
}

function AssetCard({
  row,
  categoryLabel,
  features,
  selected,
  showSelect,
  onSelect,
  canPreview,
  onPreview,
  onEdit,
  onUnbind,
  unbindBusy,
}: {
  row: AssetBinding;
  categoryLabel: string;
  features: AssetCollectionFeatures;
  selected: boolean;
  showSelect: boolean;
  onSelect: () => void;
  canPreview: boolean;
  onPreview?: () => void;
  onEdit?: () => void;
  onUnbind?: () => void;
  unbindBusy: boolean;
}) {
  const { t } = useT("assets");
  const url = row.external_ref?.url;
  return (
    <div
      className={`flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:border-violet-400/60 ${
        selected ? "border-primary/60 bg-primary/5" : "border-surface-border"
      }`}
    >
      <div className="flex min-w-0 items-start gap-2">
        {showSelect ? (
          <Checkbox
            checked={selected}
            onCheckedChange={onSelect}
            aria-label={row.asset_name}
            className="mt-1"
          />
        ) : null}
        <AssetCategoryTile category={row.asset_category} subtype={row.asset_subtype} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {canPreview && onPreview ? (
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
          <div className="truncate text-micro text-muted-foreground" title={url ?? undefined}>
            {url || categoryLabel}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <AssetStageRoleBadges stage={row.lifecycle_stage} role={row.asset_role} />
      </div>
      <AssetTagChips tags={row.tags} />
      {features.showOwnership ? (
        <div className="min-w-0 text-micro text-muted-foreground">
          {features.ownershipLabel?.(row) ?? null}
        </div>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-surface-border pt-2">
        <span className="min-w-0 truncate text-micro text-muted-foreground">
          {/* 「来源」展示面已随字段下线（与表格同口径），仅保留绑定时间 */}
          {formatAssetDate(row.created_at)}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {canPreview && onPreview ? (
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
          {onEdit ? (
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
      </div>
    </div>
  );
}
