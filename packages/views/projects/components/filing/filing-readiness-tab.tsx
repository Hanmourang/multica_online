"use client";

import { FileCheck2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { filingReadinessOptions } from "@multica/core/filing/queries";
import type { FilingReadiness, FilingTrack } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Progress } from "@multica/ui/components/ui/progress";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@multica/ui/components/ui/tabs";
import { useT } from "../../../i18n";
import { ArchiveEmpty, QueryError, QueryLoading } from "../archive/query-states";
import { FilingChecklist } from "./filing-checklist";
import { FilingCheckRunner } from "./filing-check-runner";
import { FilingCrossProject } from "./filing-cross-project";
import { FilingExport } from "./filing-export";
import { FilingBlockingPanel } from "./filing-blocking-panel";

/**
 * f12 申报就绪度顶层：软件著作权 / 专利双轨切换。
 *
 * One readiness query serves everything — the response embeds both track
 * aggregations with their full item lists, so the checklist reads the same
 * cache entry the ring does. 原型标注 2：就绪度只计必备件（must items）.
 *
 * The export gate is the server's `can_export_filing`, threaded down verbatim.
 * It used to be recomputed here from blocking_count + must ratios, which kept
 * a second definition of "can this be filed" in the client and silently
 * diverged whenever the server rule changed — the endpoint that enforces the
 * gate is the only place allowed to define it.
 */
const TRACKS: FilingTrack[] = ["software_copyright", "patent"];

type Translator = ReturnType<typeof useT<"archive">>["t"];

function trackLabel(t: Translator, track: FilingTrack): string {
  return track === "software_copyright"
    ? t(($) => $.filing.track_software)
    : t(($) => $.filing.track_patent);
}

export function FilingReadinessTab({ projectId }: { projectId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const readiness = useQuery(filingReadinessOptions(wsId, projectId));

  if (readiness.isPending) {
    return <QueryLoading rows={5} />;
  }
  if (readiness.isError) {
    return <QueryError onRetry={() => readiness.refetch()} />;
  }

  const { tracks, can_export_filing: canExport } = readiness.data;
  if (tracks.every((track) => track.items.length === 0)) {
    // The contract checklist is seeded by the CLI sync; until then the server
    // answers two empty aggregates — surfaced as a real empty state.
    return (
      <ArchiveEmpty
        icon={<FileCheck2 className="size-5" />}
        title={t(($) => $.filing.items_empty)}
      />
    );
  }

  return (
    <Tabs defaultValue="software_copyright">
      <TabsList variant="line">
        {TRACKS.map((track) => (
          <TabsTrigger key={track} value={track}>
            {trackLabel(t, track)}
          </TabsTrigger>
        ))}
      </TabsList>
      {TRACKS.map((track) => {
        const data = tracks.find((item) => item.track === track);
        return (
          <TabsContent key={track} value={track} className="mt-3">
            {data && data.items.length > 0 ? (
              <TrackPanel
                projectId={projectId}
                data={data}
                canExport={canExport}
              />
            ) : (
              <ArchiveEmpty
                icon={<FileCheck2 className="size-5" />}
                title={t(($) => $.filing.items_empty)}
              />
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

function TrackPanel({
  projectId,
  data,
  canExport,
}: {
  projectId: string;
  data: FilingReadiness;
  /** Server-side gate (`can_export_filing`) — passed through, never derived. */
  canExport: boolean;
}) {
  const { t } = useT("archive");
  const mustPct =
    data.must_total > 0
      ? Math.round((data.must_ready / data.must_total) * 100)
      : 0;

  return (
    <div className="space-y-3">
      {/* 就绪度摘要：必备件进度 + 整体进度 + 阻塞计数。 */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border bg-card/40 px-3 py-2.5">
        <div className="min-w-[220px] flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-caption font-medium">
              {t(($) => $.filing.must_progress, {
                ready: data.must_ready,
                total: data.must_total,
              })}
            </span>
            <span className="text-caption tabular-nums text-muted-foreground">
              {mustPct}%
            </span>
          </div>
          <Progress value={mustPct} className="mt-1.5 gap-0" />
        </div>
        <span className="text-caption text-muted-foreground">
          {t(($) => $.filing.ready_progress, {
            ready: data.ready_count,
            total: data.total_items,
          })}
        </span>
        {data.blocking_count > 0 ? (
          <Badge variant="destructive">
            {t(($) => $.filing.blocking_count, { count: data.blocking_count })}
          </Badge>
        ) : (
          <Badge variant="secondary">{t(($) => $.filing.no_blocking)}</Badge>
        )}
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <FilingChecklist items={data.items} />
        <aside className="space-y-3">
          <FilingCheckRunner projectId={projectId} />
          {/* anno③: 阻塞项 P0/P1/P2 优先级面板 */}
          <FilingBlockingPanel items={data.blocking_items} />
          {/* 原型标注 4：跨项目对比 sits between the check runner and the export
              panel — project-level data, so both track tabs share one cache
              entry (the query key is the same). */}
          <FilingCrossProject projectId={projectId} />
          <FilingExport
            projectId={projectId}
            track={data.track}
            canExport={canExport}
            items={data.items}
          />
        </aside>
      </div>
    </div>
  );
}
