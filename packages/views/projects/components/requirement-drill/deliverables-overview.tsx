"use client";

import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  Boxes,
  Check,
  Eye,
  FilePlus2,
  FileText,
  FolderArchive,
  Gauge,
  Lock,
  ShieldAlert,
  ShieldQuestion,
  Sparkles,
  Users,
} from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { issueDeliverablesOptions } from "@multica/core/agent-runs/queries";
import { projectArtifactsOptions } from "@multica/core/artifacts/queries";
import { useCreateComment } from "@multica/core/issues/mutations";
import type {
  ArtifactStage,
  DeliverablesCompleteness,
  DeliverablesDerivedStatus,
  DeliverablesMissingItem,
  DeliverablesModuleLock,
  DeliverablesRoleAssignment,
  DeliverablesStageGate,
  DeliverablesStageNode,
  DerivedNextActionKey,
  DerivedStatusKey,
  ProjectArtifact,
} from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { AppLink } from "../../../navigation";
import { ArtifactPreviewDialog } from "../archive/artifact-preview";
import { ArchiveActionDialog } from "../archive/archive-action-dialog";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../archive/query-states";

/**
 * f8 交付概览（issue-detail「交付概览」Tab）。
 *
 * Layout follows the prototype's f8 screen top-down:
 *
 *   ⓪ four status cards — derived status (the 9-rule projection, never a
 *      stored column) · scheduling & mutex (ModuleLocker) · role roster
 *      (issue_role_assignment) · archive completeness
 *   ① stage band — four stages joined by connectors, carrying a real `cur`
 *      pointer and green-solid `done` nodes straight from the server's
 *      stage_flow projection
 *   ② per-stage artifact rows — from the project artifact list filtered by
 *      issue_id (requires the issue to carry a project)
 *   ③ todo completion bars — the runs' todo rollup
 *
 * Every value is server-derived fact. Where the server genuinely cannot see
 * something, the card says so instead of inventing a number:
 *
 *   · `module_lock: null` means the issue carries no module, so the daemon's
 *     ModuleLocker skips Acquire entirely — rendered as an honest "no mutex
 *     info" state, never as a fake unlocked/freed lock. When a lock *is*
 *     present the card still discloses that the holder table lives in daemon
 *     process memory, so only queue-persisted facts are shown.
 *   · card ④ is driven by `stage_gate_rule` (migration 460): the server
 *     LEFT-JOINs each stage's required doc_type against the issue's artifacts
 *     and returns per-stage verdicts (`stage_gates`) plus `missing_items` that
 *     now name the specific absent document (`kind: "missing_doc_type"`). The
 *     completeness ring counts blocking rules only (原型 f8 anno②「环只算必备
 *     件」). When no ruleset resolves (`gate_defined: false`) the card degrades
 *     honestly to the legacy "stages with artifact" tally rather than inventing
 *     a required-doc denominator.
 *
 * The prototype's f8 anno③ red-boxed missing-doc row and its two repair entry
 * points live in <GateRepairSection>: 「让 agent 补写」 dispatches through the
 * existing comment → agent_task_queue trigger chain (an @mention of the
 * roster's tester agent, resolved server-side by util.ParseMentions →
 * Handler.triggerTasksForComment), while 「从模板创建」 is honestly disabled —
 * writing a template file into the git archive is a CLI-side capability, not a
 * web one, so it is a disabled control with an explanatory tooltip rather than
 * a click that silently does nothing.
 */

type Translator = ReturnType<typeof useT<"archive">>["t"];

const STAGE_ORDER: (ArtifactStage | null)[] = [1, 2, 3, 4, null];

function stageTitle(t: Translator, stage: ArtifactStage | null): string {
  switch (stage) {
    case 1:
      return t(($) => $.browser.stage_s1);
    case 2:
      return t(($) => $.browser.stage_s2);
    case 3:
      return t(($) => $.browser.stage_s3);
    case 4:
      return t(($) => $.browser.stage_s4);
    default:
      return t(($) => $.browser.unassigned);
  }
}

function stageCount(
  byStage: Record<string, number>,
  stage: ArtifactStage | null,
): number {
  return byStage[stage === null ? "unassigned" : String(stage)] ?? 0;
}

const NEUTRAL_PILL = "border-border/60 bg-muted/50 text-muted-foreground";

/** Derived status → pill tone. Deliberately mirrors progress-tracker's
 *  STATUS_TONE semantics (info = live, warning = blocked/waiting, success =
 *  settled) so the three tabs read as one system. */
const DERIVED_TONE: Record<DerivedStatusKey, string> = {
  not_decomposed: NEUTRAL_PILL,
  prototype_pending: "border-warning/40 bg-warning/10 text-warning",
  decomposition_pending: "border-warning/40 bg-warning/10 text-warning",
  pending_trigger: "border-info/30 bg-info/10 text-info",
  executing: "border-info/30 bg-info/10 text-info",
  waiting_module_lock: "border-warning/40 bg-warning/10 text-warning",
  accepting: "border-info/30 bg-info/10 text-info",
  acceptance_failed: "border-destructive/40 bg-destructive/10 text-destructive",
  completed: "border-success/30 bg-success/10 text-success",
  cancelled: NEUTRAL_PILL,
  unknown: NEUTRAL_PILL,
};

