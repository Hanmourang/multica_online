"use client";

import { useMemo, useState, useRef, type ReactNode } from "react";
import { ListTodo, Plus, Search, Workflow, X } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  ASSET_CATEGORIES,
  ASSET_LIFECYCLE_STAGES,
  type AssetBinding,
  type AssetCategory,
  type AssetIssueLink,
  type AssetIssueLinkRequest,
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
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { useT } from "../../../../i18n";
import { AssetStageBadge, AssetRoleBadge, tagTone, CATEGORY_VISUALS } from "./asset-visuals";
import {
  REQUIREMENT_TONE_CLASS,
  TASK_TONE_CLASS,
  statusToneClass,
} from "./asset-status-tone";

/**
 * 行内即时编辑：分类 / 阶段 / 对象 Select（选择即保存）+ 标签 Popover（确认即保存）。
 * 每个组件自包含 mutation 逻辑，不依赖外部表单状态。
 * 五阶段对齐 plan §7.2：项目按行 `row.project_id` 确定，不再接受容器固定 projectId，
 * 使项目 / 工作项 / 工作区三种作用域的行都写入正确项目。
 * 批量编辑 Dialog 已抽到受控的 asset-batch-edit-dialog（§7.1）。
 */

/**
 * 「空值入口」的显隐：标签 / 需求 / 任务为空时只留一个低调的十字，行悬停或键盘
 * 聚焦才显形。整屏都是「＋」会把真正有内容的列淹没（宽屏表格尤其明显），但入口
 * 仍留在 DOM 里保持可发现 / 可聚焦 / 可被测试断言。
 */
