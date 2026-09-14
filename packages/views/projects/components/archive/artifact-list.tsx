"use client";

import type { ProjectArtifact } from "@multica/core/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multica/ui/components/ui/table";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { artifactDisplayName } from "./archive-display";
import { ArtifactModuleChipControl } from "./artifact-module-tag";
import { formatBytes } from "./query-states";

/**
 * f4 列表视图 — every artifact row from the current filter, click selects
 * (drives the right-hand preview panel exactly like a matrix chip).
 */
export function ArtifactListTable({
  artifacts,
  selectedId,
  onSelect,
  tagging,
  pickedIds,
  onTogglePick,
  onSaveTag,
  tagBusy,
}: {
  artifacts: ProjectArtifact[];
  selectedId: string | null;
  onSelect: (artifact: ProjectArtifact) => void;
  tagging?: boolean;
  pickedIds?: Set<string>;
  onTogglePick?: (id: string, next: boolean) => void;
  onSaveTag?: (artifact: ProjectArtifact, value: string) => Promise<void> | void;
  tagBusy?: boolean;
}) {
  const { t } = useT("archive");

  if (artifacts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-surface-border px-4 py-8 text-center text-caption text-muted-foreground">
        {t(($) => $.browser.empty)}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-surface-border" data-testid="archive-list">
      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            {tagging ? <TableHead className="w-8" /> : null}
            <TableHead>{t(($) => $.mapping.col_name)}</TableHead>
            <TableHead>{t(($) => $.browser.module)}</TableHead>
            <TableHead>{t(($) => $.preview.field_scope)}</TableHead>
            <TableHead>{t(($) => $.preview.field_stage)}</TableHead>
            <TableHead>{t(($) => $.preview.field_doc_type)}</TableHead>
            <TableHead>{t(($) => $.preview.field_version)}</TableHead>
            <TableHead>{t(($) => $.preview.field_source)}</TableHead>
            <TableHead className="text-right">{t(($) => $.browser.size)}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {artifacts.map((artifact) => {
            const checked = pickedIds?.has(artifact.id) === true;
            return (
            <TableRow
              key={artifact.id}
              onClick={(event) => {
                onSelect(artifact);
                if (tagging || event.shiftKey || event.metaKey || event.ctrlKey) {
                  onTogglePick?.(artifact.id, !checked);
                }
              }}
              className={cn(
                "cursor-pointer",
                artifact.id === selectedId && "bg-primary/5",
                tagging && checked && "bg-amber-400/10",
              )}
            >
              {tagging ? (
                <TableCell className="w-8" onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    checked={checked}
                    aria-label={artifactDisplayName(artifact.rel_path)}
                    onCheckedChange={(value) =>
                      onTogglePick?.(artifact.id, value === true)
                    }
                  />
                </TableCell>
              ) : null}
              <TableCell className="max-w-72 truncate text-caption" title={artifact.rel_path}>
                {artifactDisplayName(artifact.rel_path)}
              </TableCell>
              <TableCell
                className="text-caption"
                onClick={(event) => event.stopPropagation()}
              >
                <ArtifactModuleChipControl
                  artifact={artifact}
                  onSave={
                    onSaveTag ? (value) => onSaveTag(artifact, value) : undefined
                  }
                  busy={tagBusy}
                />
              </TableCell>
              <TableCell className="text-caption">{artifact.scope}</TableCell>
              <TableCell className="text-caption">
                {artifact.stage ? `S${artifact.stage}` : "—"}
              </TableCell>
              <TableCell className="text-caption">{artifact.doc_type}</TableCell>
              <TableCell className="text-caption tabular-nums">
                {t(($) => $.common.version_badge, { version: artifact.version })}
              </TableCell>
              <TableCell className="text-caption">{artifact.source}</TableCell>
              <TableCell className="text-right text-caption tabular-nums">
                {formatBytes(artifact.size_bytes)}
              </TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
