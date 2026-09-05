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
import { useT } from "../../i18n";

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
  /** Calls POST /issues/{id}/trigger. Injected so tests can capture the call. */
  triggerRequirement: (issueId: string) => Promise<TriggerRequirementResponse>;
}

export function RequirementSchedulePanel({
  issue,
  childIssues,
  triggerRequirement,
}: RequirementSchedulePanelProps) {
  const { t } = useT("issues");
  const [triggering, setTriggering] = useState(false);
  const triggered = issue.triggered_at != null;
  const waitingLock = issue.requirement_status === "等待模块释放";
  const stage3 = childIssues.filter((c) => c.stage === 3);

  const onTrigger = async () => {
    setTriggering(true);
    try {
      await triggerRequirement(issue.id);
      toast.success(t(($) => $.schedule_panel.trigger_ok));
    } catch (e) {
      // 服务端 409 带 reason（decomposition_not_confirmed / dependency_cycle /
      // acceptance_spec_missing / module_window_busy）；this.fetch 抛 ApiError(message=reason)。
      toast.error(e instanceof Error ? e.message : t(($) => $.schedule_panel.trigger_failed));
    } finally {
      setTriggering(false);
    }
  };

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

      {/* 互斥等待：WS3 组锁未释放时派生态为「等待模块释放」。 */}
      {waitingLock && (
        <p
          className="mb-2 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-600"
          data-testid="schedule-waiting-lock"
        >
          {t(($) => $.schedule_panel.waiting_lock)}
        </p>
      )}

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
            {stage3.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-1.5 text-xs"
                data-testid={`schedule-child-${c.id}`}
              >
                <span>{c.identifier}</span>
                <span className="text-muted-foreground">{c.title}</span>
                <span className="ml-auto rounded bg-muted px-1 text-2xs">{c.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
