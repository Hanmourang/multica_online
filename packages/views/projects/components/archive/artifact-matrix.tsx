"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, FileStack } from "lucide-react";
import type { ArtifactStage, Issue, ProjectArtifact } from "@multica/core/types";
import { ARTIFACT_STAGES } from "@multica/core/artifacts";
import type { ArtifactEditorSeed } from "./artifact-editor-dialog";
import { Badge } from "@multica/ui/components/ui/badge";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { AppLink } from "../../../navigation";
import { matrixRequirementDisplay } from "./artifact-matrix-label";
import { requirementBucket } from "../requirements/requirement-helpers";
import { artifactDisplayName } from "./archive-display";
import { ArchiveMarqueeSurface } from "./archive-marquee-surface";
import type { PlanningShelf } from "./archive-mapping";
import {
  ARTIFACT_DND_MIME,
  dragArtifactIds,
  setPendingDragIds,
  takePendingDragIds,
} from "./archive-relocate";
import { ArtifactModuleChipControl } from "./artifact-module-tag";
import {
  blockingReadiness,
  missingBlockingDocTypes,
  requirementMissingBlocking as requirementHasBlockingGap,
} from "./archive-stage-gate";
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

// 五阶段矩阵列从 Core placement 派生（五阶段对齐 plan §6.3），不本地硬编码。
const STAGES: readonly ArtifactStage[] = ARTIFACT_STAGES;

const PROJECT_SHELVES: Array<{
  docType: PlanningShelf;
  title:
    | "shelf_research"
    | "shelf_product_design"
    | "shelf_architecture"
    | "shelf_retrospective"
    | "shelf_iteration";
}> = [
  { docType: "research", title: "shelf_research" },
  { docType: "product-design", title: "shelf_product_design" },
  { docType: "architecture", title: "shelf_architecture" },
  { docType: "retrospective", title: "shelf_retrospective" },
  { docType: "iteration", title: "shelf_iteration" },
];

function requirementMissingBlocking(row: RequirementRow): boolean {
  return requirementHasBlockingGap({
    rootDocs: row.cells.get(null) ?? [],
    filesByStage: row.cells,
  });
}

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

function ArtifactChip({
  artifact,
  selected,
  tagging,
  checked,
  pickedIds,
  onClick,
  onToggle,
  onSaveTag,
  tagBusy,
}: {
  artifact: ProjectArtifact;
  selected: boolean;
  tagging?: boolean;
  checked?: boolean;
  pickedIds?: Set<string>;
  onClick: (event: React.MouseEvent) => void;
  onToggle?: (next: boolean) => void;
  onSaveTag?: (value: string) => Promise<void> | void;
  tagBusy?: boolean;
}) {
  const { t } = useT("archive");
  const label = artifactDisplayName(artifact.rel_path);
  const dragging = useRef(false);
  return (
    <div
      data-artifact-id={artifact.id}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-caption transition-colors",
        selected
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-surface-border bg-surface hover:bg-surface-hover",
        (tagging || checked) && checked && "border-amber-500/50 bg-amber-400/10",
      )}
    >
      {tagging || checked ? (
        <Checkbox
          checked={checked === true}
          aria-label={label}
          onCheckedChange={(value) => onToggle?.(value === true)}
        />
      ) : null}
      <button
        type="button"
        draggable
        onDragStart={(event) => {
          dragging.current = true;
          const ids = dragArtifactIds(artifact.id, pickedIds);
          setPendingDragIds(ids);
          const payload = JSON.stringify(ids);
          event.dataTransfer.setData(ARTIFACT_DND_MIME, payload);
          event.dataTransfer.setData("text/plain", payload);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          window.setTimeout(() => {
            dragging.current = false;
          }, 0);
        }}
        onClick={(event) => {
          if (dragging.current) return;
          onClick(event);
        }}
        title={artifact.rel_path}
        aria-pressed={selected}
        className="min-w-0 flex-1 cursor-grab truncate text-left font-medium text-[11px] active:cursor-grabbing"
      >
        {label}
      </button>
      <ArtifactModuleChipControl
        artifact={artifact}
        onSave={onSaveTag}
        busy={tagBusy}
      />
      {artifact.source === "asset" ? (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {t(($) => $.browser.source_asset)}
        </Badge>
      ) : null}
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {t(($) => $.common.version_badge, { version: artifact.version })}
      </span>
    </div>
  );
}

const SHELF_PREVIEW = 5;

