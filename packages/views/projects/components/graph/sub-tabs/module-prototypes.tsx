"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link2, PanelsTopLeft, Pencil, Sparkles } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectArtifactsOptions } from "@multica/core/artifacts/queries";
import {
  graphModulesOptions,
  moduleNeighborhoodOptions,
  moduleObjectsOptions,
  projectIssuesForModulesOptions,
} from "@multica/core/graph/queries";
import { useChatStore } from "@multica/core/chat";
import { useCreateComment } from "@multica/core/issues/mutations";
import {
  modulePrototypeVersionsOptions,
  moduleWorkspaceOptions,
} from "@multica/core/projects";
import type {
  Issue,
  ProjectArtifact,
  PrototypeVersion,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../../i18n";
import { useGraphData } from "../graph-data-provider";
import { ArtifactPreviewPane } from "../../archive/artifact-preview-pane";
import { useArchivePreviewSource } from "../../archive/use-archive-preview-source";
import {
  artifactForPrototypeVersion,
  diffFeaturePoints,
  issueShortLabel,
  issuesForModule,
  markRollup,
  matchNodesForFeaturePoint,
  matchObjectForFeaturePoint,
  moduleRequirements,
  pickPrototypePair,
  shortChipDate,
  extractPrototypeModules,
} from "../module-feature-stats";
import {
  collapseHtmlDiff,
  diffHtmlLines,
  htmlDiffStats,
  type HtmlDiffRow,
} from "../prototype-html-diff";
import { useIssuePrototypeVersions } from "../use-module-prototypes";
import { PrototypeManageDialog } from "./prototype-manage-dialog";
import { PrototypeBuildDialog } from "./prototype-build-dialog";
import { PrototypeInspector } from "./prototype-inspector";
import {
  directoryFilesForPath,
  usePageSurfaceContext,
} from "../../../../chat/lib/page-surface-context";
import { isContractPrototypeHtml } from "../../archive/archive-html-preview";
import { hasStorybookDemo, StorybookPane } from "./storybook-demos/storybook-pane";
import { storybookDemoForModule } from "./storybook-demos/catalog";
import { StorybookDemoCanvas } from "./storybook-demos/canvases";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../../archive/query-states";

type PreviewKind = "html" | "storybook";
type ViewMode = "single" | "compare";
type CompareLayer = "preview" | "modules" | "html";
type FpDiff = ReturnType<typeof diffFeaturePoints>[number];

/**
 * 画面 14 / 15：issue_prototype_version 为权威。
 * HTML 态：单版预览 + 并排 data-fp 对比 / 变更摘要 / 影响子模块。
 * Storybook 态：代码本体平台页面模块走本地演示画布；其余模块无 discoverViews 则诚实空态。
 */
export function ModulePrototypesTab({ nodeId }: { nodeId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId } = useGraphData();
  const [preview, setPreview] = useState<PreviewKind>("html");
  const [mode, setMode] = useState<ViewMode>("single");
  const [compareLayer, setCompareLayer] = useState<CompareLayer>("modules");
  const [issueId, setIssueId] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [selectedFp, setSelectedFp] = useState<string | null>(null);
  const [manage, setManage] = useState<"associate" | "update" | null>(null);
  const [buildOpen, setBuildOpen] = useState(false);
  const setPageContext = usePageSurfaceContext((state) => state.setContext);

  const modulesQuery = useQuery(graphModulesOptions(wsId, projectId));
  const issuesQuery = useQuery(projectIssuesForModulesOptions(wsId, projectId));
  const artifactsQuery = useQuery(projectArtifactsOptions(wsId, projectId));
  const objectsQuery = useQuery(moduleObjectsOptions(wsId, projectId, nodeId));
  const neighborhoodQuery = useQuery(moduleNeighborhoodOptions(wsId, projectId, nodeId));

  const module = (modulesQuery.data?.modules ?? []).find((row) => row.graph_node_id === nodeId);
  // 草案 = 说明轴里还没成对发布的版本数（画面 1 的「草案 n」）。
  const workspaceQuery = useQuery({
    ...moduleWorkspaceOptions(wsId, projectId, module?.id),
    retry: false,
  });
  const draftCount = useMemo(() => {
    const workspace = workspaceQuery.data;
    if (!workspace) return 0;
    const releasedTo = workspace.releases.reduce(
      (max, row) => Math.max(max, row.brief_version),
      0,
    );
    return workspace.versions.filter((row) => row.version > releasedTo).length;
  }, [workspaceQuery.data]);
  const reqs = module
    ? moduleRequirements(issuesForModule(issuesQuery.data ?? [], projectId, module.id))
    : [];
  const reqIds = reqs.map((issue) => issue.id);
  const versionsQuery = useIssuePrototypeVersions(reqIds);
  // 模块自己登记过的原型（可无关联需求）：需求轴为空时用它兜底，
  // 否则「有原型、没需求」的模块会同时呈现空预览 + 空右栏。
  const moduleProtosQuery = useQuery({
    ...modulePrototypeVersionsOptions(wsId, projectId, module?.id),
    retry: false,
  });
  const moduleFallback = useMemo<PrototypeVersion | null>(() => {
    const rows = moduleProtosQuery.data?.versions ?? [];
    if (rows.length === 0) return null;
    const canonical = moduleProtosQuery.data?.canonical_prototype_version ?? null;
    const owned =
      (canonical === null ? undefined : rows.find((row) => row.version === canonical)) ??
      rows.reduce((max, row) => (row.version > max.version ? row : max), rows[0]!);
    return {
      id: owned.id,
      issue_id: owned.issue_id ?? "",
      version: owned.version,
      html_path: owned.html_path,
      prompt: owned.prompt,
      marks: [],
      status: owned.status,
      created_by_type: "system",
      created_by_id: null,
      created_at: owned.created_at,
    };
  }, [moduleProtosQuery.data]);

  const reqsWithVersions = reqs.filter((issue) => (versionsQuery.byIssue.get(issue.id)?.length ?? 0) > 0);
  const activeIssue =
    reqs.find((issue) => issue.id === issueId) ??
    reqsWithVersions[0] ??
    reqs[0];
  const versions = activeIssue ? (versionsQuery.byIssue.get(activeIssue.id) ?? []) : [];
  const pair = pickPrototypePair(versions);
  const current =
    versions.find((row) => row.id === currentId) ?? pair.current ?? moduleFallback ?? undefined;
  const baseline =
    versions.find((row) => row.id === baselineId && row.id !== current?.id) ??
    (pair.baseline?.id === current?.id ? undefined : pair.baseline);

  useEffect(() => {
    if (!reqs.length) return;
    if (!issueId || !reqs.some((issue) => issue.id === issueId)) {
      const next = reqsWithVersions[0] ?? reqs[0];
      if (next) setIssueId(next.id);
    }
  }, [issueId, reqs, reqsWithVersions]);

  useEffect(() => {
    if (pair.current && (!currentId || !versions.some((row) => row.id === currentId))) {
      setCurrentId(pair.current.id);
    }
  }, [currentId, pair.current, versions]);

  useEffect(() => {
    const fallback = pair.baseline && pair.baseline.id !== current?.id ? pair.baseline : undefined;
    if (!fallback) return;
    if (!baselineId || baselineId === current?.id || !versions.some((row) => row.id === baselineId)) {
      setBaselineId(fallback.id);
    }
  }, [baselineId, current?.id, pair.baseline, versions]);

  const artifacts = artifactsQuery.data ?? [];
  const stub = { workspace_id: wsId, project_id: projectId };
  const currentArtifact = current
    ? artifactForPrototypeVersion(current, artifacts, stub)
    : null;
  const baselineArtifact = baseline
    ? artifactForPrototypeVersion(baseline, artifacts, stub)
    : null;
  const currentSource = useArchivePreviewSource({
    artifact: currentArtifact,
    projectId,
    archiveRoots: [],
    enabled: Boolean(currentArtifact),
  });
  const currentHtml = currentSource.status === "ready" ? (currentSource.text ?? "") : "";
  const inspectorPoints = useMemo(() => extractPrototypeModules(currentHtml), [currentHtml]);

  useEffect(() => {
    setPageContext({
      surface: "prototype",
      projectId,
      moduleName: module?.name,
      version: current?.version,
      htmlPath: current?.html_path,
      html: currentHtml || undefined,
      directoryFiles: directoryFilesForPath(
        current?.html_path,
        artifacts.map((row) => row.rel_path),
      ),
    });
    useChatStore.getState().setSelectedProjectId(projectId);
    return () => setPageContext(null);
  }, [
    artifacts,
    current?.html_path,
    current?.version,
    currentHtml,
    module?.name,
    projectId,
    setPageContext,
  ]);

  const maxVersion = Math.max(
    versions.reduce((max, row) => Math.max(max, row.version), 0),
    moduleFallback?.version ?? 0,
  );
  const inflight = reqs.filter((issue) => issue.id !== activeIssue?.id);

  if (modulesQuery.isPending || issuesQuery.isPending || versionsQuery.pending) {
    return <QueryLoading rows={5} />;
  }
  if (modulesQuery.isError || issuesQuery.isError || versionsQuery.error) {
    return (
      <QueryError
        onRetry={() => {
          void modulesQuery.refetch();
          void issuesQuery.refetch();
          versionsQuery.refetch();
        }}
      />
    );
  }

  const canPreview = Boolean(current && currentArtifact);
  const designedPrototype = storybookDemoForModule(module?.graph_node_id ?? nodeId);
  const showDesignedPrototype =
    Boolean(designedPrototype) &&
    currentSource.status === "ready" &&
    isContractPrototypeHtml(currentHtml);
  const canCompare = versions.length >= 2 && Boolean(baseline && baselineArtifact);
  const viewMode = preview === "html" && canCompare && mode === "compare" ? "compare" : "single";
  const toolbarIssue = activeIssue;
  const storyReady = hasStorybookDemo(module?.graph_node_id ?? nodeId);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[10px] border border-surface-border bg-surface" data-testid="module-prototypes">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-surface-border bg-muted/25 px-3 py-2">
        <span className="text-[11px] font-bold">{t(($) => $.features.prototypes_title)}</span>
        {draftCount > 0 ? (
          <span className="rounded-full bg-amber-500/15 px-1.5 py-px text-[8.5px] font-bold text-amber-700 dark:text-amber-400">
            {t(($) => $.features.prototypes_draft, { n: draftCount })}
          </span>
        ) : null}
        <span className="ml-auto truncate font-mono text-[9px] font-semibold text-muted-foreground">
          {toolbarIssue ? issueShortLabel(toolbarIssue) : t(($) => $.features.prototypes_ready)}
          {maxVersion > 0 ? ` · v${maxVersion}` : ""}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-3">
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 rounded-[10px] border border-surface-border bg-muted/15 px-2.5 py-1.5">
          <Seg
            value={preview}
            onChange={setPreview}
            options={[
              { id: "html", label: t(($) => $.features.preview_html) },
              { id: "storybook", label: t(($) => $.features.preview_storybook) },
            ]}
          />
          {reqs.length > 0 && toolbarIssue && preview === "html" && (
            <CompactSelect
              label={t(($) => $.features.req_filter)}
              ariaLabel={t(($) => $.features.req_filter)}
              value={toolbarIssue.id}
              onChange={setIssueId}
              options={reqs.map((issue) => ({
                id: issue.id,
                label: issueShortLabel(issue),
              }))}
            />
          )}
          {preview === "html" && versions.length > 0 && (
            <Seg
              value={viewMode}
              onChange={(next) => {
                if (next === "compare" && versions.length < 2) return;
                setMode(next);
                if (next === "compare") setCompareLayer("modules");
              }}
              disabledIds={versions.length < 2 ? ["compare"] : []}
              options={[
                { id: "single", label: t(($) => $.features.prototypes_single) },
                { id: "compare", label: t(($) => $.features.prototypes_compare) },
              ]}
            />
          )}
          {preview === "html" && versions.length > 0 && current && (
            <CompactSelect
              label={viewMode === "compare" ? t(($) => $.features.version_current) : t(($) => $.features.version_label)}
              ariaLabel={t(($) => $.features.version_current)}
              value={current.id}
              onChange={(id) => {
                setCurrentId(id);
                if (id === baseline?.id) {
                  const other = pair.sorted.find((row) => row.id !== id);
                  if (other) setBaselineId(other.id);
                }
              }}
              options={pair.sorted.map((version) => ({
                id: version.id,
                label: versionOptionLabel(version),
              }))}
            />
          )}
          {preview === "html" && viewMode === "compare" && versions.length > 1 && (
            <CompactSelect
              label={t(($) => $.features.version_baseline)}
              ariaLabel={t(($) => $.features.version_baseline)}
              value={baseline?.id ?? ""}
              onChange={(id) => {
                if (id === current?.id) return;
                setBaselineId(id);
              }}
              options={pair.sorted
                .filter((version) => version.id !== current?.id)
                .map((version) => ({
                  id: version.id,
                  label: versionOptionLabel(version),
                }))}
            />
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button type="button" size="xs" variant="outline" onClick={() => setBuildOpen(true)}>
              <Sparkles className="size-3.5" />
              {t(($) => $.features.build_title)}
            </Button>
            {reqs.length > 0 && (
              <Button type="button" size="xs" variant="outline" onClick={() => setManage("associate")}>
                <Link2 className="size-3.5" />
                {t(($) => $.features.associate)}
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!current}
              onClick={() => setManage("update")}
            >
              <Pencil className="size-3.5" />
              {t(($) => $.features.update_file)}
            </Button>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {preview === "storybook" ? (
              storyReady || canPreview ? (
                <StorybookPane
                  projectId={projectId}
                  graphNodeId={module?.graph_node_id ?? nodeId}
                  version={current ?? undefined}
                  artifact={currentArtifact}
                  selectedFp={selectedFp}
                  onSelectFp={setSelectedFp}
                  objects={objectsQuery.data?.objects ?? []}
                  nodes={neighborhoodQuery.data?.nodes ?? []}
                  edges={neighborhoodQuery.data?.edges ?? []}
                />
              ) : (
                <ArchiveEmpty
                  icon={<PanelsTopLeft className="size-5" />}
                  title={t(($) => $.features.preview_storybook)}
                  description={t(($) => $.features.storybook_empty_module)}
                />
              )
            ) : !canPreview ? (
              <ArchiveEmpty
                icon={<PanelsTopLeft className="size-5" />}
                title={t(($) => $.features.prototypes_title)}
                description={t(($) => $.features.prototypes_empty)}
              />
            ) : viewMode === "single" && current && showDesignedPrototype && designedPrototype?.stories[0] ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-surface-border bg-white">
                <PvBar
                  label={`${fileName(current.html_path)} · v${current.version}`}
                  badge={t(($) => $.features.prototypes_current)}
                />
                <div className="min-h-0 flex-1">
                  <StorybookDemoCanvas
                    communityId={designedPrototype.communityId}
                    story={designedPrototype.stories[0]}
                    selectedFp={selectedFp}
                    onSelectFp={setSelectedFp}
                  />
                </div>
              </div>
            ) : viewMode === "single" && current && currentArtifact ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-surface-border bg-white">
                <PvBar
                  label={`${fileName(current.html_path)} · v${current.version}`}
                  badge={t(($) => $.features.prototypes_current)}
                />
                <div className="relative min-h-0 flex-1">
                  <ArtifactPreviewPane
                    artifact={currentArtifact}
                    projectId={projectId}
                    archiveRoots={[]}
                    embedded
                    interact
                    highlightFp={selectedFp}
                    onSelectFp={setSelectedFp}
                  />
                </div>
              </div>
            ) : current && currentArtifact ? (
              <HtmlComparePane
                projectId={projectId}
                current={current}
                baseline={baseline ?? current}
                currentArtifact={currentArtifact}
                baselineArtifact={baselineArtifact ?? currentArtifact}
                layer={compareLayer}
                onLayerChange={setCompareLayer}
                selectedFp={selectedFp}
                onSelectFp={setSelectedFp}
                objects={objectsQuery.data?.objects ?? []}
                nodes={neighborhoodQuery.data?.nodes ?? []}
                inflight={inflight}
                issue={activeIssue}
              />
            ) : (
              <ArchiveEmpty
                icon={<PanelsTopLeft className="size-5" />}
                title={t(($) => $.features.prototypes_title)}
                description={t(($) => $.features.prototypes_empty)}
              />
            )}
          </div>
          {preview === "html" ? (
            <PrototypeInspector
              projectId={projectId}
              moduleId={module?.id}
              moduleName={module?.name}
              issue={activeIssue}
              allIssues={issuesQuery.data ?? []}
              preview={
                current
                  ? {
                      version: Number(current.version),
                      htmlPath: current.html_path,
                      issueId: activeIssue?.id,
                    }
                  : undefined
              }
              points={inspectorPoints}
              selectedFp={selectedFp}
              onSelectFp={setSelectedFp}
              html={currentHtml}
            />
          ) : null}
        </div>
      </div>

      <PrototypeBuildDialog
        open={buildOpen}
        onOpenChange={setBuildOpen}
        projectId={projectId}
        moduleName={module?.name}
      />
      {manage && (
        <PrototypeManageDialog
          key={`${manage}-${toolbarIssue?.id ?? ""}-${current?.id ?? ""}`}
          open
          mode={manage}
          onOpenChange={(open) => {
            if (!open) setManage(null);
          }}
          projectId={projectId}
          workspaceId={wsId}
          issues={reqs}
          issueId={toolbarIssue?.id ?? reqs[0]?.id ?? null}
          version={manage === "update" ? current : undefined}
          artifacts={artifacts}
        />
      )}
    </div>
  );
}

function HtmlComparePane({
  projectId,
  current,
  baseline,
  currentArtifact,
  baselineArtifact,
  layer,
  onLayerChange,
  selectedFp,
  onSelectFp,
  objects,
  nodes,
  inflight,
  issue,
}: {
  projectId: string;
  current: PrototypeVersion;
  baseline: PrototypeVersion;
  currentArtifact: ProjectArtifact;
  baselineArtifact: ProjectArtifact;
  layer: CompareLayer;
  onLayerChange: (layer: CompareLayer) => void;
  selectedFp: string | null;
  onSelectFp: (id: string) => void;
  objects: import("@multica/core/types").OntologyObject[];
  nodes: import("@multica/core/types").GraphNode[];
  inflight: Issue[];
  issue?: Issue;
}) {
  const { t } = useT("archive");
  const left = useArchivePreviewSource({
    artifact: baselineArtifact,
    projectId,
    archiveRoots: [],
    enabled: true,
  });
  const right = useArchivePreviewSource({
    artifact: currentArtifact,
    projectId,
    archiveRoots: [],
    enabled: true,
  });
  const leftHtml = left.status === "ready" ? (left.text ?? "") : "";
  const rightHtml = right.status === "ready" ? (right.text ?? "") : "";
  const diffs = useMemo(
    () => diffFeaturePoints(extractPrototypeModules(leftHtml), extractPrototypeModules(rightHtml)),
    [leftHtml, rightHtml],
  );
  const htmlLines = useMemo(() => diffHtmlLines(leftHtml, rightHtml), [leftHtml, rightHtml]);
  const htmlRows = useMemo(() => collapseHtmlDiff(htmlLines), [htmlLines]);
  const htmlStats = useMemo(() => htmlDiffStats(htmlLines), [htmlLines]);
  const changed = diffs.filter((row) => row.kind !== "same");
  const marks = markRollup(current.marks);
  const ready = left.status === "ready" && right.status === "ready";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold text-muted-foreground">
          {t(($) => $.features.compare_layer)}
        </span>
        <Seg
          value={layer}
          onChange={onLayerChange}
          options={[
            { id: "preview", label: t(($) => $.features.compare_preview) },
            {
              id: "modules",
              label: `${t(($) => $.features.compare_modules)}${changed.length ? ` · ${changed.length}` : ""}`,
            },
            {
              id: "html",
              label: `${t(($) => $.features.compare_html)} · ${t(($) => $.features.html_diff_stats, htmlStats)}`,
            },
          ]}
        />
      </div>
      {layer === "preview" ? (
        <div className="grid min-h-0 flex-1 overflow-hidden rounded-[10px] border border-surface-border sm:grid-cols-2">
          <CompareColumn
            projectId={projectId}
            artifact={baselineArtifact}
            label={`${fileName(baseline.html_path)} · v${baseline.version}`}
            badge={t(($) => $.features.prototypes_baseline)}
            points={diffs}
            side="left"
            selectedFp={selectedFp}
            onSelect={onSelectFp}
          />
          <CompareColumn
            projectId={projectId}
            artifact={currentArtifact}
            label={`${fileName(current.html_path)} · v${current.version}`}
            badge={t(($) => $.features.prototypes_current)}
            badgeClass="text-emerald-600 dark:text-emerald-400"
            points={diffs}
            side="right"
            selectedFp={selectedFp}
            onSelect={onSelectFp}
          />
        </div>
      ) : layer === "html" ? (
        <HtmlCodeDiff rows={htmlRows} ready={ready} />
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 overflow-auto lg:grid-cols-2">
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-[11.5px] font-semibold">
              {`${t(($) => $.features.change_summary)} v${baseline.version} → v${current.version}`}
              <span className="ml-auto text-[10px] font-normal text-muted-foreground">
                {t(($) => $.features.change_summary_auto)}
              </span>
            </div>
            {!ready ? (
              <QueryLoading rows={3} />
            ) : changed.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{t(($) => $.features.module_diff_empty)}</p>
            ) : (
              changed.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => onSelectFp(row.id)}
                  className={cn(
                    "mb-1 flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[11px]",
                    selectedFp === row.id ? "bg-primary/10" : "hover:bg-muted/40",
                  )}
                >
                  <KindTag kind={row.kind} />
                  <span className="font-mono text-[10px]">{row.id}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {row.title}
                    {row.text ? ` · ${row.text}` : ""}
                  </span>
                </button>
              ))
            )}
            {marks.total > 0 && (
              <div className="mt-1 flex items-center gap-2 px-1 py-1 text-[11px]">
                <KindTag kind="same" label={t(($) => $.features.marks_label)} />
                <span className="text-muted-foreground">
                  {"✓ "}
                  {marks.ok}/{marks.total}
                </span>
              </div>
            )}
            {issue && changed.length > 0 && (
              <WriteSummaryButton
                issueId={issue.id}
                body={summaryMarkdown(baseline.version, current.version, changed, htmlStats)}
              />
            )}
          </div>
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-[11.5px] font-semibold">
              {t(($) => $.features.impact_title)}
              <span className="ml-auto text-[10px] font-normal text-muted-foreground">
                {t(($) => $.features.impact_via)}
              </span>
            </div>
            {changed.map((row) => {
              const object = matchObjectForFeaturePoint(row.id, objects);
              const graphHits = matchNodesForFeaturePoint(row.id, nodes);
              const safe = !object && graphHits.length === 0;
              return (
                <div
                  key={row.id}
                  className={cn(
                    "mb-1.5 flex items-center gap-1.5 rounded-[7px] border border-surface-border bg-surface px-2 py-1.5 text-[10.5px]",
                    safe && "opacity-65",
                  )}
                >
                  <KindTag kind={row.kind} />
                  <span className="font-mono text-[9.5px]">{row.id}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {object
                      ? object.qualified_name
                      : graphHits[0]
                        ? (graphHits[0].qualified_name ?? graphHits[0].name)
                        : t(($) => $.features.impact_safe)}
                  </span>
                </div>
              );
            })}
            {inflight.length > 0 && (
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                {t(($) => $.features.impact_inflight)}
                {": "}
                {inflight.map((row) => issueShortLabel(row)).join(" · ")}
              </p>
            )}
          </div>
        </div>
      )}
      <p className="shrink-0 text-[10.5px] leading-relaxed text-muted-foreground">
        {t(($) => $.features.align_hint)}
      </p>
    </div>
  );
}

