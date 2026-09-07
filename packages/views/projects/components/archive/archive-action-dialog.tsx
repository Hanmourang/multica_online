"use client";

import { useEffect, useState } from "react";
import { Archive } from "lucide-react";
import { toast } from "sonner";
import { useArchiveDeliverable } from "@multica/core/artifacts/mutations";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { Input } from "@multica/ui/components/ui/input";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";

/**
 * f6 归档动作（重新归类）。
 *
 * Submits POST /artifacts/{id}/archive with a new scope/stage/doc_type
 * (optional issue binding) and invalidates the project artifact slice on
 * settle. The server records the classification with source="agent"; the
 * CLI performs the actual file move on its next sync — surfaced honestly
 * via the cli_hint copy instead of pretending the file moved.
 */
export function ArchiveActionDialog({
  projectId,
  artifact,
  open,
  onOpenChange,
}: {
  projectId: string;
  artifact: ProjectArtifact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("archive");
  const archiveMutation = useArchiveDeliverable(projectId);

  const [scope, setScope] = useState<ArtifactScope>("requirement");
  const [stage, setStage] = useState<ArtifactStage | null>(null);
  const [docType, setDocType] = useState("");
  const [issueId, setIssueId] = useState("");

  // Re-seed the form each time a different artifact is opened.
  useEffect(() => {
    if (artifact && open) {
      setScope(artifact.scope);
      setStage(artifact.stage ?? null);
      setDocType(artifact.doc_type);
      setIssueId(artifact.issue_id ?? "");
    }
  }, [artifact, open]);

  if (!artifact) return null;

  const canSubmit = docType.trim().length > 0 && !archiveMutation.isPending;

  const targetPath = deriveTargetPath({
    scope,
    stage,
    docType: docType.trim() || "<doc_type>",
    requirementKey: artifact.requirement_key ?? (issueId.trim() || "<REQ-KEY>"),
  });

  const handleSubmit = () => {
    archiveMutation.mutate(
      {
        artifactId: artifact.id,
        scope,
        stage: scope === "requirement" && stage ? stage : undefined,
        doc_type: docType.trim(),
        issue_id: issueId.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success(t(($) => $.archive_action.success));
          onOpenChange(false);
        },
        onError: (error) => {
          toast.error(String(error));
        },
      },
    );
  };

  const scopeItems = [
    { value: "requirement", label: t(($) => $.browser.scope_requirement) },
    { value: "project", label: t(($) => $.browser.scope_project) },
    { value: "shared", label: t(($) => $.browser.scope_shared) },
  ];

  const stageItems = [
    { value: "1", label: t(($) => $.browser.stage_s1) },
    { value: "2", label: t(($) => $.browser.stage_s2) },
    { value: "3", label: t(($) => $.browser.stage_s3) },
    { value: "4", label: t(($) => $.browser.stage_s4) },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="size-4 text-muted-foreground" />
            {t(($) => $.archive_action.title)}
          </DialogTitle>
          <DialogDescription className="break-all font-mono text-caption">
            {artifact.rel_path}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-muted-foreground">
                {t(($) => $.archive_action.scope_label)}
              </span>
              <Select
                items={scopeItems}
                value={scope}
                onValueChange={(value) => {
                  if (value) setScope(value as ArtifactScope);
                }}
              >
                <SelectTrigger className="w-full" aria-label={t(($) => $.archive_action.scope_label)}>
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

            <label className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-muted-foreground">
                {t(($) => $.archive_action.stage_label)}
              </span>
              <Select
                items={stageItems}
                value={stage ? String(stage) : null}
                onValueChange={(value) => {
                  setStage(value ? (Number(value) as ArtifactStage) : null);
                }}
                disabled={scope !== "requirement"}
              >
                <SelectTrigger className="w-full" aria-label={t(($) => $.archive_action.stage_label)}>
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
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-muted-foreground">
              {t(($) => $.archive_action.doc_type_label)}
            </span>
            <Input
              value={docType}
              onChange={(event) => setDocType(event.target.value)}
              placeholder={t(($) => $.archive_action.doc_type_placeholder)}
              aria-label={t(($) => $.archive_action.doc_type_label)}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-muted-foreground">
              {t(($) => $.archive_action.issue_label)}
            </span>
            <Input
              value={issueId}
              onChange={(event) => setIssueId(event.target.value)}
              placeholder={t(($) => $.archive_action.issue_placeholder)}
              aria-label={t(($) => $.archive_action.issue_label)}
            />
          </label>

          <div
            className={cn(
              "rounded-lg border border-surface-border bg-surface px-3 py-2",
            )}
          >
            <div className="text-caption font-medium text-muted-foreground">
              {t(($) => $.archive_action.target_path)}
            </div>
            <code className="mt-1 block break-all font-mono text-caption">
              {targetPath}
            </code>
          </div>

          <p className="text-caption leading-relaxed text-muted-foreground">
            {t(($) => $.archive_action.cli_hint)}
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={archiveMutation.isPending}
          >
            {t(($) => $.archive_action.cancel)}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
            aria-label={t(($) => $.archive_action.confirm)}
          >
            {archiveMutation.isPending
              ? t(($) => $.common.loading)
              : t(($) => $.archive_action.confirm)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Best-effort contract path preview (relative form; project key unknown here). */
function deriveTargetPath(input: {
  scope: ArtifactScope;
  stage: ArtifactStage | null;
  docType: string;
  requirementKey: string;
}): string {
  switch (input.scope) {
    case "shared":
      return `_shared/${input.docType}/`;
    case "project":
      return `overview/${input.docType}/`;
    case "requirement": {
      const stageSegment = input.stage ? `s${input.stage}-` : "";
      return `requirements/${input.requirementKey}/${stageSegment}${input.docType}/`;
    }
  }
}
