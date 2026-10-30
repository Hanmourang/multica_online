"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Search, Upload } from "lucide-react";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectArtifactsOptions, useCreateArtifact } from "@multica/core/artifacts";
import {
  projectDetailOptions,
  projectResourcesOptions,
  useRegisterModulePrototype,
} from "@multica/core/projects";
import type { Attachment } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { cn } from "@multica/ui/lib/utils";
import { validateFile } from "../../assets/hooks/batch-upload";
import {
  isArchiveResourceMissingError,
  resolveArchiveBindTarget,
} from "../../archive/archive-import";
import { useT } from "../../../../i18n";
import {
  filterArtifactsByKeyword,
  isPrototypeFile,
  prototypeRelPath,
  splitArtifactPath,
} from "./prototype-create-model";

type Source = "upload" | "artifact";

/** 服务端错误体里带 gated 语义的统一判定：FF_MODULE_SPEC_CENTER 关闭时后端不注册叶子路由。 */
function isGatedError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { status?: number }).status === 404,
  );
}

/**
 * 上传分支要先落一条 project_artifact（预览靠它的 attachment_id），而档案写入
 * 要求项目已绑定档案根目录。这个前置条件不满足时错误码是
 * archive_resource_missing，必须和「能力未开启」分开提示，否则用户会以为按钮坏了。
 */
