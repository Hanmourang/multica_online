"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useBindArtifact } from "@multica/core/artifacts/mutations";
import {
  useRegisterPrototype,
  useUpdatePrototypePath,
} from "@multica/core/issues/mutations";
import type { Issue, ProjectArtifact, PrototypeVersion } from "@multica/core/types";
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
import { useT } from "../../../../i18n";
import { issueShortLabel } from "../module-feature-stats";

export function PrototypeManageDialog({
  open,
  mode,
  onOpenChange,
  projectId,
  workspaceId,
  issues,
  issueId,
  version,
  artifacts,
}: {
  open: boolean;
  mode: "associate" | "update";
  onOpenChange: (open: boolean) => void;
  projectId: string;
  workspaceId: string;
  issues: Issue[];
  issueId: string | null;
  version?: PrototypeVersion;
  artifacts: ProjectArtifact[];
}) {
  const { t } = useT("archive");
  const htmlFiles = useMemo(
    () => artifacts.filter((row) => /\.html?$/i.test(row.rel_path)),
    [artifacts],
  );
  const [targetIssueId, setTargetIssueId] = useState(issueId ?? issues[0]?.id ?? "");
  const [path, setPath] = useState(version?.html_path ?? htmlFiles[0]?.rel_path ?? "");
  useEffect(() => {
    if (!open) return;
    setTargetIssueId(issueId ?? issues[0]?.id ?? "");
    setPath(version?.html_path ?? "");
  }, [open, mode, issueId, version?.html_path, issues]);
  const register = useRegisterPrototype(targetIssueId);
  const update = useUpdatePrototypePath(targetIssueId);
  const bind = useBindArtifact(workspaceId, projectId);
  const pending = register.isPending || update.isPending || bind.isPending;

  const submit = async () => {
    const htmlPath = path.trim();
    if (!htmlPath) {
      toast.error(t(($) => $.features.path_required));
      return;
    }
    if (!targetIssueId) {
      toast.error(t(($) => $.features.req_filter));
      return;
    }
    try {
      if (mode === "update" && version) {
        await update.mutateAsync({
          version: version.version,
          html_path: htmlPath,
          prompt: "manual update",
        });
        toast.success(t(($) => $.features.update_ok));
      } else {
        await register.mutateAsync({ html_path: htmlPath, prompt: "manual attach" });
        const artifact = htmlFiles.find((row) => row.rel_path === htmlPath);
        if (artifact && artifact.issue_id !== targetIssueId) {
          await bind.mutateAsync({ artifactId: artifact.id, issueId: targetIssueId });
        }
        toast.success(t(($) => $.features.associate_ok));
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(String(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "update" ? t(($) => $.features.update_title) : t(($) => $.features.associate_title)}
          </DialogTitle>
          <DialogDescription>
            {mode === "update"
              ? t(($) => $.features.update_hint)
              : t(($) => $.features.associate_hint)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <label className="block space-y-1 text-[11px] font-medium">
            {t(($) => $.features.req_filter)}
            <select
              value={targetIssueId}
              onChange={(event) => setTargetIssueId(event.target.value)}
              className="h-8 w-full rounded-md border border-surface-border bg-surface px-2 text-[12px]"
            >
              {issues.map((issue) => (
                <option key={issue.id} value={issue.id}>
                  {issueShortLabel(issue)}
                </option>
              ))}
            </select>
          </label>
          {htmlFiles.length > 0 && (
            <label className="block space-y-1 text-[11px] font-medium">
              {t(($) => $.features.pick_file)}
              <select
                value={htmlFiles.some((row) => row.rel_path === path) ? path : ""}
                onChange={(event) => setPath(event.target.value)}
                className="h-8 w-full rounded-md border border-surface-border bg-surface px-2 font-mono text-[11px]"
              >
                <option value="">{t(($) => $.features.pick_file)}</option>
                {htmlFiles.map((row) => (
                  <option key={row.id} value={row.rel_path}>
                    {row.rel_path}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block space-y-1 text-[11px] font-medium">
            {t(($) => $.features.html_path)}
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              // Prototype path format hint, not copy.
              // eslint-disable-next-line no-restricted-syntax
              placeholder="requirements/REQ-…/s1-prototype/prototype-v3.html"
              className="font-mono text-[11px]"
            />
          </label>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t(($) => $.common.close)}
          </Button>
          <Button type="button" disabled={pending} onClick={() => void submit()}>
            {mode === "update" ? t(($) => $.features.update_file) : t(($) => $.features.associate)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
