"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { calendarIssuesOptions } from "@multica/core/issues/queries";
import { projectArtifactListOptions } from "@multica/core/artifacts/queries";
import type { ProjectArtifact } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { ArchiveActionDialog } from "../archive/archive-action-dialog";
import { ArtifactPreviewDialog } from "../archive/artifact-preview";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../archive/query-states";
import {
  acceptanceVerdict,
  projectRequirements,
} from "../requirements/requirement-helpers";
import { splitDeliverables } from "./deliverable-scope";

type KindFilter = "all" | "prototype" | "code" | "doc" | "report";
type ArchiveFilter = "all" | "pending";
type VerdictFilter = "all" | "fail" | "pass" | "running";

function classifyArtifact(artifact: ProjectArtifact): KindFilter {
  const path = artifact.rel_path.toLowerCase();
  const type = artifact.doc_type.toLowerCase();
  if (type.includes("prototype") || path.includes("prototype")) return "prototype";
  if (type.includes("report") || type.includes("acceptance") || path.includes("acceptance")) {
    return "report";
  }
  if (path.endsWith(".ts") || path.endsWith(".tsx") || path.includes("/src/") || type.includes("mr")) {
    return "code";
  }
  return "doc";
}

function isPendingArchive(artifact: ProjectArtifact): boolean {
  return artifact.source !== "agent" && artifact.source !== "manual" && !artifact.attachment_id;
}

