"use client";

import { useMemo, useRef, useState } from "react";
import { FileUp, FolderUp } from "lucide-react";
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
import { useT } from "../../../../i18n";
import { useBatchUpload, type BatchMeta } from "../hooks/batch-upload";

/**
 * 目录批量导入面板（绑定资产对话框第三个 TAB）。
 *
 * 选本地目录（webkitdirectory）或多选文件 → 前端过滤（隐藏 / >20MB / 不支持类型）
 * → 逐个上传（POST /api/upload-file，落 workspace 附件存储）→ 逐个绑定为项目资产
 * （POST /assets，473 字段可带默认阶段 / 角色 / 标签）。顺序执行避免并发打爆服务端，
 * 支持中途取消（已绑定部分保留）。
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
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        aria-hidden
        onChange={() => void handleFilesSelected(modeRef.current, currentMeta())}
      />

      {isUploading && progress ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-caption font-medium tabular-nums">
              {t(($) => $.batch.uploading, { done: progress.done, total: progress.total })}
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
          {progress.current ? (
            <div className="truncate text-micro text-muted-foreground" title={progress.current}>
              {t(($) => $.batch.uploading_current, { name: progress.current })}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-caption text-muted-foreground">{t(($) => $.manual_form.stage_label)}</span>
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
            <label className="block space-y-1">
              <span className="text-caption text-muted-foreground">{t(($) => $.manual_form.role_label)}</span>
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
            <label className="col-span-2 block space-y-1">
              <span className="text-caption text-muted-foreground">{t(($) => $.manual_form.tags_label)}</span>
              <Input
                value={tagsText}
                onChange={(event) => setTagsText(event.target.value)}
                placeholder={t(($) => $.manual_form.tags_placeholder)}
                className="h-8 text-caption"
              />
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                modeRef.current = "directory";
                pickFolder();
              }}
            >
              <FolderUp />
              {t(($) => $.batch.select_folder)}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                modeRef.current = "files";
                pickFiles();
              }}
            >
              <FileUp />
              {t(($) => $.batch.select_files)}
            </Button>
          </div>
          <p className="text-micro leading-relaxed text-muted-foreground">
            {t(($) => $.batch.folder_hint)}
          </p>
        </>
      )}
    </div>
  );
}