function ExpandableArtifactList({
  items,
  selectedId,
  onSelect,
  tagging,
  pickedIds,
  onTogglePick,
  onSaveTag,
  tagBusy,
}: {
  items: ProjectArtifact[];
  selectedId: string | null;
  onSelect: (artifact: ProjectArtifact) => void;
  tagging?: boolean;
  pickedIds?: Set<string>;
  onTogglePick?: (id: string, next: boolean) => void;
  onSaveTag?: (artifact: ProjectArtifact, value: string) => Promise<void> | void;
  tagBusy?: boolean;
}) {
  const { t } = useT("archive");
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, items.length - SHELF_PREVIEW);
  const visible = expanded ? items : items.slice(0, SHELF_PREVIEW);

  useEffect(() => {
    if (!selectedId || expanded) return;
    if (items.slice(SHELF_PREVIEW).some((artifact) => artifact.id === selectedId)) {
      setExpanded(true);
    }
  }, [expanded, items, selectedId]);

  return (
    <div className="mt-2 space-y-1">
      <ul
        className={cn(
          "space-y-1",
          expanded && hidden > 0 && "max-h-72 overflow-y-auto pr-0.5",
        )}
      >
        {visible.map((artifact) => (
          <li key={artifact.id}>
            <ArtifactChip
              artifact={artifact}
              selected={artifact.id === selectedId}
              tagging={tagging}
              checked={pickedIds?.has(artifact.id)}
              pickedIds={pickedIds}
              onClick={(event) => {
                onSelect(artifact);
                if (tagging || event.shiftKey || event.metaKey || event.ctrlKey) {
                  onTogglePick?.(artifact.id, !pickedIds?.has(artifact.id));
                }
              }}
              onToggle={(next) => onTogglePick?.(artifact.id, next)}
              onSaveTag={
                onSaveTag ? (value) => onSaveTag(artifact, value) : undefined
              }
              tagBusy={tagBusy}
            />
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          data-testid="archive-shelf-more"
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-surface-border px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" aria-hidden />
              {t(($) => $.browser.show_less)}
            </>
          ) : (
            <>
              <ChevronDown className="size-3" aria-hidden />
              {t(($) => $.browser.show_more, { n: hidden })}
            </>
          )}
        </button>
      )}
    </div>
  );
}

/** C5 `.rq-id`：brand + 等宽加粗，hover 才下划线。 */
const REQ_ID_CLASS =
  "block min-w-0 truncate font-mono text-caption font-bold text-brand hover:underline";

/** 需求信息三子列 + S1–S4 + 就绪度。 */
const MATRIX_GRID =
  "grid grid-cols-[minmax(6.5rem,7.75rem)_minmax(8.5rem,1.15fr)_minmax(7.5rem,8.75rem)_repeat(5,minmax(128px,1fr))_5.75rem]";

