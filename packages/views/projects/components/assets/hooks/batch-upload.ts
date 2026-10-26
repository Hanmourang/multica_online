"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { assetKeys } from "@multica/core/assets/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import type { AssetCategory, AssetLifecycleStage, AssetRole } from "@multica/core/types";
import { useT } from "../../../../i18n";

// 批量上传 hook（目录 / 文件两种入口）。
// spec: change_logs/multica/plans/资产批量导入/方案.md §3.2
//
// 流程：选目录/文件 → 前端过滤 → 逐个 uploadFile → 逐个 bindProjectAsset →
// 统计成功/失败 → invalidate 资产列表。
//
// 设计要点：
//  1. 顺序上传（非 Promise.all）：避免并发过多导致服务器拒绝或网络拥塞。
//  2. AbortController 支持取消：已完成的上传不回滚（binding 已落库）。
//  3. 进度状态对外暴露：调用方渲染进度条。
//  4. 跳过文件单独收集：前端过滤掉的（隐藏文件 / 超大小 / 不支持类型）。

/** 单个文件的上传结果。 */
interface FileResult {
  status: "success" | "failed" | "skipped";
  error?: string;
}

/** 批量上传的完整统计。 */
export interface BatchUploadStats {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  failures: Array<{ name: string; error: string }>;
}

/** 批量上传的进度快照（对外渲染用）。 */
export interface BatchUploadProgress {
  phase: "picking" | "uploading" | "done" | "cancelled";
  current: string;
  done: number;
  total: number;
  results: Map<string, FileResult>;
}

/** 批量上传 hook 的返回值。 */
export interface BatchUploadState {
  isUploading: boolean;
  progress: BatchUploadProgress | null;
  canCancel: boolean;
}

/** 文件选择 input 的 ref 类型。 */
type FileInputRef = React.RefObject<HTMLInputElement | null>;

/** 单个待上传条目。 */
interface PendingFile {
  file: File;
  relPath: string;
}

/** 批量导入时附加到每个 binding 的默认元信息（473 字段）。 */
export interface BatchMeta {
  lifecycle_stage?: AssetLifecycleStage;
  asset_role?: AssetRole;
  tags?: string[];
}

/** 从 webkitdirectory 输入中收集文件（跳过 0 字节占位条目）。 */
export function collectDirectoryFiles(input: HTMLInputElement): PendingFile[] {
  const out: PendingFile[] = [];
  const fl = input.files;
  if (!fl) return out;
  for (let i = 0; i < fl.length; i++) {
    const f = fl[i];
    if (!f) continue;
    if (f.size === 0) continue;
    const rp = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    out.push({ file: f, relPath: rp });
  }
  return out;
}

/** 从普通 file input（多选文件）中收集条目。 */
export function collectPlainFiles(input: HTMLInputElement): PendingFile[] {
  const out: PendingFile[] = [];
  const fl = input.files;
  if (!fl) return out;
  for (let i = 0; i < fl.length; i++) {
    const f = fl[i];
    if (!f || f.size === 0) continue;
    out.push({ file: f, relPath: f.name });
  }
  return out;
}

/**
 * 前端文件过滤：排除不可见文件、超大文件、不支持的类型。
 * 返回 null = 通过；返回字符串 = 跳过原因 i18n 键。
 */
export function validateFile(f: File, relPath: string): "too_large" | "hidden" | "unsupported_type" | null {
  const name = relPath.split("/").pop() || f.name;
  if (name.startsWith(".")) return "hidden";
  if (f.size > 20 * 1024 * 1024) return "too_large";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const supported = new Set([
    "md", "markdown", "txt", "doc", "docx", "pdf", "html", "htm",
    "xls", "xlsx", "ppt", "pptx", "png", "jpg", "jpeg", "gif", "svg",
    "webp", "json", "yaml", "yml", "csv", "log", "xml",
  ]);
  if (!supported.has(ext)) return "unsupported_type";
  return null;
}

/**
 * 批量上传 hook。
 *
 * @param projectId 绑定目标项目 ID（必填，资产必须落到具体项目）
 * @param category 资产分类（默认 "other"，文档类）
 * @param inputRef 隐藏 file input 的 ref
 */
