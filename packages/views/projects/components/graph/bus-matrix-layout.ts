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

export interface BusMatrixLayout {
  domainOrder: string[];
  hiddenDomains: string[];
  aliases: Record<string, string>;
  hiddenRows: string[];
  manualRows: ManualRegisterRow[];
}

const EMPTY: BusMatrixLayout = {
  domainOrder: [],
  hiddenDomains: [],
  aliases: {},
  hiddenRows: [],
  manualRows: [],
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
      manualRows: parsed.manualRows ?? [],
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
  const ordered = [
    ...layout.domainOrder.filter((d) => domains.includes(d)),
    ...domains.filter((d) => !layout.domainOrder.includes(d)),
  ];
  return ordered.filter((d) => !layout.hiddenDomains.includes(d));
}