export function ArtifactMatrix({
  artifacts,
  issues = [],
  requirementHref,
  selectedId,
  onSelect,
  onOpenRequirement,
  onCreateMissing,
  missingOnly,
  tagging,
  pickedIds,
  onTogglePick,
  onSaveTag,
  tagBusy,
  onPickMany,
  onRelocate,
}: {
  artifacts: ProjectArtifact[];
  issues?: Issue[];
  requirementHref?: (issueId: string) => string;
  selectedId: string | null;
  onSelect: (artifact: ProjectArtifact) => void;
  onOpenRequirement?: (issueId: string, drill?: string) => void;
  onCreateMissing?: (seed: ArtifactEditorSeed) => void;
  missingOnly: boolean;
  tagging?: boolean;
  pickedIds?: Set<string>;
  onTogglePick?: (id: string, next: boolean) => void;
  onSaveTag?: (artifact: ProjectArtifact, value: string) => Promise<void> | void;
  tagBusy?: boolean;
  onPickMany?: (ids: string[], additive: boolean) => void;
  onRelocate?: (ids: string[], shelf: PlanningShelf) => void;
}) {
  const { t } = useT("archive");
  const [overShelf, setOverShelf] = useState<PlanningShelf | null>(null);

  const { projectRows, sharedRows, filingRows, requirementRows } = useMemo(
    () => groupArtifacts(artifacts, t),
    [artifacts, t],
  );
  const projectByType = useMemo(() => {
    const map = new Map(projectRows.map((row) => [row.docType, row.items]));
    return map;
  }, [projectRows]);
  // 资产自动同步行（source='asset'，doc_type='asset'）：不在四固定货架内，
  // 单独成区展示，避免绑定的知识/文档在矩阵视图隐身。
  const assetItems = useMemo(() => projectByType.get("asset") ?? [], [projectByType]);

  const visibleRequirementRows = useMemo(
    () =>
      missingOnly
        ? requirementRows.filter((row) => requirementMissingBlocking(row))
        : requirementRows,
    [requirementRows, missingOnly],
  );

  return (
    <div className="space-y-6" data-testid="archive-matrix">
      <section className="space-y-2" aria-label={t(($) => $.browser.project_scope_title)}>
        <h4 className="text-caption font-medium text-muted-foreground">
          {t(($) => $.browser.project_scope_title)}
        </h4>
        <p className="text-[11px] text-muted-foreground">{t(($) => $.browser.drag_hint)}</p>
        <ArchiveMarqueeSurface
          onPickIds={(ids, additive) => onPickMany?.(ids, additive)}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {PROJECT_SHELVES.map((shelf) => {
            const items = projectByType.get(shelf.docType) ?? [];
            const missing = items.length === 0;
            const dropping = overShelf === shelf.docType;
            return (
              <div
                key={shelf.docType}
                data-testid={`archive-shelf-${shelf.docType}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setOverShelf(shelf.docType);
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                  setOverShelf((current) => (current === shelf.docType ? null : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setOverShelf(null);
                  const ids = takePendingDragIds(
                    event.dataTransfer.getData(ARTIFACT_DND_MIME) ||
                      event.dataTransfer.getData("text/plain"),
                  );
                  if (ids.length > 0) onRelocate?.(ids, shelf.docType);
                }}
                className={cn(
                  "min-h-28 rounded-lg border bg-surface p-3",
                  dropping
                    ? "border-amber-500 bg-amber-400/10"
                    : missing
                      ? "border-dashed border-destructive/50"
                      : "border-surface-border",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-caption font-medium">
                    {shelfTitle(t, shelf.title)}
                  </span>
                  <code className="text-[10px] text-muted-foreground">{shelf.docType}</code>
                  <span className="ml-auto text-caption tabular-nums text-muted-foreground">
                    {items.length}
                  </span>
                </div>
                {missing ? (
                  <button
                    type="button"
                    className="mt-2 w-full rounded-md border border-dashed border-destructive/50 bg-destructive/5 p-1.5 text-[10px] font-medium text-destructive"
                    onClick={() =>
                      onCreateMissing?.({
                        scope: "project",
                        docType: shelf.docType,
                      })
                    }
                  >
                    {t(($) => $.browser.shelf_missing)}
                  </button>
                ) : (
                  <ExpandableArtifactList
                    items={items}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    tagging={tagging}
                    pickedIds={pickedIds}
                    onTogglePick={onTogglePick}
                    onSaveTag={onSaveTag}
                    tagBusy={tagBusy}
                  />
                )}
              </div>
            );
          })}
          </div>
        </ArchiveMarqueeSurface>
        {sharedRows.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {sharedRows.map((group) => (
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
                <ExpandableArtifactList
                  items={group.items}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  tagging={tagging}
                  pickedIds={pickedIds}
                  onTogglePick={onTogglePick}
                  onSaveTag={onSaveTag}
                  tagBusy={tagBusy}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {assetItems.length > 0 && (
        <section className="space-y-2" aria-label={t(($) => $.browser.source_asset)}>
          <h4 className="text-caption font-medium text-muted-foreground">
            {t(($) => $.browser.source_asset)}
          </h4>
          <div className="rounded-lg border border-surface-border bg-surface p-3">
            <div className="flex items-center gap-2">
              <code className="text-caption font-medium">{assetItems[0]?.doc_type}</code>
              <span className="ml-auto text-caption tabular-nums text-muted-foreground">
                {assetItems.length}
              </span>
            </div>
            <ExpandableArtifactList
              items={assetItems}
              selectedId={selectedId}
              onSelect={onSelect}
              tagging={tagging}
              pickedIds={pickedIds}
              onTogglePick={onTogglePick}
              onSaveTag={onSaveTag}
              tagBusy={tagBusy}
            />
          </div>
        </section>
      )}

      {filingRows.length > 0 && (
        <section className="space-y-2" aria-label={t(($) => $.browser.filing_title)}>
          <h4 className="text-caption font-medium text-muted-foreground">
            {t(($) => $.browser.filing_title)}
          </h4>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {filingRows.map((group) => (
              <div
                key={group.key}
                className="rounded-lg border border-surface-border bg-surface p-3"
              >
                <div className="flex items-center gap-2">
                  <code className="text-caption font-medium">{group.docType}</code>
                  <span className="ml-auto text-caption tabular-nums text-muted-foreground">
                    {group.items.length}
                  </span>
                </div>
                <ExpandableArtifactList
                  items={group.items}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  tagging={tagging}
                  pickedIds={pickedIds}
                  onTogglePick={onTogglePick}
                  onSaveTag={onSaveTag}
                  tagBusy={tagBusy}
                />
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
            <div className="min-w-[1080px]">
              <div
                className={cn(
                  MATRIX_GRID,
                  "grid-rows-[auto_auto] border-b border-surface-border bg-surface-hover/40 text-caption font-medium text-muted-foreground",
                )}
              >
                <div className="col-span-3 border-r border-surface-border px-3 py-1.5">
                  {t(($) => $.browser.mx_req_info)}
                </div>
                {STAGES.map((stage) => (
                  <div key={stage} className="row-span-2 flex items-end px-3 py-2">
                    {stageName(t, stage)}
                  </div>
                ))}
                <div className="row-span-2 flex items-end justify-end px-2 py-2 text-right">
                  {t(($) => $.browser.mx_status)}
                </div>
                <div className="border-t border-surface-border px-3 py-1.5 text-micro">
                  {t(($) => $.browser.mx_col_id)}
                </div>
                <div className="border-t border-surface-border px-2 py-1.5 text-micro">
                  {t(($) => $.browser.mx_col_name)}
                </div>
                <div className="border-r border-t border-surface-border px-2 py-1.5 text-micro">
                  {t(($) => $.browser.mx_col_state_gap)}
                </div>
              </div>
              {visibleRequirementRows.map((row) => {
                const readiness = blockingReadiness({
                  rootDocs: row.cells.get(null) ?? [],
                  filesByStage: row.cells,
                });
                const gap = Math.max(0, readiness.total - readiness.filled);
                const display = matrixRequirementDisplay(row, issues);
                return (
                  <div
                    key={row.key}
                    className={cn(MATRIX_GRID, "border-b border-surface-border last:border-b-0")}
                  >
                    <div className="min-w-0 px-3 py-2">
                      <MatrixRequirementId
                        display={display}
                        requirementHref={requirementHref}
                        onOpenRequirement={onOpenRequirement}
                      />
                    </div>
                    <div className="min-w-0 px-2 py-2">
                      <span
                        className="block truncate text-caption font-medium"
                        title={display.title ?? undefined}
                      >
                        {display.title ?? "—"}
                      </span>
                    </div>
                    <div className="min-w-0 border-r border-surface-border px-2 py-2">
                      <RequirementStateGap
                        status={display.status}
                        gap={gap}
                        issueId={display.issueId}
                        issues={issues}
                      />
                    </div>
                    {STAGES.map((stage) => {
                      const cellArtifacts = row.cells.get(stage) ?? [];
                      const missing = missingBlockingDocTypes(stage, cellArtifacts);
                      return (
                        <div key={stage} className="min-w-0 border-l border-surface-border px-2 py-2">
                          {cellArtifacts.length > 0 && (
                            <ul className="space-y-1">
                              {cellArtifacts.map((artifact) => (
                                <li key={artifact.id}>
                                  <ArtifactChip
                                    artifact={artifact}
                                    selected={artifact.id === selectedId}
                                    tagging={tagging}
                                    checked={pickedIds?.has(artifact.id)}
                                    pickedIds={pickedIds}
                                    onClick={(event) => {
                                      onSelect(artifact);
                                      if (
                                        tagging ||
                                        event.shiftKey ||
                                        event.metaKey ||
                                        event.ctrlKey
                                      ) {
                                        onTogglePick?.(
                                          artifact.id,
                                          !pickedIds?.has(artifact.id),
                                        );
                                      }
                                    }}
                                    onToggle={(next) => onTogglePick?.(artifact.id, next)}
                                    onSaveTag={
                                      onSaveTag
                                        ? (value) => onSaveTag(artifact, value)
                                        : undefined
                                    }
                                    tagBusy={tagBusy}
                                  />
                                </li>
                              ))}
                            </ul>
                          )}
                          {missing.map((docType) => (
                            <button
                              key={docType}
                              type="button"
                              className="mt-1 w-full rounded-md border border-dashed border-destructive/50 bg-destructive/5 p-1.5 text-center text-[10px] font-medium text-destructive hover:bg-destructive/10"
                              onClick={() =>
                                onCreateMissing?.({
                                  scope: "requirement",
                                  stage,
                                  docType,
                                  requirementKey:
                                    row.key.startsWith("REQ-") ? row.key : null,
                                  issueId: row.issueId,
                                  title: matrixRequirementDisplay(row, issues).title ?? row.label,
                                })
                              }
                            >
                              {t(($) => $.browser.missing_doc, { doc: docType })}
                              {onCreateMissing ? ` · ${t(($) => $.manage.create)}` : ""}
                            </button>
                          ))}
                          {cellArtifacts.length === 0 && missing.length === 0 && (
                            <p className="text-center text-[10px] text-muted-foreground">—</p>
                          )}
                        </div>
                      );
                    })}
                    <div className="px-2 py-2 text-right">
                      <ReadinessPill filled={readiness.filled} total={readiness.total} />
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

function MatrixRequirementId({
  display,
  requirementHref,
  onOpenRequirement,
}: {
  display: ReturnType<typeof matrixRequirementDisplay>;
  requirementHref?: (issueId: string) => string;
  onOpenRequirement?: (issueId: string, drill?: string) => void;
}) {
  const { t } = useT("archive");
  const href = display.issueId && requirementHref ? requirementHref(display.issueId) : null;

  if (href) {
    return (
      <AppLink
        href={href}
        newTabTitle={display.identifier}
        aria-label={t(($) => $.req_mgmt.open_requirement, { id: display.identifier })}
        title={display.identifier}
        className={REQ_ID_CLASS}
        data-testid="matrix-requirement-id"
      >
        {display.identifier}
      </AppLink>
    );
  }
  if (display.issueId && onOpenRequirement) {
    return (
      <button
        type="button"
        data-testid="matrix-requirement-id"
        className={`${REQ_ID_CLASS} text-left`}
        onClick={() => onOpenRequirement(display.issueId!, "deliverables")}
      >
        {display.identifier}
      </button>
    );
  }
  return (
    <span className={REQ_ID_CLASS} data-testid="matrix-requirement-id">
      {display.identifier}
    </span>
  );
}

function RequirementStateGap({
  status,
  gap,
  issueId,
  issues,
}: {
  status: string | null;
  gap: number;
  issueId: string | null;
  issues: Issue[];
}) {
  const { t } = useT("archive");
  const issue = issueId ? issues.find((row) => row.id === issueId) : undefined;
  const bucket = issue ? requirementBucket(issue) : "other";
  const tone =
    bucket === "failed"
      ? "bg-destructive/10 text-destructive"
      : bucket === "pending"
        ? "bg-warning/15 text-warning"
        : bucket === "done"
          ? "bg-success/15 text-success"
          : bucket === "active"
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground";
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid="matrix-requirement-state-gap">
      <span className={cn("w-fit max-w-full truncate rounded-full px-1.5 py-0.5 text-micro", tone)}>
        {status ?? t(($) => $.browser.mx_status_none)}
      </span>
      <span
        className={cn(
          "text-micro tabular-nums",
          gap > 0 ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {gap > 0
          ? t(($) => $.browser.mx_gap_n, { n: gap })
          : t(($) => $.browser.mx_gap_ok)}
      </span>
    </div>
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

function isFilingArtifact(artifact: ProjectArtifact): boolean {
  return (
    artifact.doc_type.startsWith("filing") ||
    artifact.rel_path.replace(/\\/g, "/").includes("/filing/")
  );
}

function groupArtifacts(artifacts: ProjectArtifact[], t: Translator) {
  const projectMap = new Map<string, ProjectArtifact[]>();
  const sharedMap = new Map<string, ProjectArtifact[]>();
  const filingMap = new Map<string, ProjectArtifact[]>();
  const rowMap = new Map<string, RequirementRow>();

  for (const artifact of artifacts) {
    if (isFilingArtifact(artifact)) {
      const bucket = filingMap.get(artifact.doc_type);
      if (bucket) bucket.push(artifact);
      else filingMap.set(artifact.doc_type, [artifact]);
      continue;
    }
    if (artifact.scope === "requirement") {
      const rowKey = artifact.requirement_key ?? artifact.issue_id ?? "__unassigned__";
      let row = rowMap.get(rowKey);
      if (!row) {
        row = {
          key: rowKey,
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
    filingRows: toGroups(filingMap, t(($) => $.browser.filing_title)),
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
function shelfTitle(
  t: Translator,
  key:
    | "shelf_research"
    | "shelf_product_design"
    | "shelf_architecture"
    | "shelf_retrospective"
    | "shelf_iteration",
): string {
  switch (key) {
    case "shelf_research":
      return t(($) => $.browser.shelf_research);
    case "shelf_product_design":
      return t(($) => $.browser.shelf_product_design);
    case "shelf_architecture":
      return t(($) => $.browser.shelf_architecture);
    case "shelf_retrospective":
      return t(($) => $.browser.shelf_retrospective);
    case "shelf_iteration":
      return t(($) => $.browser.shelf_iteration);
  }
}

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
    case 5:
      return t(($) => $.browser.stage_s5);
  }
}
