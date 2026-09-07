"use client";

import { useMemo } from "react";
import { Check, FileStack } from "lucide-react";
import type { ArtifactStage, ProjectArtifact } from "@multica/core/types";
import type { ArtifactEditorSeed } from "./artifact-editor-dialog";
import { Badge } from "@multica/ui/components/ui/badge";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { artifactDisplayName } from "./archive-display";
import { ArchiveEmpty } from "./query-states";

/**
 * f4 需求 × 阶段矩阵（+ 项目级/共享卡片区）。
 *
 * Pure presentation: the parent (ArchiveTab) owns the query + filters and
 * passes the artifact rows in; this component groups them by requirement
 * (requirement_key → issue_id → unassigned) and stage, renders one chip per
 * file (label from rel_path; card header is doc_type), and reports selection
 * clicks.
 */

const STAGES: ArtifactStage[] = [1, 2, 3, 4];

interface RequirementRow {
  key: string;
  label: string;
  issueId: string | null;
  cells: Map<ArtifactStage | null, ProjectArtifact[]>;
}

interface ScopeGroup {
  key: string;
  docType: string;
  scopeLabel: string;
  items: ProjectArtifact[];
}

type Translator = ReturnType<typeof useT<"archive">>["t"];

export function ArtifactMatrix({
  artifacts,
  selectedId,
  onSelect,
  onOpenRequirement,
  onCreateMissing,
  missingOnly,
}: {
  artifacts: ProjectArtifact[];
  selectedId: string | null;
  onSelect: (artifact: ProjectArtifact) => void;
  onOpenRequirement?: (issueId: string, drill?: string) => void;
  onCreateMissing?: (seed: ArtifactEditorSeed) => void;
  missingOnly: boolean;
}) {
  const { t } = useT("archive");

  const { projectRows, sharedRows, requirementRows } = useMemo(
    () => groupArtifacts(artifacts, t),
    [artifacts, t],
  );

  const visibleRequirementRows = useMemo(
    () =>
      missingOnly
        ? requirementRows.filter((row) => {
            const touched = STAGES.some((stage) => row.cells.get(stage)?.length);
            if (!touched) return false;
            return STAGES.some((stage) => !row.cells.get(stage)?.length);
          })
        : requirementRows,
    [requirementRows, missingOnly],
  );

  if (artifacts.length === 0) {
    return (
      <ArchiveEmpty
        title={t(($) => $.browser.empty)}
        description={t(($) => $.browser.empty_never_synced_hint)}
        icon={<FileStack className="size-4" />}
      />
    );
  }

  return (
    <div className="space-y-6" data-testid="archive-matrix">
      {/* Project-scope + shared cards */}
      {(projectRows.length > 0 || sharedRows.length > 0) && (
        <section className="space-y-2" aria-label={t(($) => $.browser.project_scope_title)}>
          <h4 className="text-caption font-medium text-muted-foreground">
            {t(($) => $.browser.project_scope_title)}
          </h4>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[...projectRows, ...sharedRows].map((group) => (
              <div
                key={group.key}
                className="rounded-lg border border-surface-border bg-surface p-3"
              >
                <div className="flex items-center gap-2">
                  <code className="text-caption font-medium">{group.docType}</code>
                  <Badge variant="outline">{group.scopeLabel}</Badge>
                  <span className="ml-auto text-caption tabular-nums text-muted-foreground">
                    {group.items.length}
                  </span>
                </div>
                <ul className="mt-2 space-y-1">
                  {group.items.slice(0, 5).map((artifact) => (
                    <li key={artifact.id}>
                      <ArtifactChip
                        artifact={artifact}
                        selected={artifact.id === selectedId}
                        onClick={() => onSelect(artifact)}
                      />
                    </li>
                  ))}
                  {group.items.length > 5 && (
                    <li className="text-caption text-muted-foreground">
                      +{group.items.length - 5}
                    </li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Requirement × stage matrix */}
      <section className="space-y-2" aria-label={t(($) => $.browser.matrix_title)}>
        <h4 className="text-caption font-medium text-muted-foreground">
          {t(($) => $.browser.matrix_title)}
        </h4>
        {visibleRequirementRows.length === 0 ? (
          <ArchiveEmpty title={t(($) => $.browser.empty)} icon={<FileStack className="size-4" />} />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-surface-border">
            <div className="min-w-[760px]">
              {/* Header */}
              <div className="grid grid-cols-[220px_repeat(4,1fr)_120px] border-b border-surface-border bg-surface-hover/40 text-caption font-medium text-muted-foreground">
                <div className="px-3 py-2">{t(($) => $.browser.scope_requirement)}</div>
                {STAGES.map((stage) => (
                  <div key={stage} className="px-3 py-2">
                    {stageName(t, stage)}
                  </div>
                ))}
                <div className="px-2 py-2 text-right">{t(($) => $.browser.mx_status)}</div>
              </div>
              {/* Rows */}
              {visibleRequirementRows.map((row) => {
                /* Readiness = how many of the 4 calendar stages hold ≥1 doc. */
                const filled = STAGES.filter(
                  (stage) => (row.cells.get(stage)?.length ?? 0) > 0,
                ).length;
                const unstaged = row.cells.get(null)?.length ?? 0;
                return (
                  <div
                    key={row.key}
                    className="grid grid-cols-[220px_repeat(4,1fr)_120px] border-b border-surface-border last:border-b-0"
                  >
                    <div className="min-w-0 px-3 py-2">
                      {row.issueId && onOpenRequirement ? (
                        <button
                          type="button"
                          className="block min-w-0 text-left"
                          onClick={() => onOpenRequirement(row.issueId!, "deliverables")}
                        >
                          <div className="truncate text-caption font-medium hover:underline" title={row.label}>
                            {row.label}
                          </div>
                          <div className="truncate font-mono text-caption text-muted-foreground">
                            {row.issueId.slice(0, 8)}
                          </div>
                        </button>
                      ) : (
                        <>
                          <div className="truncate text-caption font-medium" title={row.label}>
                            {row.label}
                          </div>
                          {row.issueId && (
                            <div className="truncate font-mono text-caption text-muted-foreground">
                              {row.issueId.slice(0, 8)}
                            </div>
                          )}
                        </>
                      )}
                      {unstaged > 0 && (
                        <Badge variant="outline" className="mt-1">
                          {t(($) => $.browser.stage_missing)} · {unstaged}
                        </Badge>
                      )}
                    </div>
                    {STAGES.map((stage) => {
                      const cellArtifacts = row.cells.get(stage) ?? [];
                      return (
                        <div key={stage} className="min-w-0 border-l border-surface-border px-2 py-2">
                          {cellArtifacts.length === 0 ? (
                            <button
                              type="button"
                              className="w-full rounded-md border border-dashed border-destructive/50 bg-destructive/5 p-1.5 text-center text-[10px] font-medium text-destructive hover:bg-destructive/10"
                              onClick={() =>
                                onCreateMissing?.({
                                  scope: "requirement",
                                  stage,
                                  docType:
                                    stage === 1
                                      ? "prototype"
                                      : stage === 2
                                        ? "design"
                                        : stage === 4
                                          ? "acceptance"
                                          : "plan",
                                  requirementKey:
                                    row.key.startsWith("REQ-") ? row.key : null,
                                  issueId: row.issueId,
                                  title: row.label,
                                })
                              }
                            >
                              {t(($) => $.browser.stage_missing)}
                              {onCreateMissing ? ` · ${t(($) => $.manage.create)}` : ""}
                            </button>
                          ) : (
                            <ul className="space-y-1">
                              {cellArtifacts.map((artifact) => (
                                <li key={artifact.id}>
                                  <ArtifactChip
                                    artifact={artifact}
                                    selected={artifact.id === selectedId}
                                    onClick={() => onSelect(artifact)}
                                  />
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                    <div className="px-2 py-2 text-right">
                      <ReadinessPill filled={filled} total={STAGES.length} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** One doc chip: path label + version + source badge; click selects it. */
function ArtifactChip({
  artifact,
  selected,
  onClick,
}: {
  artifact: ProjectArtifact;
  selected: boolean;
  onClick: () => void;
}) {
  const { t } = useT("archive");
  const label = artifactDisplayName(artifact.rel_path);
  return (
    <button
      type="button"
      onClick={onClick}
      title={artifact.rel_path}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left text-caption transition-colors",
        selected
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-surface-border bg-surface hover:bg-surface-hover",
      )}
    >
      <span className="min-w-0 flex-1 truncate font-medium font-mono text-[11px]">
        {label}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {t(($) => $.common.version_badge, { version: artifact.version })}
      </span>
      <Badge variant="ghost" className="shrink-0">
        {artifact.source}
      </Badge>
    </button>
  );
}

/**
 * Readiness pill for a requirement row's last column: green ✓ when all four
 * calendar stages hold a doc, blue while partially filled, red when empty.
 */
function ReadinessPill({ filled, total }: { filled: number; total: number }) {
  const { t } = useT("archive");
  const base =
    "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-micro font-medium tabular-nums";
  if (filled >= total) {
    return (
      <span className={cn(base, "border-success/30 bg-success/10 text-success")}>
        <Check className="size-3" />
        {t(($) => $.browser.mx_ready)}
      </span>
    );
  }
  if (filled === 0) {
    return (
      <span className={cn(base, "border-destructive/30 bg-destructive/10 text-destructive")}>
        {t(($) => $.browser.mx_missing, { n: total })}
      </span>
    );
  }
  return (
    <span className={cn(base, "border-info/30 bg-info/10 text-info")}>
      {t(($) => $.browser.mx_partial, { filled, total })}
    </span>
  );
}

function groupArtifacts(artifacts: ProjectArtifact[], t: Translator) {
  const projectMap = new Map<string, ProjectArtifact[]>();
  const sharedMap = new Map<string, ProjectArtifact[]>();
  const rowMap = new Map<string, RequirementRow>();

  for (const artifact of artifacts) {
    if (artifact.scope === "requirement") {
      const rowKey = artifact.requirement_key ?? artifact.issue_id ?? "__unassigned__";
      let row = rowMap.get(rowKey);
      if (!row) {
        row = {
          key: rowKey,
          // TODO(backend): GetArtifactMatrix does not JOIN the issue table, so
          // ProjectArtifact carries no issue_title. Once the handler returns a
          // title, prefer it here (truncated ~20 chars) over requirement_key.
          label:
            artifact.requirement_key ??
            (artifact.issue_id
              ? artifact.issue_id
              : t(($) => $.browser.unassigned)),
          issueId: artifact.issue_id ?? null,
          cells: new Map(),
        };
        rowMap.set(rowKey, row);
      }
      const cellKey = artifact.stage ?? null;
      const cell = row.cells.get(cellKey);
      if (cell) cell.push(artifact);
      else row.cells.set(cellKey, [artifact]);
    } else {
      const target = artifact.scope === "project" ? projectMap : sharedMap;
      const bucket = target.get(artifact.doc_type);
      if (bucket) bucket.push(artifact);
      else target.set(artifact.doc_type, [artifact]);
    }
  }

  const toGroups = (
    map: Map<string, ProjectArtifact[]>,
    scopeLabel: string,
  ): ScopeGroup[] =>
    [...map.entries()].map(([docType, items]) => ({
      key: `${scopeLabel}:${docType}`,
      docType,
      scopeLabel,
      items: items.sort(
        (a, b) =>
          a.rel_path.localeCompare(b.rel_path) || b.version - a.version,
      ),
    }));

  const requirementRows = [...rowMap.values()].map((row) => {
    for (const [stage, items] of row.cells) {
      row.cells.set(
        stage,
        dedupeByDocType(items).sort((a, b) => a.doc_type.localeCompare(b.doc_type)),
      );
    }
    return row;
  });
  requirementRows.sort((a, b) => a.label.localeCompare(b.label));

  return {
    projectRows: toGroups(projectMap, t(($) => $.browser.scope_project)),
    sharedRows: toGroups(sharedMap, t(($) => $.browser.scope_shared)),
    requirementRows,
  };
}

/** Keep only the newest version per doc_type within a matrix cell. */
function dedupeByDocType(items: ProjectArtifact[]): ProjectArtifact[] {
  const map = new Map<string, ProjectArtifact>();
  for (const item of items) {
    const existing = map.get(item.doc_type);
    if (!existing || item.version > existing.version) map.set(item.doc_type, item);
  }
  return [...map.values()];
}

/** Stage display name via i18n. */
function stageName(t: Translator, stage: ArtifactStage): string {
  switch (stage) {
    case 1:
      return t(($) => $.browser.stage_s1);
    case 2:
      return t(($) => $.browser.stage_s2);
    case 3:
      return t(($) => $.browser.stage_s3);
    case 4:
      return t(($) => $.browser.stage_s4);
  }
}
