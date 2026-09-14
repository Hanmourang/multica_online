export type FeatureViewMode = "modules" | "graph" | "table";

export type FeatureModuleFilters = {
  search: string;
  bizKind: string;
  unboundOnly: boolean;
};

export const EMPTY_FEATURE_FILTERS: FeatureModuleFilters = {
  search: "",
  bizKind: "all",
  unboundOnly: false,
};

export function resolveFeatureFilters(
  filters?: FeatureModuleFilters | null,
): FeatureModuleFilters {
  return {
    search: filters?.search ?? "",
    bizKind: filters?.bizKind ?? "all",
    unboundOnly: Boolean(filters?.unboundOnly),
  };
}
