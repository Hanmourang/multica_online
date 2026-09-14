import type {
  BusMatrixAlert,
  BusMatrixTableDetail,
  ModuleGraphSummary,
} from "@multica/core/types";
import type { MatrixTableBinding } from "./bus-matrix-layout";

export type MatrixTableSource = "summary" | "cell" | "orphan" | "unclassified" | "manual";

export type MatrixTableRow = {
  name: string;
  domain?: string;
  modules: Array<{ id: string; name: string }>;
  bound: boolean;
  attributed: boolean;
  sources: MatrixTableSource[];
  read?: number;
  write?: number;
};

function attributedDomain(domain?: string): boolean {
  const value = domain?.trim();
  if (!value) return false;
  return value !== "unmapped" && value !== "unknown" && value !== "unclassified";
}

function ensureRow(map: Map<string, MatrixTableRow>, name: string): MatrixTableRow {
  const hit = map.get(name);
  if (hit) return hit;
  const created: MatrixTableRow = {
    name,
    modules: [],
    bound: false,
    attributed: false,
    sources: [],
  };
  map.set(name, created);
  return created;
}

function addSource(row: MatrixTableRow, source: MatrixTableSource) {
  if (!row.sources.includes(source)) row.sources.push(source);
}

function addModule(row: MatrixTableRow, id: string, name: string) {
  if (!id && !name) return;
  if (row.modules.some((module) => module.id === id && module.name === name)) return;
  row.modules.push({ id, name });
  row.bound = true;
}

export function collectMatrixTables(input: {
  summaries: ModuleGraphSummary[];
  drilldownTables: BusMatrixTableDetail[];
  alerts: BusMatrixAlert[];
  bindings: Record<string, MatrixTableBinding>;
}): MatrixTableRow[] {
  const map = new Map<string, MatrixTableRow>();

  for (const summary of input.summaries) {
    for (const table of summary.tables_touched ?? []) {
      const name = table.trim();
      if (!name) continue;
      const row = ensureRow(map, name);
      addSource(row, "summary");
      addModule(row, summary.node_id, summary.name);
    }
  }

  for (const table of input.drilldownTables) {
    const name = table.name.trim();
    if (!name) continue;
    const row = ensureRow(map, name);
    addSource(row, "cell");
    if (table.domain && !row.domain) row.domain = table.domain;
    if (table.read_count !== undefined) row.read = table.read_count;
    if (table.write_count !== undefined) row.write = table.write_count;
    row.attributed = row.attributed || attributedDomain(table.domain);
  }

  for (const alert of input.alerts) {
    const source: MatrixTableSource | null =
      alert.type === "orphan_table"
        ? "orphan"
        : alert.type === "unclassified"
          ? "unclassified"
          : null;
    if (!source) continue;
    for (const table of alert.tables ?? []) {
      const name = table.trim();
      if (!name) continue;
      const row = ensureRow(map, name);
      addSource(row, source);
      if (source === "unclassified") row.attributed = false;
      if (alert.domain && !row.domain) row.domain = alert.domain;
    }
  }

  for (const [name, binding] of Object.entries(input.bindings)) {
    const row = ensureRow(map, name.trim());
    addSource(row, "manual");
    addModule(row, binding.moduleNodeId, binding.moduleName);
    if (binding.domain) {
      row.domain = binding.domain;
      row.attributed = attributedDomain(binding.domain);
    }
  }

  for (const row of map.values()) {
    if (row.modules.length > 0) row.bound = true;
    if (row.domain) row.attributed = row.attributed || attributedDomain(row.domain);
  }

  return [...map.values()].sort((a, b) => {
    if (a.bound !== b.bound) return a.bound ? 1 : -1;
    if (a.attributed !== b.attributed) return a.attributed ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export function filterMatrixTables(
  rows: MatrixTableRow[],
  filter: "all" | "bound" | "unbound" | "unattributed",
): MatrixTableRow[] {
  if (filter === "bound") return rows.filter((row) => row.bound);
  if (filter === "unbound") return rows.filter((row) => !row.bound);
  if (filter === "unattributed") return rows.filter((row) => !row.attributed);
  return rows;
}
