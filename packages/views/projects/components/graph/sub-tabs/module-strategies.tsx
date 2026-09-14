"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { moduleStrategiesOptions } from "@multica/core/graph/queries";
import { useT } from "../../../../i18n";
import {
  FeaturePane,
  FeaturePill,
  FeatureTable,
  FeatureTd,
  FeatureTh,
  featurePillTone,
} from "../feature-chrome";
import { useGraphData } from "../graph-data-provider";
import { strategyRows } from "../module-feature-stats";
import { QueryError, QueryLoading } from "../../archive/query-states";

/**
 * f11 子TAB 4 · 模块策略（S1–S10）。本体未抽取时只展示降级条 + 实证表，
 * 不再叠一层巨大空态。
 */
export function ModuleStrategiesTab({ nodeId }: { nodeId: string }) {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId } = useGraphData();

  const query = useQuery({
    ...moduleStrategiesOptions(wsId, projectId, nodeId),
    placeholderData: keepPreviousData,
  });

  if (query.isPending) {
    return <QueryLoading rows={3} />;
  }
  if (query.isError) {
    return <QueryError onRetry={() => void query.refetch()} />;
  }

  const { strategies: rawStrategies, ontology_ready } = query.data;
  const strategies = strategyRows(rawStrategies);
  const degraded = ontology_ready !== "ready";

  return (
    <FeaturePane
      tag="子TAB 4"
      title={`${t(($) => $.features.strategies_title)}（S1–S10）`}
      meta={t(($) => $.features.strategies_ready)}
    >
      <div className="space-y-2">
        {degraded && (
          <div
            role="status"
            className="rounded-[7px] border border-dashed border-surface-border bg-muted/30 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground"
          >
            {t(($) => $.features.strategies_degraded_hint)}
          </div>
        )}

        {strategies.length === 0 ? (
          !degraded && (
            <p className="py-2 text-[11px] text-muted-foreground">
              {t(($) => $.features.strategies_empty)}
            </p>
          )
        ) : (
          <FeatureTable>
            <thead>
              <tr>
                <FeatureTh>{t(($) => $.features.col_strategy)}</FeatureTh>
                <FeatureTh>{t(($) => $.features.col_value)}</FeatureTh>
                <FeatureTh>{t(($) => $.features.col_source)}</FeatureTh>
                <FeatureTh>{t(($) => $.features.col_status)}</FeatureTh>
              </tr>
            </thead>
            <tbody>
              {strategies.map((strategy) => (
                <tr key={`${strategy.key}:${strategy.source}`}>
                  <FeatureTd mono>{strategy.key}</FeatureTd>
                  <FeatureTd className="max-w-[260px] truncate">{strategy.value}</FeatureTd>
                  <FeatureTd className="text-muted-foreground">{strategy.source}</FeatureTd>
                  <FeatureTd>
                    <FeaturePill tone={featurePillTone(strategy.status || (degraded ? "wait" : "ok"))}>
                      {strategy.status || (degraded ? t(($) => $.features.ontology_empty) : "—")}
                    </FeaturePill>
                  </FeatureTd>
                </tr>
              ))}
            </tbody>
          </FeatureTable>
        )}
      </div>
    </FeaturePane>
  );
}
