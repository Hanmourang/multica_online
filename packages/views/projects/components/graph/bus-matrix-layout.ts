/**
 * C4 展示层配置：只影响矩阵列序 / 隐藏 / 别名 / 人工行，不改写图谱事实。
 * 按项目写入 localStorage，团队成员各自保存视图。
 */

const STORAGE_PREFIX = "multica.bus-matrix.layout.";

export interface ManualRegisterRow {
  id: string;
  name: string;
  domain: string;
  read: number;
  write: number;
}

export interface MatrixTableBinding {
  moduleName: string;
  moduleNodeId: string;
  domain?: string;
}

export interface ManualPage {
  id: string;
  moduleName: string;
  pageName: string;
  /** Reuse an existing module group when adding a page under it. */
  moduleKey?: string;
  /** Nest under an existing snapshot page (业务过程 row); absent = standalone page row. */
  pageKey?: string;
  /** 业务过程（主键组合）显示名；设置后该 id 是过程级 rowKey。 */
  processName?: string;
}

export interface CellEdit {
  read: number;
  write: number;
}

export type AssetMountRw = "R" | "W" | "RW";

/** 格子上的增量挂载：手动优先于图谱，忽略 ≠ 删边。 */
export interface AssetMount {
  table: string;
  rw: AssetMountRw;
  ignored?: boolean;
}

export interface MatrixRowSeed {
  moduleKey: string;
  moduleName: string;
  pageKey: string;
  pageName: string;
  /** 业务过程粒度（数据模型 v2）：存在时该行是过程行，rowKey = processKey。 */
  processKey?: string;
  processName?: string;
}

/** 行定位符：过程行取 process_key，否则退化为 page_key（v1 行为）。 */
export function cellRowKey(cell: { page_key: string; process_key?: string }): string {
  return cell.process_key ?? cell.page_key;
}

export interface BusMatrixLayout {
  domainOrder: string[];
  hiddenDomains: string[];
  aliases: Record<string, string>;
  hiddenRows: string[];
  rowOrder: string[];
  rowAliases: Record<string, string>;
  moduleAliases: Record<string, string>;
  manualDomains: string[];
  manualRows: ManualRegisterRow[];
  manualPages: ManualPage[];
  tableBindings: Record<string, MatrixTableBinding>;
  cellEdits: Record<string, CellEdit>;
  deletedCells: string[];
  /** 格子定位符 → 挂载增量；key 与 matrixCellKey 一致。 */
  assetMounts: Record<string, AssetMount[]>;
}

const EMPTY: BusMatrixLayout = {
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

export function loadBusMatrixLayout(projectId: string): BusMatrixLayout {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + projectId);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<BusMatrixLayout>;
    return {
      domainOrder: parsed.domainOrder ?? [],
      hiddenDomains: parsed.hiddenDomains ?? [],
      aliases: parsed.aliases ?? {},
      hiddenRows: parsed.hiddenRows ?? [],
      rowOrder: parsed.rowOrder ?? [],
      rowAliases: parsed.rowAliases ?? {},
      moduleAliases: parsed.moduleAliases ?? {},
      manualDomains: parsed.manualDomains ?? [],
      manualRows: parsed.manualRows ?? [],
      manualPages: parsed.manualPages ?? [],
      tableBindings: parsed.tableBindings ?? {},
      cellEdits: parsed.cellEdits ?? {},
      deletedCells: parsed.deletedCells ?? [],
      assetMounts: parsed.assetMounts ?? {},
    };
  } catch {
    return EMPTY;
  }
}

export function saveBusMatrixLayout(projectId: string, layout: BusMatrixLayout) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(layout));
}

export function applyDomainLayout(
  domains: string[],
  layout: BusMatrixLayout,
): string[] {
  const all = [...new Set([...domains, ...layout.manualDomains])];
  const ordered = [
    ...layout.domainOrder.filter((d) => all.includes(d)),
    ...all.filter((d) => !layout.domainOrder.includes(d)),
  ];
  return ordered.filter((d) => !layout.hiddenDomains.includes(d));
}

