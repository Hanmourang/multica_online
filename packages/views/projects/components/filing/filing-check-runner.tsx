"use client";

import { RefreshCw } from "lucide-react";
import { useRunFilingCheck } from "@multica/core/filing/mutations";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../../i18n";
import { QueryError } from "../archive/query-states";

/**
 * f12 校验执行器。
 *
 * POST /projects/{id}/filing/check recomputes every item and records a
 * filing_check_run; the mutation invalidates the whole filing key space so
 * the checklist + readiness ring refetch on settle. The rule engine is a
 * skeleton (bound artifact → pass) — the hint says exactly that.
 */
export function FilingCheckRunner({ projectId }: { projectId: string }) {
  const { t } = useT("archive");
  const check = useRunFilingCheck(projectId);

  return (
    <div className="space-y-2 rounded-lg border border-surface-border bg-surface p-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={check.isPending}
        onClick={() => check.mutate()}
        aria-label={t(($) => $.filing.check_button)}
      >
        <RefreshCw />
        {check.isPending
          ? t(($) => $.filing.checking)
          : t(($) => $.filing.check_button)}
      </Button>

      {check.isError && (
        <QueryError
          compact
          onRetry={() => check.mutate()}
          message={check.error instanceof Error ? check.error.message : undefined}
        />
      )}

      {check.data && (
        <div className="space-y-1 text-caption">
          <div className="font-medium text-foreground">
            {t(($) => $.filing.check_result, {
              pass: check.data.pass_count,
              fail: check.data.fail_count,
              count: check.data.checked_count,
            })}
          </div>
          <p className="leading-relaxed text-muted-foreground">
            {t(($) => $.filing.check_hint_rules)}
          </p>
        </div>
      )}
    </div>
  );
}
