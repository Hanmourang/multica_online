"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { latestGraphSnapshotOptions } from "@multica/core/graph/queries";
import type {
  BusMatrixCell,
  GraphSnapshotSummary,
} from "@multica/core/types";

/**
 * Shared state for the graph-backed views (f10 产品功能 / f11 数据模型).
 *
 * Owns the latest-snapshot query — the single source for scan identity, the
 * module summary and the bus-matrix pre-aggregation — plus the two selection
 * states these tabs drive: the module picked in the left list and the matrix
 * cell picked in the grid. Ontology readiness stays on ScanStatusBar so a
 * strategies fetch does not re-render the whole feature tree.
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
  /**
   * Module UUID selected in the module list (f10).
   *
   * 模块的稳定主键是 project_module.id；graph_node_id 只是可选的图谱桥接列，
   * 未绑定的模块没有它。只按 node id 记选中会让「未绑定模块」永远选不中、
   * 右栏恒为空态，所以选中态必须以模块 UUID 为准，node id 只做兼容与邻域查询。
   */
  selectedModuleId: string | null;
  setSelectedModuleId: (moduleId: string | null) => void;
  /** Matrix cell selected in the grid (f11 drilldown driver). */
  selectedCell: BusMatrixCell | null;
  setSelectedCell: (cell: BusMatrixCell | null) => void;
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
  const [selectedNodeId, setSelectedNodeIdState] = useState<string | null>(null);
  const [selectedModuleId, setSelectedModuleIdState] = useState<string | null>(null);
  const [selectedCell, setSelectedCellState] = useState<BusMatrixCell | null>(null);

  const snapshotQuery = useQuery(latestGraphSnapshotOptions(wsId, projectId));
  const setSelectedNodeId = useCallback((nodeId: string | null) => {
    setSelectedNodeIdState((prev) => (prev === nodeId ? prev : nodeId));
  }, []);
  const setSelectedModuleId = useCallback((moduleId: string | null) => {
    setSelectedModuleIdState((prev) => (prev === moduleId ? prev : moduleId));
  }, []);
  const setSelectedCell = useCallback((cell: BusMatrixCell | null) => {
    setSelectedCellState(cell);
  }, []);
  const refetchSnapshot = useCallback(() => {
    void snapshotQuery.refetch();
  }, [snapshotQuery.refetch]);

  const value = useMemo<GraphDataValue>(
    () => ({
      projectId,
      snapshot: snapshotQuery.data ?? null,
      snapshotLoading: snapshotQuery.isPending,
      snapshotError: snapshotQuery.isError,
      refetchSnapshot,
      selectedNodeId,
      setSelectedNodeId,
      selectedModuleId,
      setSelectedModuleId,
      selectedCell,
      setSelectedCell,
    }),
    [
      projectId,
      refetchSnapshot,
      selectedCell,
      selectedModuleId,
      selectedNodeId,
      setSelectedCell,
      setSelectedModuleId,
      setSelectedNodeId,
      snapshotQuery.data,
      snapshotQuery.isError,
      snapshotQuery.isPending,
    ],
  );

  return <GraphDataContext.Provider value={value}>{children}</GraphDataContext.Provider>;
}

export function useGraphData(): GraphDataValue {
  const ctx = useContext(GraphDataContext);
  if (!ctx) {
    throw new Error("useGraphData must be used within <GraphDataProvider>");
  }
  return ctx;
}
