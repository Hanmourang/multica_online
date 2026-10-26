"use client";

import { useMemo, useState, useRef } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  ASSET_CATEGORIES,
  ASSET_LIFECYCLE_STAGES,
  type AssetBinding,
  type AssetCategory,
  type AssetLifecycleStage,
  type AssetRole,
} from "@multica/core/types";
import { useUpdateAssetMeta } from "@multica/core/assets/mutations";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import { Input } from "@multica/ui/components/ui/input";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../../../i18n";
import { AssetStageBadge, AssetRoleBadge, tagTone, CATEGORY_VISUALS } from "./asset-visuals";

/**
 * 行内即时编辑：分类 / 阶段 / 对象 Select（选择即保存）+ 标签 Popover（确认即保存）。
 * 每个组件自包含 mutation 逻辑，不依赖外部表单状态。
 * 五阶段对齐 plan §7.2：项目按行 `row.project_id` 确定，不再接受容器固定 projectId，
 * 使项目 / 工作项 / 工作区三种作用域的行都写入正确项目。
 * 批量编辑 Dialog 已抽到受控的 asset-batch-edit-dialog（§7.1）。
 */

// ──────────────────────────────────────────────
// InlineStageSelect
// ──────────────────────────────────────────────

export function InlineStageSelect({ row }: { row: AssetBinding }) {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const mutation = useUpdateAssetMeta(wsId);

  const items = useMemo(
    () => [
      { value: "" as const, label: t(($) => $.stages.none) },
      ...ASSET_LIFECYCLE_STAGES.map((s) => ({ value: s as string, label: t(($) => $.stages[s]) })),
    ],
    [t],
  );

  const current = row.lifecycle_stage ?? "";

  const handleChange = (value: string | null) => {
    if (value === null) return;
    const next = value as AssetLifecycleStage | "";
    if (next === current) return; // no-op
    mutation.mutate(
      { projectId: row.project_id, bindingId: row.id, data: { lifecycle_stage: next } },
      {
        onSuccess: () => toast.success(t(($) => $.toast.meta_saved)),
        onError: () => toast.error(t(($) => $.toast.meta_save_failed)),
      },
    );
  };

  return (
    <Select items={items} value={current} onValueChange={handleChange}>
      <SelectTrigger size="sm" className="h-6 max-w-28 border-none bg-transparent px-1 py-0 text-[10px] shadow-none hover:bg-accent/50">
        <SelectValue>
          {current ? <AssetStageBadge stage={current as AssetLifecycleStage} /> : (
            <span className="text-[10px] text-muted-foreground">{t(($) => $.stages.none)}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ──────────────────────────────────────────────
// InlineRoleSelect
// ──────────────────────────────────────────────

export function InlineRoleSelect({ row }: { row: AssetBinding }) {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const mutation = useUpdateAssetMeta(wsId);

  const items = useMemo(
    () => [
      { value: "" as const, label: t(($) => $.roles.none) },
      { value: "input" as const, label: t(($) => $.roles.input) },
      { value: "output" as const, label: t(($) => $.roles.output) },
    ],
    [t],
  );

  const current = row.asset_role ?? "";

  const handleChange = (value: string | null) => {
    if (value === null) return;
    const next = value as AssetRole | "";
    if (next === current) return;
    mutation.mutate(
      { projectId: row.project_id, bindingId: row.id, data: { asset_role: next } },
      {
        onSuccess: () => toast.success(t(($) => $.toast.meta_saved)),
        onError: () => toast.error(t(($) => $.toast.meta_save_failed)),
      },
    );
  };

  return (
    <Select items={items} value={current} onValueChange={handleChange}>
      <SelectTrigger size="sm" className="h-6 max-w-20 border-none bg-transparent px-1 py-0 text-[10px] shadow-none hover:bg-accent/50">
        <SelectValue>
          {current ? <AssetRoleBadge role={current as AssetRole} /> : (
            <span className="text-[10px] text-muted-foreground">{t(($) => $.roles.none)}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ──────────────────────────────────────────────
// InlineCategorySelect
// ──────────────────────────────────────────────

export function InlineCategorySelect({ row }: { row: AssetBinding }) {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const mutation = useUpdateAssetMeta(wsId);

  const labels = useMemo<Record<AssetCategory, string>>(
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

  const items = useMemo(
    () => ASSET_CATEGORIES.map((c) => ({ value: c as string, label: labels[c] })),
    [labels],
  );

  const current = row.asset_category;

  const handleChange = (value: string | null) => {
    if (value === null) return;
    const next = value as AssetCategory;
    if (next === current) return;
    mutation.mutate(
      { projectId: row.project_id, bindingId: row.id, data: { asset_category: next } },
      {
        onSuccess: () => toast.success(t(($) => $.toast.meta_saved)),
        onError: () => toast.error(t(($) => $.toast.meta_save_failed)),
      },
    );
  };

  const visual = CATEGORY_VISUALS[current] ?? CATEGORY_VISUALS.other;

  return (
    <Select items={items} value={current} onValueChange={handleChange}>
      <SelectTrigger size="sm" className="h-6 max-w-32 border-none bg-transparent px-1 py-0 text-[10px] shadow-none hover:bg-accent/50">
        <SelectValue>
          <span className={`inline-flex items-center gap-1 rounded px-1 py-px text-[10px] font-medium ${visual.tile}`}>
            {labels[current] ?? current}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ──────────────────────────────────────────────
// InlineTagsEditor
// ──────────────────────────────────────────────

export function InlineTagsEditor({ row }: { row: AssetBinding }) {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const mutation = useUpdateAssetMeta(wsId);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(row.tags ?? []);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleOpen = (next: boolean) => {
    if (next) setDraft(row.tags ?? []);
    setOpen(next);
  };

  const addTag = () => {
    const val = inputRef.current?.value.trim();
    if (!val) return;
    if (draft.includes(val)) { inputRef.current!.value = ""; return; }
    if (draft.length >= 20) return;
    setDraft((d) => [...d, val]);
    inputRef.current!.value = "";
  };

  const removeTag = (tag: string) => setDraft((d) => d.filter((t) => t !== tag));

  const save = () => {
    const cleaned = draft.map((s) => s.trim()).filter(Boolean).slice(0, 20);
    mutation.mutate(
      { projectId: row.project_id, bindingId: row.id, data: { tags: cleaned } },
      {
        onSuccess: () => { toast.success(t(($) => $.toast.meta_saved)); setOpen(false); },
        onError: () => toast.error(t(($) => $.toast.meta_save_failed)),
      },
    );
  };

  const displayed = row.tags ?? [];

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex min-w-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent/50"
          >
            {displayed.length === 0 ? (
              <Plus className="size-3 text-muted-foreground" />
            ) : (
              displayed.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className={`max-w-20 truncate rounded px-1 py-px text-[10px] font-medium ${tagTone(tag)}`}
                  title={tag}
                >
                  {tag}
                </span>
              ))
            )}
            {displayed.length > 3 ? (
              <span className="text-[10px] text-muted-foreground">+{displayed.length - 3}</span>
            ) : null}
          </button>
        }
      />
      <PopoverContent align="start" className="w-64 p-2">
        <div className="flex flex-wrap gap-1">
          {draft.map((tag) => (
            <span
              key={tag}
              className={`inline-flex items-center gap-0.5 rounded px-1.5 py-px text-[10px] font-medium ${tagTone(tag)}`}
            >
              {tag}
              <button type="button" onClick={() => removeTag(tag)} className="ml-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10">
                <X className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          <Input
            ref={inputRef}
            placeholder={t(($) => $.inline_edit.tags_placeholder)}
            className="h-6 text-[11px]"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
          />
          <Button type="button" size="xs" variant="ghost" className="h-6 px-1" onClick={addTag}>
            <Plus className="size-3" />
          </Button>
        </div>
        <div className="mt-2 flex justify-end gap-1">
          <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
            {t(($) => $.actions.cancel)}
          </Button>
          <Button type="button" size="xs" disabled={mutation.isPending} onClick={save}>
            {t(($) => $.actions.save)}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