export function ProjectDeliverablesTab({
  projectId,
  onOpenRequirement,
  onOpenAcceptance,
}: {
  projectId: string;
  onOpenRequirement: (issueId: string, drill?: string) => void;
  onOpenAcceptance: (issueId?: string) => void;
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const [kind, setKind] = useState<KindFilter>("all");
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>("all");
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>("all");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ProjectArtifact | null>(null);

  const issuesQuery = useQuery(calendarIssuesOptions(wsId));
  const artifactsQuery = useQuery(projectArtifactListOptions(wsId, projectId));

  const requirements = useMemo(
    () => projectRequirements(issuesQuery.data ?? [], projectId),
    [issuesQuery.data, projectId],
  );
  // 交付物 = 产出物：资产管理上传的输入物（对象≠产物 / 未标）在这里被挡下，
  // 只统计隐藏条数如实提示，不篡改服务端返回的全量档案。
  const { deliverables: artifacts, hiddenNonOutput } = useMemo(
    () => splitDeliverables(artifactsQuery.data?.artifacts ?? []),
    [artifactsQuery.data],
  );

  const groups = useMemo(() => {
    const byIssue = new Map<string, ProjectArtifact[]>();
    const unbound: ProjectArtifact[] = [];
    for (const artifact of artifacts) {
      const kindOf = classifyArtifact(artifact);
      if (kind !== "all" && kindOf !== kind) continue;
      if (archiveFilter === "pending" && !isPendingArchive(artifact)) continue;
      if (artifact.issue_id) {
        const list = byIssue.get(artifact.issue_id) ?? [];
        list.push(artifact);
        byIssue.set(artifact.issue_id, list);
      } else {
        unbound.push(artifact);
      }
    }
    return { byIssue, unbound };
  }, [artifacts, kind, archiveFilter]);

  const pendingCount = artifacts.filter(isPendingArchive).length;
  const kindCounts = useMemo(() => {
    const counts: Record<KindFilter, number> = {
      all: artifacts.length,
      prototype: 0,
      code: 0,
      doc: 0,
      report: 0,
    };
    for (const artifact of artifacts) {
      counts[classifyArtifact(artifact)] += 1;
    }
    return counts;
  }, [artifacts]);

  if (issuesQuery.isPending || artifactsQuery.isPending) return <QueryLoading rows={6} />;
  if (artifactsQuery.isError) {
    return <QueryError onRetry={() => void artifactsQuery.refetch()} />;
  }

  const previewIndex = previewId
    ? artifacts.findIndex((a) => a.id === previewId)
    : -1;

  return (
    <div className="space-y-3" data-testid="project-deliverables">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["all", kindCounts.all],
            ["prototype", kindCounts.prototype],
            ["code", kindCounts.code],
            ["doc", kindCounts.doc],
            ["report", kindCounts.report],
          ] as const
        ).map(([key, count]) => (
          <button
            key={key}
            type="button"
            aria-pressed={kind === key}
            onClick={() => setKind(key)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-micro font-medium",
              kind === key
                ? "border-primary/40 bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            {t(($) => $.proj_dlv[`kind_${key}`])} {count}
          </button>
        ))}
        {(
          [
            ["all", "filter_verdict_all"],
            ["fail", "filter_verdict_fail"],
            ["pass", "filter_verdict_pass"],
            ["running", "filter_verdict_running"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={verdictFilter === key}
            onClick={() => setVerdictFilter(key)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-micro",
              verdictFilter === key
                ? "border-primary/40 bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            {t(($) => $.proj_dlv[label])}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={archiveFilter === "pending"}
          onClick={() => setArchiveFilter((v) => (v === "pending" ? "all" : "pending"))}
          className={cn(
            "rounded-full border px-2.5 py-1 text-micro",
            archiveFilter === "pending"
              ? "border-warning/40 bg-warning/10 text-warning"
              : "text-muted-foreground",
          )}
        >
          {t(($) => $.proj_dlv.pending_archive)} {pendingCount}
        </button>
        {hiddenNonOutput > 0 && (
          <span
            className="text-micro text-muted-foreground"
            data-testid="deliverables-hidden-non-output"
          >
            {t(($) => $.proj_dlv.hidden_non_output, { count: hiddenNonOutput })}
          </span>
        )}
      </div>

      {requirements.length === 0 && artifacts.length === 0 ? (
        <ArchiveEmpty title={t(($) => $.proj_dlv.empty)} />
      ) : (
        <div className="space-y-3">
          {requirements.map((issue) => {
            const items = groups.byIssue.get(issue.id) ?? [];
            const verdict = acceptanceVerdict(issue);
            if (verdictFilter !== "all" && verdict !== verdictFilter) return null;
            if (kind !== "all" && archiveFilter === "pending" && items.length === 0) {
              return null;
            }
            if (kind !== "all" && items.length === 0) return null;
            return (
              <section
                key={issue.id}
                className={cn(
                  "overflow-hidden rounded-lg border border-surface-border",
                  verdict === "fail" && "border-destructive/40",
                )}
              >
                <header className="flex items-center gap-2 bg-surface-hover/40 px-3 py-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left"
                    onClick={() => onOpenRequirement(issue.id, "deliverables")}
                  >
                    <span className="font-mono text-caption text-primary">
                      {issue.identifier}
                    </span>{" "}
                    <span className="text-body font-medium">{issue.title}</span>
                    <span className="ml-2 text-micro text-muted-foreground">
                      {issue.requirement_status}
                    </span>
                  </button>
                  {verdict === "fail" && (
                    <Button size="xs" variant="outline" onClick={() => onOpenAcceptance(issue.id)}>
                      {t(($) => $.proj_dlv.go_reflow)}
                    </Button>
                  )}
                </header>
                <div className="divide-y divide-surface-border">
                  {items.length === 0 ? (
                    <div className="px-3 py-2 text-caption text-muted-foreground">
                      {t(($) => $.proj_dlv.pending_produce)}
                    </div>
                  ) : (
                    items.map((artifact) => (
                      <DeliverableRow
                        key={artifact.id}
                        artifact={artifact}
                        onPreview={() => setPreviewId(artifact.id)}
                        onArchive={() => setArchiveTarget(artifact)}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
          {groups.unbound.length > 0 && (
            <section className="overflow-hidden rounded-lg border border-dashed border-surface-border">
              <header className="px-3 py-2 text-caption font-medium text-muted-foreground">
                {t(($) => $.proj_dlv.unbound)}
              </header>
              {groups.unbound.map((artifact) => (
                <DeliverableRow
                  key={artifact.id}
                  artifact={artifact}
                  onPreview={() => setPreviewId(artifact.id)}
                  onArchive={() => setArchiveTarget(artifact)}
                />
              ))}
            </section>
          )}
        </div>
      )}

      <ArtifactPreviewDialog
        projectId={projectId}
        artifacts={artifacts}
        index={Math.max(previewIndex, 0)}
        onIndexChange={(index) => setPreviewId(artifacts[index]?.id ?? null)}
        open={previewIndex >= 0}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null);
        }}
        onRequestArchive={(artifact) => setArchiveTarget(artifact)}
      />
      <ArchiveActionDialog
        projectId={projectId}
        artifact={archiveTarget}
        open={Boolean(archiveTarget)}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null);
        }}
      />
    </div>
  );
}

function DeliverableRow({
  artifact,
  onPreview,
  onArchive,
}: {
  artifact: ProjectArtifact;
  onPreview: () => void;
  onArchive: () => void;
}) {
  const { t } = useT("archive");
  const pending = isPendingArchive(artifact);
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2",
        pending && "border-l-2 border-dashed border-warning",
      )}
    >
      <button type="button" className="min-w-0 flex-1 text-left" onDoubleClick={onPreview} onClick={onPreview}>
        <div className="truncate text-caption font-medium">
          {artifact.rel_path.split("/").pop()}
        </div>
        <div className="truncate font-mono text-micro text-muted-foreground">
          {artifact.rel_path}
        </div>
      </button>
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-micro",
          pending ? "bg-warning/15 text-warning" : "bg-emerald-500/15 text-emerald-700",
        )}
      >
        {pending ? t(($) => $.proj_dlv.status_pending) : t(($) => $.proj_dlv.status_archived)}
      </span>
      {pending && (
        <Button size="xs" variant="outline" onClick={onArchive}>
          <Archive className="size-3" />
          {t(($) => $.proj_dlv.archive)}
        </Button>
      )}
    </div>
  );
}
