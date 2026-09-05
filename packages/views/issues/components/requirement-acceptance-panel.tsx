/**
 * RequirementAcceptancePanel — 验收阶段面板（spec 2026-09-04-requirement-calendar
 * 画面 7）：验收轮次（acceptance_round，DEFAULT 0 / 每 fail +1 / >3 判验收失败终态）、
 * stage4 tester 报告清单、stage3 打回链（fail 分支新建的修复子任务）、pass/fail
 * 人工仲裁入口（evidence 必填 → POST /issues/{id}/acceptance/verdict，member-authed）。
 *
 * §7.5③：验收失败「转人工仲裁」；daemon 只走 runtime-token 路由、无法调 member 路由，
 * 故本面板的 pass/fail 按钮是合法的人工仲裁入口。裁决回调由挂载点（flow-section）注入。
 */
import { useState } from "react";
import type { AcceptanceVerdictResponse, Issue } from "@multica/core/types";
import { toast } from "sonner";
import { useT } from "../../i18n";

/** 验收轮次上限（design §9 / WS4 Task 4.4）：round>3 判验收失败终态。 */
const MAX_ACCEPTANCE_ROUND = 3;

interface RequirementAcceptancePanelProps {
  issue: Issue;
  /** 挂载点已查询的子任务列表：stage4=tester 报告，stage3=打回修复链。 */
  childIssues: Issue[];
  /** Calls POST /issues/{id}/acceptance/verdict. Injected so tests can capture the payload. */
  submitAcceptanceVerdict: (
    issueId: string,
    body: { verdict: "pass" | "fail"; evidence: string },
  ) => Promise<AcceptanceVerdictResponse>;
}

export function RequirementAcceptancePanel({
  issue,
  childIssues,
  submitAcceptanceVerdict,
}: RequirementAcceptancePanelProps) {
  const { t } = useT("issues");
  const [evidence, setEvidence] = useState("");
  const [submitting, setSubmitting] = useState<"pass" | "fail" | null>(null);
  const round = issue.acceptance_round ?? 0;
  const failed = round > MAX_ACCEPTANCE_ROUND;
  const testers = childIssues.filter((c) => c.stage === 4);
  const repairs = childIssues.filter((c) => c.stage === 3);

  const submit = async (verdict: "pass" | "fail") => {
    setSubmitting(verdict);
    try {
      await submitAcceptanceVerdict(issue.id, { verdict, evidence: evidence.trim() });
      toast.success(t(($) => $.acceptance_panel.verdict_ok));
      setEvidence("");
    } catch (e) {
      // 400（非法 verdict）/ 500；this.fetch 抛 ApiError(message=服务端 body)。
      toast.error(e instanceof Error ? e.message : t(($) => $.acceptance_panel.verdict_failed));
    } finally {
      setSubmitting(null);
    }
  };

  // 验收失败终态（round>MAX）后禁止再次裁决：否则按钮仍可点，喂给服务端持续累加
  // round + 追加仲裁评论。前端校验（服务端另有守卫，前端不可作唯一防线）。
  const canSubmit = !failed && evidence.trim().length > 0 && submitting == null;

  return (
    <section className="rounded-md border bg-card p-3" data-testid="acceptance-panel">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t(($) => $.acceptance_panel.title)}</h4>
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground"
          data-testid="acceptance-round"
        >
          {t(($) => $.acceptance_panel.round_label)} {round} / {MAX_ACCEPTANCE_ROUND}
        </span>
      </header>

      {/* 验收失败终态（round>3）：转人工仲裁 banner（§7.5③）。 */}
      {failed && (
        <p
          className="mb-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
          data-testid="acceptance-failed-banner"
        >
          {t(($) => $.acceptance_panel.failed_banner)}
        </p>
      )}

      {/* 验收报告：stage4 tester 子任务。 */}
      <div className="mb-2" data-testid="acceptance-report">
        <h5 className="text-2xs text-muted-foreground">{t(($) => $.acceptance_panel.report_title)}</h5>
        {testers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t(($) => $.acceptance_panel.no_report)}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {testers.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-1.5 text-xs"
                data-testid={`acceptance-tester-${c.id}`}
              >
                <span>{c.identifier}</span>
                <span className="text-muted-foreground">{c.title}</span>
                <span className="ml-auto rounded bg-muted px-1 text-2xs">{c.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 打回链：fail 分支新建的 stage3 修复子任务（WS4 Task 4.3）。 */}
      {repairs.length > 0 && (
        <div className="mb-2" data-testid="acceptance-repairs">
          <h5 className="text-2xs text-muted-foreground">{t(($) => $.acceptance_panel.repairs_title)}</h5>
          <ul className="mt-1 flex flex-col gap-0.5">
            {repairs.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-1.5 text-xs"
                data-testid={`acceptance-repair-${c.id}`}
              >
                <span>{c.identifier}</span>
                <span className="text-muted-foreground">{c.title}</span>
                <span className="ml-auto rounded bg-muted px-1 text-2xs">{c.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 人工仲裁：evidence 必填 + pass/fail（§7.5③）。 */}
      <div className="flex flex-col gap-1.5" data-testid="acceptance-arbitration">
        <textarea
          className="w-full rounded-md border bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          rows={2}
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder={t(($) => $.acceptance_panel.evidence_placeholder)}
          data-testid="acceptance-evidence"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="acceptance-pass"
            disabled={!canSubmit}
            onClick={() => void submit("pass")}
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            {submitting === "pass"
              ? t(($) => $.acceptance_panel.submitting)
              : t(($) => $.acceptance_panel.pass)}
          </button>
          <button
            type="button"
            data-testid="acceptance-fail"
            disabled={!canSubmit}
            onClick={() => void submit("fail")}
            className="rounded-md bg-destructive px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            {submitting === "fail"
              ? t(($) => $.acceptance_panel.submitting)
              : t(($) => $.acceptance_panel.fail)}
          </button>
          {evidence.trim().length === 0 && (
            <span className="text-2xs text-muted-foreground" data-testid="acceptance-evidence-hint">
              {t(($) => $.acceptance_panel.evidence_required)}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
