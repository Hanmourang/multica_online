"use client";

import { useEffect, useState } from "react";
import { Badge } from "@multica/ui/components/ui/badge";
import type { GraphEdge, GraphNode, OntologyObject, ProjectArtifact, PrototypeVersion } from "@multica/core/types";
import { useT } from "../../../../../i18n";
import { useArchivePreviewSource } from "../../../archive/use-archive-preview-source";
import { QueryLoading } from "../../../archive/query-states";
import {
  extractFeaturePoints,
  matchNodesForFeaturePoint,
  matchObjectForFeaturePoint,
} from "../../module-feature-stats";
import { storybookDemoForModule, type StorybookDemo } from "./catalog";
import { StorybookDemoCanvas } from "./canvases";

export function StorybookPane({
  projectId,
  graphNodeId,
  version,
  artifact,
  selectedFp,
  onSelectFp,
  objects,
  nodes,
  edges,
}: {
  projectId: string;
  graphNodeId?: string | null;
  version?: PrototypeVersion;
  artifact?: ProjectArtifact | null;
  selectedFp: string | null;
  onSelectFp: (id: string) => void;
  objects: OntologyObject[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}) {
  const { t } = useT("archive");
  const demo = storybookDemoForModule(graphNodeId);
  const [storyId, setStoryId] = useState(demo?.stories[0]?.storyId ?? "");
  const story = demo?.stories.find((row) => row.storyId === storyId) ?? demo?.stories[0];

  useEffect(() => {
    setStoryId(demo?.stories[0]?.storyId ?? "");
  }, [demo]);

  const source = useArchivePreviewSource({
    artifact: artifact ?? null,
    projectId,
    archiveRoots: [],
    enabled: Boolean(artifact) && !demo,
  });

  const htmlPoints =
    !demo && source.status === "ready" ? extractFeaturePoints(source.text ?? "") : [];
  const points = story?.points ?? htmlPoints;
  const selected = points.find((point) => point.id === selectedFp) ?? points[0];
  const object = selected ? matchObjectForFeaturePoint(selected.id, objects) : undefined;
  const graphHits = selected ? matchNodesForFeaturePoint(selected.id, nodes) : [];

  if (!demo && artifact && source.status === "loading") return <QueryLoading rows={4} />;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-[10px] border border-surface-border">
      <div className="flex min-w-0 flex-1 flex-col">
        <PvBar
          label={story ? `storybook · ${story.storyId}` : `storybook · ${t(($) => $.features.no_story_id)}`}
          badge={demo ? t(($) => $.features.storybook_demo) : t(($) => $.features.contract_only)}
        />
        {demo && story ? (
          <>
            {demo.stories.length > 1 && (
              <div className="flex shrink-0 items-center gap-1.5 border-b border-surface-border bg-muted/20 px-2.5 py-1.5">
                <span className="text-[10px] text-muted-foreground">{t(($) => $.features.storybook_variant)}</span>
                {demo.stories.map((row) => (
                  <button
                    key={row.storyId}
                    type="button"
                    onClick={() => {
                      setStoryId(row.storyId);
                      onSelectFp(row.points[0]?.id ?? "");
                    }}
                    className={
                      row.storyId === story.storyId
                        ? "rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
                        : "rounded-md px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/60"
                    }
                  >
                    {row.variant}
                  </button>
                ))}
              </div>
            )}
            <div className="relative min-h-0 flex-1">
              <StorybookDemoCanvas
                communityId={demo.communityId}
                story={story}
                selectedFp={selected?.id ?? null}
                onSelectFp={onSelectFp}
              />
            </div>
          </>
        ) : points.length === 0 ? (
          <p className="p-3 text-[11px] text-muted-foreground">{t(($) => $.features.storybook_empty_module)}</p>
        ) : (
          <div className="flex flex-1 flex-col gap-2 overflow-auto bg-[oklch(0.98_0.002_286)] p-3 dark:bg-muted/20">
            {points.map((point) => {
              const hit = matchObjectForFeaturePoint(point.id, objects);
              const isActive = selected?.id === point.id;
              return (
                <button
                  key={point.id}
                  type="button"
                  onClick={() => onSelectFp(point.id)}
                  className={spotClass(isActive ? "sel" : hit ? "plain" : "same")}
                >
                  <span className="mb-0.5 block font-mono text-[9px] text-muted-foreground">{point.id}</span>
                  <span className="font-semibold">{point.title}</span>
                  <span className="ml-1 text-muted-foreground">{point.text}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="border-t border-surface-border bg-surface px-3 py-1.5 text-[10px] text-muted-foreground">
          {demo ? t(($) => $.features.storybook_demo_hint) : t(($) => $.features.hotspot_order)}
        </div>
      </div>
      <aside className="w-[clamp(220px,30%,380px)] shrink-0 overflow-auto border-l border-surface-border bg-muted/10">
        <section className="border-b border-surface-border p-3 text-[11.5px]">
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold">
            {"① "}
            {t(($) => $.features.storybook_anchor)}
            <span className="ml-auto text-[10px] font-normal text-muted-foreground">
              {t(($) => $.features.storybook_align)}
            </span>
          </div>
          {story ? (
            <div className="rounded-md border border-surface-border bg-surface px-2 py-2">
              <p className="font-mono text-[10.5px]">{story.storyId}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {"parameters.featurePointIds"}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-primary">
                {story.points.map((point) => point.id).join(" · ")}
              </p>
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-surface-border px-2 py-2 text-[11px] text-muted-foreground">
              {t(($) => $.features.storybook_unavailable)}
            </p>
          )}
        </section>
        <section className="border-b border-surface-border p-3 text-[11.5px]">
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold">
            {"② "}
            {t(($) => $.features.related_code)}
            <span className="ml-auto font-mono text-[10px] font-normal text-muted-foreground">
              {version?.status ?? t(($) => $.features.storybook_demo)}
            </span>
          </div>
          {object ? (
            <pre className="overflow-auto rounded-[9px] bg-[#0f1115] px-3 py-2 font-mono text-[10.5px] leading-relaxed text-[#d7dae0]">
              {`// ${object.qualified_name}\n// entity_type ${object.entity_type}${object.impl_status ? ` · ${object.impl_status}` : ""}`}
            </pre>
          ) : (
            <p className="text-[11px] text-muted-foreground">{t(($) => $.features.codehints_empty)}</p>
          )}
        </section>
        <section className="p-3 text-[11.5px]">
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold">
            {"③ "}
            {t(($) => $.features.graph_layer)}
            <span className="ml-auto text-[10px] font-normal text-muted-foreground">
              {t(($) => $.features.neighborhood_ready)}
            </span>
          </div>
          {graphHits.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t(($) => $.features.graph_contract)}</p>
          ) : (
            graphHits.map((node) => {
              const related = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
              return (
                <div key={node.id} className="mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="font-mono text-[10px]">{node.type}</Badge>
                    <span className="min-w-0 flex-1 truncate font-mono">{node.qualified_name ?? node.name}</span>
                  </div>
                  {related.slice(0, 2).map((edge, index) => (
                    <p key={`${edge.source}-${edge.target}-${index}`} className="pl-3 font-mono text-[10px] text-muted-foreground">
                      {"└ "}
                      {edge.type}
                    </p>
                  ))}
                </div>
              );
            })
          )}
        </section>
      </aside>
    </div>
  );
}

function PvBar({
  label,
  badge,
}: {
  label: string;
  badge?: string;
}) {
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-1.5 border-b border-surface-border bg-muted/50 px-2.5">
      <i className="size-2 rounded-full bg-muted-foreground/30" />
      <i className="size-2 rounded-full bg-muted-foreground/30" />
      <i className="size-2 rounded-full bg-muted-foreground/30" />
      <span className="ml-1.5 truncate font-mono text-[10.5px] text-muted-foreground">{label}</span>
      {badge ? (
        <span className="ml-auto text-[9.5px] font-bold text-muted-foreground">{badge}</span>
      ) : null}
    </div>
  );
}

function spotClass(kind: "sel" | "plain" | "same"): string {
  return [
    "relative rounded-lg border-[1.5px] border-dashed border-muted-foreground/25 bg-surface px-2.5 py-2 text-left text-[11px]",
    kind === "same" ? "border-solid opacity-55" : "",
    kind === "sel" ? "border-solid border-primary shadow-[0_0_0_3px] shadow-primary/20" : "",
  ].join(" ");
}

export function hasStorybookDemo(graphNodeId: string | null | undefined): boolean {
  return Boolean(storybookDemoForModule(graphNodeId));
}

export type { StorybookDemo };
