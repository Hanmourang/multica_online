"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderSearch } from "lucide-react";
import { toast } from "sonner";
import { clientErrorMessage } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCreateArtifact } from "@multica/core/artifacts";
import {
  projectDetailOptions,
  projectResourcesOptions,
  useUpdateProject,
} from "@multica/core/projects";
import type { ListProjectResourcesResponse, Project, ProjectResource } from "@multica/core/types";
import type { ProjectArtifact } from "@multica/core/types";
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
import { Badge } from "@multica/ui/components/ui/badge";
import { pickDirectory, isDesktopShell } from "../../../platform";
import { listArchiveDocs, readArchiveFile } from "../../../platform/archive-fs";
import { useT } from "../../../i18n";
import {
  classifyArchiveScan,
  importScanSummary,
  isArchiveDocPath,
  isArchiveResourceMissingError,
  resolveArchiveBindTarget,
  selectedImportRequests,
  type ArchiveImportRow,
  type ArchiveScanFile,
} from "./archive-import";
import { putArchivePreviewTexts } from "./archive-preview-cache";

const READ_CONCURRENCY = 8;
const MAX_CONTENT_CHARS = 1_500_000;

export function ArchiveImportDialog({
  projectId,
  artifacts,
  open,
  onOpenChange,
  archiveRoot,
  onArchiveRootChange,
}: {
  projectId: string;
  artifacts: ProjectArtifact[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  archiveRoot?: string | null;
  onArchiveRootChange?: (path: string | null) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const createMutation = useCreateArtifact(wsId, projectId);
  const updateProject = useUpdateProject();
  const queryClient = useQueryClient();
  const projectQuery = useQuery(projectDetailOptions(wsId, projectId));
  const resourcesQuery = useQuery(projectResourcesOptions(wsId, projectId));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bindTarget = resolveArchiveBindTarget(
    projectQuery.data?.archive_resource_id,
    resourcesQuery.data ?? [],
  );

  const [rootLabel, setRootLabel] = useState<string | null>(null);
  const [rows, setRows] = useState<ArchiveImportRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const summary = importScanSummary(rows);
  const existingPaths = artifacts.map((artifact) => artifact.rel_path);

  const applyFiles = (files: ArchiveScanFile[], label: string) => {
    setRootLabel(label);
    setRows(classifyArchiveScan(files, existingPaths));
    putArchivePreviewTexts(
      files
        .filter((file) => file.content)
        .map((file) => ({ relPath: file.relPath, text: file.content! })),
    );
  };

  const scanDesktopRoot = async (root: string) => {
    setScanning(true);
    try {
      const listed = await listArchiveDocs(root);
      if (!listed.ok) {
        toast.error(listed.error ?? t(($) => $.import.scan_failed));
        return;
      }
      const paths = (listed.files ?? []).filter(isArchiveDocPath);
      const scanned: ArchiveScanFile[] = [];
      for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
        const batch = paths.slice(i, i + READ_CONCURRENCY);
        const read = await Promise.all(
          batch.map(async (relPath) => {
            const result = await readArchiveFile(root, relPath);
            return {
              relPath,
              ...(result.ok && result.content != null && result.content.length <= MAX_CONTENT_CHARS
                ? { content: result.content }
                : {}),
            };
          }),
        );
        scanned.push(...read);
      }
      onArchiveRootChange?.(root);
      applyFiles(scanned, root);
    } finally {
      setScanning(false);
    }
  };

  const pickDesktop = async () => {
    const picked = await pickDirectory(archiveRoot ?? undefined);
    if (!picked.ok || !picked.path) return;
    await scanDesktopRoot(picked.path);
  };

  const pickWebFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setScanning(true);
    try {
      const files = Array.from(list);
      const scanned: ArchiveScanFile[] = [];
      for (const file of files) {
        const relPath =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
          file.name;
        if (!isArchiveDocPath(relPath)) continue;
        let content: string | undefined;
        try {
          const text = await file.text();
          if (text.length <= MAX_CONTENT_CHARS) content = text;
        } catch {
          content = undefined;
        }
        scanned.push({ relPath, ...(content != null ? { content } : {}) });
      }
      if (scanned.length === 0) {
        applyFiles([], files[0]?.name ?? t(($) => $.import.pick_web));
        return;
      }
      const folder =
        scanned[0]?.relPath.replace(/\\/g, "/").split("/").filter(Boolean)[0] ??
        t(($) => $.import.pick_web);
      applyFiles(scanned, folder);
    } finally {
      setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const pick = () => {
    if (isDesktopShell()) {
      void pickDesktop();
      return;
    }
    fileInputRef.current?.click();
  };

  const toggleRow = (relPath: string, selected: boolean) => {
    setRows((current) =>
      current.map((row) =>
        row.relPath === relPath && row.status === "importable"
          ? { ...row, selected }
          : row,
      ),
    );
  };

  const importFailureReason = (err: unknown) => {
    if (isArchiveResourceMissingError(err)) {
      return t(($) => $.import.need_resource);
    }
    return clientErrorMessage(err) ?? t(($) => $.import.unknown_error);
  };

  const refreshBindTarget = async () => {
    const [project, resourceData] = await Promise.all([
      queryClient.fetchQuery(projectDetailOptions(wsId, projectId)),
      queryClient.fetchQuery(projectResourcesOptions(wsId, projectId)),
    ]);
    const resources = Array.isArray(resourceData)
      ? resourceData
      : ((resourceData as ListProjectResourcesResponse | undefined)?.resources ?? []);
    return resolveArchiveBindTarget(
      (project as Project | undefined)?.archive_resource_id,
      resources as ProjectResource[],
    );
  };

  const submit = async () => {
    const requests = selectedImportRequests(rows);
    if (requests.length === 0) {
      toast.info(t(($) => $.import.none_selected));
      return;
    }
    setImporting(true);
    let ok = 0;
    let fail = 0;
    let firstError: string | undefined;
    try {
      let target = await refreshBindTarget();
      if (target.status === "bind-local" && target.resourceId) {
        try {
          await updateProject.mutateAsync({
            id: projectId,
            archive_resource_id: target.resourceId,
          });
        } catch (err) {
          toast.error(importFailureReason(err));
          return;
        }
        target = await refreshBindTarget();
      }
      if (target.status !== "bound") {
        toast.error(
          target.status === "missing"
            ? t(($) => $.import.need_resource)
            : t(($) => $.import.server_stale),
        );
        return;
      }
      for (const request of requests) {
        try {
          await createMutation.mutateAsync(request);
          ok += 1;
        } catch (err) {
          fail += 1;
          firstError ??= importFailureReason(err);
          if (isArchiveResourceMissingError(err)) break;
        }
      }
      if (fail === 0) {
        toast.success(t(($) => $.import.done, { ok }));
        onOpenChange(false);
        setRows([]);
        setRootLabel(null);
      } else {
        toast.error(
          t(($) => $.import.partial, { ok, fail, reason: firstError ?? "" }),
        );
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (scanning || importing)) return;
        onOpenChange(next);
        if (!next) {
          setRows([]);
          setRootLabel(null);
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.import.title)}</DialogTitle>
          <DialogDescription>{t(($) => $.import.hint)}</DialogDescription>
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-hidden
          onChange={(event) => void pickWebFiles(event.target.files)}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={scanning || importing}
            onClick={pick}
          >
            <FolderSearch />
            {scanning
              ? t(($) => $.import.scanning)
              : isDesktopShell()
                ? t(($) => $.import.pick)
                : t(($) => $.import.pick_web)}
          </Button>
          {isDesktopShell() && archiveRoot && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={scanning || importing}
              onClick={() => void scanDesktopRoot(archiveRoot)}
            >
              {t(($) => $.import.scan_current)}
            </Button>
          )}
          {rootLabel && (
            <span className="min-w-0 truncate font-mono text-caption text-muted-foreground">
              {rootLabel}
            </span>
          )}
        </div>
        {!isDesktopShell() && (
          <p className="text-caption text-muted-foreground">{t(($) => $.import.web_only)}</p>
        )}
        {bindTarget.status === "missing" && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-caption text-destructive">
            {t(($) => $.import.need_resource)}
          </p>
        )}
        {bindTarget.status === "bind-local" && (
          <p className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-caption text-muted-foreground">
            {t(($) => $.import.will_bind)}
          </p>
        )}

        {rows.length > 0 ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                {t(($) => $.import.summary, {
                  importable: summary.importable,
                  exists: summary.exists,
                  unclassified: summary.unclassified,
                })}
              </Badge>
            </div>
            <div className="max-h-[40vh] overflow-auto rounded-md border border-surface-border">
              <table className="w-full text-left text-caption">
                <thead className="sticky top-0 bg-surface text-muted-foreground">
                  <tr>
                    <th className="w-8 px-2 py-1.5" />
                    <th className="px-2 py-1.5 font-medium">{t(($) => $.import.col_path)}</th>
                    <th className="px-2 py-1.5 font-medium">{t(($) => $.import.col_type)}</th>
                    <th className="px-2 py-1.5 font-medium">{t(($) => $.import.col_status)}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const canSelect = row.status === "importable";
                    return (
                      <tr
                        key={`${row.scannedPath}:${row.relPath}`}
                        className="border-t border-surface-border"
                      >
                        <td className="px-2 py-1.5 align-top">
                          <Checkbox
                            checked={row.selected}
                            disabled={!canSelect || importing}
                            onCheckedChange={(value) =>
                              toggleRow(row.relPath, value === true)
                            }
                            aria-label={row.relPath}
                          />
                        </td>
                        <td className="px-2 py-1.5 align-top">
                          <div className="font-mono text-[11px] break-all">{row.relPath}</div>
                          {row.scannedPath !== row.relPath && (
                            <div className="text-[11px] text-muted-foreground break-all">
                              {row.scannedPath}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 align-top">
                          {row.draft
                            ? `${row.draft.doc_type}${row.draft.stage ? ` · S${row.draft.stage}` : ""}`
                            : "—"}
                        </td>
                        <td className="px-2 py-1.5 align-top">
                          <div>
                            {row.status === "importable"
                              ? t(($) => $.import.status_importable)
                              : row.status === "exists"
                                ? t(($) => $.import.status_exists)
                                : row.status === "unclassified"
                                  ? t(($) => $.import.status_unclassified)
                                  : t(($) => $.import.status_skipped)}
                          </div>
                          <div className="text-muted-foreground">{row.reason}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          rootLabel &&
          !scanning && (
            <p className="text-caption text-muted-foreground">{t(($) => $.import.empty)}</p>
          )
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={scanning || importing}
            onClick={() => onOpenChange(false)}
          >
            {t(($) => $.import.cancel)}
          </Button>
          <Button
            type="button"
            disabled={
              scanning ||
              importing ||
              summary.selected === 0 ||
              bindTarget.status === "missing"
            }
            onClick={() => void submit()}
          >
            {importing
              ? t(($) => $.import.importing)
              : t(($) => $.import.submit, { n: summary.selected })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
