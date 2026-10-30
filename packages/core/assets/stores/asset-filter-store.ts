import { create } from "zustand";
import type { AssetCategory } from "../../types";

/**
 * Client-side filter / paging state for the asset table. This is UI state
 * (which category chip is lit, the draft search term, the current page) — NOT
 * server state, so it lives in Zustand, not React Query. Isolated per project
 * via a `${wsId}:${projectId}` key so switching projects never leaks filters.
 */
export interface AssetFilters {
  readonly category: AssetCategory | null;
  readonly name: string;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_ASSET_FILTERS: AssetFilters = Object.freeze({
  category: null,
  name: "",
  page: 1,
  pageSize: 20,
});

interface AssetFilterState {
  filtersByProject: Record<string, AssetFilters>;
  setCategory: (key: string, category: AssetCategory | null) => void;
  setName: (key: string, name: string) => void;
  setPage: (key: string, page: number) => void;
  setPageSize: (key: string, pageSize: number) => void;
  reset: (key: string) => void;
}

function withEntry(
  map: Record<string, AssetFilters>,
  key: string,
  next: AssetFilters,
): Record<string, AssetFilters> {
  return { ...map, [key]: next };
}

export const useAssetFilterStore = create<AssetFilterState>()((set) => ({
  filtersByProject: {},
  // Any filter change resets paging back to page 1 — a narrowed category or a
  // new search term must not strand the view on an out-of-range page.
  setCategory: (key, category) =>
    set((state) => ({
      filtersByProject: withEntry(state.filtersByProject, key, {
        ...(state.filtersByProject[key] ?? DEFAULT_ASSET_FILTERS),
        category,
        page: 1,
      }),
    })),
  setName: (key, name) =>
    set((state) => ({
      filtersByProject: withEntry(state.filtersByProject, key, {
        ...(state.filtersByProject[key] ?? DEFAULT_ASSET_FILTERS),
        name,
        page: 1,
      }),
    })),
  setPage: (key, page) =>
    set((state) => ({
      filtersByProject: withEntry(state.filtersByProject, key, {
        ...(state.filtersByProject[key] ?? DEFAULT_ASSET_FILTERS),
        page: page > 0 ? page : 1,
      }),
    })),
  // Written by the tables' fit-to-viewport measurement, not by a page-size
  // picker. The page is re-anchored in the same write: the row the reader was
  // looking at stays the first row of the new page, and because both fields
  // move together a resize costs one fetch instead of a stale-size fetch
  // followed by a corrected one.
  setPageSize: (key, pageSize) =>
    set((state) => {
      const current = state.filtersByProject[key] ?? DEFAULT_ASSET_FILTERS;
      if (pageSize <= 0 || current.pageSize === pageSize) return state;
      const firstVisible = (current.page - 1) * current.pageSize;
      return {
        filtersByProject: withEntry(state.filtersByProject, key, {
          ...current,
          pageSize,
          page: Math.floor(firstVisible / pageSize) + 1,
        }),
      };
    }),
  reset: (key) =>
    set((state) => {
      if (!state.filtersByProject[key]) return state;
      const { [key]: _removed, ...filtersByProject } = state.filtersByProject;
      return { filtersByProject };
    }),
}));

/** Project-isolated filter state with a stable default fallback. */
export function useAssetFilters(key: string): AssetFilters {
  return useAssetFilterStore((state) => state.filtersByProject[key]) ?? DEFAULT_ASSET_FILTERS;
}

/** Compose the store key from workspace + project ids. */
export function assetFilterKey(wsId: string, projectId: string): string {
  return `${wsId}:${projectId}`;
}
