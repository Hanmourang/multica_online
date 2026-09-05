/**
 * RequirementPrototypePanel — prototype confirm panel (spec画面 4):
 * left column shows the prototype preview strip (numbered detail dots, ✗
 * items turn red) plus the per-detail marks list (three-state ✓/✗/○ cycling;
 * a ✗ mark requires a correction note before saving); right column shows the
 * assembled five-section prompt read-only, a red 〔本轮修正〕 preview composed
 * from ✗+note marks, the one-click generate / regenerate button (regenerate
 * carries the current marks in the POST body), the version history rows, and
 * the goal-coverage block.
 *
 * Confirm is disabled with a red hint while any ✗ mark is unresolved — the
 * server enforces the same gate (spec §9); ✗ marks only clear via a new
 * generated version.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@multica/ui/lib/utils";
import type {
  Issue,
  GeneratePrototypeRequest,
  GeneratePrototypeResponse,
  PrototypeMark,
  PrototypeVersion,
} from "@multica/core/types";
import { toast } from "sonner";
import { useT } from "../../i18n";

export interface RequirementPrototypePanelProps {
  issue: Issue;
  /** GET /issues/{id}/prototypes — version history, latest first. */
  listVersions: (issueId: string) => Promise<PrototypeVersion[]>;
  /** POST /issues/{id}/prototype/generate — registers the next version and
   *  dispatches the stage-1 prototype task. */
  generatePrototype: (
    issueId: string,
    body: GeneratePrototypeRequest,
  ) => Promise<GeneratePrototypeResponse>;
  /** POST /issues/{id}/prototypes/{version}/marks — whole-document marks write. */
  saveMarks: (issueId: string, version: number, marks: PrototypeMark[]) => Promise<PrototypeVersion>;
  /** POST /issues/{id}/prototypes/{version}/confirm — server-side gate. */
  confirmPrototype: (issueId: string, version: number) => Promise<PrototypeVersion>;
}

const VERDICT_CYCLE: Record<PrototypeMark["verdict"], PrototypeMark["verdict"]> = {
  pending: "ok",
  ok: "no",
  no: "pending",
};

/** Generate resolves once the version row exists; the version list is polled
 *  until it shows up so the history reflects the server truth. */
const POLL_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 250;

