"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronRight, FileUp, FolderUp, Info, Loader2, Tags } from "lucide-react";
import type { AssetCategory, AssetLifecycleStage, AssetRole } from "@multica/core/types";
import { ASSET_LIFECYCLE_STAGES } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../../i18n";
import { useBatchUpload, type BatchMeta } from "../hooks/batch-upload";

/**
 * 目录批量导入面板（绑定资产对话框第三个 TAB）。
 *
 * 选本地目录（webkitdirectory）或多选文件 → 前端过滤（隐藏 / >20MB / 不支持类型）
 * → 逐个上传（POST /api/upload-file，落 workspace 附件存储）→ 逐个绑定为项目资产
 * （POST /assets，473 字段可带默认阶段 / 角色 / 标签）。顺序执行避免并发打爆服务端，
 * 支持中途取消（已绑定部分保留）。
 *
 * 视觉分层：①两个并列的上传入口磁贴（唯一的行动点）→ ②「导入属性」可选分组卡
 * （一次写入本批全部文件）→ ③约束说明条。上传中整体切换为进度卡，入口与属性表单
 * 收起，避免中途改属性造成"同一批两套元信息"的误读。
 */
export function BatchImportPanel({
  projectId,
  category,
}: {
  projectId: string;
  category: AssetCategory;
}) {
  const { t } = useT("assets");
  const inputRef = useRef<HTMLInputElement>(null);
  // 同一个隐藏 input 复用两种选择模式：点按钮时先记模式，onChange 里读取。
  const modeRef = useRef<"directory" | "files">("directory");

  const [stage, setStage] = useState<"none" | AssetLifecycleStage>("none");
  const [role, setRole] = useState<"none" | AssetRole>("none");
  const [tagsText, setTagsText] = useState("");

  const { pickFolder, pickFiles, cancel, handleFilesSelected, isUploading, progress, canCancel } =
    useBatchUpload(projectId, category, inputRef);

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

  const currentMeta = (): BatchMeta => {
    const tags = tagsText
      .split(/[,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      ...(stage !== "none" ? { lifecycle_stage: stage } : {}),
      ...(role !== "none" ? { asset_role: role } : {}),
      ...(tags.length ? { tags } : {}),
    };
  };

  const percent =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="min-w-0 space-y-3">
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        aria-hidden
        onChange={() => void handleFilesSelected(modeRef.current, currentMeta())}
      />

      {isUploading && progress ? (
        <div className="space-y-2.5 rounded-lg border border-surface-border bg-surface-hover/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-caption font-medium">
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              <span className="truncate tabular-nums">
                {t(($) => $.batch.uploading, { done: progress.done, total: progress.total })}
              </span>
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canCancel}
              onClick={cancel}
            >
              {t(($) => $.batch.cancel)}
            </Button>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-accent">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-micro text-muted-foreground">
            <span className="min-w-0 truncate" title={progress.current}>
              {progress.current
                ? t(($) => $.batch.uploading_current, { name: progress.current })
                : null}
            </span>
            <span className="shrink-0 tabular-nums">{percent}%</span>
          </div>
          <p className="text-micro leading-relaxed text-muted-foreground">
            {t(($) => $.batch.progress_note)}
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <PickTile
              icon={FolderUp}
              title={t(($) => $.batch.select_folder)}
              hint={t(($) => $.batch.pick_folder_hint)}
              onClick={() => {
                modeRef.current = "directory";
                pickFolder();
              }}
            />
            <PickTile
              icon={FileUp}
              title={t(($) => $.batch.select_files)}
              hint={t(($) => $.batch.pick_files_hint)}
              onClick={() => {
                modeRef.current = "files";
                pickFiles();
              }}
            />
          </div>

          <div className="space-y-2 rounded-lg border border-surface-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span className="flex items-center gap-1.5 text-caption font-medium">
                <Tags className="size-3.5 text-muted-foreground" />
                {t(($) => $.batch.meta_title)}
              </span>
              <span className="min-w-0 truncate text-micro text-muted-foreground">
                {t(($) => $.batch.meta_hint)}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block min-w-0 space-y-1">
                <span className="text-caption text-muted-foreground">
                  {t(($) => $.manual_form.stage_label)}
                </span>
                <Select
                  items={stageItems}
                  value={stage}
                  onValueChange={(value) => value && setStage(value as "none" | AssetLifecycleStage)}
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
              <label className="block min-w-0 space-y-1">
                <span className="text-caption text-muted-foreground">
                  {t(($) => $.manual_form.role_label)}
                </span>
                <Select
                  items={roleItems}
                  value={role}
                  onValueChange={(value) => value && setRole(value as "none" | AssetRole)}
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
              <label className="col-span-full block min-w-0 space-y-1">
                <span className="text-caption text-muted-foreground">
                  {t(($) => $.manual_form.tags_label)}
                </span>
                <Input
                  value={tagsText}
                  onChange={(event) => setTagsText(event.target.value)}
                  placeholder={t(($) => $.manual_form.tags_placeholder)}
                  className="h-7"
                />
              </label>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2">
            <Info className="mt-px size-3.5 shrink-0 text-muted-foreground" />
            <p className="min-w-0 text-micro leading-relaxed text-muted-foreground">
              {t(($) => $.batch.folder_hint)}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/** 上传入口磁贴：整块可点，图标 + 标题 + 一句作用说明，比两个并列按钮更好扫。 */
function PickTile({
  icon: Icon,
  title,
  hint,
  onClick,
}: {
  icon: typeof FolderUp;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex min-w-0 items-center gap-2.5 rounded-lg border border-dashed border-surface-border bg-surface px-3 py-2.5 text-left",
        "transition-colors hover:border-primary/45 hover:bg-primary/5",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-caption font-medium">{title}</span>
        <span className="block truncate text-micro text-muted-foreground">{hint}</span>
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
