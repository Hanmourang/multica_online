"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Ticket } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { graphModulesOptions, projectIssuesForModulesOptions } from "@multica/core/graph/queries";
import { useT } from "../../../../i18n";
import { FeatureLinkRow, FeaturePane, FeaturePill, featurePillTone } from "../feature-chrome";
import { useGraphData } from "../graph-data-provider";
import {
  issueShortLabel,
  issuesForModule,
  moduleRequirements,
  moduleTasks,
  rollupTasks,
} from "../module-feature-stats";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../../archive/query-states";

/**
 * f11 子TAB 2 · 模块变更概览：左需求、右任务进度条（对齐原型画面 11）。
 */
export function ChangeOverviewTab({ nodeId }: { nodeId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId } = useGraphData();
  const modulesQuery = useQuery(graphModulesOptions(wsId, projectId));
  const issuesQuery = useQuery(projectIssuesForModulesOptions(wsId, projectId));

  const module = (modulesQuery.data?.modules ?? []).find((row) => row.graph_node_id === nodeId);
  const issues = useMemo(() => {
    if (!module) return [];
    return issuesForModule(issuesQuery.data ?? [], projectId, module.id);
  }, [issuesQuery.data, module, projectId]);
  const requirements = moduleRequirements(issues);
  const tasks = rollupTasks(moduleTasks(issues));
  const acceptRounds = requirements.map((row) => row.acceptance_round ?? 0);
  const acceptAvg =
    acceptRounds.length > 0
      ? (acceptRounds.reduce((sum, n) => sum + n, 0) / acceptRounds.length).toFixed(1)
      : "0";
  const rework = requirements.filter((row) => (row.acceptance_round ?? 0) > 0).length;
  const protoDone = issues.filter((row) => row.stage === 1 && row.status === "done").length;
  const protoTotal = issues.filter((row) => row.stage === 1).length;

  if (modulesQuery.isPending || issuesQuery.isPending) {
    return <QueryLoading rows={4} />;
  }
  if (modulesQuery.isError || issuesQuery.isError) {
    return (
      <QueryError
        onRetry={() => {
          void modulesQuery.refetch();
          void issuesQuery.refetch();
        }}
      />
    );
  }

  if (issues.length === 0) {
    return (
      <ArchiveEmpty
        icon={<Ticket className="size-5" />}
        title={t(($) => $.features.changes_title)}
        description={t(($) => $.features.changes_empty)}
      />
    );
  }

  const donePct = tasks.total ? (tasks.done / tasks.total) * 100 : 0;
  const doingPct = tasks.total ? (tasks.doing / tasks.total) * 100 : 0;
  const stuckPct = tasks.total ? (tasks.stuck / tasks.total) * 100 : 0;

  return (
    <FeaturePane
      tag="子TAB 2"
      title={t(($) => $.features.changes_title)}
      meta={t(($) => $.features.changes_recent, { name: module?.name ?? nodeId })}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 text-[9px] font-bold text-muted-foreground">
            {t(($) => $.features.req_heading, { count: requirements.length })}
          </div>
          <ul>
            {requirements.map((issue, index) => {
              const status = issue.requirement_status || issue.status;
              return (
                <FeatureLinkRow key={issue.id} last={index === requirements.length - 1}>
                  <span className="min-w-0 flex-1 truncate">🎫 {issueShortLabel(issue)}</span>
                  <FeaturePill tone={featurePillTone(status)}>{status}</FeaturePill>
                </FeatureLinkRow>
              );
            })}
          </ul>
        </div>
        <div>
          <div className="mb-1.5 text-[9px] font-bold text-muted-foreground">
            {t(($) => $.features.task_heading, { done: tasks.done, total: tasks.total })}
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-sm bg-muted">
            <i className="block bg-emerald-500" style={{ width: `${donePct}%` }} />
            <i className="block bg-primary" style={{ width: `${doingPct}%` }} />
            <i className="block bg-amber-500" style={{ width: `${stuckPct}%` }} />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1 text-[9px] text-muted-foreground">
            <span className="text-emerald-600 dark:text-emerald-400">
              {"● "}
              <b className="text-muted-foreground">{t(($) => $.features.task_done)} {tasks.done}</b>
            </span>
            <span className="text-primary">
              {"● "}
              <b className="text-muted-foreground">{t(($) => $.features.task_doing)} {tasks.doing}</b>
            </span>
            <span className="text-amber-600 dark:text-amber-400">
              {"● "}
              <b className="text-muted-foreground">{t(($) => $.features.task_stuck)} {tasks.stuck}</b>
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 text-[9px] text-muted-foreground">
            <span>
              {t(($) => $.features.accept_avg)} <b className="text-foreground">{acceptAvg}</b>
            </span>
            <span>
              {t(($) => $.features.accept_rework)} <b className="text-destructive">{rework}</b>
            </span>
            <span>
              {t(($) => $.features.proto_done)}{" "}
              <b className="text-emerald-600 dark:text-emerald-400">
                {protoDone}/{protoTotal}
              </b>
            </span>
          </div>
        </div>
      </div>
    </FeaturePane>
  );
}
