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

/**
 * graph_context / acceptance_spec 在 DecomposeDraftTask 里是 `unknown`（api.ts:127-128，
 * PM agent 产出形状未定型）。防御式提取可识别的数组项作为 display-only 芯片：
 * nodes 取字符串或 {id|label}，cases 取字符串或 {name}；无法识别 → 空数组（不出框）。
 */
function graphNodeLabels(graph: unknown): string[] {
  if (!graph || typeof graph !== "object") return [];
  const nodes = (graph as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((n) =>
      typeof n === "string"
        ? n
        : n && typeof n === "object"
          ? String((n as Record<string, unknown>).id ?? (n as Record<string, unknown>).label ?? "")
          : "",
    )
    .filter((s) => s.length > 0);
}

function acceptanceCaseNames(spec: unknown): string[] {
  if (!spec || typeof spec !== "object") return [];
  const cases = (spec as Record<string, unknown>).cases;
  if (!Array.isArray(cases)) return [];
  return cases
    .map((c) =>
      typeof c === "string"
        ? c
        : c && typeof c === "object"
          ? String((c as Record<string, unknown>).name ?? "")
          : "",
    )
    .filter((s) => s.length > 0);
}

export function RequirementDecomposePanel({
  issue,
  moduleName,
  repoLabel,
  roster,
  plan,
  drafts,
  onDraftsChange,
  confirmDecomposition,
}: RequirementDecomposePanelProps) {
  const { t } = useT("issues");
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState<Issue[] | null>(null);

  const enabledRoster = useMemo(() => roster.filter((r) => r.enabled), [roster]);
  const kindWarning = hasUnmarkedFeaturePoint(drafts);
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
        </dl>
        {plan ? (
          <section className="rounded-md border bg-muted/30 p-2 text-sm" data-testid="decompose-plan">
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              {t(($) => $.decompose_panel.plan_title)}
            </h4>
            <p className="whitespace-pre-wrap">{plan}</p>
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
        {drafts.map((d) => (
          <DraftCard
            key={d.temp_id}
            draft={d}
            enabledRoster={enabledRoster}
            onChange={(patch) => patchDraft(d.temp_id, patch)}
          />
        ))}
        {kindWarning && (
          <p className="text-xs text-destructive" data-testid="decompose-kind-warning">
            {t(($) => $.decompose_panel.fp_kind_missing)}
          </p>
        )}
        <div>
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
}: {
  draft: DecomposeDraftTask;
  enabledRoster: RoleAssignment[];
  onChange: (patch: Partial<DecomposeDraftTask>) => void;
}) {
  const { t } = useT("issues");
  const isAcceptance = draft.stage === 4;

  const setFpKind = (index: number, kind: DecomposeFeaturePoint["kind"]) => {
    const fps = (draft.feature_points ?? []).map((fp, i) => (i === index ? { ...fp, kind } : fp));
    onChange({ feature_points: fps });
  };

  return (
    <section className="rounded-md border p-2" data-testid={`draft-card-${draft.temp_id}`}>
      <header className="mb-1 flex items-center gap-2">
        <span className="text-sm font-medium">{draft.title}</span>
        {isAcceptance && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-2xs text-amber-600">
            {t(($) => $.decompose_panel.acceptance_badge)}
          </span>
        )}
      </header>

      {!isAcceptance && (
        <div className="mb-1">
          <h5 className="text-2xs text-muted-foreground">{t(($) => $.decompose_panel.fp_title)}</h5>
          <ul className="flex flex-col gap-0.5">
            {(draft.feature_points ?? []).map((fp, i) => (
              <li key={i} className="flex items-center gap-1.5 text-xs">
                <span>{fp.title}</span>
                <button
                  type="button"
                  data-testid={`fp-kind-${draft.temp_id}-${i}`}
                  onClick={() => setFpKind(i, fp.kind === "new" ? "modify" : "new")}
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
                {(fp.code_objects ?? []).map((o) => (
                  <code key={o} className="rounded bg-muted px-1 text-2xs">{o}</code>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!isAcceptance && (
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t(($) => $.decompose_panel.asg_label)}</span>
          <select
            data-testid={`draft-asg-${draft.temp_id}`}
            className="rounded border bg-background px-1 py-0.5"
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

      {graphNodeLabels(draft.graph_context).length > 0 && (
        <div className="mt-1" data-testid={`draft-gn-${draft.temp_id}`}>
          <h5 className="text-2xs text-muted-foreground">{t(($) => $.decompose_panel.graph_title)}</h5>
          <div className="flex flex-wrap gap-1">
            {graphNodeLabels(draft.graph_context).map((n) => (
              <code key={n} className="rounded bg-muted px-1 text-2xs">{n}</code>
            ))}
          </div>
        </div>
      )}

      {acceptanceCaseNames(draft.acceptance_spec).length > 0 && (
        <div className="mt-1" data-testid={`draft-acc-${draft.temp_id}`}>
          <h5 className="text-2xs text-muted-foreground">{t(($) => $.decompose_panel.acc_title)}</h5>
          <div className="flex flex-wrap gap-1">
            {acceptanceCaseNames(draft.acceptance_spec).map((c) => (
              <code key={c} className="rounded bg-muted px-1 text-2xs">{c}</code>
            ))}
          </div>
        </div>
      )}
    </section>
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
