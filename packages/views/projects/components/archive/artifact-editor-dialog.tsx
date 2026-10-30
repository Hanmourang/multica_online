"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  projectArtifactsOptions,
  useCreateArtifact,
  useDeleteArtifact,
  usePatchArtifact,
} from "@multica/core/artifacts";
import { projectAssetsOptions, useBindProjectAsset } from "@multica/core/assets";
import type {
  ArtifactScope,
  ArtifactStage,
  Attachment,
  ProjectArtifact,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { cn } from "@multica/ui/lib/utils";
import { readArchiveFile, writeArchiveFile } from "../../../platform/archive-fs";
import { useT } from "../../../i18n";
import { validateFile } from "../assets/hooks/batch-upload";
import { upsertArchiveFrontmatter } from "./archive-frontmatter";
import { suggestedRelPath, todayRequirementKey } from "./archive-inspector";
import type { ArchiveWritebackMode } from "./archive-mapping";
import { ARCHIVE_CREATE_TYPES, renderArchiveTemplate, resolveArchiveDocChoice } from "./archive-templates";
import {
  assetMountCandidates,
  assetNameFromFile,
  fileExtension,
  filterMountCandidates,
  formatFileSize,
  isTextArchiveFile,
  shelfDocTypeForMount,
  syncLifecycleForPlacement,
  withFileExtension,
  type ArtifactSourceMode,
  type AssetMountCandidate,
} from "./artifact-editor-source";

export interface ArtifactEditorSeed {
  scope?: ArtifactScope;
  stage?: ArtifactStage | null;
  docType?: string;
  requirementKey?: string | null;
  issueId?: string | null;
  filename?: string;
  title?: string;
}

const SOURCE_MODES: ArtifactSourceMode[] = ["write", "upload", "asset"];

/** 服务端 issue_id 只认 UUID；非法值不随资产绑定上送，避免整个 bind 400。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 新增档案文档弹窗。
 *
 * 正文有三种来源（仅新建时可选）：
 *  - 手写：模板起步，frontmatter 写回 + 桌面端落盘（原有行为）；
 *  - 上传：本地文件先存为附件，再落档案行，可一并登记为项目资产；
 *  - 资产：从项目资产管理里挑已上传的文件，用其附件挂载到当前档案位置。
 */
export function ArtifactEditorDialog({
  projectId,
  artifact,
  seed,
  open,
  onOpenChange,
  archiveRoot,
}: {
  projectId: string;
  artifact?: ProjectArtifact | null;
  seed?: ArtifactEditorSeed | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 桌面端选中的档案根目录；有值时补齐会同时写本地文件。 */
  archiveRoot?: string | null;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const createMutation = useCreateArtifact(wsId, projectId);
  const patchMutation = usePatchArtifact(wsId, projectId);
  const deleteMutation = useDeleteArtifact(wsId, projectId);
  const bindAssetMutation = useBindProjectAsset(wsId, projectId);
  const editing = !!artifact;

  const [scope, setScope] = useState<ArtifactScope>("project");
  const [stage, setStage] = useState<ArtifactStage | null>(null);
  const [docType, setDocType] = useState("architecture");
  const [requirementKey, setRequirementKey] = useState("");
  const [issueId, setIssueId] = useState("");
  const [relPath, setRelPath] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [pathLocked, setPathLocked] = useState(false);
  const [writebackMode, setWritebackMode] = useState<ArchiveWritebackMode>("frontmatter");
  const [overrideReason, setOverrideReason] = useState("");
  const [source, setSource] = useState<ArtifactSourceMode>("write");
  const [file, setFile] = useState<File | null>(null);
  const [syncToAssets, setSyncToAssets] = useState(true);
  const [assetQuery, setAssetQuery] = useState("");
  const [pickedAssetId, setPickedAssetId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setSource("write");
    setFile(null);
    setSyncToAssets(true);
    setAssetQuery("");
    setPickedAssetId(null);
    if (artifact) {
      setScope(artifact.scope);
      setStage(artifact.stage ?? null);
      setDocType(artifact.doc_type);
      setRequirementKey(artifact.requirement_key ?? "");
      setIssueId(artifact.issue_id ?? "");
      setRelPath(artifact.rel_path);
      setTitle(artifact.rel_path.split("/").pop() ?? "");
      setContent("");
      setPathLocked(true);
      setWritebackMode("frontmatter");
      setOverrideReason("");
      if (archiveRoot) {
        void readArchiveFile(archiveRoot, artifact.rel_path).then((result) => {
          if (result.ok && result.content != null) setContent(result.content);
        });
      }
      return;
    }
    const nextScope = seed?.scope ?? "project";
    const nextStage = seed?.stage ?? null;
    const nextType = seed?.docType ?? "architecture";
    const nextKey = seed?.requirementKey ?? todayRequirementKey();
    const nextTitle = seed?.title ?? seed?.filename ?? nextType;
    setScope(nextScope);
    setStage(nextStage);
    setDocType(nextType);
    setRequirementKey(nextKey);
    setIssueId(seed?.issueId ?? "");
    setTitle(nextTitle);
    setPathLocked(false);
    setRelPath(
      suggestedRelPath({
        scope: nextScope === "shared" ? "shared" : nextScope,
        docType: nextType,
        stage: nextStage,
        requirementKey: nextKey,
        filename: seed?.filename ?? `${resolveArchiveDocChoice(nextType).shelf}.md`,
      }),
    );
    setWritebackMode("frontmatter");
    setOverrideReason("");
    setContent(
      renderArchiveTemplate({
        docType: nextType,
        title: nextTitle,
        requirementKey: nextKey,
        issueId: seed?.issueId,
      }),
    );
  }, [archiveRoot, artifact, open, seed]);

  // 上传 / 挂载时按 stage 归一到货架 doc_type（矩阵的证据种类由路径承载）。
  const choice = useMemo(() => resolveArchiveDocChoice(docType), [docType]);
  const storedDocType =
    !editing && source !== "write"
      ? shelfDocTypeForMount(stage, choice.shelf)
      : choice.shelf;
  const syncLifecycle = useMemo(
    () => syncLifecycleForPlacement({ stage, docType: storedDocType }),
    [stage, storedDocType],
  );

  const derivedPath = useMemo(
    () =>
      suggestedRelPath({
        scope: scope === "shared" ? "shared" : scope,
        docType: storedDocType,
        stage,
        requirementKey,
        filename: title.endsWith(".md") || title.endsWith(".html")
          ? title
          : `${storedDocType}.md`,
      }),
    [scope, storedDocType, stage, requirementKey, title],
  );

  useEffect(() => {
    if (!pathLocked && !editing) setRelPath(derivedPath);
  }, [derivedPath, editing, pathLocked]);

  // 资产库查询只在「从资产选择」时打开，避免每次开弹窗都拉一遍列表。
  const mountQuery = useQuery({
    ...projectAssetsOptions(wsId, projectId, { pageSize: 100 }),
    enabled: open && !editing && source === "asset",
  });
  const artifactsQuery = useQuery({
    ...projectArtifactsOptions(wsId, projectId),
    enabled: open && !editing && source === "asset",
  });
  const mountCandidates = useMemo(
    () => assetMountCandidates(mountQuery.data?.items ?? [], artifactsQuery.data ?? []),
    [mountQuery.data, artifactsQuery.data],
  );
  const visibleCandidates = useMemo(
    () => filterMountCandidates(mountCandidates, assetQuery),
    [mountCandidates, assetQuery],
  );
  const pickedCandidate =
    mountCandidates.find((candidate) => candidate.binding.id === pickedAssetId && !candidate.mounted) ??
    null;

  const busy =
    submitting ||
    createMutation.isPending ||
    patchMutation.isPending ||
    deleteMutation.isPending ||
    bindAssetMutation.isPending;

  const rejectMessage = (reason: "too_large" | "hidden" | "unsupported_type") => {
    switch (reason) {
      case "too_large":
        return t(($) => $.manage.upload_too_large);
      case "hidden":
        return t(($) => $.manage.upload_hidden);
      default:
        return t(($) => $.manage.upload_unsupported);
    }
  };

  const handleFilePick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!picked) return;
    const reason = validateFile(picked, picked.name);
    if (reason) {
      toast.error(rejectMessage(reason));
      setFile(null);
      return;
    }
    setFile(picked);
    // 基名保持（design.md 等证据种类），只把扩展名换成本地文件类型。
    setRelPath((prev) => withFileExtension(prev, picked.name));
    setPathLocked(true);
    if (isTextArchiveFile(picked.name)) {
      try {
        setContent(await picked.text());
      } catch {
        setContent("");
      }
    } else {
      setContent("");
    }
  };

  const submit = async () => {
    if (!relPath.trim() || !docType.trim()) return;
    if (!editing) {
      if (source === "upload" && !file) {
        toast.error(t(($) => $.manage.upload_need_file));
        return;
      }
      if (source === "asset" && !pickedCandidate) {
        toast.error(t(($) => $.manage.asset_need_pick));
        return;
      }
    }
    if (writebackMode === "pointer_only" && !overrideReason.trim()) {
      toast.error(t(($) => $.manage.writeback_reason_required));
      return;
    }
    const mapping = {
      docType: storedDocType,
      docClass: choice.docClass ?? null,
      issueId: issueId.trim() || null,
      requirementKey: requirementKey.trim() || null,
    };
    // 只有手写正文才有 frontmatter 写回语义；上传/挂载保持原文件内容。
    let body = content;
    if (writebackMode === "frontmatter" && (editing || source === "write")) {
      const sourceBody = body.trim()
        ? body
        : editing && archiveRoot
          ? (await readArchiveFile(archiveRoot, relPath.trim())).content ?? ""
          : "";
      if (sourceBody) body = upsertArchiveFrontmatter(sourceBody, mapping);
    }
    setSubmitting(true);
    try {
      if (editing && artifact) {
        await patchMutation.mutateAsync({
          artifactId: artifact.id,
          patch: {
            scope,
            stage,
            doc_type: storedDocType,
            doc_class: choice.docClass ?? null,
            rel_path: relPath.trim(),
            requirement_key: mapping.requirementKey,
            issue_id: mapping.issueId,
            ...(body.trim() ? { content: body } : {}),
          },
        });
        if (archiveRoot && writebackMode === "frontmatter" && body.trim()) {
          const written = await writeArchiveFile(archiveRoot, relPath.trim(), body);
          toast.success(
            written.ok
              ? t(($) => $.manage.writeback_written)
              : t(($) => $.manage.written_db_only),
          );
        } else {
          toast.success(
            writebackMode === "pointer_only"
              ? t(($) => $.manage.writeback_pointer_only)
              : t(($) => $.manage.saved),
          );
        }
        onOpenChange(false);
        return;
      }

      let attachment: Attachment | null = null;
      if (source === "upload" && file) {
        attachment = await api.uploadFile(file);
      }
      const attachmentId = attachment?.id ?? pickedCandidate?.attachmentId ?? null;
      const created = await createMutation.mutateAsync({
        scope,
        stage,
        doc_type: storedDocType,
        doc_class: choice.docClass ?? null,
        rel_path: relPath.trim(),
        requirement_key: mapping.requirementKey,
        issue_id: mapping.issueId,
        version: 1,
        ...(body.trim() ? { content: body } : {}),
        ...(attachmentId ? { attachment_id: attachmentId } : {}),
      });

      let synced = false;
      if (
        source === "upload" &&
        attachment &&
        file &&
        syncToAssets &&
        syncLifecycle
      ) {
        const bindIssueId =
          mapping.issueId && UUID_PATTERN.test(mapping.issueId) ? mapping.issueId : undefined;
        try {
          await bindAssetMutation.mutateAsync({
            asset_category: "knowledge_repo",
            asset_name: assetNameFromFile(file.name),
            asset_subtype: fileExtension(file.name) || null,
            source: "manual",
            asset_role: "output",
            lifecycle_stage: syncLifecycle,
            ...(bindIssueId ? { issue_id: bindIssueId } : {}),
            external_ref: {
              url: attachment.url,
              attachment_id: attachment.id,
              filename: file.name,
              size_bytes: file.size,
              content_type: attachment.content_type || file.type,
              rel_path: relPath.trim(),
              artifact_id: created.id,
            },
          });
          synced = true;
        } catch (err) {
          toast.warning(
            t(($) => $.manage.asset_sync_failed, {
              reason: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }

      if (archiveRoot && source === "write" && body) {
        const written = await writeArchiveFile(archiveRoot, relPath.trim(), body);
        if (!written.ok && written.reason !== "unsupported") {
          toast.info(t(($) => $.manage.written_db_only));
        }
      }
      if (!synced || source !== "upload") {
        toast.success(
          source === "asset"
            ? t(($) => $.manage.mounted_from_asset)
            : t(($) => $.manage.created),
        );
      }
      if (synced) toast.success(t(($) => $.manage.created_with_asset));
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.manage.save_failed));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (!artifact) return;
    try {
      await deleteMutation.mutateAsync(artifact.id);
      toast.success(t(($) => $.manage.deleted));
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.manage.delete_failed));
    }
  };

  const scopeItems = [
    { value: "project", label: t(($) => $.browser.scope_project) },
    { value: "requirement", label: t(($) => $.browser.scope_requirement) },
    { value: "shared", label: t(($) => $.browser.scope_shared) },
  ];
  const stageItems = [
    { value: "none", label: t(($) => $.browser.stage_all) },
    { value: "1", label: t(($) => $.browser.stage_s1) },
    { value: "2", label: t(($) => $.browser.stage_s2) },
    { value: "3", label: t(($) => $.browser.stage_s3) },
    { value: "4", label: t(($) => $.browser.stage_s4) },
    { value: "5", label: t(($) => $.browser.stage_s5) },
  ];
  const sourceLabel = (mode: ArtifactSourceMode) => {
    switch (mode) {
      case "upload":
        return t(($) => $.manage.source_upload);
      case "asset":
        return t(($) => $.manage.source_asset);
      default:
        return t(($) => $.manage.source_write);
    }
  };
  const showWriteback = editing || source === "write";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? t(($) => $.manage.edit_title) : t(($) => $.manage.create_title)}
          </DialogTitle>
          <DialogDescription>
            {t(($) => $.manage.hint)}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {!editing && (
            <div className="space-y-1">
              <span className="text-caption text-muted-foreground">
                {t(($) => $.manage.source)}
              </span>
              <div
                role="group"
                aria-label={t(($) => $.manage.source)}
                className="flex gap-1 rounded-lg bg-muted p-[3px]"
              >
                {SOURCE_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={source === mode}
                    onClick={() => setSource(mode)}
                    className={cn(
                      "flex-1 rounded-md px-2 py-1 text-caption font-medium transition-colors",
                      source === mode
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {sourceLabel(mode)}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t(($) => $.manage.source_hint)}
              </p>
            </div>
          )}
          <label className="space-y-1 text-caption">
            <span className="text-muted-foreground">{t(($) => $.preview.field_doc_type)}</span>
            <Select
              items={ARCHIVE_CREATE_TYPES.map((item) => ({
                value: item.value,
                label: item.label,
              }))}
              value={docType}
              onValueChange={(value) => value && setDocType(value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ARCHIVE_CREATE_TYPES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-caption">
              <span className="text-muted-foreground">{t(($) => $.preview.field_scope)}</span>
              <Select
                items={scopeItems}
                value={scope}
                onValueChange={(value) => value && setScope(value as ArtifactScope)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopeItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1 text-caption">
              <span className="text-muted-foreground">{t(($) => $.preview.field_stage)}</span>
              <Select
                items={stageItems}
                value={stage ? String(stage) : "none"}
                onValueChange={(value) =>
                  setStage(
                    value && value !== "none"
                      ? (Number(value) as ArtifactStage)
                      : null,
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stageItems.map((item) => (
                    <SelectItem key={item.value || "none"} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          {scope === "requirement" && (
            <label className="space-y-1 text-caption">
              <span className="text-muted-foreground">{t(($) => $.manage.requirement_key)}</span>
              <Input
                value={requirementKey}
                onChange={(event) => setRequirementKey(event.target.value)}
                // Requirement key format hint, not copy.
                // eslint-disable-next-line no-restricted-syntax
                placeholder="REQ-20260907-01"
              />
            </label>
          )}
          <label className="space-y-1 text-caption">
            <span className="text-muted-foreground">{t(($) => $.manage.issue_id)}</span>
            <Input
              value={issueId}
              onChange={(event) => setIssueId(event.target.value)}
              // Column name of the linked issue, not copy.
              // eslint-disable-next-line no-restricted-syntax
              placeholder="multica_issue_id"
              className="font-mono"
            />
          </label>
          {showWriteback && (
            <label className="space-y-1 text-caption">
              <span className="text-muted-foreground">{t(($) => $.manage.writeback_mode)}</span>
              <Select
                items={[
                  { value: "frontmatter", label: t(($) => $.manage.writeback_frontmatter) },
                  { value: "pointer_only", label: t(($) => $.manage.writeback_pointer) },
                ]}
                value={writebackMode}
                onValueChange={(value) =>
                  value && setWritebackMode(value as ArchiveWritebackMode)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="frontmatter">
                    {t(($) => $.manage.writeback_frontmatter)}
                  </SelectItem>
                  <SelectItem value="pointer_only">
                    {t(($) => $.manage.writeback_pointer)}
                  </SelectItem>
                </SelectContent>
              </Select>
            </label>
          )}
          {showWriteback && writebackMode === "pointer_only" && (
            <label className="space-y-1 text-caption">
              <span className="text-muted-foreground">{t(($) => $.manage.writeback_reason)}</span>
              <Input
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                placeholder={t(($) => $.manage.writeback_reason)}
              />
            </label>
          )}
          <label className="space-y-1 text-caption">
            <span className="text-muted-foreground">{t(($) => $.manage.title)}</span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-caption">
            <span className="text-muted-foreground">{t(($) => $.preview.field_rel_path)}</span>
            <Input
              value={relPath}
              onChange={(event) => {
                setPathLocked(true);
                setRelPath(event.target.value);
              }}
              className="font-mono"
            />
          </label>

          {!editing && source === "upload" && (
            <div className="space-y-2 rounded-md border border-dashed border-surface-border p-3">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(event) => void handleFilePick(event)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {t(($) => $.manage.upload_pick)}
                </Button>
                <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                  {file
                    ? t(($) => $.manage.upload_ready, {
                        name: file.name,
                        size: formatFileSize(file.size),
                      })
                    : t(($) => $.manage.upload_none)}
                </span>
                {file ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setFile(null)}
                  >
                    {t(($) => $.manage.upload_clear)}
                  </Button>
                ) : null}
              </div>
              <label className="flex items-start gap-2 text-caption">
                <Checkbox
                  className="mt-0.5"
                  checked={syncToAssets && syncLifecycle != null}
                  disabled={syncLifecycle == null}
                  onCheckedChange={(value) => setSyncToAssets(value === true)}
                />
                <span className="space-y-0.5">
                  <span className="block text-foreground">{t(($) => $.manage.sync_assets)}</span>
                  <span className="block text-muted-foreground">
                    {syncLifecycle
                      ? t(($) => $.manage.sync_assets_hint, { stage: syncLifecycle })
                      : t(($) => $.manage.sync_assets_unavailable)}
                  </span>
                </span>
              </label>
            </div>
          )}

          {!editing && source === "asset" && (
            <div className="space-y-2 rounded-md border border-surface-border p-3">
              <Input
                value={assetQuery}
                onChange={(event) => setAssetQuery(event.target.value)}
                placeholder={t(($) => $.manage.asset_search)}
              />
              {mountQuery.isLoading || artifactsQuery.isLoading ? (
                <p className="text-caption text-muted-foreground">
                  {t(($) => $.common.loading)}
                </p>
              ) : visibleCandidates.length === 0 ? (
                <p className="text-caption text-muted-foreground">
                  {t(($) => $.manage.asset_empty)}
                </p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
                  {visibleCandidates.map((candidate) => (
                    <AssetMountRow
                      key={candidate.binding.id}
                      candidate={candidate}
                      picked={pickedAssetId === candidate.binding.id}
                      mountedLabel={t(($) => $.manage.asset_mounted)}
                      onPick={() => setPickedAssetId(candidate.binding.id)}
                    />
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-muted-foreground">
                {t(($) => $.manage.asset_hint)}
              </p>
            </div>
          )}

          {!editing && source === "write" && (
            <label className="space-y-1 text-caption">
              <span className="text-muted-foreground">{t(($) => $.manage.content)}</span>
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={10}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-caption"
              />
            </label>
          )}
          {editing && (
            <label className="space-y-1 text-caption">
              <span className="text-muted-foreground">{t(($) => $.manage.content)}</span>
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={10}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-caption"
                placeholder={t(($) => $.manage.content_keep)}
              />
            </label>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {editing ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t(($) => $.manage.delete)}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t(($) => $.common.close)}
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>
              {editing ? t(($) => $.manage.save) : t(($) => $.manage.create)}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssetMountRow({
  candidate,
  picked,
  mountedLabel,
  onPick,
}: {
  candidate: AssetMountCandidate;
  picked: boolean;
  mountedLabel: string;
  onPick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        disabled={candidate.mounted}
        aria-pressed={picked}
        title={candidate.filename}
        onClick={onPick}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-caption transition-colors",
          candidate.mounted
            ? "cursor-not-allowed border-surface-border/60 opacity-60"
            : "border-surface-border hover:bg-surface-hover",
          picked && !candidate.mounted && "border-primary/60 bg-primary/10",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{candidate.filename}</span>
        {candidate.binding.lifecycle_stage ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
            {candidate.binding.lifecycle_stage}
          </span>
        ) : null}
        {candidate.mounted ? (
          <span className="shrink-0 text-micro text-muted-foreground">{mountedLabel}</span>
        ) : null}
      </button>
    </li>
  );
}