function failMessage(error: unknown, t: ReturnType<typeof useT<"archive">>["t"]): string {
  if (isArchiveResourceMissingError(error)) return t(($) => $.features.create_proto_no_archive);
  if (isGatedError(error)) return t(($) => $.features.create_proto_gated);
  return t(($) => $.features.create_proto_failed);
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 新增模块原型：上传本地 HTML 或从项目档案里挑已有的 HTML，登记成模块原型版本。
 *
 * 走的是「先存正文、再记版本」两步：附件 + project_artifact 提供可预览的正文，
 * issue_prototype_version（issue_id 为空）提供版本坐标与权威指针。模块未绑定图谱、
 * 甚至没有任何需求时也能用 —— 这正是此前完全缺失的入口。
 */
export function PrototypeCreateDialog({
  open,
  onOpenChange,
  projectId,
  moduleId,
  moduleName,
  nextVersion,
  registeredPaths = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  moduleId: string;
  moduleName?: string | null;
  nextVersion: number;
  registeredPaths?: string[];
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const createArtifact = useCreateArtifact(wsId, projectId);
  const register = useRegisterModulePrototype(wsId, projectId, moduleId);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [source, setSource] = useState<Source>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [pickedPath, setPickedPath] = useState("");
  const [keyword, setKeyword] = useState("");
  const [busy, setBusy] = useState(false);
  const artifactsQuery = useQuery({
    ...projectArtifactsOptions(wsId, projectId),
    enabled: open,
  });
  // 上传分支要写 project_artifact，而档案行必须挂在档案资源上。提前探一下，
  // 未绑定时在对话框里就说明原因，不让用户点完提交才看到失败。
  const projectQuery = useQuery({
    ...projectDetailOptions(wsId, projectId),
    enabled: open && source === "upload",
  });
  const resourcesQuery = useQuery({
    ...projectResourcesOptions(wsId, projectId),
    enabled: open && source === "upload",
  });
  const archiveBind = resolveArchiveBindTarget(
    projectQuery.data?.archive_resource_id,
    resourcesQuery.data ?? [],
  );
  const archiveReady = archiveBind.status !== "missing";

  const registered = useMemo(() => new Set(registeredPaths), [registeredPaths]);
  const htmlArtifacts = useMemo(
    () =>
      (artifactsQuery.data ?? [])
        .filter((row) => isPrototypeFile(row.rel_path))
        .sort((a, b) => a.rel_path.localeCompare(b.rel_path)),
    [artifactsQuery.data],
  );

  // 列表最高 17rem，过滤后行数变少时要回到顶部，否则会停在旧滚动位置露出空白。
  const visibleArtifacts = useMemo(
    () => filterArtifactsByKeyword(htmlArtifacts, keyword),
    [htmlArtifacts, keyword],
  );

  useEffect(() => {
    if (!open) return;
    setSource("upload");
    setFile(null);
    setPickedPath("");
    setKeyword("");
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [keyword]);

  const pickFile = (next: File | null) => {
    if (!next) {
      setFile(null);
      return;
    }
    const problem = validateFile(next, next.name);
    if (problem === "too_large") {
      toast.error(t(($) => $.features.create_proto_too_large));
      return;
    }
    if (problem === "hidden") {
      toast.error(t(($) => $.features.create_proto_hidden));
      return;
    }
    if (problem === "unsupported_type" || !isPrototypeFile(next.name)) {
      toast.error(t(($) => $.features.create_proto_not_html));
      return;
    }
    setFile(next);
  };

  const submit = async () => {
    if (busy) return;
    let htmlPath = "";
    let attachment: Attachment | null = null;
    if (source === "upload") {
      if (!file) {
        toast.error(t(($) => $.features.create_proto_need_file));
        return;
      }
      htmlPath = prototypeRelPath({
        moduleName,
        version: nextVersion,
        fileName: file.name,
      });
    } else {
      if (!pickedPath) {
        toast.error(t(($) => $.features.create_proto_need_artifact));
        return;
      }
      htmlPath = pickedPath;
    }

    setBusy(true);
    try {
      if (source === "upload" && file) {
        attachment = await api.uploadFile(file);
        await createArtifact.mutateAsync({
          scope: "project",
          stage: 1,
          doc_type: "prototype",
          rel_path: htmlPath,
          doc_module: moduleName ?? null,
          version: nextVersion,
          attachment_id: attachment.id,
        });
      }
      await register.mutateAsync({
        version: nextVersion,
        html_path: htmlPath,
        prompt: "manual upload",
        status: "confirmed",
        set_canonical: true,
      });
      toast.success(
        t(($) => $.features.create_proto_ok, { version: nextVersion }),
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(failMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/**
       * `[&>*]:min-w-0` 是必须的：DialogContent 是 grid，隐式 auto 轨道的基准尺寸
       * 取子元素的 min-content，而 grid 轨道不会被 max-width 压缩。档案里一条长路径
       * 用 truncate（overflow:hidden + nowrap）也**不会**降低 intrinsic min-content，
       * 于是整条轨道被顶到路径宽度，表头/分段控件/页脚一起越出白底。
       * 给每个直接子元素显式 min-w-0，轨道才会停在容器宽。
       * overflow-x-clip 是最后一道防线，避免今后新元素再画出边界。
       */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-x-clip [&>*]:min-w-0 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.features.create_proto_title)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.features.create_proto_hint, { version: nextVersion })}
          </DialogDescription>
        </DialogHeader>

        {/* 等宽两格的分段控件：ghost 按钮并排时看起来只是两个文字，选中的那个不明显。 */}
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-surface-border bg-muted/40 p-1">
          {(
            [
              { id: "upload" as const, label: t(($) => $.features.create_proto_upload) },
              { id: "artifact" as const, label: t(($) => $.features.create_proto_from_archive) },
            ]
          ).map((option) => {
            const active = source === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => setSource(option.id)}
                className={cn(
                  "cursor-pointer rounded-md px-2 py-1.5 text-center text-[11.5px] font-medium transition-colors",
                  active
                    ? "bg-surface-raised text-foreground shadow-sm ring-1 ring-primary/25"
                    : "text-muted-foreground hover:bg-surface-raised/60 hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {source === "upload" ? (
          <div className="space-y-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".html,.htm,text/html"
              className="hidden"
              onChange={(event) => {
                const picked = event.target.files?.[0] ?? null;
                // 清空 value，同一个文件重选也能触发 change。
                event.target.value = "";
                pickFile(picked);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center gap-2 rounded-lg border border-dashed border-surface-border bg-muted/20 px-3 py-4 text-left hover:border-primary/40 hover:bg-primary/5"
            >
              <Upload className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-semibold">
                  {file
                    ? t(($) => $.features.create_proto_selected, {
                        name: file.name,
                        size: formatSize(file.size),
                      })
                    : t(($) => $.features.create_proto_pick)}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {t(($) => $.features.create_proto_pick_hint)}
                </span>
              </span>
            </button>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {t(($) => $.features.create_proto_path_hint, {
                path: prototypeRelPath({
                  moduleName,
                  version: nextVersion,
                  fileName: file?.name ?? "prototype.html",
                }),
              })}
            </p>
            {archiveReady ? null : (
              <div className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2">
                <p className="text-[10.5px] leading-relaxed text-warning">
                  {t(($) => $.features.create_proto_no_archive)}
                </p>
                {/* 别让用户卡在一条走不通的路上：档案里已有 HTML 时直接给出口。 */}
                {htmlArtifacts.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setSource("artifact")}
                    className="mt-1 cursor-pointer text-[10.5px] font-medium text-warning underline underline-offset-2 hover:opacity-80"
                  >
                    {t(($) => $.features.create_proto_switch_to_archive)}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {artifactsQuery.isPending ? (
              <p className="text-[11px] text-muted-foreground">
                {t(($) => $.features.create_proto_loading)}
              </p>
            ) : htmlArtifacts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-surface-border px-3 py-4 text-center text-[11px] text-muted-foreground">
                {t(($) => $.features.create_proto_archive_empty)}
              </p>
            ) : (
              <>
                {/* 真实项目能攒到上百个 HTML，平铺只能靠滚：给一个关键词过滤框。 */}
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <input
                    type="search"
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder={t(($) => $.features.create_proto_search_placeholder)}
                    className="w-full rounded-md border border-surface-border bg-surface-raised py-1.5 pr-2 pl-7 text-[11.5px] outline-none placeholder:text-muted-foreground focus:border-primary/40"
                  />
                </div>
                <div className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {keyword.trim()
                      ? t(($) => $.features.create_proto_search_result, {
                          n: visibleArtifacts.length,
                          total: htmlArtifacts.length,
                        })
                      : t(($) => $.features.create_proto_archive_count, {
                          n: htmlArtifacts.length,
                        })}
                  </span>
                  <span className="shrink-0">{t(($) => $.features.create_proto_archive_pick_hint)}</span>
                </div>
                {visibleArtifacts.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-surface-border px-3 py-4 text-center text-[11px] text-muted-foreground">
                    {t(($) => $.features.create_proto_search_empty)}
                  </p>
                ) : (
                  /* max-h 用 dvh 兼作矮视口兜底：列表自己让位，而不是把页脚推出屏幕。 */
                  <ul
                    ref={listRef}
                    className="w-full max-h-[min(17rem,calc(100dvh-20rem))] space-y-1 overflow-auto pr-1"
                  >
                    {visibleArtifacts.map((row) => {
                    const used = registered.has(row.rel_path);
                    const active = pickedPath === row.rel_path;
                    const { dir, name } = splitArtifactPath(row.rel_path);
                    return (
                      <li key={row.id}>
                        {/* 默认态就给边框与 pointer 光标：只靠 hover 变色的行看不出能点。 */}
                        <button
                          type="button"
                          disabled={used}
                          title={row.rel_path}
                          onClick={() => setPickedPath(row.rel_path)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                            active
                              ? "border-primary bg-primary/8 shadow-sm ring-1 ring-primary/15"
                              : "border-surface-border bg-surface-raised hover:border-primary/30 hover:bg-muted/40",
                            used
                              ? "cursor-not-allowed border-dashed opacity-60"
                              : "cursor-pointer",
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11.5px] font-medium">
                              {name}
                            </span>
                            {dir ? (
                              <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                                {dir}
                              </span>
                            ) : null}
                          </span>
                          {used ? (
                            <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                              <Check className="size-3" aria-hidden />
                              {t(($) => $.features.create_proto_registered)}
                            </span>
                          ) : active ? (
                            <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                  </ul>
                )}
              </>
            )}
            {pickedPath ? (
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {t(($) => $.features.create_proto_archive_path_hint, { path: pickedPath })}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t(($) => $.common.close)}
          </Button>
          <Button
            type="button"
            disabled={busy || (source === "upload" && !archiveReady)}
            onClick={() => void submit()}
          >
            {busy
              ? t(($) => $.features.create_proto_pending)
              : t(($) => $.features.create_proto_submit, { version: nextVersion })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
