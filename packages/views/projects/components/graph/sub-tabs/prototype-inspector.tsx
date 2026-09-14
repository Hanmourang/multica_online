"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, PanelRightClose, PanelRightOpen, Target, Waypoints } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { graphKeys } from "@multica/core/graph/queries";
import { useUpdateIssue } from "@multica/core/issues/mutations";
import type { Issue, PrototypeMark, PrototypeVersion } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../../i18n";
import { isTopLevelRequirement } from "../../requirements/requirement-helpers";
import { FeaturePill, featurePillTone, TypeChip } from "../feature-chrome";
import {
  decoratePrototypeFeatures,
  issueShortLabel,
  markRollup,
  type DecoratedPrototypeFeature,
  type FeaturePointKind,
  type PrototypeModule,
} from "../module-feature-stats";
import { usePrototypeInspector } from "../use-prototype-inspector";

/**
 * 原型图右侧详情：交付预期 + 功能详解 + 需求/任务快速绑模块。
 * 默认收缩；左侧手柄拖宽。
 */
export function PrototypeInspector({
  projectId,
  moduleId,
  moduleName,
  issue,
  allIssues,
  version,
  points,
  selectedFp,
  onSelectFp,
  extra,
}: {
  projectId: string;
  moduleId?: string;
  moduleName?: string;
  issue?: Issue;
  allIssues: Issue[];
  version?: PrototypeVersion;
  points: PrototypeModule[];
  selectedFp: string | null;
  onSelectFp: (id: string) => void;
  extra?: ReactNode;
}) {
  const { t } = useT("archive");
  const { open, setOpen, width, startResize } = usePrototypeInspector();
  useEffect(() => {
    if (selectedFp) setOpen(true);
  }, [selectedFp, setOpen]);
  const features = useMemo(
    () => decoratePrototypeFeatures(points, version?.marks),
    [points, version?.marks],
  );
  const hasHotspots = points.some((point) => point.source === "fp");

  if (!open) {
    return (
      <div
        className="flex h-full w-9 shrink-0 flex-col items-center border-l border-surface-border bg-muted/20"
        data-testid="prototype-inspector-rail"
      >
        <button
          type="button"
          aria-expanded={false}
          aria-label={t(($) => $.features.inspector_expand)}
          onClick={() => setOpen(true)}
          className="flex w-full flex-1 flex-col items-center gap-3 px-1 py-3 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <PanelRightOpen className="size-3.5" />
          <span
            className="text-[10px] font-semibold tracking-wide"
            style={{ writingMode: "vertical-rl" }}
          >
            {t(($) => $.features.inspector_open)}
          </span>
        </button>
      </div>
    );
  }

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-l border-surface-border bg-[oklch(0.988_0_0)] dark:bg-muted/10"
      style={{ width }}
      data-testid="prototype-inspector"
    >
      <button
        type="button"
        aria-label={t(($) => $.features.inspector_width)}
        onPointerDown={startResize}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize bg-transparent hover:bg-primary/25"
      />
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-surface-border px-3">
        <TypeChip>DETAIL</TypeChip>
        <span className="text-[11px] font-bold">{t(($) => $.features.inspector_open)}</span>
        <button
          type="button"
          aria-expanded
          aria-label={t(($) => $.features.inspector_collapse)}
          onClick={() => setOpen(false)}
          className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <PanelRightClose className="size-3.5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <BindSection
          projectId={projectId}
          moduleId={moduleId}
          moduleName={moduleName}
          issue={issue}
          allIssues={allIssues}
        />
        <DeliverySection issue={issue} version={version} />
        <DetailsSection
          features={features}
          selectedFp={selectedFp}
          onSelectFp={onSelectFp}
          hasHotspots={hasHotspots}
        />
        {extra}
      </div>
    </aside>
  );
}

