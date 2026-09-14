"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { moduleObjectsOptions } from "@multica/core/graph/queries";
import { useT } from "../../../../i18n";
import {
  FeatureEdge,
  FeaturePane,
  FeaturePill,
  FeatureTable,
  FeatureTd,
  FeatureTh,
  TypeChip,
  featurePillTone,
} from "../feature-chrome";
import { useGraphData } from "../graph-data-provider";
import {
  objectKind,
  objectTables,
  parseObjectProperties,
} from "../module-feature-stats";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../../archive/query-states";

export function ModuleObjectsTab({ nodeId }: { nodeId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId, snapshot } = useGraphData();
  const query = useQuery({
    ...moduleObjectsOptions(wsId, projectId, nodeId),
    placeholderData: keepPreviousData,
  });

  if (query.isPending) return <QueryLoading rows={4} />;
  if (query.isError) return <QueryError onRetry={() => void query.refetch()} />;

  const { objects, obj_count, tables_touched } = query.data;
  const summary = snapshot?.module_summary.find((row) => row.node_id === nodeId);
  const kinds = new Map<string, number>();
  for (const obj of objects) {
    const kind = objectKind(parseObjectProperties(obj.properties), obj.entity_type);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }

  return (
    <FeaturePane
      tag="子TAB 3"
      title={t(($) => $.features.objects_title)}
      meta={t(($) => $.features.objects_neighborhood, {
        id: nodeId.replace(/^comm-/, ""),
        count: objects.length || obj_count,
      })}
    >
      <div className="space-y-2">
        {kinds.size > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-surface-border px-2 py-1 text-[10.5px]">
            {[...kinds.entries()].map(([kind, count], index) => (
              <span key={kind} className="inline-flex items-center gap-1">
                {index > 0 ? <span className="text-muted-foreground">·</span> : null}
                <TypeChip muted={index > 0}>{kind}</TypeChip>
                {count}
              </span>
            ))}
            <span className="ml-auto text-[9px] text-muted-foreground">
              {t(($) => $.features.member_of)}
            </span>
          </div>
        )}
        {summary && (
          <FeatureEdge>
            {t(($) => $.features.calls_stat, {
              internal: summary.edge_stats.calls_internal,
              external: summary.edge_stats.calls_external,
            })}
          </FeatureEdge>
        )}
        {objects.length === 0 ? (
          <div className="space-y-2">
            <ArchiveEmpty
              icon={<Boxes className="size-5" />}
              title={t(($) => $.features.objects_title)}
              description={t(($) => $.features.objects_empty)}
              className="min-h-0 border-dashed py-6"
            />
            {tables_touched.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tables_touched.map((table) => (
                  <TypeChip key={table} muted>
                    {table}
                  </TypeChip>
                ))}
              </div>
            )}
          </div>
        ) : (
          <FeatureTable>
            <thead>
              <tr>
                <FeatureTh>{t(($) => $.features.objects_title)}</FeatureTh>
                <FeatureTh>{t(($) => $.features.col_type)}</FeatureTh>
                <FeatureTh>{t(($) => $.features.col_impl_status)}</FeatureTh>
                <FeatureTh>{t(($) => $.features.col_tables)}</FeatureTh>
              </tr>
            </thead>
            <tbody>
              {objects.map((obj) => {
                const props = parseObjectProperties(obj.properties);
                return (
                  <tr key={obj.id}>
                    <FeatureTd mono className="max-w-[240px] truncate">
                      {obj.qualified_name}
                    </FeatureTd>
                    <FeatureTd className="text-muted-foreground">
                      {objectKind(props, obj.entity_type)}
                    </FeatureTd>
                    <FeatureTd>
                      {obj.impl_status ? (
                        <FeaturePill tone={featurePillTone(obj.impl_status)}>
                          {obj.impl_status}
                        </FeaturePill>
                      ) : (
                        "—"
                      )}
                    </FeatureTd>
                    <FeatureTd mono className="text-muted-foreground">
                      {objectTables(props) || (obj.domain ?? "—")}
                    </FeatureTd>
                  </tr>
                );
              })}
            </tbody>
          </FeatureTable>
        )}
      </div>
    </FeaturePane>
  );
}