function HtmlCodeDiff({ rows, ready }: { rows: HtmlDiffRow[]; ready: boolean }) {
  const { t } = useT("archive");
  if (!ready) return <QueryLoading rows={6} />;
  if (rows.length === 0) {
    return (
      <p className="rounded-[10px] border border-dashed border-surface-border px-3 py-8 text-center text-[11px] text-muted-foreground">
        {t(($) => $.features.html_diff_empty)}
      </p>
    );
  }
  return (
    <pre className="min-h-0 flex-1 overflow-auto rounded-[10px] border border-surface-border bg-[#0f1115] p-3 font-mono text-[11px] leading-relaxed text-[#d7dae0]">
      {rows.map((row, index) => {
        if (row.kind === "skip") {
          return (
            <div key={`skip-${index}`} className="py-1 text-center text-[10px] text-muted-foreground">
              {t(($) => $.features.html_diff_skip, { count: row.count })}
            </div>
          );
        }
        return (
          <div
            key={`${row.kind}-${row.leftNo ?? "x"}-${row.rightNo ?? "x"}-${index}`}
            className={cn(
              "whitespace-pre-wrap break-all",
              row.kind === "added" && "bg-emerald-500/15 text-emerald-300",
              row.kind === "removed" && "bg-destructive/20 text-red-300",
            )}
          >
            <span className="inline-block w-6 text-muted-foreground">
              {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
            </span>
            {row.text || " "}
          </div>
        );
      })}
    </pre>
  );
}

function CompareColumn({
  projectId,
  artifact,
  label,
  badge,
  badgeClass,
  points,
  side,
  selectedFp,
  onSelect,
}: {
  projectId: string;
  artifact: ProjectArtifact;
  label: string;
  badge: string;
  badgeClass?: string;
  points: FpDiff[];
  side: "left" | "right";
  selectedFp: string | null;
  onSelect: (id: string) => void;
}) {
  const visible = points.filter((row) => (side === "left" ? row.kind !== "added" : row.kind !== "removed"));
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", side === "left" && "border-r border-surface-border")}>
      <PvBar label={label} badge={badge} badgeClass={badgeClass} />
      <div className="relative min-h-0 flex-[1.4] overflow-hidden border-b border-surface-border bg-white">
        <ArtifactPreviewPane
          artifact={artifact}
          projectId={projectId}
          archiveRoots={[]}
          embedded
          interact
          highlightFp={selectedFp}
          onSelectFp={onSelect}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto bg-[oklch(0.98_0.002_286)] p-3 dark:bg-muted/20">
        {visible.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => onSelect(row.id)}
            className={spotClass(selectedFp === row.id ? "sel" : row.kind)}
          >
            <span className="mb-0.5 block font-mono text-[9px] text-muted-foreground">
              {row.id} · {row.title}
            </span>
            {row.text}
            <span className="absolute right-1.5 top-1.5">
              <KindTag kind={row.kind} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PvBar({
  label,
  badge,
  badgeClass,
}: {
  label: string;
  badge?: string;
  badgeClass?: string;
}) {
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-1.5 border-b border-surface-border bg-muted/50 px-2.5">
      <i className="size-2 rounded-full bg-muted-foreground/30" />
      <i className="size-2 rounded-full bg-muted-foreground/30" />
      <i className="size-2 rounded-full bg-muted-foreground/30" />
      <span className="ml-1.5 truncate font-mono text-[10.5px] text-muted-foreground">{label}</span>
      {badge ? (
        <span className={cn("ml-auto text-[9.5px] font-bold text-muted-foreground", badgeClass)}>
          {badge}
        </span>
      ) : null}
    </div>
  );
}

function spotClass(kind: FpDiff["kind"] | "sel" | "plain"): string {
  return cn(
    "relative rounded-lg border-[1.5px] border-dashed border-muted-foreground/25 bg-surface px-2.5 py-2 text-left text-[11px]",
    kind === "same" && "border-solid opacity-55",
    kind === "added" && "border-emerald-500/55 bg-emerald-500/5",
    kind === "modified" && "border-primary/55 bg-primary/5",
    kind === "removed" && "border-destructive/50 bg-destructive/5",
    kind === "sel" && "border-solid border-primary shadow-[0_0_0_3px] shadow-primary/20",
  );
}

function Seg<T extends string>({
  value,
  onChange,
  options,
  disabledIds = [],
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ id: T; label: string }>;
  disabledIds?: T[];
}) {
  return (
    <div className="flex rounded-lg border border-surface-border bg-surface p-0.5">
      {options.map((option) => (
        <Button
          key={option.id}
          type="button"
          size="xs"
          variant={value === option.id ? "secondary" : "ghost"}
          disabled={disabledIds.includes(option.id)}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function CompactSelect({
  label,
  ariaLabel,
  value,
  onChange,
  options,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ id: string; label: string }>;
}) {
  return (
    <label className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg border border-surface-border bg-surface px-2 text-[11px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 truncate bg-transparent text-[11px] outline-none"
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function versionOptionLabel(version: PrototypeVersion): string {
  const date = shortChipDate(version.created_at);
  const source = version.created_by_type === "agent" ? "agent" : version.created_by_type;
  const base = date ? `v${version.version} · ${version.status} · ${date}` : `v${version.version} · ${version.status}`;
  return source ? `${base} · ${source}` : base;
}

function KindTag({
  kind,
  label,
}: {
  kind: FpDiff["kind"];
  label?: string;
}) {
  const { t } = useT("archive");
  const text =
    label ??
    (kind === "added"
      ? t(($) => $.features.fp_added)
      : kind === "removed"
        ? t(($) => $.features.fp_removed)
        : kind === "modified"
          ? t(($) => $.features.fp_modified)
          : t(($) => $.features.fp_same));
  return (
    <span
      className={cn(
        "inline-block rounded px-1 py-px text-[9px] font-bold",
        kind === "added" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
        kind === "modified" && "bg-primary/15 text-primary",
        kind === "removed" && "bg-destructive/15 text-destructive",
        kind === "same" && "bg-muted text-muted-foreground",
      )}
    >
      {text}
    </span>
  );
}

function WriteSummaryButton({ issueId, body }: { issueId: string; body: string }) {
  const { t } = useT("archive");
  const create = useCreateComment(issueId);
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="mt-2"
      disabled={create.isPending}
      onClick={() => {
        create.mutate(
          { content: body },
          {
            onSuccess: () => toast.success(t(($) => $.features.write_comment_ok)),
            onError: (error) => toast.error(String(error) || t(($) => $.features.write_comment_failed)),
          },
        );
      }}
    >
      {t(($) => $.features.write_comment)}
    </Button>
  );
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function summaryMarkdown(
  from: number,
  to: number,
  rows: FpDiff[],
  html: { added: number; removed: number },
): string {
  const lines = rows.map((row) => `- ${row.kind} \`${row.id}\` ${row.title}${row.text ? ` · ${row.text}` : ""}`);
  return `变更摘要 v${from} → v${to}\n\n模块细节：\n${lines.join("\n") || "- 无"}\n\nHTML 代码：+${html.added} / -${html.removed}`;
}