export function useBatchUpload(projectId: string, category: AssetCategory = "other", inputRef: FileInputRef) {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();

  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<BatchUploadState>({ isUploading: false, progress: null, canCancel: false });

  /** 触发文件选择器（目录模式）。 */
  const pickFolder = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.removeAttribute("multiple");
    input.value = "";
    input.click();
  }, [inputRef]);

  /** 触发文件选择器（多选文件模式）。 */
  const pickFiles = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.removeAttribute("webkitdirectory");
    input.setAttribute("multiple", "");
    input.value = "";
    input.click();
  }, [inputRef]);

  /** 取消上传（已完成的不回滚）。 */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** 处理选中的文件（由 input onChange 调用）。meta 应用到每个绑定。 */
  const handleFilesSelected = useCallback(
    async (mode: "directory" | "files", meta?: BatchMeta) => {
      const input = inputRef.current;
      if (!input) return;
      const pending = mode === "directory" ? collectDirectoryFiles(input) : collectPlainFiles(input);
      input.removeAttribute("webkitdirectory");
      input.removeAttribute("multiple");

      if (pending.length === 0) {
        toast.error(t(($) => $.batch.no_files));
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;

      const results = new Map<string, FileResult>();
      let done = 0;
      let skipped = 0;
      const skippedReasons: string[] = [];
      const failures: Array<{ name: string; error: string }> = [];

      setState({
        isUploading: true,
        canCancel: true,
        progress: { phase: "uploading", current: "", done: 0, total: pending.length, results },
      });

      for (const { file, relPath } of pending) {
        if (controller.signal.aborted) break;

        const reason = validateFile(file, relPath);
        if (reason) {
          results.set(relPath, { status: "skipped" });
          skippedReasons.push(`${relPath.split("/").pop()}: ${t(($) => $.batch[reason])}`);
          skipped++;
          done++;
          setState((prev) => prev.progress ? { ...prev, progress: { ...prev.progress, done, results } } : prev);
          continue;
        }

        setState((prev) => prev.progress ? { ...prev, progress: { ...prev.progress, current: file.name } } : prev);

        try {
          const attachment = await api.uploadFile(file, undefined, controller.signal);
          const assetName = file.name.replace(/\.[^.]+$/, "");
          await api.bindProjectAsset(projectId, {
            asset_category: category,
            asset_name: assetName,
            asset_subtype: file.name.split(".").pop()?.toLowerCase() || null,
            source: "manual",
            ...(meta?.lifecycle_stage ? { lifecycle_stage: meta.lifecycle_stage } : {}),
            ...(meta?.asset_role ? { asset_role: meta.asset_role } : {}),
            ...(meta?.tags?.length ? { tags: meta.tags } : {}),
            external_ref: {
              url: attachment.url,
              attachment_id: attachment.id,
              filename: file.name,
              size_bytes: file.size,
              content_type: file.type,
              rel_path: relPath,
            },
          });
          results.set(relPath, { status: "success" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.set(relPath, { status: "failed", error: msg });
          failures.push({ name: relPath.split("/").pop() || relPath, error: msg });
        }

        done++;
        setState((prev) => prev.progress ? { ...prev, progress: { ...prev.progress, done, results } } : prev);
      }

      const wasCancelled = controller.signal.aborted;
      abortRef.current = null;

      const succeeded = Array.from(results.values()).filter((r) => r.status === "success").length;
      const failed = Array.from(results.values()).filter((r) => r.status === "failed").length;

      // 刷新资产列表（绑定成功的部分）。已落库的 binding 不因取消回滚。
      if (succeeded > 0) {
        queryClient.invalidateQueries({ queryKey: assetKeys.project(wsId, projectId) });
        queryClient.invalidateQueries({ queryKey: assetKeys.all(wsId) });
      }

      setState({ isUploading: false, canCancel: false, progress: null });

      if (wasCancelled) {
        toast.info(t(($) => $.batch.cancelled, { done, total: pending.length }));
      } else if (failed === 0 && skipped === 0) {
        toast.success(t(($) => $.batch.imported, { count: succeeded }));
      } else if (succeeded === 0) {
        toast.error(t(($) => $.batch.import_failed));
      } else {
        const details = [
          failed > 0 ? t(($) => $.batch.done_detail_failures, { failures: failures.map((f) => `${f.name}(${f.error})`).join("、") }) : "",
          skipped > 0 ? t(($) => $.batch.done_detail_skipped, { skipped_list: skippedReasons.join("、") }) : "",
        ].filter(Boolean).join("；");
        toast.warning(t(($) => $.batch.done_summary, { succeeded, failed, skipped }), { description: details });
      }
    },
    [t, inputRef, projectId, category, queryClient, wsId],
  );

  return { pickFolder, pickFiles, cancel, handleFilesSelected, ...state };
}