function BindSection({
  projectId,
  moduleId,
  moduleName,
  issue,
  allIssues,
}: {
  projectId: string;
  moduleId?: string;
  moduleName?: string;
  issue?: Issue;
  allIssues: Issue[];
}) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const updateIssue = useUpdateIssue();

  const childTasks = useMemo(
    () => (issue ? allIssues.filter((row) => row.parent_issue_id === issue.id) : []),
    [allIssues, issue],
  );
  const unboundChildren = childTasks.filter((row) => row.module_id !== moduleId);
  const unboundPool = useMemo(
    () =>
      allIssues
        .filter(
          (row) =>
            row.project_id === projectId &&
            !row.module_id &&
            row.id !== issue?.id,
        )
        .slice(0, 8),
    [allIssues, issue?.id, projectId],
  );

  const bind = (issueId: string) => {
    if (!moduleId) return;
    updateIssue.mutate(
      { id: issueId, module_id: moduleId },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: graphKeys.projectIssues(wsId, projectId) });
          toast.success(t(($) => $.features.inspector_bind_ok));
        },
        onError: () => toast.error(t(($) => $.features.inspector_bind_failed)),
      },
    );
  };

  const bindChildren = async () => {
    if (!moduleId || unboundChildren.length === 0) return;
    try {
      await Promise.all(
        unboundChildren.map((row) => updateIssue.mutateAsync({ id: row.id, module_id: moduleId })),
      );
      void qc.invalidateQueries({ queryKey: graphKeys.projectIssues(wsId, projectId) });
      toast.success(t(($) => $.features.inspector_bind_ok));
    } catch {
      toast.error(t(($) => $.features.inspector_bind_failed));
    }
  };

  return (
    <section className="border-b border-surface-border px-3 py-3">
      <SectionHead
        icon={<Waypoints className="size-3" />}
        title={t(($) => $.features.inspector_bind)}
      />
      {issue ? (
        <div className="rounded-lg border border-surface-border bg-surface px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">
              {issueShortLabel(issue)}
            </span>
            <FeaturePill tone={featurePillTone(issue.requirement_status || issue.status)}>
              {issue.requirement_status || issue.status}
            </FeaturePill>
          </div>
          <p className="mt-1 text-[10.5px] text-muted-foreground">
            {moduleName
              ? t(($) => $.features.inspector_bound_module, { name: moduleName })
              : t(($) => $.features.inspector_unbound)}
          </p>
          {childTasks.length > 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              {t(($) => $.features.inspector_task_count, {
                bound: childTasks.length - unboundChildren.length,
                total: childTasks.length,
              })}
            </p>
          )}
          {unboundChildren.length > 0 && moduleId && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="mt-2"
              disabled={updateIssue.isPending}
              onClick={() => void bindChildren()}
            >
              {t(($) => $.features.inspector_bind_tasks)}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">{t(($) => $.features.prototypes_empty)}</p>
      )}
      {moduleId && unboundPool.length > 0 && (
        <div className="mt-2">
          <p className="mb-1 text-[10px] font-semibold text-muted-foreground">
            {t(($) => $.features.inspector_unbound_pick)}
          </p>
          <ul className="space-y-1">
            {unboundPool.map((row) => (
              <li key={row.id} className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px]">
                  {isTopLevelRequirement(row)
                    ? t(($) => $.features.req_filter)
                    : t(($) => $.features.inspector_task)}
                  {" · "}
                  {issueShortLabel(row)}
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={updateIssue.isPending}
                  onClick={() => bind(row.id)}
                >
                  {t(($) => $.features.inspector_bind_here)}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {moduleId && unboundPool.length === 0 && (
        <p className="mt-2 text-[10px] text-muted-foreground">
          {t(($) => $.features.inspector_no_unbound)}
        </p>
      )}
    </section>
  );
}

function DeliverySection({
  issue,
  version,
}: {
  issue?: Issue;
  version?: PrototypeVersion;
}) {
  const { t } = useT("archive");
  const marks = markRollup(version?.marks);
  const goal = issue?.goal?.trim() ?? "";

  return (
    <section className="border-b border-surface-border px-3 py-3">
      <SectionHead
        icon={<Target className="size-3" />}
        title={t(($) => $.features.inspector_delivery)}
        index="①"
      />
      {goal ? (
        <blockquote className="rounded-lg border border-primary/15 bg-primary/[0.04] px-2.5 py-2 text-[12px] leading-relaxed text-foreground">
          {goal}
        </blockquote>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(($) => $.features.inspector_goal_empty)}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {version && (
          <FeaturePill tone={version.status === "confirmed" ? "ok" : "wait"}>
            {t(($) => $.features.inspector_version_status, {
              status: version.status,
              version: version.version,
            })}
          </FeaturePill>
        )}
        {marks.total > 0 && (
          <FeaturePill tone={marks.ok === marks.total ? "ok" : "wait"}>
            {t(($) => $.features.marks_label)} {marks.ok}/{marks.total}
          </FeaturePill>
        )}
        {issue?.acceptance_round != null && (
          <FeaturePill tone={(issue.acceptance_round ?? 0) > 0 ? "warn" : "mute"}>
            {t(($) => $.features.accept_avg)} {issue.acceptance_round}
          </FeaturePill>
        )}
      </div>
    </section>
  );
}

function DetailsSection({
  features,
  selectedFp,
  onSelectFp,
  hasHotspots,
}: {
  features: DecoratedPrototypeFeature[];
  selectedFp: string | null;
  onSelectFp: (id: string) => void;
  hasHotspots: boolean;
}) {
  const { t } = useT("archive");
  return (
    <section className="px-3 py-3">
      <SectionHead
        title={t(($) => $.features.inspector_details)}
        index="②"
        meta={
          hasHotspots
            ? t(($) => $.features.inspector_interact_hint)
            : t(($) => $.features.inspector_interact_no_fp)
        }
      />
      {features.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(($) => $.features.inspector_fp_empty)}
        </p>
      ) : (
        <ol className="space-y-1.5">
          {features.map((feature, index) => {
            const active = selectedFp === feature.id;
            return (
              <li key={feature.id}>
                <button
                  type="button"
                  onClick={() => onSelectFp(feature.id)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
                    active
                      ? "border-primary bg-primary/8 shadow-[0_0_0_3px] shadow-primary/15"
                      : "border-surface-border bg-surface hover:border-primary/30 hover:bg-muted/30",
                  )}
                >
                  <span className="mt-0.5 w-4 shrink-0 text-[10px] font-bold text-muted-foreground">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate text-[11.5px] font-semibold">
                        {feature.title}
                      </span>
                      <KindChip kind={feature.kind} />
                      <MarkChip mark={feature.mark} />
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                      {feature.id}
                    </span>
                    {feature.text ? (
                      <span className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground">
                        {feature.text}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight
                    className={cn(
                      "mt-1 size-3 shrink-0 text-muted-foreground",
                      active && "text-primary",
                    )}
                  />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function SectionHead({
  icon,
  title,
  index,
  meta,
}: {
  icon?: ReactNode;
  title: string;
  index?: string;
  meta?: string;
}) {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-1.5 text-[11px] font-bold">
        {index ? <span className="text-muted-foreground">{index}</span> : icon}
        {title}
      </div>
      {meta ? (
        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{meta}</p>
      ) : null}
    </div>
  );
}

function KindChip({ kind }: { kind?: FeaturePointKind }) {
  const { t } = useT("archive");
  if (!kind) {
    return (
      <span className="rounded px-1 py-px text-[9px] font-bold bg-muted text-muted-foreground">
        {t(($) => $.features.inspector_kind_unset)}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "rounded px-1 py-px text-[9px] font-bold",
        kind === "new" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
        kind === "modify" && "bg-primary/15 text-primary",
      )}
    >
      {kind === "new"
        ? t(($) => $.features.inspector_kind_new)
        : t(($) => $.features.inspector_kind_modify)}
    </span>
  );
}

function MarkChip({ mark }: { mark?: PrototypeMark }) {
  const { t } = useT("archive");
  if (!mark) return null;
  const tone =
    mark.verdict === "ok" ? "ok" : mark.verdict === "no" ? "warn" : "wait";
  const label =
    mark.verdict === "ok"
      ? t(($) => $.features.inspector_mark_ok)
      : mark.verdict === "no"
        ? t(($) => $.features.inspector_mark_no)
        : t(($) => $.features.inspector_mark_pending);
  return <FeaturePill tone={tone}>{label}</FeaturePill>;
}
