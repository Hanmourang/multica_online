/**
 * RequirementDecomposePanel — decomposition confirm panel (spec画面 5):
 * left column holds the requirement basics (identifier / module / repo /
 * minute-granularity window / roster chips / goal) plus the PM plan; the
 * right column lists the draft cards — feature-point table with new/modify
 * tags, graph + acceptance summaries, assignee fine-tuning (enabled roster
 * members only) and dependency chips.
 *
 * Confirm is disabled with a red hint while any exec draft has a feature
 * point without a kind; on success the panel swaps to the materialized
 * children returned by the confirm API.
 */
import { useMemo, useState } from "react";
import { cn } from "@multica/ui/lib/utils";
import type {
  Issue,
  RoleAssignment,
  DecomposeDraftTask,
  DecomposeFeaturePoint,
} from "@multica/core/types";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { ActorAvatar } from "../../common/actor-avatar";
import { useActorName } from "@multica/core/workspace/hooks";
import { isFallbackDraftId } from "./requirement-decompose-fallback";
import {
  readAcceptanceSpec,
  readGraphContext,
  splitPlanSections,
  titleMatchesGoals,
} from "./requirement-plan";

interface RequirementDecomposePanelProps {
  issue: Issue;
  moduleName?: string | null;
  repoLabel?: string | null;
  roster: RoleAssignment[];
  plan?: string | null;
  drafts: DecomposeDraftTask[];
  onDraftsChange: (next: DecomposeDraftTask[]) => void;
  /** Calls POST /issues/{id}/decomposition/confirm; resolves with the
   *  materialized children. Injected so tests can capture the payload. */
  confirmDecomposition: (
    issueId: string,
    drafts: DecomposeDraftTask[],
  ) => Promise<Issue[]>;
  /** 写 @PM 重跑 impact-analysis 评论；不连 GitNexus。 */
  requeryGraph?: () => Promise<void>;
}

