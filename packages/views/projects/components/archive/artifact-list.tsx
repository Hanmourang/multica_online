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
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { formatBytes } from "./query-states";

/**
 * f4 列表视图 — every artifact row from the current filter, click selects
 * (drives the right-hand preview panel exactly like a matrix chip).
 */
export function ArtifactListTable({
  artifacts,
  selectedId,
  onSelect,
}: {
  artifacts: ProjectArtifact[];
  selectedId: string | null;
  onSelect: (artifact: ProjectArtifact) => void;
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t(($) => $.preview.field_rel_path)}</TableHead>
            <TableHead>{t(($) => $.preview.field_scope)}</TableHead>
            <TableHead>{t(($) => $.preview.field_stage)}</TableHead>
            <TableHead>{t(($) => $.preview.field_doc_type)}</TableHead>
            <TableHead>{t(($) => $.preview.field_version)}</TableHead>
            <TableHead>{t(($) => $.preview.field_source)}</TableHead>
            <TableHead className="text-right">{t(($) => $.browser.size)}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {artifacts.map((artifact) => (
            <TableRow
              key={artifact.id}
              onClick={() => onSelect(artifact)}
              className={cn(
                "cursor-pointer",
                artifact.id === selectedId && "bg-primary/5",
              )}
            >
              <TableCell className="max-w-72 truncate font-mono text-caption" title={artifact.rel_path}>
                {artifact.rel_path}
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
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
