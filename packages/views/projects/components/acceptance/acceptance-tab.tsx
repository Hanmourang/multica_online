"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { calendarIssuesOptions, childrenByParentsOptions } from "@multica/core/issues/queries";
import { useSubmitAcceptanceVerdict } from "@multica/core/issues/mutations";
import { projectModulesOptions } from "@multica/core/modules";
import type { Issue } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { AppLink } from "../../../navigation";
import { readAcceptanceSpec } from "../../../issues/components/requirement-plan";
import { ProgressRing } from "../../../issues/components/progress-ring";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../archive/query-states";
import {
  acceptanceVerdict,
  canReflow,
  hasAcceptanceScene,
  projectRequirements,
} from "../requirements/requirement-helpers";

type AccFilter = "all" | "fail" | "running" | "pass";

export function AcceptanceTab({
  projectId,
  focusIssueId,
  onOpenRequirement,
}: {
  projectId: string;
  focusIssueId?: string | null;
  onOpenRequirement: (issueId: string, drill?: string) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<AccFilter>("all");
  const [moduleId, setModuleId] = useState<string | null>(null);

  const issuesQuery = useQuery(calendarIssuesOptions(wsId));
  const modulesQuery = useQuery(projectModulesOptions(wsId, projectId));

  const rows = useMemo(() => {
    return projectRequirements(issuesQuery.data ?? [], projectId).filter(hasAcceptanceScene);
  }, [issuesQuery.data, projectId]);

  const parentIds = useMemo(() => [...rows.map((r) => r.id)].sort(), [rows]);
  const childrenQuery = useQuery({
    ...childrenByParentsOptions(wsId, parentIds, qc),
    enabled: parentIds.length > 0,
  });

  const filtered = useMemo(() => {
    return rows.filter((issue) => {
      const verdict = acceptanceVerdict(issue);
      if (filter === "fail" && verdict !== "fail") return false;
      if (filter === "running" && verdict !== "running") return false;
      if (filter === "pass" && verdict !== "pass") return false;
      if (moduleId && issue.module_id !== moduleId) return false;
      return true;
    });
  }, [rows, filter, moduleId]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      fail: rows.filter((r) => acceptanceVerdict(r) === "fail").length,
      running: rows.filter((r) => acceptanceVerdict(r) === "running").length,
      pass: rows.filter((r) => acceptanceVerdict(r) === "pass").length,
    }),
    [rows],
  );

  if (issuesQuery.isPending) return <QueryLoading rows={5} />;
  if (issuesQuery.isError) {
    return <QueryError onRetry={() => void issuesQuery.refetch()} />;
  }

  return (
    <div className="space-y-3" data-testid="acceptance-tab">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["all", counts.all],
            ["fail", counts.fail],
            ["running", counts.running],
            ["pass", counts.pass],
          ] as const
        ).map(([key, count]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-micro font-medium",
              filter === key
                ? "border-primary/40 bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/60",
              key === "fail" && count > 0 && "text-destructive",
            )}
          >
            {t(($) => $.acceptance[`filter_${key}`])} {count}
          </button>
        ))}
        <select
          className="h-7 rounded-md border border-surface-border bg-surface px-2 text-micro"
          value={moduleId ?? ""}
          onChange={(e) => setModuleId(e.target.value || null)}
        >
          <option value="">{t(($) => $.req_mgmt.filter_module_all)}</option>
          {(modulesQuery.data ?? []).map((mod) => (
            <option key={mod.id} value={mod.id}>
              {mod.name}
            </option>
          ))}
        </select>
        <span className="ml-auto text-micro text-muted-foreground">
          {t(($) => $.acceptance.scope_hint)}
        </span>
      </div>

      {filtered.length === 0 ? (
        <ArchiveEmpty title={t(($) => $.acceptance.empty)} />
      ) : (
        <div className="space-y-2">
          {filtered.map((issue) => (
            <AcceptanceRow
              key={issue.id}
              issue={issue}
              childIssues={childrenQuery.data?.get(issue.id) ?? []}
              defaultOpen={focusIssueId === issue.id || acceptanceVerdict(issue) === "fail"}
              onOpenRequirement={onOpenRequirement}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AcceptanceRow({
  issue,
  childIssues,
  defaultOpen,
  onOpenRequirement,
}: {
  issue: Issue;
  childIssues: Issue[];
  defaultOpen: boolean;
  onOpenRequirement: (issueId: string, drill?: string) => void;
}) {
  const { t } = useT("archive");
  const paths = useWorkspacePaths();
  const [open, setOpen] = useState(defaultOpen);
  const [confirming, setConfirming] = useState(false);
  const reflow = useSubmitAcceptanceVerdict(issue.id);
  const verdict = acceptanceVerdict(issue);
  const testers = childIssues.filter((c) => c.stage === 4);
  const spec = readAcceptanceSpec(testers[0]?.acceptance_spec ?? issue.acceptance_spec);
  const assertions = spec.assertions.length ? spec.assertions : spec.cases;
  const passed = assertions.length === 0 ? 0 : Math.max(0, assertions.length - (verdict === "fail" ? 1 : 0));
  const total = Math.max(assertions.length, 1);
  const ratio = verdict === "pass" ? 100 : verdict === "fail" ? Math.round((passed / total) * 100) : 0;
  const allow = canReflow(issue);

  const handleReflow = () => {
    const evidence =
      assertions.slice(0, 3).join("；") ||
      t(($) => $.acceptance.reflow_evidence_fallback);
    reflow.mutate(
      { verdict: "fail", evidence },
      {
        onSuccess: () => {
          toast.success(t(($) => $.acceptance.reflow_ok));
          setConfirming(false);
        },
        onError: (error) => {
          toast.error(String(error));
        },
      },
    );
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-surface-border bg-surface",
        verdict === "fail" && "border-destructive/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <span
          className="relative inline-flex size-12 items-center justify-center"
          style={{ ["--p" as string]: `${ratio}` }}
        >
          <ProgressRing
            done={verdict === "pass" ? total : passed}
            total={total}
            size={36}
          />
          <span className="absolute text-micro tabular-nums">
            {verdict === "running" || verdict === "none" ? "—" : `${passed}/${total}`}
          </span>
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-caption text-primary">{issue.identifier}</span>
            <span className="truncate text-body font-medium">{issue.title}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-micro",
                verdict === "fail" && "bg-destructive/10 text-destructive",
                verdict === "pass" && "bg-emerald-500/15 text-emerald-700",
                verdict === "running" && "bg-muted text-muted-foreground",
              )}
            >
              {issue.requirement_status}
            </span>
          </div>
          <div className="text-micro text-muted-foreground">
            {t(($) => $.acceptance.round, { n: issue.acceptance_round ?? 0 })}
            {spec.path ? ` · ${spec.path}` : ""}
          </div>
        </button>
        <AppLink href={paths.calendarRequirement(issue.id, 4, "project")}>
          <Button size="xs" variant="ghost">
            {t(($) => $.acceptance.full_report)}
          </Button>
        </AppLink>
        <Button
          size="xs"
          variant="outline"
          disabled={!allow}
          onClick={() => allow && setConfirming(true)}
        >
          <RotateCcw className="size-3" />
          {allow ? t(($) => $.acceptance.reflow) : t(($) => $.acceptance.reflow_disabled)}
        </Button>
      </div>

      {open && (
        <div className="space-y-2 border-t border-surface-border px-3 py-2.5">
          {assertions.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.acceptance.no_assertions)}
            </p>
          ) : (
            assertions.map((line) => (
              <div key={line} className="text-caption text-muted-foreground">
                {verdict === "fail" ? "✗ " : "○ "}
                {line}
              </div>
            ))
          )}
          <button
            type="button"
            className="text-caption text-primary hover:underline"
            onClick={() => onOpenRequirement(issue.id, "deliverables")}
          >
            {t(($) => $.acceptance.to_deliverables)}
          </button>
        </div>
      )}

      {confirming && (
        <div className="space-y-2 border-t border-destructive/30 bg-destructive/5 px-3 py-2.5 text-caption">
          <b>{t(($) => $.acceptance.reflow_confirm_title)}</b>
          <p>{t(($) => $.acceptance.reflow_confirm_body)}</p>
          <div className="flex gap-2">
            <Button
              size="xs"
              disabled={reflow.isPending}
              onClick={handleReflow}
            >
              {t(($) => $.acceptance.reflow_confirm)}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              {t(($) => $.acceptance.reflow_cancel)}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