export function applyRowLayout(keys: string[], layout: BusMatrixLayout): string[] {
  const ordered = [
    ...layout.rowOrder.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !layout.rowOrder.includes(key)),
  ];
  return ordered.filter((key) => !layout.hiddenRows.includes(key));
}

export function matrixCellKey(moduleNodeId: string, pageKey: string, domain: string): string {
  return `${moduleNodeId}\0${pageKey}\0${domain}`;
}

export function applyCellEdits<
  T extends {
    module_name: string;
    module_node_id: string;
    page_name: string;
    page_key: string;
    domain: string;
    table_count: number;
    read_count: number;
    write_count: number;
    is_new_table?: boolean;
    is_cross_domain_write?: boolean;
    process_key?: string;
    process_name?: string;
  },
>(
  cells: T[],
  layout: BusMatrixLayout,
): T[] {
  const byKey = new Map(
    cells
      .filter((cell) => !layout.deletedCells.includes(matrixCellKey(cell.module_node_id, cellRowKey(cell), cell.domain)))
      .map((cell) => [matrixCellKey(cell.module_node_id, cellRowKey(cell), cell.domain), { ...cell }]),
  );
  for (const [key, edit] of Object.entries(layout.cellEdits)) {
    const current = byKey.get(key);
    const parts = key.split("\0");
    const moduleNodeId = parts[0] ?? "";
    const pageKey = parts[1] ?? "";
    const domain = parts[2] ?? "";
    const seed =
      current ??
      cells.find(
        (cell) =>
          cell.module_node_id === moduleNodeId &&
          (cell.process_key ?? cell.page_key) === pageKey,
      ) ??
      layout.manualPages.find((page) => page.id === moduleNodeId || page.id === pageKey);
    if (!domain) continue;
    const moduleName =
      current?.module_name ??
      (seed && "module_name" in seed ? seed.module_name : undefined) ??
      (seed && "moduleName" in seed ? seed.moduleName : moduleNodeId);
    const pageName =
      current?.page_name ??
      (seed && "page_name" in seed ? seed.page_name : undefined) ??
      (seed && "pageName" in seed ? seed.pageName : pageKey);
    byKey.set(key, {
      module_name: moduleName,
      module_node_id: moduleNodeId,
      page_name: pageName,
      page_key: pageKey,
      domain,
      table_count: edit.read + edit.write,
      read_count: edit.read,
      write_count: edit.write,
      // 合成的人工格子没有过程定位符；调用方传入的 T 可能更宽，这里安全断言。
    } as T);
  }
  return [...byKey.values()];
}

export function collectRowSeeds(
  snapshotCells: Array<{
    module_node_id: string;
    module_name: string;
    page_key: string;
    page_name: string;
    process_key?: string;
    process_name?: string;
  }>,
  layout: BusMatrixLayout,
): MatrixRowSeed[] {
  const map = new Map<string, MatrixRowSeed>();
  const add = (
    rowKey: string,
    moduleKey: string,
    moduleName: string,
    pageKey: string,
    pageName: string,
    processKey?: string,
    processName?: string,
  ) => {
    if (layout.hiddenRows.includes(rowKey) || map.has(rowKey)) return;
    map.set(rowKey, {
      moduleKey,
      moduleName: layout.moduleAliases[moduleKey] ?? moduleName,
      pageKey,
      pageName: layout.rowAliases[pageKey] ?? pageName,
      processKey,
      processName: processKey
        ? layout.rowAliases[processKey] ?? processName
        : undefined,
    });
  };
  for (const cell of snapshotCells) {
    const rowKey = cell.process_key ?? cell.page_key;
    add(
      rowKey,
      cell.module_node_id,
      cell.module_name,
      cell.page_key,
      cell.page_name,
      cell.process_key,
      cell.process_name,
    );
  }
  for (const row of layout.manualRows) {
    add(row.id, row.id, row.name, row.id, row.name);
  }
  for (const page of layout.manualPages) {
    const pageKey = page.pageKey ?? page.id;
    add(
      page.id,
      page.moduleKey ?? page.id,
      page.moduleName,
      pageKey,
      page.pageName,
      page.processName ? page.id : undefined,
      page.processName,
    );
  }
  return applyRowLayout([...map.keys()], layout)
    .map((key) => map.get(key))
    .filter((row): row is MatrixRowSeed => Boolean(row));
}

