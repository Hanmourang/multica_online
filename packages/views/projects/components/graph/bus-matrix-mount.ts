import type { BusMatrixTableDetail, OntologyChangeType } from "@multica/core/types";
import type { AssetMount, AssetMountRw, BusMatrixLayout } from "./bus-matrix-layout";
import { matrixCellKey } from "./bus-matrix-layout";

export type MountSource = "auto" | "manual";

export type MergedMountRow = {
  table: string;
  rw: AssetMountRw;
  source: MountSource;
  ignored: boolean;
  columns: string[];
  domain?: string;
  changeType?: OntologyChangeType;
};

function inferRw(table: BusMatrixTableDetail): AssetMountRw {
  const read = table.read_count ?? 0;
  const write = table.write_count ?? 0;
  if (read > 0 && write > 0) return "RW";
  if (write > 0) return "W";
  return "R";
}

export function cellMountKey(
  moduleNodeId: string,
  pageKey: string,
  domain: string,
): string {
  return matrixCellKey(moduleNodeId, pageKey, domain);
}

export function listCellMounts(layout: BusMatrixLayout, cellKey: string): AssetMount[] {
  return layout.assetMounts[cellKey] ?? [];
}

function writeMounts(
  layout: BusMatrixLayout,
  cellKey: string,
  mounts: AssetMount[],
): BusMatrixLayout {
  const next = { ...layout.assetMounts };
  if (mounts.length === 0) delete next[cellKey];
  else next[cellKey] = mounts;
  return { ...layout, assetMounts: next };
}

function upsertMount(
  mounts: AssetMount[],
  table: string,
  patch: Partial<AssetMount> & Pick<AssetMount, "rw">,
): AssetMount[] {
  const name = table.trim();
  if (!name) return mounts;
  const rest = mounts.filter((item) => item.table !== name);
  return [...rest, { table: name, ...patch }];
}

export function mountAsset(
  layout: BusMatrixLayout,
  cellKey: string,
  table: string,
  rw: AssetMountRw,
): BusMatrixLayout {
  const current = listCellMounts(layout, cellKey);
  return writeMounts(layout, cellKey, upsertMount(current, table, { rw, ignored: false }));
}

export function ignoreAsset(
  layout: BusMatrixLayout,
  cellKey: string,
  table: string,
  rw: AssetMountRw = "R",
): BusMatrixLayout {
  const current = listCellMounts(layout, cellKey);
  const existing = current.find((item) => item.table === table.trim());
  return writeMounts(
    layout,
    cellKey,
    upsertMount(current, table, { rw: existing?.rw ?? rw, ignored: true }),
  );
}

export function restoreAsset(
  layout: BusMatrixLayout,
  cellKey: string,
  table: string,
): BusMatrixLayout {
  const current = listCellMounts(layout, cellKey);
  const existing = current.find((item) => item.table === table.trim());
  if (!existing) return layout;
  return writeMounts(
    layout,
    cellKey,
    upsertMount(current, table, { rw: existing.rw, ignored: false }),
  );
}

export function unmountAsset(
  layout: BusMatrixLayout,
  cellKey: string,
  table: string,
): BusMatrixLayout {
  const name = table.trim();
  return writeMounts(
    layout,
    cellKey,
    listCellMounts(layout, cellKey).filter((item) => item.table !== name),
  );
}

export function setMountRw(
  layout: BusMatrixLayout,
  cellKey: string,
  table: string,
  rw: AssetMountRw,
): BusMatrixLayout {
  const current = listCellMounts(layout, cellKey);
  const existing = current.find((item) => item.table === table.trim());
  if (!existing) return mountAsset(layout, cellKey, table, rw);
  return writeMounts(
    layout,
    cellKey,
    upsertMount(current, table, { rw, ignored: existing.ignored === true }),
  );
}

export function mergeCellAssets(input: {
  autoTables: BusMatrixTableDetail[];
  mounts: AssetMount[];
  changeByTable?: Record<string, OntologyChangeType>;
}): MergedMountRow[] {
  const byName = new Map<string, MergedMountRow>();

  for (const table of input.autoTables) {
    const name = table.name.trim();
    if (!name) continue;
    byName.set(name, {
      table: name,
      rw: inferRw(table),
      source: "auto",
      ignored: false,
      columns: table.columns.map((column) => column.name).filter(Boolean),
      domain: table.domain,
      changeType: input.changeByTable?.[name],
    });
  }

  for (const mount of input.mounts) {
    const name = mount.table.trim();
    if (!name) continue;
    const existing = byName.get(name);
    byName.set(name, {
      table: name,
      rw: mount.rw,
      source: existing ? "auto" : "manual",
      ignored: mount.ignored === true,
      columns: existing?.columns ?? [],
      domain: existing?.domain,
      changeType: input.changeByTable?.[name] ?? existing?.changeType,
    });
  }

  return [...byName.values()].sort((a, b) => {
    if (a.ignored !== b.ignored) return a.ignored ? 1 : -1;
    if (a.source !== b.source) return a.source === "manual" ? -1 : 1;
    return a.table.localeCompare(b.table);
  });
}

export function changeByTableName(
  changes: Array<{ object_name: string; change_type: OntologyChangeType }>,
): Record<string, OntologyChangeType> {
  const map: Record<string, OntologyChangeType> = {};
  for (const change of changes) {
    const name = change.object_name.trim();
    if (!name) continue;
    map[name] = change.change_type;
  }
  return map;
}