// i18n keys must be static literals — `$.deliverables[\`status_${key}\`]` is
// banned repo-wide — so each server-driven enum resolves through an exhaustive
// switch. If the backend grows a value this map has not caught up with, the
// `unknown` / `default` branch falls back to the raw server literal (or a
// neutral label) instead of inventing one.

function derivedStatusLabel(
  t: Translator,
  derived: DeliverablesDerivedStatus,
): string {
  switch (derived.status_key) {
    case "not_decomposed":
      return t(($) => $.deliverables.status_not_decomposed);
    case "prototype_pending":
      return t(($) => $.deliverables.status_prototype_pending);
    case "decomposition_pending":
      return t(($) => $.deliverables.status_decomposition_pending);
    case "pending_trigger":
      return t(($) => $.deliverables.status_pending_trigger);
    case "executing":
      return t(($) => $.deliverables.status_executing);
    case "waiting_module_lock":
      return t(($) => $.deliverables.status_waiting_module_lock);
    case "accepting":
      return t(($) => $.deliverables.status_accepting);
    case "acceptance_failed":
      return t(($) => $.deliverables.status_acceptance_failed);
    case "completed":
      return t(($) => $.deliverables.status_completed);
    case "cancelled":
      return t(($) => $.deliverables.status_cancelled);
    case "unknown":
    default:
      return (
        derived.requirement_status || t(($) => $.deliverables.status_unknown)
      );
  }
}

function nextActionLabel(t: Translator, key: DerivedNextActionKey): string {
  switch (key) {
    case "confirm_prototype":
      return t(($) => $.deliverables.action_confirm_prototype);
    case "confirm_decomposition":
      return t(($) => $.deliverables.action_confirm_decomposition);
    case "decompose":
      return t(($) => $.deliverables.action_decompose);
    case "trigger":
      return t(($) => $.deliverables.action_trigger);
    case "wait_module_lock":
      return t(($) => $.deliverables.action_wait_module_lock);
    case "finish_execution":
      return t(($) => $.deliverables.action_finish_execution);
    case "finish_acceptance":
      return t(($) => $.deliverables.action_finish_acceptance);
    case "none":
    default:
      return t(($) => $.deliverables.action_none);
  }
}

function roleLabel(
  t: Translator,
  role: DeliverablesRoleAssignment["role"],
): string {
  switch (role) {
    case "pm":
      return t(($) => $.deliverables.role_pm);
    case "prototyper":
      return t(($) => $.deliverables.role_prototyper);
    case "developer":
      return t(($) => $.deliverables.role_developer);
    case "data":
      return t(($) => $.deliverables.role_data);
    case "tester":
    default:
      return t(($) => $.deliverables.role_tester);
  }
}

function stageStateLabel(
  t: Translator,
  state: DeliverablesStageNode["state"],
): string {
  switch (state) {
    case "done":
      return t(($) => $.deliverables.stage_state_done);
    case "cur":
      return t(($) => $.deliverables.stage_state_cur);
    case "todo":
    default:
      return t(($) => $.deliverables.stage_state_todo);
  }
}

