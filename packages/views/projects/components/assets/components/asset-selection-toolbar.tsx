"use client";

import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../../../i18n";

/**
 * 共享选择工具栏（五阶段对齐 plan §7.1）：已选数量 / 清空 / 批量编辑。
 * 选择状态归容器持有；全选只作用当前页由容器在 onToggleAll 里保证。
 */
export function AssetSelectionToolbar({
  count,
  onClear,
  onBatchEdit,
}: {
  count: number;
  onClear: () => void;
  onBatchEdit: () => void;
}) {
  const { t } = useT("assets");
  if (count <= 0) return null;
  return (
    <div className="flex items-center gap-2 rounded-md bg-accent/50 px-3 py-1.5">
      <span className="text-caption font-medium">
        {t(($) => $.selection.selected_count, { count })}
      </span>
      <Button type="button" size="xs" variant="ghost" onClick={onClear}>
        {t(($) => $.selection.clear)}
      </Button>
      <Button type="button" size="xs" variant="outline" onClick={onBatchEdit}>
        {t(($) => $.selection.batch_edit)}
      </Button>
    </div>
  );
}