export function addMatrixDomain(
  layout: BusMatrixLayout,
  name: string,
  visibleDomains: string[],
): BusMatrixLayout {
  const trimmed = name.trim();
  if (!trimmed) return layout;
  if (layout.hiddenDomains.includes(trimmed)) {
    return { ...layout, hiddenDomains: layout.hiddenDomains.filter((item) => item !== trimmed) };
  }
  if (visibleDomains.includes(trimmed) || layout.manualDomains.includes(trimmed)) return layout;
  return {
    ...layout,
    manualDomains: [...layout.manualDomains, trimmed],
    domainOrder: [...visibleDomains, trimmed],
  };
}

export function removeMatrixDomain(layout: BusMatrixLayout, domain: string): BusMatrixLayout {
  if (layout.manualDomains.includes(domain)) {
    const { [domain]: _alias, ...aliases } = layout.aliases;
    return {
      ...layout,
      aliases,
      manualDomains: layout.manualDomains.filter((item) => item !== domain),
      domainOrder: layout.domainOrder.filter((item) => item !== domain),
      hiddenDomains: layout.hiddenDomains.filter((item) => item !== domain),
    };
  }
  return {
    ...layout,
    hiddenDomains: [...new Set([...layout.hiddenDomains, domain])],
  };
}

export function addMatrixPage(
  layout: BusMatrixLayout,
  page: ManualPage,
  visibleRows: string[],
): BusMatrixLayout {
  if (!page.moduleName.trim() || !page.pageName.trim()) return layout;
  if (layout.manualPages.some((item) => item.id === page.id)) return layout;
  return {
    ...layout,
    manualPages: [...layout.manualPages, page],
    rowOrder: [...visibleRows, page.id],
  };
}

export function removeMatrixRow(layout: BusMatrixLayout, pageKey: string): BusMatrixLayout {
  const isManual =
    layout.manualPages.some((page) => page.id === pageKey) ||
    layout.manualRows.some((row) => row.id === pageKey);
  if (isManual) {
    return {
      ...layout,
      manualPages: layout.manualPages.filter((page) => page.id !== pageKey),
      manualRows: layout.manualRows.filter((row) => row.id !== pageKey),
      rowOrder: layout.rowOrder.filter((item) => item !== pageKey),
      hiddenRows: layout.hiddenRows.filter((item) => item !== pageKey),
    };
  }
  return {
    ...layout,
    hiddenRows: [...new Set([...layout.hiddenRows, pageKey])],
  };
}

export function saveCellCounts(
  layout: BusMatrixLayout,
  moduleNodeId: string,
  pageKey: string,
  domain: string,
  read: number,
  write: number,
): BusMatrixLayout {
  const key = matrixCellKey(moduleNodeId, pageKey, domain);
  const safeRead = Math.max(0, Math.floor(read));
  const safeWrite = Math.max(0, Math.floor(write));
  if (safeRead === 0 && safeWrite === 0) {
    const nextEdits = { ...layout.cellEdits };
    delete nextEdits[key];
    return {
      ...layout,
      cellEdits: nextEdits,
      deletedCells: [...new Set([...layout.deletedCells, key])],
    };
  }
  return {
    ...layout,
    cellEdits: { ...layout.cellEdits, [key]: { read: safeRead, write: safeWrite } },
    deletedCells: layout.deletedCells.filter((item) => item !== key),
  };
}

export function moveListItem(items: string[], key: string, delta: -1 | 1): string[] {
  const index = items.indexOf(key);
  if (index < 0) return items;
  const next = index + delta;
  if (next < 0 || next >= items.length) return items;
  const copy = [...items];
  const swap = copy[next];
  if (swap === undefined) return items;
  copy[next] = key;
  copy[index] = swap;
  return copy;
}