export function DeliverablesOverview({
  issueId,
  projectId,
}: {
  issueId: string;
  projectId?: string | null;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();

  const overviewQuery = useQuery(issueDeliverablesOptions(wsId, issueId));
  const detailQuery = useQuery({
    ...projectArtifactsOptions(wsId, projectId ?? "", { issue_id: issueId }),
    enabled: Boolean(projectId),
  });

  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ProjectArtifact | null>(null);

  const artifacts = detailQuery.data;
  const sortedArtifacts = useMemo(() => {
    if (!artifacts) return [];
    return [...artifacts].sort(
      (a, b) => (a.stage ?? 9) - (b.stage ?? 9) || a.doc_type.localeCompare(b.doc_type),
    );
  }, [artifacts]);

  const grouped = useMemo(() => {
    const groups = new Map<ArtifactStage | null, ProjectArtifact[]>();
    for (const artifact of sortedArtifacts) {
      const key = artifact.stage ?? null;
      const bucket = groups.get(key);
      if (bucket) bucket.push(artifact);
      else groups.set(key, [artifact]);
    }
    return groups;
  }, [sortedArtifacts]);

  if (overviewQuery.isPending) {
    return <QueryLoading rows={4} />;
  }
  if (overviewQuery.isError) {
    return (
      <QueryError
        onRetry={() => overviewQuery.refetch()}
        message={overviewQuery.error.message}
      />
    );
  }

  const overview = overviewQuery.data;
  const todoMax = Math.max(1, ...Object.values(overview.todos.by_status));
  // `?? []` / truthiness guards keep the tab usable against a response written
  // before the f8 fields existed: a missing projection then simply renders no
  // card or band instead of throwing on `.map`.
  const derived = overview.derived_status;
  const stageFlow = overview.stage_flow ?? [];
  const roles = overview.role_assignments ?? [];
  const missing = overview.missing_items ?? [];
  const stageGates = overview.stage_gates ?? [];
  const blockingStage = overview.blocking_stage ?? 0;

  if (
    overview.artifacts.total === 0 &&
    overview.todos.total === 0 &&
    roles.length === 0 &&
    stageFlow.every((node) => node.task_total === 0)
  ) {
    return (
      <ArchiveEmpty
        title={t(($) => $.deliverables.title)}
        description={t(($) => $.deliverables.empty_hint)}
        icon={<Boxes className="size-5" />}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* ⓪ Four status cards — the prototype's `.stt` grid (repeat(4, 1fr)),
          stepped down to 2-up and 1-up by breakpoint. Card order follows the
          prototype: derived status · mutex · role roster · completeness. */}
      <div>
        <div className="mb-2 text-caption font-medium text-foreground">
          {t(($) => $.deliverables.status_cards_title)}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {derived && <DerivedStatusCard derived={derived} />}
          <ModuleLockCard lock={overview.module_lock} />
          <RoleRosterCard roles={roles} />
          {overview.completeness && (
            <CompletenessCard
              completeness={overview.completeness}
              gates={stageGates}
              blockingStage={blockingStage}
              archiveHref={projectId ? paths.projectView(projectId, "archive") : null}
            />
          )}
        </div>
      </div>

      {/* ④′ Stage-gate gaps — the prototype's f8 anno③ red-boxed missing-doc
          rows with their two repair entry points. Full width (not a grid cell)
          so the two actions per row have room; renders only when the resolved
          ruleset actually names an absent required document. This is a
          gate/completeness surface, not a second stage band (anno②「避免两套
          阶段 UI」). */}
      <GateRepairSection
        issueId={issueId}
        missing={missing}
        roles={roles}
      />

      {/* ① Stage band — the `cur` pointer and green-solid `done` nodes now come
          from the server's stage_flow projection (derived status + per-stage
          task counts), so nothing here is guessed from artifact volume.
          Artifacts that carry no stage stay in their own chip outside the
          band: folding them into S1–S4 would invent a stage they never had. */}
      {stageFlow.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-caption font-medium text-foreground">
              {t(($) => $.deliverables.stage_flow)}
            </span>
            <span className="text-micro text-muted-foreground">
              {t(($) => $.deliverables.stage_click_hint)}
            </span>
          </div>
          <StageBand
            issueId={issueId}
            nodes={stageFlow}
            unassigned={stageCount(overview.artifacts.by_stage, null)}
          />
        </div>
      )}

      {/* ② Per-stage artifact rows — needs the issue to carry a project. */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-caption font-medium text-foreground">
            {t(($) => $.deliverables.by_stage)}
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-1">
            {projectId && (
              <AppLink href={paths.projectView(projectId, "deliverables")}>
                <Button size="xs" variant="ghost">
                  {t(($) => $.deliverables.open_project_deliverables)}
                </Button>
              </AppLink>
            )}
            {Object.entries(overview.artifacts.by_scope).map(([scope, count]) => (
              <Badge key={scope} variant="outline" className="tabular-nums">
                {scope} {count}
              </Badge>
            ))}
          </span>
        </div>
        {!projectId ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-caption text-muted-foreground">
            {t(($) => $.deliverables.detail_needs_project)}
          </p>
        ) : detailQuery.isPending ? (
          <QueryLoading rows={2} />
        ) : detailQuery.isError ? (
          <QueryError
            compact
            message={detailQuery.error.message}
            onRetry={() => detailQuery.refetch()}
          />
        ) : sortedArtifacts.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-caption text-muted-foreground">
            {t(($) => $.deliverables.stage_empty)}
          </p>
        ) : (
          <div className="space-y-2">
            {STAGE_ORDER.filter((stage) => grouped.has(stage)).map((stage) => {
              const rows = grouped.get(stage) ?? [];
              return (
                <div
                  key={stage ?? "unassigned"}
                  className="overflow-hidden rounded-lg border bg-card/30"
                >
                  <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
                    <span className="text-caption font-semibold">
                      {stageTitle(t, stage)}
                    </span>
                    <span className="text-micro tabular-nums text-muted-foreground">
                      {rows.length}
                    </span>
                  </div>
                  <div className="divide-y divide-border/60">
                    {rows.map((artifact) => {
                      const index = sortedArtifacts.indexOf(artifact);
                      const pending =
                        artifact.source !== "agent" &&
                        artifact.source !== "manual" &&
                        !artifact.attachment_id;
                      return (
                        <div
                          key={artifact.id}
                          className="flex items-center gap-2 px-3 py-1.5"
                        >
                          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="text-caption font-medium">
                              {artifact.doc_type}
                              <span className="ml-1 text-micro text-muted-foreground">
                                {t(($) => $.common.version_badge, { version: artifact.version })}
                              </span>
                            </span>
                            <span className="block truncate font-mono text-micro text-muted-foreground">
                              {artifact.rel_path}
                            </span>
                          </span>
                          <Badge variant="outline" className="shrink-0">
                            {artifact.source}
                          </Badge>
                          {pending && projectId && (
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              className="shrink-0"
                              onClick={() => setArchiveTarget(artifact)}
                            >
                              <Archive className="size-3" />
                              {t(($) => $.deliverables.archive_action)}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="shrink-0"
                            aria-label={t(($) => $.preview.open)}
                            onClick={() => setPreviewIndex(index)}
                          >
                            <Eye />
                            {t(($) => $.preview.open)}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ③ Todo completion — the runs' todo projection, by status. */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-caption font-medium text-foreground">
            {t(($) => $.deliverables.todos_title)}
          </span>
          <span className="ml-auto text-micro tabular-nums text-muted-foreground">
            {t(($) => $.deliverables.total_label)} {overview.todos.total}
          </span>
        </div>
        {overview.todos.total === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-caption text-muted-foreground">
            {t(($) => $.deliverables.todos_empty)}
          </p>
        ) : (
          <div className="space-y-1 rounded-lg border bg-card/30 px-3 py-2">
            {Object.entries(overview.todos.by_status).map(([status, count]) => (
              <div key={status} className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-caption text-muted-foreground">
                  {status}
                </span>
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      status === "done"
                        ? "bg-primary"
                        : status === "failed"
                          ? "bg-destructive"
                          : "bg-muted-foreground/60",
                    )}
                    style={{ width: `${(count / todoMax) * 100}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-caption tabular-nums">
                  {count}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {projectId && sortedArtifacts.length > 0 && (
        <ArtifactPreviewDialog
          projectId={projectId}
          artifacts={sortedArtifacts}
          index={previewIndex ?? 0}
          onIndexChange={setPreviewIndex}
          open={previewIndex !== null}
          onOpenChange={(open) => {
            if (!open) setPreviewIndex(null);
          }}
        />
      )}
      {projectId && (
        <ArchiveActionDialog
          projectId={projectId}
          artifact={archiveTarget}
          open={Boolean(archiveTarget)}
          onOpenChange={(open) => {
            if (!open) setArchiveTarget(null);
          }}
        />
      )}
    </div>
  );
}

// ─── f8 四状态卡 + 阶段带 ──────────────────────────────────────────────
//
// Each subcomponent calls useT() itself, matching how progress-tracker and
// requirement-dynamics structure theirs.

/** Shared card shell — the prototype's `.stt-c` (title / big value / sub line)
 *  rebuilt on the existing archive tokens (bg-card/40 · caption / title-sm /
 *  micro) instead of a new visual language. `hint` is the card's static
 *  descriptor; per-state disclosures live in the body so they stay adjacent to
 *  the number they qualify. */
function StatusCard({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
        {icon}
        <span className="truncate">{title}</span>
      </div>
      {children}
      <div className="mt-1.5 text-micro leading-snug text-muted-foreground">
        {hint}
      </div>
    </div>
  );
}

/** ① 派生状态 — 「执行中 S3 · 3/5」+ 下一动作提示。
 *  The 9-rule projection is recomputed from facts on every request and never
 *  stored, so the pill cannot drift from the underlying tasks. */
function DerivedStatusCard({
  derived,
}: {
  derived: DeliverablesDerivedStatus;
}) {
  const { t } = useT("archive");
  const hasSubtasks = derived.stage_total > 0;
  const pct = hasSubtasks
    ? Math.round((derived.stage_done / derived.stage_total) * 100)
    : 0;

  return (
    <StatusCard
      icon={<Gauge className="size-3.5 shrink-0" />}
      title={t(($) => $.deliverables.card_derived)}
      hint={t(($) => $.deliverables.card_derived_hint)}
    >
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span
          className={cn(
            "rounded-full border px-2 py-px text-micro font-medium",
            DERIVED_TONE[derived.status_key] ?? NEUTRAL_PILL,
          )}
        >
          {derivedStatusLabel(t, derived)}
        </span>
        <span className="text-title-sm font-semibold tabular-nums">
          {t(($) => $.deliverables.derived_stage_label, {
            stage: derived.current_stage,
          })}
        </span>
        <span className="text-title-sm font-semibold tabular-nums text-muted-foreground">
          {hasSubtasks
            ? t(($) => $.deliverables.derived_counter, {
                done: derived.stage_done,
                total: derived.stage_total,
              })
            : t(($) => $.deliverables.derived_no_subtasks)}
        </span>
      </div>
      {hasSubtasks && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {derived.next_action_key !== "none" && (
        <div className="mt-1 text-micro text-muted-foreground">
          {t(($) => $.deliverables.derived_next_action, {
            action: nextActionLabel(t, derived.next_action_key),
          })}
        </div>
      )}
    </StatusCard>
  );
}

/** ② 调度与互斥 — ModuleLocker.
 *  `lock == null` is a real state, not missing data: the issue carries no
 *  module so the daemon skips Acquire entirely. The card says exactly that
 *  rather than painting an idle lock. When a lock *is* present the numbers are
 *  the persisted queue facts (same-module active / own waiting tasks) — the
 *  holder table itself lives in daemon process memory and is not observable
 *  here, which the body note discloses. */
function ModuleLockCard({ lock }: { lock?: DeliverablesModuleLock | null }) {
  const { t } = useT("archive");

  if (!lock) {
    return (
      <StatusCard
        icon={<ShieldQuestion className="size-3.5 shrink-0" />}
        title={t(($) => $.deliverables.card_mutex)}
        hint={t(($) => $.deliverables.card_mutex_hint)}
      >
        <div className="mt-1.5 text-title-sm font-semibold text-muted-foreground">
          {t(($) => $.deliverables.mutex_na)}
        </div>
        <div className="mt-0.5 text-micro text-muted-foreground">
          {t(($) => $.deliverables.mutex_na_hint)}
        </div>
      </StatusCard>
    );
  }

  const waiting = lock.waiting ?? [];
  return (
    <StatusCard
      icon={<Lock className="size-3.5 shrink-0" />}
      title={t(($) => $.deliverables.card_mutex)}
      hint={t(($) => $.deliverables.card_mutex_hint)}
    >
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <span className="text-title-sm font-semibold">
          {t(($) => $.deliverables.mutex_lock_on, { module: lock.module.name })}
        </span>
        <span
          className={cn(
            "rounded-full border px-1.5 py-px text-micro font-medium",
            lock.avoid_conflict
              ? "border-warning/40 bg-warning/10 text-warning"
              : NEUTRAL_PILL,
          )}
        >
          {lock.avoid_conflict
            ? t(($) => $.deliverables.mutex_exclusive)
            : t(($) => $.deliverables.mutex_shared)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 text-micro tabular-nums text-muted-foreground">
        <span>
          {t(($) => $.deliverables.mutex_same_module_active, {
            n: lock.same_module_active,
          })}
        </span>
        <span>
          {t(($) => $.deliverables.mutex_cross_waiting, {
            n: lock.waiting_count,
          })}
        </span>
      </div>
      {waiting.length === 0 ? (
        <div className="mt-0.5 text-micro text-muted-foreground">
          {t(($) => $.deliverables.mutex_no_waiting)}
        </div>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {waiting.map((entry) => (
            <li
              key={entry.task_id}
              className="truncate font-mono text-micro text-warning"
              title={entry.reason ?? undefined}
            >
              {t(($) => $.deliverables.mutex_waiting_task, {
                id: entry.task_id.slice(0, 8),
                reason:
                  entry.reason?.trim() ||
                  t(($) => $.deliverables.mutex_waiting_reason_unknown),
              })}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 border-t border-dashed pt-1 text-micro leading-snug text-muted-foreground">
        {t(($) => $.deliverables.mutex_degraded_hint)}
      </p>
    </StatusCard>
  );
}

/** ③ 角色班底 — issue_role_assignment 快照。
 *  Display names are resolved server-side (the shared `issueRolesOptions` hook
 *  only carries bare assignee UUIDs and the repo has no agent/member name
 *  lookup hook); when a name cannot be resolved — hard-deleted agent, removed
 *  member — the row falls back to a truncated id rather than inventing one. */
function RoleRosterCard({ roles }: { roles: DeliverablesRoleAssignment[] }) {
  const { t } = useT("archive");
  const list = roles ?? [];
  const agentCount = list.filter((role) => role.assignee_type === "agent").length;
  const memberCount = list.length - agentCount;

  return (
    <StatusCard
      icon={<Users className="size-3.5 shrink-0" />}
      title={t(($) => $.deliverables.card_roles)}
      hint={t(($) => $.deliverables.card_roles_hint)}
    >
      {list.length === 0 ? (
        <>
          <div className="mt-1.5 text-title-sm font-semibold text-muted-foreground">
            {t(($) => $.deliverables.roles_empty)}
          </div>
          <div className="mt-0.5 text-micro text-muted-foreground">
            {t(($) => $.deliverables.roles_empty_hint)}
          </div>
        </>
      ) : (
        <>
          <div className="mt-1.5 text-caption font-semibold tabular-nums">
            {t(($) => $.deliverables.roles_summary, {
              total: list.length,
              agents: agentCount,
              members: memberCount,
            })}
          </div>
          <ul className="mt-1 space-y-0.5">
            {list.map((role) => (
              <li
                key={`${role.role}:${role.ordinal}:${role.assignee_id}`}
                className="flex items-center gap-1.5 text-micro"
              >
                <span className="w-9 shrink-0 text-muted-foreground">
                  {roleLabel(t, role.role)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {role.assignee_name || role.assignee_id.slice(0, 8)}
                </span>
                {!role.enabled && (
                  <span className="shrink-0 rounded border border-border/60 bg-muted/50 px-1 text-micro text-muted-foreground">
                    {t(($) => $.deliverables.roles_disabled_badge)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </StatusCard>
  );
}

/** ④ 档案完整度 — stage_gate_rule（migration 460）驱动的门闭合视图。
 *  The ring + 「N/M 齐备」 headline count blocking rules only (anno②「环只算
 *  必备件」); `gate_defined: false` degrades honestly to the legacy
 *  stages-with-artifact tally instead of inventing a required-doc denominator.
 *  The red-boxed repair rows live in <GateRepairSection> below the grid (they
 *  need full width for two actions), so this card is the at-a-glance verdict:
 *  ring + ratio + the missing doc_type names + the 「S{n} 门未闭合 → 阻止进
 *  S{n+1}」 blocker (原型卡4 :1996-2000 + 完整度环 :2168-2178). */
function CompletenessCard({
  completeness,
  gates,
  blockingStage,
  archiveHref,
}: {
  completeness: DeliverablesCompleteness;
  gates: DeliverablesStageGate[];
  blockingStage: number;
  archiveHref?: string | null;
}) {
  const { t } = useT("archive");
  const gateDefined = completeness.gate_defined;
  const ready = completeness.required_ready;
  const total = completeness.required_total;
  const complete = gateDefined && total > 0 && ready >= total;
  // Missing required doc_type names across all stages, in stage order — the
  // compact 「缺 test-plan · report-r2」 cue from the prototype's card 4.
  const missingDocs = (gates ?? []).flatMap((g) => g.missing_doc_types ?? []);

  return (
    <StatusCard
      icon={<FolderArchive className="size-3.5 shrink-0" />}
      title={t(($) => $.deliverables.card_completeness)}
      hint={t(($) => $.deliverables.card_completeness_hint)}
    >
      {gateDefined ? (
        <div className="mt-1.5 flex items-center gap-2.5">
          <CompletenessRing ready={ready} total={total} complete={complete} />
          <div className="min-w-0">
            <div
              className={cn(
                "text-title-sm font-semibold tabular-nums",
                total === 0
                  ? "text-muted-foreground"
                  : complete
                    ? "text-success"
                    : "text-warning",
              )}
            >
              {t(($) => $.deliverables.completeness_gate_ready, { ready, total })}
            </div>
            {missingDocs.length > 0 ? (
              <div className="mt-0.5 truncate text-micro text-destructive">
                {t(($) => $.deliverables.completeness_missing_docs, {
                  docs: missingDocs.join(" · "),
                })}
              </div>
            ) : (
              <div className="mt-0.5 text-micro text-muted-foreground">
                {t(($) => $.deliverables.completeness_none_missing)}
              </div>
            )}
          </div>
        </div>
      ) : (
        // No ruleset resolved — honest legacy tally, no invented denominator.
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-title-sm font-semibold tabular-nums text-muted-foreground">
            {t(($) => $.deliverables.completeness_stages, {
              have: completeness.stages_with_artifact,
              total: completeness.stages_total,
            })}
          </span>
          <span className="text-micro tabular-nums text-muted-foreground">
            {t(($) => $.deliverables.completeness_artifacts, {
              n: completeness.artifact_total,
            })}
          </span>
        </div>
      )}

      {blockingStage > 0 && (
        <div className="mt-1.5 flex items-start gap-1 rounded-md border border-destructive/40 bg-destructive/5 px-1.5 py-1 text-micro text-destructive">
          <ShieldAlert className="mt-px size-3 shrink-0" />
          <span>
            {t(($) => $.deliverables.gate_blocking_warning, {
              stage: blockingStage,
              next: blockingStage + 1,
            })}
          </span>
        </div>
      )}

      <p className="mt-1 border-t border-dashed pt-1 text-micro leading-snug text-muted-foreground">
        {gateDefined
          ? t(($) => $.deliverables.completeness_gate_hint)
          : t(($) => $.deliverables.completeness_gate_undefined)}
      </p>
      {archiveHref && (
        <AppLink href={archiveHref} className="mt-1 inline-block text-micro text-primary hover:underline">
          {t(($) => $.deliverables.open_archive)} →
        </AppLink>
      )}
    </StatusCard>
  );
}

/** The prototype's f8 anno⑤ 档案完整度环: a conic-gradient donut whose filled
 *  arc is required_ready / required_total (blocking rules only — 「环只算必备
 *  件」). The fill is success-green once every required doc is present and
 *  warning-amber while any is missing; the track is the muted surface-selected
 *  token. Outer/inner diameters match the prototype (52px / 38px). The ratio is
 *  duplicated in the card headline, so the ring is decorative to AT. */
function CompletenessRing({
  ready,
  total,
  complete,
}: {
  ready: number;
  total: number;
  complete: boolean;
}) {
  const { t } = useT("archive");
  const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
  const fill = complete ? "var(--success)" : "var(--warning)";
  return (
    <div
      aria-hidden
      className="flex size-[52px] shrink-0 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(${fill} 0 ${pct}%, var(--surface-selected) ${pct}% 100%)`,
      }}
    >
      <span className="flex size-[38px] items-center justify-center rounded-full bg-surface text-caption font-semibold tabular-nums text-foreground">
        {t(($) => $.deliverables.completeness_ring_ratio, { ready, total })}
      </span>
    </div>
  );
}

/** ④′ 阶段门缺件与修复 — the prototype's f8 anno③ red-boxed missing-doc rows
 *  (:2076-2080). Each `missing_doc_type` row names the absent required document
 *  and offers two repair entry points:
 *    · 「让 agent 补写」 (active) — posts a comment @mentioning the roster's
 *      tester agent (falling back to any enabled agent). The server's comment
 *      trigger chain (util.ParseMentions → Handler.triggerTasksForComment →
 *      enqueueCommentAgentTriggers) turns that mention into an agent_task_queue
 *      row, so this reuses the existing dispatch path rather than a new one. No
 *      agent in the roster → honestly disabled with an explanatory tooltip.
 *    · 「从模板创建」 (always disabled) — writing a template file into the git
 *      archive directory is a CLI-side capability the web client does not have,
 *      so the control is disabled + tooltip instead of a fake no-op click.
 *  `empty_stage` rows (an entered stage with no archive and no specific rule gap
 *  to name) render as muted info — there is no single document to repair. */
function GateRepairSection({
  issueId,
  missing,
  roles,
}: {
  issueId: string;
  missing: DeliverablesMissingItem[];
  roles: DeliverablesRoleAssignment[];
}) {
  const { t } = useT("archive");
  const createComment = useCreateComment(issueId);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [sentKey, setSentKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  // Prefer the tester agent (原型：「让 tester agent 补写」); fall back to any
  // enabled agent in the roster. A member-only or empty roster leaves this null,
  // which honestly disables the dispatch button rather than faking a target.
  const dispatchAgent = useMemo(() => {
    const agents = (roles ?? []).filter(
      (r) => r.assignee_type === "agent" && r.enabled,
    );
    return agents.find((r) => r.role === "tester") ?? agents[0] ?? null;
  }, [roles]);

  const list = missing ?? [];
  // Only a specific missing document is repairable; empty_stage rows carry no
  // doc_type to create or dispatch against.
  const docGaps = list.filter(
    (m): m is DeliverablesMissingItem & { required_doc_type: string } =>
      m.kind === "missing_doc_type" && Boolean(m.required_doc_type),
  );
  const emptyStages = list.filter((m) => m.kind === "empty_stage");

  if (docGaps.length === 0 && emptyStages.length === 0) return null;

  const dispatch = (key: string, docType: string, stage: number) => {
    if (!dispatchAgent) return;
    const label =
      dispatchAgent.assignee_name || dispatchAgent.assignee_id.slice(0, 8);
    // Mention markup is data (an agent link), the instruction body is i18n; the
    // server parses the mention and enqueues the agent — same path the composer
    // uses, so no bespoke dispatch endpoint is introduced.
    const mention = `[@${label}](mention://agent/${dispatchAgent.assignee_id})`;
    const body = t(($) => $.deliverables.fix_agent_comment, {
      doc_type: docType,
      stage,
    });
    setPendingKey(key);
    setErrorKey(null);
    setSentKey(null);
    createComment.mutate(
      { content: `${mention} ${body}` },
      {
        onSuccess: () => {
          setPendingKey(null);
          setSentKey(key);
        },
        onError: () => {
          setPendingKey(null);
          setErrorKey(key);
        },
      },
    );
  };

  const agentLabel = dispatchAgent
    ? dispatchAgent.assignee_name || dispatchAgent.assignee_id.slice(0, 8)
    : "";

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span className="text-caption font-medium text-foreground">
          {t(($) => $.deliverables.gate_gaps_title)}
        </span>
        <span className="text-micro text-muted-foreground">
          {t(($) => $.deliverables.gate_gaps_hint)}
        </span>
      </div>
      <div className="space-y-1.5">
        {docGaps.map((item) => {
          const key = `${item.stage}:${item.required_doc_type}`;
          const isPending = pendingKey === key;
          const isSent = sentKey === key;
          const isError = errorKey === key;
          return (
            <div
              key={key}
              className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-1.5"
            >
              <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1 text-caption text-foreground">
                {t(($) => $.deliverables.gate_missing_doc, {
                  doc_type: item.required_doc_type,
                  stage: item.stage,
                })}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                {/* 从模板创建 — honestly disabled: a CLI-side capability. */}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled
                      >
                        <FilePlus2 />
                        {t(($) => $.deliverables.fix_from_template)}
                      </Button>
                    }
                  />
                  <TooltipContent side="bottom">
                    {t(($) => $.deliverables.fix_from_template_disabled)}
                  </TooltipContent>
                </Tooltip>
                {/* 让 agent 补写 — dispatch via the comment trigger chain. */}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={!dispatchAgent || isPending}
                        onClick={() =>
                          dispatch(key, item.required_doc_type, item.stage)
                        }
                      >
                        <Sparkles />
                        {isPending
                          ? t(($) => $.deliverables.fix_agent_pending)
                          : t(($) => $.deliverables.fix_agent_write)}
                      </Button>
                    }
                  />
                  <TooltipContent side="bottom">
                    {dispatchAgent
                      ? t(($) => $.deliverables.fix_agent_write_tooltip, {
                          agent: agentLabel,
                        })
                      : t(($) => $.deliverables.fix_agent_no_roster)}
                  </TooltipContent>
                </Tooltip>
              </div>
              {isSent && (
                <span className="w-full text-micro text-success">
                  {t(($) => $.deliverables.fix_agent_sent, {
                    agent: agentLabel,
                    doc_type: item.required_doc_type,
                  })}
                </span>
              )}
              {isError && (
                <span className="w-full text-micro text-destructive">
                  {t(($) => $.deliverables.fix_agent_failed)}
                </span>
              )}
            </div>
          );
        })}
        {emptyStages.map((item) => (
          <div
            key={`empty:${item.stage}`}
            className="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-caption text-muted-foreground"
          >
            <FolderArchive className="size-3.5 shrink-0" />
            <span>
              {t(($) => $.deliverables.completeness_missing_stage, {
                stage: item.stage,
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 阶段带 — the prototype's `.stage-flow`: four nodes joined by connectors,
 *  `done` green-solid with a check, `cur` brand-filled with a ring, `todo`
 *  muted. State comes from the server's stage_flow projection (derived status
 *  + per-stage task counts); this component only paints it. Artifacts with no
 *  stage are counted in a separate chip below the band. */
function StageBand({
  issueId,
  nodes,
  unassigned,
}: {
  issueId: string;
  nodes: DeliverablesStageNode[];
  unassigned: number;
}) {
  const { t } = useT("archive");
  const paths = useWorkspacePaths();
  const list = nodes ?? [];

  return (
    <>
      <div className="flex items-start overflow-x-auto pb-1">
        {list.map((node, index) => {
          const previous = index > 0 ? list[index - 1] : undefined;
          const taskText =
            node.task_total > 0
              ? t(($) => $.deliverables.derived_counter, {
                  done: node.task_done,
                  total: node.task_total,
                })
              : "";
          const artifactText =
            node.artifact_count > 0
              ? t(($) => $.deliverables.stage_artifact_count, {
                  n: node.artifact_count,
                })
              : "";
          const sub = [taskText, artifactText].filter(Boolean).join(" · ");
          return (
            <Fragment key={node.stage}>
              {previous && (
                <div
                  className={cn(
                    "mt-3.5 h-px min-w-4 flex-1",
                    previous.state === "done" ? "bg-success/45" : "bg-border",
                  )}
                />
              )}
              <AppLink
                href={paths.calendarRequirement(issueId, node.stage, "project")}
                className="flex w-24 shrink-0 flex-col items-center gap-1"
                title={t(($) => $.deliverables.open_stage_workbench)}
                data-testid="deliverables-stage-band"
              >
                <span
                  aria-label={stageStateLabel(t, node.state)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full text-caption font-semibold tabular-nums",
                    node.state === "done" && "bg-success text-white",
                    node.state === "cur" &&
                      "bg-primary text-primary-foreground ring-2 ring-primary/25",
                    node.state === "todo" && "bg-muted text-muted-foreground",
                  )}
                >
                  {node.state === "done" ? (
                    <Check className="size-3.5" />
                  ) : (
                    node.stage
                  )}
                </span>
                <span className="text-caption font-medium">
                  {stageTitle(t, node.stage)}
                </span>
                <span className="text-micro tabular-nums text-muted-foreground">
                  {sub}
                </span>
              </AppLink>
            </Fragment>
          );
        })}
      </div>
      {unassigned > 0 && (
        <div className="mt-2 flex items-center gap-1.5 text-micro text-muted-foreground">
          <Boxes className="size-3.5 shrink-0" />
          <span>{stageTitle(t, null)}</span>
          <span className="tabular-nums">
            {t(($) => $.deliverables.stage_artifact_count, { n: unassigned })}
          </span>
        </div>
      )}
    </>
  );
}
