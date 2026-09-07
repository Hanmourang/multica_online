/**
 * RequirementSchedulePanel — 执行阶段面板（spec 2026-09-04-requirement-calendar
 * 画面 6）：触发倒计时 / 已触发时刻、stage3 子任务进度、互斥等待 banner
 * （requirement_status==="等待模块释放"，对齐 WS3 组锁）、手动触发按钮
 * （POST /issues/{id}/trigger，与 30s sweep 共用触发服务；409 → toast 原因）。
 *
 * 触发回调由挂载点（flow-section）注入，与 confirmDecomposition 同约定，便于测试
 * 捕获调用。所有数据取自 Issue 既有投影字段，面板本身不发查询。
 */
import { useState } from "react";
import type { Issue, TriggerRequirementResponse } from "@multica/core/types";
import { toast } from "sonner";
import { useWorkspacePaths } from "@multica/core/paths";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { findModuleHolder } from "../../calendar/calendar-helpers";

/** Minute-granularity UTC timestamp（与 decompose-panel / calendar 同一约定）。 */
function formatMinuteUTC(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

interface RequirementSchedulePanelProps {
  issue: Issue;
  /** 挂载点已查询的子任务列表；面板只取 stage3 展示执行进度。 */
  childIssues: Issue[];
  /** 同工作区顶层需求，用于互斥窗口 / held-by（与色块同一函数）。 */
  peerIssues?: Issue[];
  /** Calls POST /issues/{id}/trigger. Injected so tests can capture the call. */
  triggerRequirement: (issueId: string) => Promise<TriggerRequirementResponse>;
}

function specPresent(child: Issue): boolean {
  const spec = child.acceptance_spec;
  if (!spec) return false;
  if (typeof spec === "string") return spec.trim().length > 2 && spec.trim() !== "{}";
  if (typeof spec === "object") return Object.keys(spec as object).length > 0;
  return false;
}

function hasBlockedByCycle(children: Issue[]): boolean {
  const ids = new Set(children.map((c) => c.id));
  const edges = new Map<string, string[]>();
  for (const child of children) {
    edges.set(
      child.id,
      (child.blocked_by ?? []).filter((id) => ids.has(id)),
    );
  }
  const seen = new Set<string>();
  const stack = new Set<string>();
  const visit = (id: string): boolean => {
    if (stack.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    stack.add(id);
    for (const next of edges.get(id) ?? []) {
      if (visit(next)) return true;
    }
    stack.delete(id);
    return false;
  };
  return [...ids].some(visit);
}

export function RequirementSchedulePanel({
  issue,
  childIssues,
  peerIssues = [],
  triggerRequirement,
}: RequirementSchedulePanelProps) {
  const { t } = useT("issues");
  const paths = useWorkspacePaths();
  const [triggering, setTriggering] = useState(false);
  const [failReason, setFailReason] = useState<string | null>(null);
  const triggered = issue.triggered_at != null;
  const waitingLock = issue.requirement_status === "等待模块释放";
  const stage3 = childIssues.filter((c) => c.stage === 3);
  const holder = findModuleHolder(peerIssues, issue);
  const checks = {
    confirmed: issue.decomposition_confirmed_at != null,
    acyclic: !hasBlockedByCycle(childIssues),
    acceptance: stage3.some(specPresent),
    mutex: !holder,
  };

  const onTrigger = async () => {
    setTriggering(true);
    try {
      await triggerRequirement(issue.id);
      setFailReason(null);
      toast.success(t(($) => $.schedule_panel.trigger_ok));
    } catch (e) {
      // 服务端 409 带 reason（decomposition_not_confirmed / dependency_cycle /
      // acceptance_spec_missing / module_window_busy）；this.fetch 抛 ApiError(message=reason)。
      const message = e instanceof Error ? e.message : t(($) => $.schedule_panel.trigger_failed);
      setFailReason(message);
      toast.error(message);
    } finally {
      setTriggering(false);
    }
  };

  const rowTone = (ok: boolean, reason: string) =>
    failReason?.includes(reason)
      ? "text-destructive"
      : ok
        ? "text-emerald-600"
        : "text-muted-foreground";

  return (
    <section className="rounded-md border bg-card p-3" data-testid="schedule-panel">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t(($) => $.schedule_panel.title)}</h4>
        {triggered ? (
          <span
            className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-2xs text-emerald-600"
            data-testid="schedule-triggered"
          >
            {t(($) => $.schedule_panel.already_triggered)}
          </span>
        ) : (
          <button
            type="button"
            data-testid="schedule-trigger"
            disabled={triggering}
            onClick={() => void onTrigger()}
            className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
          >
            {triggering
              ? t(($) => $.schedule_panel.triggering)
              : t(($) => $.schedule_panel.trigger)}
          </button>
        )}
      </header>

      {/* 倒计时 / 触发时刻：start_at 是分钟精度 t0（design §5）。 */}
      <div className="mb-2 text-xs text-muted-foreground" data-testid="schedule-countdown">
        {triggered
          ? `${t(($) => $.schedule_panel.started_at)} ${formatMinuteUTC(issue.triggered_at) ?? "—"}`
          : `${t(($) => $.schedule_panel.countdown_label)} ${formatMinuteUTC(issue.start_at) ?? "—"}`}
      </div>

      <ul className="mb-2 flex flex-col gap-0.5 text-xs" data-testid="schedule-preflight">
        <li className={rowTone(checks.confirmed, "decomposition_not_confirmed")} data-testid="preflight-confirmed">
          {t(($) => $.schedule_panel.preflight_confirmed)} · {checks.confirmed ? t(($) => $.schedule_panel.preflight_ok) : t(($) => $.schedule_panel.preflight_fail)}
        </li>
        <li className={rowTone(checks.acyclic, "dependency_cycle")} data-testid="preflight-acyclic">
          {t(($) => $.schedule_panel.preflight_acyclic)} · {checks.acyclic ? t(($) => $.schedule_panel.preflight_ok) : t(($) => $.schedule_panel.preflight_fail)}
        </li>
        <li className={rowTone(checks.acceptance, "acceptance_spec_missing")} data-testid="preflight-acceptance">
          {t(($) => $.schedule_panel.preflight_acceptance)} · {checks.acceptance ? t(($) => $.schedule_panel.preflight_ok) : t(($) => $.schedule_panel.preflight_fail)}
        </li>
        <li className={rowTone(checks.mutex, "module_window_busy")} data-testid="preflight-mutex">
          {t(($) => $.schedule_panel.preflight_mutex)} · {checks.mutex ? t(($) => $.schedule_panel.preflight_ok) : t(($) => $.schedule_panel.preflight_fail)}
        </li>
      </ul>

      {/* 互斥等待：WS3 组锁未释放时派生态为「等待模块释放」。 */}
      {waitingLock && (
        <p
          className="mb-2 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-600"
          data-testid="schedule-waiting-lock"
        >
          {t(($) => $.schedule_panel.waiting_lock)}
          {holder
            ? ` · ${t(($) => $.schedule_panel.held_by, { n: holder.number, title: holder.title })}`
            : ""}
        </p>
      )}

      <div className="mb-2" data-testid="schedule-deps">
        <h5 className="text-2xs text-muted-foreground">{t(($) => $.schedule_panel.deps_title)}</h5>
        {childIssues.every((c) => !c.blocked_by?.length) ? (
          <p className="text-xs text-muted-foreground">{t(($) => $.schedule_panel.deps_empty)}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5 text-xs">
            {childIssues.flatMap((c) =>
              (c.blocked_by ?? []).map((dep) => (
                <li key={`${c.id}-${dep}`}>
                  {c.identifier ?? c.id} ← {dep}
                </li>
              )),
            )}
          </ul>
        )}
      </div>

      {/* 进度：stage_progress 是 server 投影的 "N/M"（issue.sql §6）。 */}
      <div data-testid="schedule-progress">
        <h5 className="text-2xs text-muted-foreground">
          {t(($) => $.schedule_panel.progress_label)}
          {issue.stage_progress ? ` · ${issue.stage_progress}` : ""}
        </h5>
        {stage3.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t(($) => $.schedule_panel.no_children)}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {stage3.map((c) => {
              const failed = c.status === "failed";
              return (
              <li
                key={c.id}
                className="flex items-center gap-1.5 text-xs"
                data-testid={`schedule-child-${c.id}`}
              >
                <span>{c.identifier}</span>
                <span className="min-w-0 truncate text-muted-foreground">{c.title}</span>
                <span className="rounded bg-muted px-1 text-2xs">{c.status}</span>
                <AppLink
                  href={paths.issueExecLog(c.id)}
                  className={`ml-auto shrink-0 text-2xs hover:underline ${
                    failed ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {failed
                    ? t(($) => $.schedule_panel.exec_log_failed)
                    : t(($) => $.schedule_panel.exec_log)}
                </AppLink>
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
