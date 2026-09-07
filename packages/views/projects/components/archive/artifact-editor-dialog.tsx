"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  useCreateArtifact,
  useDeleteArtifact,
  usePatchArtifact,
} from "@multica/core/artifacts";
import type {
  ArtifactScope,
  ArtifactStage,
  ProjectArtifact,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
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
import { writeArchiveFile } from "../../../platform/archive-fs";
import { useT } from "../../../i18n";
import { suggestedRelPath, todayRequirementKey } from "./archive-inspector";
import { renderArchiveTemplate } from "./archive-templates";

const DOC_TYPES = [
  "requirement",
  "design",
  "test-plan",
  "acceptance",
  "report",
  "architecture",
  "research",
  "product-design",
  "retrospective",
  "filing-software-copyright",
  "change-log",
  "work-plan",
] as const;

export interface ArtifactEditorSeed {
  scope?: ArtifactScope;
  stage?: ArtifactStage | null;
  docType?: string;
  requirementKey?: string | null;
  issueId?: string | null;
  filename?: string;
  title?: string;
}

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

  useEffect(() => {
    if (!open) return;
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
        filename: seed?.filename ?? `${nextType}.md`,
      }),
    );
    setContent(
      renderArchiveTemplate({
        docType: nextType,
        title: nextTitle,
        requirementKey: nextKey,
        issueId: seed?.issueId,
      }),
    );
  }, [artifact, open, seed]);

  const derivedPath = useMemo(
    () =>
      suggestedRelPath({
        scope: scope === "shared" ? "shared" : scope,
        docType,
        stage,
        requirementKey,
        filename: title.endsWith(".md") || title.endsWith(".html")
          ? title
          : `${docType}.md`,
      }),
    [scope, docType, stage, requirementKey, title],
  );

  useEffect(() => {
    if (!pathLocked && !editing) setRelPath(derivedPath);
  }, [derivedPath, editing, pathLocked]);

  const busy =
    createMutation.isPending ||
    patchMutation.isPending ||
    deleteMutation.isPending;

  const submit = async () => {
    if (!relPath.trim() || !docType.trim()) return;
    try {
      if (editing && artifact) {
        await patchMutation.mutateAsync({
          artifactId: artifact.id,
          patch: {
            scope,
            stage,
            doc_type: docType.trim(),
            rel_path: relPath.trim(),
            requirement_key: requirementKey.trim() || null,
            issue_id: issueId.trim() || null,
            ...(content.trim() ? { content } : {}),
          },
        });
        toast.success(t(($) => $.manage.saved));
      } else {
        await createMutation.mutateAsync({
          scope,
          stage,
          doc_type: docType.trim(),
          rel_path: relPath.trim(),
          requirement_key: requirementKey.trim() || null,
          issue_id: issueId.trim() || null,
          content,
          version: 1,
        });
        if (archiveRoot && content) {
          const written = await writeArchiveFile(archiveRoot, relPath.trim(), content);
          if (!written.ok && written.reason !== "unsupported") {
            toast.info(t(($) => $.manage.written_db_only));
          }
        }
        toast.success(t(($) => $.manage.created));
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.manage.save_failed));
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
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? t(($) => $.manage.edit_title) : t(($) => $.manage.create_title)}
          </DialogTitle>
          <DialogDescription>
            {t(($) => $.manage.hint)}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="space-y-1 text-caption">
            <span className="text-muted-foreground">{t(($) => $.preview.field_doc_type)}</span>
            <Select
              items={DOC_TYPES.map((value) => ({ value, label: value }))}
              value={docType}
              onValueChange={(value) => value && setDocType(value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOC_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
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
                placeholder="REQ-20260907-01"
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
          <label className="space-y-1 text-caption">
            <span className="text-muted-foreground">{t(($) => $.manage.content)}</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={10}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-caption"
              placeholder={editing ? t(($) => $.manage.content_keep) : undefined}
            />
          </label>
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
