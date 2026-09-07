"use client";

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  latestGraphSnapshotOptions,
  moduleStrategiesOptions,
} from "@multica/core/graph/queries";
import type {
  BusMatrixCell,
  GraphSnapshotSummary,
  OntologyReadiness,
} from "@multica/core/types";

/**
 * Shared state for the graph-backed views (f10 产品功能 / f11 数据模型).
 *
 * Owns the latest-snapshot query — the single source for scan identity, the
 * module summary and the bus-matrix pre-aggregation — plus the two selection
 * states these tabs drive: the module picked in the left list and the matrix
 * cell picked in the grid. Ontology readiness piggybacks on the selected
 * module's strategies query; the strategies sub-tab reads the same query
 * key, so React Query dedupes this into one request (no fabricated state).
 */
interface GraphDataValue {
  projectId: string;
  /** Latest snapshot summary; null when the project was never scanned. */
  snapshot: GraphSnapshotSummary | null;
  snapshotLoading: boolean;
  snapshotError: boolean;
  refetchSnapshot: () => void;
  /** Community node id selected in the module list (f10). */
  selectedNodeId: string | null;
  setSelectedNodeId: (nodeId: string | null) => void;
  /** Matrix cell selected in the grid (f11 drilldown driver). */
  selectedCell: BusMatrixCell | null;
  setSelectedCell: (cell: BusMatrixCell | null) => void;
  /** Ontology readiness of the selected module; null before a selection. */
  ontologyReady: OntologyReadiness | null;
}

const GraphDataContext = createContext<GraphDataValue | null>(null);

export function GraphDataProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const wsId = useWorkspaceId();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<BusMatrixCell | null>(null);

  const snapshotQuery = useQuery(latestGraphSnapshotOptions(wsId, projectId));
  const strategiesQuery = useQuery({
    ...moduleStrategiesOptions(wsId, projectId, selectedNodeId ?? ""),
    enabled: Boolean(selectedNodeId),
  });

  return (
    <GraphDataContext.Provider
      value={{
        projectId,
        snapshot: snapshotQuery.data ?? null,
        snapshotLoading: snapshotQuery.isPending,
        snapshotError: snapshotQuery.isError,
        refetchSnapshot: () => void snapshotQuery.refetch(),
        selectedNodeId,
        setSelectedNodeId,
        selectedCell,
        setSelectedCell,
        ontologyReady: strategiesQuery.data?.ontology_ready ?? null,
      }}
    >
      {children}
    </GraphDataContext.Provider>
  );
}

export function useGraphData(): GraphDataValue {
  const ctx = useContext(GraphDataContext);
  if (!ctx) {
    throw new Error("useGraphData must be used within <GraphDataProvider>");
  }
  return ctx;
}
