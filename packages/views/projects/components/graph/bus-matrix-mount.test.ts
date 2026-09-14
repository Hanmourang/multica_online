import { describe, expect, it } from "vitest";
import type { BusMatrixLayout } from "./bus-matrix-layout";
import {
  changeByTableName,
  ignoreAsset,
  mergeCellAssets,
  mountAsset,
  restoreAsset,
  unmountAsset,
} from "./bus-matrix-mount";

const empty: BusMatrixLayout = {
  domainOrder: [],
  hiddenDomains: [],
  aliases: {},
  hiddenRows: [],
  rowOrder: [],
  rowAliases: {},
  moduleAliases: {},
  manualDomains: [],
  manualRows: [],
  manualPages: [],
  tableBindings: {},
  cellEdits: {},
  deletedCells: [],
  assetMounts: {},
};

describe("asset mount layer", () => {
  it("mounts, ignores, restores, and unmounts without inventing tables", () => {
    const key = "mod\0page\0domain";
    const mounted = mountAsset(empty, key, "bus_matrix_layout", "RW");
    expect(mounted.assetMounts[key]).toEqual([
      { table: "bus_matrix_layout", rw: "RW", ignored: false },
    ]);
    const ignored = ignoreAsset(mounted, key, "kv_session_cache", "R");
    expect(ignored.assetMounts[key]?.find((row) => row.table === "kv_session_cache")?.ignored).toBe(
      true,
    );
    const restored = restoreAsset(ignored, key, "kv_session_cache");
    expect(restored.assetMounts[key]?.find((row) => row.table === "kv_session_cache")?.ignored).toBe(
      false,
    );
    const cleared = unmountAsset(restored, key, "bus_matrix_layout");
    expect(cleared.assetMounts[key]?.map((row) => row.table)).toEqual(["kv_session_cache"]);
  });

  it("merges auto tables with manual overlay; ignore hides from mounted", () => {
    const merged = mergeCellAssets({
      autoTables: [
        { name: "project_graph_snapshot", domain: "graph", columns: [{ name: "scan_id" }] },
      ],
      mounts: [
        { table: "project_graph_snapshot", rw: "RW", ignored: false },
        { table: "kv_session_cache", rw: "R", ignored: true },
        { table: "asset_mount", rw: "RW" },
      ],
      changeByTable: { asset_mount: "added", project_graph_snapshot: "modified" },
    });
    expect(merged.find((row) => row.table === "asset_mount")).toMatchObject({
      source: "manual",
      ignored: false,
      changeType: "added",
    });
    expect(merged.find((row) => row.table === "kv_session_cache")?.ignored).toBe(true);
    expect(merged.find((row) => row.table === "project_graph_snapshot")).toMatchObject({
      source: "auto",
      rw: "RW",
      changeType: "modified",
    });
  });

  it("indexes changelog by object_name without fabricating names", () => {
    expect(
      changeByTableName([
        { object_name: "issue", change_type: "modified" },
        { object_name: "  ", change_type: "added" },
      ]),
    ).toEqual({ issue: "modified" });
  });
});