export function RequirementPrototypePanel({
  issue,
  listVersions,
  generatePrototype,
  saveMarks,
  confirmPrototype,
}: RequirementPrototypePanelProps) {
  const { t } = useT("issues");
  const [versions, setVersions] = useState<PrototypeVersion[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Edited marks, keyed by version id: before the first edit they derive
  // synchronously from the current version (no effect round-trip), so the
  // confirm gate and regenerate body are correct on first render.
  const [marksState, setMarksState] = useState<{ versionId: string; marks: PrototypeMark[] } | null>(null);

  const reload = useCallback(async () => {
    try {
      setVersions(await listVersions(issue.id));
    } catch {
      toast.error(t(($) => $.prototype_panel.load_failed));
    }
  }, [issue.id, listVersions, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = useMemo(
    () => (versions ?? []).find((v) => v.status === "pending") ?? null,
    [versions],
  );
  const confirmedVersion = useMemo(
    () => (versions ?? []).find((v) => v.status === "confirmed") ?? null,
    [versions],
  );
  const editedMarks =
    current && marksState?.versionId === current.id ? marksState.marks : (current?.marks ?? []);

  const pollUntilVersion = useCallback(
    async (target: number) => {
      for (let i = 0; i < POLL_ATTEMPTS; i++) {
        try {
          const list = await listVersions(issue.id);
          if (list.some((v) => v.version === target)) {
            setVersions(list);
            return;
          }
        } catch {
          // keep polling — transient list failure must not lose the new version
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      void reload();
    },
    [issue.id, listVersions, reload],
  );

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const body: GeneratePrototypeRequest = {};
      // Regenerate: carry the current marks so the server can compose the
      // 〔本轮修正〕 prompt section from ✗+note items.
      if (current) body.marks = editedMarks;
      const resp = await generatePrototype(issue.id, body);
      await pollUntilVersion(resp.version.version);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.prototype_panel.generate_failed));
    } finally {
      setGenerating(false);
    }
  };

  const handleConfirm = async () => {
    if (!current) return;
    setConfirming(true);
    try {
      const updated = await confirmPrototype(issue.id, current.version);
      setVersions((vs) => (vs ?? []).map((v) => (v.version === updated.version ? updated : v)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.prototype_panel.confirm_failed));
    } finally {
      setConfirming(false);
    }
  };

  const handleSaved = (updated: PrototypeVersion) => {
    setVersions((vs) => (vs ?? []).map((v) => (v.version === updated.version ? updated : v)));
  };

  const corrections = editedMarks.filter(
    (m) => m.verdict === "no" && m.note.trim() !== "",
  );
  const hasUnresolvedNo = editedMarks.some((m) => m.verdict === "no");

  return (
    <div
      className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4"
      data-testid="prototype-panel"
    >
      {/* ---- Left: preview strip + per-detail marks ---- */}
      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="text-sm font-medium">{t(($) => $.prototype_panel.title)}</h3>
        <section className="rounded-md border" data-testid="proto-preview">
          <header className="flex items-center gap-1.5 border-b px-2 py-1.5">
            <span className="size-2 rounded-full bg-muted-foreground/40" />
            <span className="size-2 rounded-full bg-muted-foreground/40" />
            <span className="ml-1 truncate text-xs text-muted-foreground">
              {current ? current.html_path : t(($) => $.prototype_panel.preview_title)}
            </span>
          </header>
          <div className="flex flex-wrap items-center gap-1.5 p-2">
            {!current && (
              <p className="text-xs text-muted-foreground" data-testid="proto-preview-empty">
                {t(($) => $.prototype_panel.preview_empty)}
              </p>
            )}
            {current?.marks.map((m, i) => (
              <span
                key={m.detail_id}
                data-testid={`proto-preview-dot-${m.detail_id}`}
                className={cn(
                  "inline-flex size-5 items-center justify-center rounded-full text-2xs",
                  m.verdict === "ok" && "bg-emerald-500/15 text-emerald-600",
                  m.verdict === "no" && "bg-destructive/15 text-destructive",
                  m.verdict === "pending" && "bg-secondary text-muted-foreground",
                )}
              >
                {i + 1}
              </span>
            ))}
          </div>
        </section>

        {current ? (
          <MarksEditor
            issueId={issue.id}
            version={current}
            marks={editedMarks}
            onMarksChange={(marks) => setMarksState({ versionId: current.id, marks })}
            saveMarks={saveMarks}
            onSaved={handleSaved}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {t(($) => $.prototype_panel.marks_empty)}
          </p>
        )}
      </div>

      {/* ---- Right: prompt + generate + versions + goal coverage ---- */}
      <div className="flex min-w-0 flex-col gap-3">
        <section className="rounded-md border bg-muted/30 p-2" data-testid="proto-prompt">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            {t(($) => $.prototype_panel.prompt_title)}
          </h4>
          <p className="whitespace-pre-wrap text-xs">
            {current ? current.prompt : t(($) => $.prototype_panel.prompt_empty)}
          </p>
        </section>

        {corrections.length > 0 && (
          <section
            className="rounded-md border border-destructive/40 bg-destructive/10 p-2"
            data-testid="proto-corrections"
          >
            <h4 className="mb-1 text-xs font-medium text-destructive">
              {t(($) => $.prototype_panel.corrections_title)}
            </h4>
            <ul className="flex flex-col gap-0.5 text-xs">
              {corrections.map((m) => (
                <li key={m.detail_id}>{`${m.detail_id}：${m.note}`}</li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex items-center gap-2">
          {(!current || confirmedVersion === null || versions?.length === 0) && (
            <button
              type="button"
              data-testid="proto-generate"
              disabled={generating || confirmedVersion !== null}
              onClick={handleGenerate}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            >
              {generating
                ? t(($) => $.prototype_panel.generating)
                : current
                  ? t(($) => $.prototype_panel.regenerate)
                  : t(($) => $.prototype_panel.generate)}
            </button>
          )}
          {confirmedVersion && (
            <span
              className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-2xs text-emerald-600"
              data-testid="proto-confirmed-badge"
            >
              {t(($) => $.prototype_panel.confirmed_badge)}{` · v${confirmedVersion.version}`}
            </span>
          )}
        </div>

        {current && (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              data-testid="proto-confirm"
              disabled={hasUnresolvedNo || confirming}
              onClick={handleConfirm}
              className="self-start rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            >
              {confirming
                ? t(($) => $.prototype_panel.confirming)
                : t(($) => $.prototype_panel.confirm)}
            </button>
            {hasUnresolvedNo && (
              <p className="text-xs text-destructive" data-testid="proto-confirm-blocked">
                {t(($) => $.prototype_panel.confirm_blocked)}
              </p>
            )}
          </div>
        )}

        <section data-testid="proto-versions">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            {t(($) => $.prototype_panel.versions_title)}
          </h4>
          <ul className="flex flex-col">
            {(versions ?? []).map((v) => (
              <li
                key={v.id}
                data-testid={`proto-ver-${v.version}`}
                className="flex items-center gap-2 py-0.5 text-xs"
              >
                <span className="font-mono font-semibold">{`v${v.version}`}</span>
                <span className="text-muted-foreground">
                  {`${v.marks.length} · ${v.marks.filter((m) => m.verdict === "no").length} ✗`}
                </span>
                <span className="flex-1" />
                {v.status === "pending" && (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-2xs text-primary">
                    {t(($) => $.prototype_panel.version_current)}
                  </span>
                )}
                {v.status === "confirmed" && (
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-2xs text-emerald-600">
                    {t(($) => $.prototype_panel.confirmed_badge)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>

        {issue.goal && (
          <section className="text-xs text-muted-foreground" data-testid="proto-goal">
            <h4 className="mb-1 font-medium">{t(($) => $.prototype_panel.goal_title)}</h4>
            <p className="whitespace-pre-wrap">{issue.goal}</p>
            <p className="mt-0.5">{t(($) => $.prototype_panel.goal_hint)}</p>
          </section>
        )}
      </div>
    </div>
  );
}

/** Marks list editor for the current pending version (controlled). */
function MarksEditor({
  issueId,
  version,
  marks,
  onMarksChange,
  saveMarks,
  onSaved,
}: {
  issueId: string;
  version: PrototypeVersion;
  marks: PrototypeMark[];
  onMarksChange: (marks: PrototypeMark[]) => void;
  saveMarks: (issueId: string, version: number, marks: PrototypeMark[]) => Promise<PrototypeVersion>;
  onSaved: (updated: PrototypeVersion) => void;
}) {
  const { t } = useT("issues");
  const [saving, setSaving] = useState(false);

  const noNeedsNote = marks.some((m) => m.verdict === "no" && m.note.trim() === "");

  const cycleVerdict = (detailId: string) => {
    onMarksChange(
      marks.map((m) =>
        m.detail_id === detailId ? { ...m, verdict: VERDICT_CYCLE[m.verdict] } : m,
      ),
    );
  };

  const setNote = (detailId: string, note: string) => {
    onMarksChange(marks.map((m) => (m.detail_id === detailId ? { ...m, note } : m)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await saveMarks(issueId, version.version, marks);
      onSaved(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.prototype_panel.save_failed));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-1.5" data-testid="proto-marks">
      <h4 className="text-xs font-medium text-muted-foreground">
        {t(($) => $.prototype_panel.marks_title)}
      </h4>
      {marks.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t(($) => $.prototype_panel.marks_empty)}
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {marks.map((m) => (
          <li key={m.detail_id} className="flex flex-col gap-1" data-testid={`proto-mark-row-${m.detail_id}`}>
            <div className="flex items-center gap-2 text-sm">
              <button
                type="button"
                data-testid={`proto-mark-${m.detail_id}`}
                onClick={() => cycleVerdict(m.detail_id)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-2xs",
                  m.verdict === "ok" && "bg-emerald-500/15 text-emerald-600",
                  m.verdict === "no" && "bg-destructive/15 text-destructive",
                  m.verdict === "pending" && "bg-secondary text-muted-foreground",
                )}
              >
                {m.verdict === "ok"
                  ? t(($) => $.prototype_panel.mark_ok)
                  : m.verdict === "no"
                    ? t(($) => $.prototype_panel.mark_no)
                    : t(($) => $.prototype_panel.mark_pending)}
              </button>
              <span className="min-w-0 flex-1 truncate text-xs">{m.detail_id}</span>
            </div>
            {m.verdict === "no" && (
              <textarea
                data-testid={`proto-note-${m.detail_id}`}
                value={m.note}
                onChange={(e) => setNote(m.detail_id, e.target.value)}
                placeholder={t(($) => $.prototype_panel.note_placeholder)}
                rows={2}
                className="w-full rounded border bg-background px-1.5 py-1 text-xs"
              />
            )}
          </li>
        ))}
      </ul>
      {noNeedsNote && (
        <p className="text-xs text-destructive" data-testid="proto-marks-hint">
          {t(($) => $.prototype_panel.no_needs_note)}
        </p>
      )}
      <div>
        <button
          type="button"
          data-testid="proto-marks-save"
          disabled={noNeedsNote || saving}
          onClick={handleSave}
          className="rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
        >
          {saving
            ? t(($) => $.prototype_panel.saving_marks)
            : t(($) => $.prototype_panel.save_marks)}
        </button>
      </div>
    </section>
  );
}