/** Minute-granularity UTC timestamp (same convention as the calendar view). */
function formatMinuteUTC(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Every exec (stage 3) feature point must be tagged new/modify (spec §8). */
function hasUnmarkedFeaturePoint(drafts: DecomposeDraftTask[]): boolean {
  return drafts.some(
    (d) =>
      d.stage === 3 &&
      (d.feature_points ?? []).some((fp) => fp.kind !== "new" && fp.kind !== "modify"),
  );
}

function hasEmptyFeatureTitle(drafts: DecomposeDraftTask[]): boolean {
  return drafts.some(
    (d) =>
      d.stage === 3 &&
      (d.feature_points ?? []).some((fp) => !fp.title.trim()),
  );
}

function hasEmptyDraftTitle(drafts: DecomposeDraftTask[]): boolean {
  return drafts.some((d) => !d.title.trim());
}

/**
 * graph_context / acceptance_spec 在 DecomposeDraftTask 里是 `unknown`（api.ts:127-128，
 * PM agent 产出形状未定型）。防御式提取可识别的数组项作为 display-only 芯片：
 * nodes 取字符串或 {id|label}，cases 取字符串或 {name}；无法识别 → 空数组。
 */

export function RequirementDecomposePanel({
  issue,
  moduleName,
  repoLabel,
  roster,
  plan,
  drafts,
  onDraftsChange,
  confirmDecomposition,
  requeryGraph,
}: RequirementDecomposePanelProps) {
  const { t } = useT("issues");
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState<Issue[] | null>(null);
  const [requerying, setRequerying] = useState(false);

  const enabledRoster = useMemo(() => roster.filter((r) => r.enabled), [roster]);
  const planSections = useMemo(() => splitPlanSections(plan), [plan]);
  const kindWarning =
    hasUnmarkedFeaturePoint(drafts) ||
    hasEmptyFeatureTitle(drafts) ||
    hasEmptyDraftTitle(drafts);
  const windowText = useMemo(() => {
    const start = formatMinuteUTC(issue.start_at ?? issue.start_date);
    const end = formatMinuteUTC(issue.due_date) ?? issue.due_date;
    if (start && end) return `${start} → ${end}`;
    return start ?? end ?? "—";
  }, [issue.start_at, issue.start_date, issue.due_date]);

  const patchDraft = (tempId: string, patch: Partial<DecomposeDraftTask>) => {
    onDraftsChange(drafts.map((d) => (d.temp_id === tempId ? { ...d, ...patch } : d)));
  };

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      const issues = await confirmDecomposition(issue.id, drafts);
      setConfirmed(issues);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.decompose_panel.confirm_failed));
    } finally {
      setConfirming(false);
    }
  };

  if (confirmed) {
    return (
      <div className="flex flex-col gap-2" data-testid="decompose-confirmed">
        <h3 className="text-sm font-medium">{t(($) => $.decompose_panel.confirmed_title)}</h3>
        <ul className="flex flex-col gap-1">
          {confirmed.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{c.identifier}</span>
              <span>{c.title}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4" data-testid="decompose-panel">
      {/* ---- Left: requirement basics + plan ---- */}
      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="text-sm font-medium">{t(($) => $.decompose_panel.title)}</h3>
        <dl className="flex flex-col gap-1.5 text-sm" data-testid="decompose-kv">
          <KvRow label={t(($) => $.decompose_panel.kv_identifier)} value={issue.identifier} />
          <KvRow label={t(($) => $.decompose_panel.kv_module)} value={moduleName ?? "—"} />
          <KvRow label={t(($) => $.decompose_panel.kv_repo)} value={repoLabel ?? "—"} />
          <KvRow label={t(($) => $.decompose_panel.kv_window)} value={windowText} />
          <div className="flex items-start gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">{t(($) => $.decompose_panel.kv_roster)}</dt>
            <dd className="flex flex-wrap gap-1" data-testid="decompose-kv-roster">
              {enabledRoster.map((r) => (
                <RosterChip key={r.id} entry={r} />
              ))}
            </dd>
          </div>
          <KvRow label={t(($) => $.decompose_panel.kv_goal)} value={issue.goal ?? "—"} />
          <KvRow
            label={t(($) => $.decompose_panel.kv_mode)}
            value={
              issue.decompose_mode === "auto"
                ? t(($) => $.decompose_panel.mode_auto)
                : issue.decompose_mode === "manual"
                  ? t(($) => $.decompose_panel.mode_manual)
                  : t(($) => $.decompose_panel.mode_confirm)
            }
          />
        </dl>
        {plan ? (
          <section className="rounded-md border bg-muted/30 p-2 text-sm" data-testid="decompose-plan">
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              {t(($) => $.decompose_panel.plan_title)}
            </h4>
            {planSections.split ? (
              <div className="flex flex-col gap-2">
                {planSections.goals && (
                  <PlanChunk
                    testId="decompose-plan-goals"
                    label={t(($) => $.decompose_panel.plan_goals)}
                    body={planSections.goals}
                  />
                )}
                {planSections.phases && (
                  <PlanChunk
                    testId="decompose-plan-phases"
                    label={t(($) => $.decompose_panel.plan_phases)}
                    body={planSections.phases}
                  />
                )}
                {planSections.risks && (
                  <PlanChunk
                    testId="decompose-plan-risks"
                    label={t(($) => $.decompose_panel.plan_risks)}
                    body={planSections.risks}
                  />
                )}
              </div>
            ) : (
              <p className="whitespace-pre-wrap">{plan}</p>
            )}
          </section>
        ) : null}
        <section className="text-xs text-muted-foreground" data-testid="decompose-deps">
          <h4 className="mb-1 font-medium">{t(($) => $.decompose_panel.deps_title)}</h4>
          <div className="flex flex-wrap gap-1">
            {drafts.map((d) =>
              (d.depends_on ?? []).map((dep) => (
                <span key={`${d.temp_id}-${dep}`} className="rounded-full bg-secondary px-1.5 py-0.5">
                  {dep} → {d.temp_id}
                </span>
              )),
            )}
          </div>
        </section>
      </div>

      {/* ---- Right: draft cards ---- */}
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="text-sm font-medium">{t(($) => $.decompose_panel.drafts_title)}</h4>
        {drafts.some((d) => isFallbackDraftId(d.temp_id)) && (
          <p
            data-testid="decompose-fallback-hint"
            className="text-xs text-amber-700"
          >
            {t(($) => $.decompose_panel.fallback_hint)}
          </p>
        )}
        {drafts.length === 0 && (
          <p
            data-testid="decompose-drafts-empty"
            className="rounded-md border border-dashed px-2 py-2 text-xs text-muted-foreground"
          >
            {t(($) => $.decompose_panel.drafts_empty)}
          </p>
        )}
        {drafts.map((d, i) => (
          <DraftCard
            key={d.temp_id}
            draft={d}
            enabledRoster={enabledRoster}
            defaultOpen={i === 0 || d.stage === 4}
            goalText={planSections.goals ?? plan ?? null}
            onChange={(patch) => patchDraft(d.temp_id, patch)}
          />
        ))}
        <button
          type="button"
          data-testid="decompose-add-draft"
          onClick={() => {
            const execCount = drafts.filter((d) => d.stage === 3).length;
            const exec: DecomposeDraftTask = {
              temp_id: `local-${Date.now()}`,
              title: issue.goal?.trim() || `${issue.title} · ${execCount + 1}`,
              stage: 3,
              feature_points: [
                {
                  title: issue.goal?.trim() || issue.title,
                  kind: "modify",
                },
              ],
            };
            const withoutAccept = drafts.filter((d) => d.stage !== 4);
            const accept =
              drafts.find((d) => d.stage === 4) ??
              ({
                temp_id: "local-accept",
                title: `验收：${issue.title}`,
                stage: 4,
              } as DecomposeDraftTask);
            const next = [...withoutAccept, exec];
            onDraftsChange([
              ...next,
              {
                ...accept,
                depends_on: next
                  .filter((d) => d.stage === 3)
                  .map((d) => d.temp_id),
              },
            ]);
          }}
          className="self-start rounded-md border px-2 py-1 text-xs"
        >
          {t(($) => $.decompose_panel.add_draft)}
        </button>
        {kindWarning && (
          <p className="text-xs text-destructive" data-testid="decompose-kind-warning">
            {hasEmptyDraftTitle(drafts) || hasEmptyFeatureTitle(drafts)
              ? t(($) => $.decompose_panel.fp_title_missing)
              : t(($) => $.decompose_panel.fp_kind_missing)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {requeryGraph && (
            <button
              type="button"
              data-testid="decompose-requery"
              disabled={requerying}
              onClick={() => {
                setRequerying(true);
                void requeryGraph()
                  .then(() => toast.success(t(($) => $.decompose_panel.requery_ok)))
                  .catch(() => toast.error(t(($) => $.decompose_panel.requery_failed)))
                  .finally(() => setRequerying(false));
              }}
              className="rounded-md border px-2 py-1 text-xs"
            >
              {t(($) => $.decompose_panel.requery)}
            </button>
          )}
          {requeryGraph && (
            <span className="text-2xs text-muted-foreground">
              {t(($) => $.decompose_panel.requery_hint)}
            </span>
          )}
          <button
            type="button"
            data-testid="decompose-confirm"
            disabled={kindWarning || confirming || drafts.length === 0}
            onClick={handleConfirm}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {confirming ? t(($) => $.decompose_panel.confirming) : t(($) => $.decompose_panel.confirm)}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanChunk({
  testId,
  label,
  body,
}: {
  testId: string;
  label: string;
  body: string;
}) {
  return (
    <div data-testid={testId}>
      <h5 className="text-2xs font-medium text-muted-foreground">{label}</h5>
      <p className="whitespace-pre-wrap">{body}</p>
    </div>
  );
}

function KvRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  );
}

function RosterChip({ entry }: { entry: RoleAssignment }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-1.5 py-0.5 text-2xs">
      <ActorAvatar actorType={entry.assignee_type} actorId={entry.assignee_id} size="sm" profileLink={false} />
      <AssigneeName entry={entry} />
    </span>
  );
}

function AssigneeName({ entry }: { entry: RoleAssignment }) {
  const { getActorName } = useActorName();
  return <span>{getActorName(entry.assignee_type, entry.assignee_id)}</span>;
}

function DraftCard({
  draft,
  enabledRoster,
  onChange,
  defaultOpen,
  goalText,
}: {
  draft: DecomposeDraftTask;
  enabledRoster: RoleAssignment[];
  onChange: (patch: Partial<DecomposeDraftTask>) => void;
  defaultOpen: boolean;
  goalText: string | null;
}) {
  const { t } = useT("issues");
  const isAcceptance = draft.stage === 4;
  const [initialAsg] = useState(`${draft.assignee_type ?? ""}:${draft.assignee_id ?? ""}`);
  const asgChanged = `${draft.assignee_type ?? ""}:${draft.assignee_id ?? ""}` !== initialAsg;
  const offPlan = draft.stage === 3 && !titleMatchesGoals(draft.title, goalText);
  const graph = readGraphContext(draft.graph_context);
  const acc = readAcceptanceSpec(draft.acceptance_spec);
  const hasGraph = graph.nodes.length + graph.code_objects.length + graph.dependencies.length + graph.impacts.length > 0;
  const hasAcc = Boolean(acc.path || acc.version || acc.cases.length || acc.assertions.length);

  const patchFp = (index: number, patch: Partial<DecomposeFeaturePoint>) => {
    const fps = (draft.feature_points ?? []).map((fp, i) => (i === index ? { ...fp, ...patch } : fp));
    onChange({ feature_points: fps });
  };

  return (
    <details
      className="rounded-md border p-2"
      data-testid={`draft-card-${draft.temp_id}`}
      defaultOpen={defaultOpen}
    >
      <summary className="mb-1 flex cursor-pointer items-center gap-2">
        <span className="text-sm font-medium">{draft.title || "—"}</span>
        {isFallbackDraftId(draft.temp_id) && (
          <span
            data-testid={`draft-fallback-${draft.temp_id}`}
            className="rounded bg-amber-500/15 px-1 text-2xs text-amber-700"
          >
            {t(($) => $.decompose_panel.fallback_badge)}
          </span>
        )}
        {offPlan && (
          <span
            data-testid={`draft-mismatch-${draft.temp_id}`}
            className="rounded bg-amber-500/15 px-1 text-2xs text-amber-700"
          >
            {t(($) => $.decompose_panel.plan_mismatch)}
          </span>
        )}
        {isAcceptance && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-2xs text-amber-600">
            {t(($) => $.decompose_panel.acceptance_badge)}
          </span>
        )}
      </summary>

      <label className="mb-1 flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">{t(($) => $.decompose_panel.draft_title)}</span>
        <input
          data-testid={`draft-title-${draft.temp_id}`}
          className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-sm"
          value={draft.title}
          placeholder={t(($) => $.decompose_panel.draft_title_placeholder)}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange({ title: e.target.value })}
        />
      </label>

      {!isAcceptance && (
        <div className="mb-1">
          <h5 className="text-2xs text-muted-foreground">{t(($) => $.decompose_panel.fp_title)}</h5>
          <ul className="flex flex-col gap-0.5">
            {(draft.feature_points ?? []).map((fp, i) => (
              <li key={i} className="flex flex-col gap-0.5 text-xs">
                <div className="flex items-center gap-1.5">
                  <input
                    data-testid={`fp-title-${draft.temp_id}-${i}`}
                    className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5"
                    value={fp.title}
                    onChange={(e) => patchFp(i, { title: e.target.value })}
                  />
                  <button
                    type="button"
                    data-testid={`fp-kind-${draft.temp_id}-${i}`}
                    onClick={() =>
                      patchFp(i, { kind: fp.kind === "new" ? "modify" : "new" })
                    }
                    className={cn(
                      "rounded px-1 py-0 text-2xs",
                      fp.kind === "new" && "bg-emerald-500/15 text-emerald-600",
                      fp.kind === "modify" && "bg-blue-500/15 text-blue-600",
                      !fp.kind && "bg-destructive/15 text-destructive",
                    )}
                  >
                    {fp.kind === "new"
                      ? t(($) => $.decompose_panel.fp_kind_new)
                      : fp.kind === "modify"
                        ? t(($) => $.decompose_panel.fp_kind_modify)
                        : "?"}
                  </button>
                  <button
                    type="button"
                    data-testid={`fp-remove-${draft.temp_id}-${i}`}
                    onClick={() =>
                      onChange({
                        feature_points: (draft.feature_points ?? []).filter((_, idx) => idx !== i),
                      })
                    }
                    className="text-2xs text-muted-foreground"
                  >
                    {t(($) => $.decompose_panel.fp_remove)}
                  </button>
                </div>
                <input
                  data-testid={`fp-detail-${draft.temp_id}-${i}`}
                  className="rounded border bg-background px-1 py-0.5 text-2xs"
                  placeholder={t(($) => $.decompose_panel.fp_detail_placeholder)}
                  value={fp.detail ?? ""}
                  onChange={(e) => patchFp(i, { detail: e.target.value })}
                />
                {(fp.code_objects ?? []).map((o) => (
                  <code key={o} className="rounded bg-muted px-1 text-2xs">{o}</code>
                ))}
              </li>
            ))}
          </ul>
          <button
            type="button"
            data-testid={`fp-add-${draft.temp_id}`}
            onClick={() =>
              onChange({
                feature_points: [
                  ...(draft.feature_points ?? []),
                  { title: "", kind: "" },
                ],
              })
            }
            className="mt-1 text-2xs text-primary"
          >
            {t(($) => $.decompose_panel.fp_add)}
          </button>
        </div>
      )}

      {!isAcceptance && (
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t(($) => $.decompose_panel.asg_label)}</span>
          <select
            data-testid={`draft-asg-${draft.temp_id}`}
            className={cn(
              "rounded border bg-background px-1 py-0.5",
              asgChanged && "asg-edit ring-1 ring-amber-500",
            )}
            value={`${draft.assignee_type}:${draft.assignee_id}`}
            onChange={(e) => {
              const [assignee_type, assignee_id] = e.target.value.split(":");
              onChange({ assignee_type: assignee_type as "member" | "agent", assignee_id });
            }}
          >
            {enabledRoster.map((r) => (
              <RosterOption key={r.id} entry={r} />
            ))}
          </select>
        </label>
      )}

      <div className="mt-1" data-testid={`draft-gn-${draft.temp_id}`}>
        <h5 className="text-2xs text-muted-foreground">{t(($) => $.decompose_panel.graph_title)}</h5>
        {hasGraph ? (
          <div className="flex flex-col gap-0.5 text-2xs">
            <GraphRow label={t(($) => $.decompose_panel.graph_nodes)} items={graph.nodes} />
            <GraphRow label={t(($) => $.decompose_panel.graph_objects)} items={graph.code_objects} />
            <GraphRow label={t(($) => $.decompose_panel.graph_deps)} items={graph.dependencies} />
            <GraphRow label={t(($) => $.decompose_panel.graph_impacts)} items={graph.impacts} />
          </div>
        ) : (
          <p className="text-2xs text-muted-foreground">{t(($) => $.decompose_panel.archive_unready)}</p>
        )}
      </div>

      <div className="mt-1" data-testid={`draft-acc-${draft.temp_id}`}>
        <h5 className="text-2xs text-muted-foreground">{t(($) => $.decompose_panel.acc_title)}</h5>
        {hasAcc ? (
          <div className="flex flex-col gap-0.5 text-2xs">
            {acc.path && <p>{t(($) => $.decompose_panel.acc_path)} {acc.path}</p>}
            {acc.version && <p>{t(($) => $.decompose_panel.acc_version)} {acc.version}</p>}
            {acc.assertions.length > 0 && (
              <p>{t(($) => $.decompose_panel.acc_assertions)} {acc.assertions.join(" · ")}</p>
            )}
            <div className="flex flex-wrap gap-1">
              {acc.cases.map((c) => (
                <code key={c} className="rounded bg-muted px-1">{c}</code>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-2xs text-muted-foreground">{t(($) => $.decompose_panel.archive_unready)}</p>
        )}
      </div>
    </details>
  );
}

function GraphRow({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <p>
      {label}{" "}
      {items.map((n) => (
        <code key={n} className="mr-1 rounded bg-muted px-1">{n}</code>
      ))}
    </p>
  );
}

/** Option label needs the actor-name hook; keep it a component. */
function RosterOption({ entry }: { entry: RoleAssignment }) {
  const { getActorName } = useActorName();
  return (
    <option value={`${entry.assignee_type}:${entry.assignee_id}`}>
      {getActorName(entry.assignee_type, entry.assignee_id)}
    </option>
  );
}
