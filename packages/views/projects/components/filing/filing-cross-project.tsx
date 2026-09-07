"use client";

import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { filingCrossProjectOptions } from "@multica/core/filing/queries";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@multica/ui/components/ui/collapsible";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { ArchiveEmpty, QueryError, QueryLoading } from "../archive/query-states";

/**
 * f12 跨项目对比（原型标注 4：申报期挑必备件已齐的项目先报）。
 *
 * GET /projects/{id}/filing/cross-project answers one row per project × track;
 * the prototype draws ONE bar per project, so the two tracks are folded here.
 * Folding is a pure sum — must_ready / must_total are counts over disjoint
 * item sets, and the percentage is recomputed from the sums rather than
 * averaged, because averaging two tracks with different must totals would
 * misreport a 3/3 + 0/6 project as 50% instead of 33%.
 *
 * Bars are plain div widths (原型：`.bar-row .track i { width: N% }`). No chart
 * library is pulled in for four rectangles.
 */

interface ProjectBar {
  projectId: string;
  title: string;
  mustReady: number;
  mustTotal: number;
  /** 0-100, recomputed from the folded sums. */
  pct: number;
}

export function FilingCrossProject({ projectId }: { projectId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const comparison = useQuery(filingCrossProjectOptions(wsId, projectId));

  const bars = useMemo<ProjectBar[]>(() => {
    const folded = new Map<string, ProjectBar>();
    for (const row of comparison.data ?? []) {
      const existing = folded.get(row.project_id);
      if (existing) {
        existing.mustReady += row.must_ready;
        existing.mustTotal += row.must_total;
        continue;
      }
      folded.set(row.project_id, {
        projectId: row.project_id,
        title: row.project_title,
        mustReady: row.must_ready,
        mustTotal: row.must_total,
        pct: 0,
      });
    }
    // The server sorts by per-track pct; folding can reorder (a project strong
    // on one track and weak on the other), so re-sort on the folded numbers —
    // most-ready first, then title for a stable order across refetches.
    return [...folded.values()]
      .map((bar) => ({
        ...bar,
        pct:
          bar.mustTotal > 0
            ? Math.round((bar.mustReady / bar.mustTotal) * 100)
            : 0,
      }))
      .sort((a, b) => b.pct - a.pct || a.title.localeCompare(b.title));
  }, [comparison.data]);

  return (
    <div className="rounded-lg border border-surface-border bg-surface p-3">
      <Collapsible>
        <CollapsibleTrigger className="group/cross -mx-1 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/40">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[panel-open]/cross:rotate-90" />
          <span className="text-caption font-medium">
            {t(($) => $.filing.cross_project_title)}
          </span>
          {bars.length > 0 && (
            <span className="ml-auto shrink-0 text-micro tabular-nums text-muted-foreground">
              {t(($) => $.filing.cross_project_projects, {
                projects: bars.length,
              })}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          {comparison.isPending ? (
            <QueryLoading rows={3} />
          ) : comparison.isError ? (
            <QueryError compact onRetry={() => comparison.refetch()} />
          ) : bars.length === 0 ? (
            <ArchiveEmpty
              className="border-dashed"
              title={t(($) => $.filing.cross_project_empty)}
            />
          ) : (
            <>
              <ul className="space-y-2">
                {bars.map((bar) => {
                  const isCurrent = bar.projectId === projectId;
                  const complete =
                    bar.mustTotal > 0 && bar.mustReady === bar.mustTotal;
                  return (
                    <li key={bar.projectId} className="flex items-center gap-2">
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span
                          className={cn(
                            "truncate text-caption",
                            isCurrent
                              ? "font-semibold text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {bar.title}
                        </span>
                        {isCurrent && (
                          <Badge
                            variant="secondary"
                            className="h-4 shrink-0 px-1.5 text-micro"
                          >
                            {t(($) => $.filing.cross_project_current)}
                          </Badge>
                        )}
                      </span>
                      {/* 横条只算必备件（原型标注 2 + 4）: width is the must-tier
                          ratio, colour flips to success only at 9/9 — a 8/9
                          project still cannot be submitted. */}
                      <div
                        role="img"
                        aria-label={t(($) => $.filing.cross_project_bar_aria, {
                          project: bar.title,
                          ready: bar.mustReady,
                          total: bar.mustTotal,
                        })}
                        className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted"
                      >
                        <div
                          className={cn(
                            "h-full rounded-full transition-[width] duration-300",
                            complete ? "bg-emerald-500" : "bg-destructive",
                          )}
                          style={{ width: `${bar.pct}%` }}
                        />
                      </div>
                      <span className="w-10 shrink-0 text-right text-micro tabular-nums text-muted-foreground">
                        {t(($) => $.filing.cross_project_count, {
                          ready: bar.mustReady,
                          total: bar.mustTotal,
                        })}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="text-micro leading-relaxed text-faint-foreground">
                {t(($) => $.filing.cross_project_hint)}
              </p>
            </>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
