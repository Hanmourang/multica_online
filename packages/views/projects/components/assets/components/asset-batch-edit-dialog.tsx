"use client";

import { useMemo, useState } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { ASSET_CATEGORIES, ASSET_LIFECYCLE_STAGES } from "@multica/core/types";
import type { BatchUpdateAssetMetaRequest } from "@multica/core/types";
import { useT } from "../../../../i18n";
import {
  CLEAR,
  UNCHANGED,
  buildBatchUpdateRequest,
  type BatchFormState,
} from "./asset-batch-draft";

/**
 * 受控批量编辑对话框（五阶段对齐 plan §7.1/§7.4）。
 *
 * 只负责表单、校验与提交状态展示：不绑定固定 projectId，也不自持 mutation ——
 * 提交行为由容器注入。项目/工作项一次调用项目级事务端点；工作区按项目分组
 * 顺序提交并把部分失败结果通过 resultNote 回显（保留表单与选择供重试）。
 */
export function AssetBatchEditDialog({
  open,
  onOpenChange,
  selectedIds,
  isPending,
  onSubmit,
  resultNote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: readonly string[];
  isPending: boolean;
  onSubmit: (request: BatchUpdateAssetMetaRequest) => void | Promise<void>;
  /** 容器注入的结果提示（如"X 个项目成功，Y 个失败"）；成功后由容器关闭。 */
  resultNote?: string;
}) {
  const { t } = useT("assets");
  const [form, setForm] = useState<BatchFormState>({
    stage: UNCHANGED,
    role: UNCHANGED,
    category: UNCHANGED,
    tagsText: "",
    tagsMode: "add",
  });

  const stageItems = useMemo(
    () => [
      { value: UNCHANGED, label: t(($) => $.batch_edit.unchanged) },
      { value: CLEAR, label: t(($) => $.batch_edit.clear) },
      ...ASSET_LIFECYCLE_STAGES.map((s) => ({ value: s as string, label: t(($) => $.stages[s]) })),
    ],
    [t],
  );
  const roleItems = useMemo(
    () => [
      { value: UNCHANGED, label: t(($) => $.batch_edit.unchanged) },
      { value: CLEAR, label: t(($) => $.batch_edit.clear) },
      { value: "input", label: t(($) => $.roles.input) },
      { value: "output", label: t(($) => $.roles.output) },
    ],
    [t],
  );
  const categoryItems = useMemo(
    () => [
      { value: UNCHANGED, label: t(($) => $.batch_edit.unchanged) },
      ...ASSET_CATEGORIES.map((c) => ({ value: c as string, label: t(($) => $.categories[c]) })),
    ],
    [t],
  );
  const tagsModeItems = useMemo(
    () => [
      { value: "replace", label: t(($) => $.batch_edit.tags_mode.replace) },
      { value: "add", label: t(($) => $.batch_edit.tags_mode.add) },
      { value: "remove", label: t(($) => $.batch_edit.tags_mode.remove) },
    ],
    [t],
  );

  const request = buildBatchUpdateRequest(form, selectedIds);

  const handleApply = () => {
    // pending 期间禁止重复提交；无改动时不提交也不关闭（保留表单）。
    if (isPending || !request) return;
    void onSubmit(request);
  };

  const field = (
    label: string,
    items: { value: string; label: string }[],
    value: string,
    setValue: (next: string) => void,
  ) => (
    <label className="block space-y-1">
      <span className="text-caption text-muted-foreground">{label}</span>
      <Select items={items} value={value} onValueChange={(v) => v && setValue(v)}>
        <SelectTrigger size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // pending 期间不允许关闭，避免提交结果丢失（§7.4.6）。
        if (!next && isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.batch_edit.title)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.batch_edit.desc, { count: selectedIds.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {field(t(($) => $.batch_edit.stage_label), stageItems, form.stage, (next) =>
            setForm((current) => ({ ...current, stage: next })),
          )}
          {field(t(($) => $.batch_edit.role_label), roleItems, form.role, (next) =>
            setForm((current) => ({ ...current, role: next })),
          )}
          {field(t(($) => $.batch_edit.category_label), categoryItems, form.category, (next) =>
            setForm((current) => ({ ...current, category: next })),
          )}
          <div className="space-y-1">
            <span className="text-caption text-muted-foreground">
              {t(($) => $.batch_edit.tags_label)}
            </span>
            <div className="flex items-center gap-1.5">
              <Input
                value={form.tagsText}
                onChange={(event) =>
                  setForm((current) => ({ ...current, tagsText: event.target.value }))
                }
                placeholder={t(($) => $.manual_form.tags_placeholder)}
                className="flex-1"
              />
              <Select
                items={tagsModeItems}
                value={form.tagsMode}
                onValueChange={(v) =>
                  v &&
                  setForm((current) => ({
                    ...current,
                    tagsMode: v as BatchFormState["tagsMode"],
                  }))
                }
              >
                <SelectTrigger size="sm" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tagsModeItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {resultNote ? (
            <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-caption text-amber-700 dark:text-amber-400">
              {resultNote}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => onOpenChange(false)}
          >
            {t(($) => $.actions.cancel)}
          </Button>
          <Button type="button" disabled={isPending || request === null} onClick={handleApply}>
            {t(($) => $.batch_edit.apply)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