const EMPTY_TRIGGER_REVEAL =
  "opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus:opacity-100 focus-visible:opacity-100";

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
      <SelectTrigger size="sm" className="h-7 max-w-32 border-none bg-transparent px-1.5 py-0 text-micro shadow-none hover:bg-accent/60">
        <SelectValue>
          {current ? <AssetStageBadge stage={current as AssetLifecycleStage} /> : (
            <span className="text-micro text-muted-foreground">{t(($) => $.stages.none)}</span>
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
      <SelectTrigger size="sm" className="h-7 max-w-24 border-none bg-transparent px-1.5 py-0 text-micro shadow-none hover:bg-accent/60">
        <SelectValue>
          {current ? <AssetRoleBadge role={current as AssetRole} /> : (
            <span className="text-micro text-muted-foreground">{t(($) => $.roles.none)}</span>
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
      <SelectTrigger size="sm" className="h-7 max-w-36 border-none bg-transparent px-1.5 py-0 text-micro shadow-none hover:bg-accent/60">
        <SelectValue>
          <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro font-medium ${visual.tile}`}>
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
  // 无标签时只留悬停才显形的「＋」，有标签时正常常驻。
  const revealClass = displayed.length === 0 ? EMPTY_TRIGGER_REVEAL : "";

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={`inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-accent/60 ${revealClass}`}
          >
            {displayed.length === 0 ? (
              <Plus className="size-3.5 text-muted-foreground" />
            ) : (
              displayed.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className={`max-w-24 truncate rounded-md px-1.5 py-0.5 text-micro font-medium leading-none ${tagTone(tag)}`}
                  title={tag}
                >
                  {tag}
                </span>
              ))
            )}
            {displayed.length > 3 ? (
              <span className="text-micro text-muted-foreground">+{displayed.length - 3}</span>
            ) : null}
          </button>
        }
      />
      <PopoverContent align="start" className="w-64 p-2">
        <div className="flex flex-wrap gap-1">
          {draft.map((tag) => (
            <span
              key={tag}
              className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-micro font-medium leading-none ${tagTone(tag)}`}
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
            className="h-7 text-caption"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
          />
          <Button type="button" size="xs" variant="ghost" className="h-7 px-1.5" onClick={addTag}>
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

// ──────────────────────────────────────────────
// InlineIssueLinkEditor（需求 / 任务行内关联）
// ──────────────────────────────────────────────

/** 行内关联可选的工作项（容器把 overview.issues 按 is_requirement 分桶后传入）。 */
export type InlineIssueCandidate = {
  id: string;
  title: string;
  status?: string;
  project_id?: string | null;
  is_requirement?: boolean;
};

/**
 * 需求 / 任务列行内关联编辑（对标客户端）：点列内徽标开 Popover，勾选即改选，
 * 保存即写入。写入是全量替换语义，所以另一桶的关联必须原样带回，否则会误删。
 * 新关联的链型沿用默认口径：需求=produces、任务=resolves。
 */
export function InlineIssueLinkEditor({
  row,
  bucket,
  bucketLinks,
  otherLinks,
  candidates,
}: {
  row: AssetBinding;
  bucket: "requirement" | "task";
  /** 当前桶已关联条目。 */
  bucketLinks: readonly AssetIssueLink[];
  /** 另一桶关联（全量替换时原样保留）。 */
  otherLinks: readonly AssetIssueLink[];
  /** 当前桶的可选工作项。 */
  candidates: readonly InlineIssueCandidate[];
}) {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const mutation = useUpdateAssetMeta(wsId);
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const isRequirement = bucket === "requirement";
  const toneClass = isRequirement ? REQUIREMENT_TONE_CLASS : TASK_TONE_CLASS;
  const icon: ReactNode = isRequirement ? (
    <Workflow className="size-3 shrink-0" />
  ) : (
    <ListTodo className="size-3 shrink-0" />
  );

  const handleOpen = (next: boolean) => {
    if (next) {
      setSelected(bucketLinks.map((l) => l.issue_id));
      setKeyword("");
    }
    setOpen(next);
  };

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return candidates;
    return candidates.filter(
      (c) => c.title.toLowerCase().includes(kw) || c.id.toLowerCase().startsWith(kw),
    );
  }, [candidates, keyword]);

  const save = () => {
    const keep = new Set(selected);
    const kept = bucketLinks.filter((l) => keep.has(l.issue_id));
    const keptIds = new Set(kept.map((l) => l.issue_id));
    const fallbackType = isRequirement ? "produces" : "resolves";
    const added: AssetIssueLinkRequest[] = selected
      .filter((id) => !keptIds.has(id))
      .map((id) => ({ issue_id: id, link_type: fallbackType }));
    const nextLinks: AssetIssueLinkRequest[] = [
      ...otherLinks,
      ...kept,
      ...added,
    ].map((l) => ({
      issue_id: l.issue_id,
      link_type: l.link_type as AssetIssueLinkRequest["link_type"],
    }));
    // 无变化时不开请求，避免无意义的 invalidate。
    if (linkSignature(nextLinks) === linkSignature([...otherLinks, ...bucketLinks])) {
      setOpen(false);
      return;
    }
    mutation.mutate(
      { projectId: row.project_id, bindingId: row.id, data: { links: nextLinks } },
      {
        onSuccess: () => { toast.success(t(($) => $.toast.meta_saved)); setOpen(false); },
        onError: () => toast.error(t(($) => $.toast.meta_save_failed)),
      },
    );
  };

  const count = bucketLinks.length;
  const triggerLabel = t(($) => $.inline_edit.link_manage, { count });

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger
        aria-label={triggerLabel}
        title={triggerLabel}
        className={`inline-flex h-7 min-w-7 cursor-pointer items-center justify-center gap-1 rounded-md border border-transparent px-1.5 text-micro font-medium outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring ${
          count > 0 ? toneClass : `text-muted-foreground hover:text-foreground ${EMPTY_TRIGGER_REVEAL}`
        }`}
      >
        {count > 0 ? (
          <>
            {icon}
            <span className="tabular-nums">{count}</span>
          </>
        ) : (
          <Plus className="size-3.5" />
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b border-surface-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={
                isRequirement
                  ? t(($) => $.inline_edit.link_search_requirement)
                  : t(($) => $.inline_edit.link_search_task)
              }
              className="h-8 pl-7 text-caption"
            />
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-caption text-muted-foreground">
              {t(($) => $.inline_edit.link_empty)}
            </p>
          ) : (
            filtered.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60"
              >
                <Checkbox checked={selected.includes(c.id)} onCheckedChange={() => toggle(c.id)} />
                <span className="min-w-0 flex-1 truncate text-caption" title={c.title}>
                  {c.title}
                </span>
                {c.status ? (
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-micro font-medium ${statusToneClass(c.status)}`}
                  >
                    {c.status}
                  </span>
                ) : null}
              </label>
            ))
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-surface-border p-2">
          <span className="text-micro text-muted-foreground">
            {t(($) => $.inline_edit.link_selected, { count: selected.length })}
          </span>
          <div className="flex items-center gap-1">
            <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
              {t(($) => $.actions.cancel)}
            </Button>
            <Button type="button" size="xs" disabled={mutation.isPending} onClick={save}>
              {t(($) => $.actions.save)}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 关联集合签名：按 issue_id + link_type 排序后比较，用于判定“无变化”。 */
function linkSignature(links: ReadonlyArray<{ issue_id: string; link_type?: string }>): string {
  return links
    .map((l) => `${l.issue_id}:${l.link_type ?? ""}`)
    .sort()
    .join("|");
}
