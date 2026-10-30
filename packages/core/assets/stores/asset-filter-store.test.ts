import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ASSET_FILTERS,
  useAssetFilterStore,
} from "./asset-filter-store";

// The store is a module singleton; each case starts from a clean slate so the
// per-project keys never leak the previous page size.
const KEY = "ws-1:project-1";

function readFilters(key = KEY) {
  return useAssetFilterStore.getState().filtersByProject[key] ?? DEFAULT_ASSET_FILTERS;
}

describe("asset filter store — fit-to-viewport page size", () => {
  beforeEach(() => {
    useAssetFilterStore.setState({ filtersByProject: {} });
  });

  it("re-anchors the page on the row the reader was already looking at", () => {
    const { setPage, setPageSize } = useAssetFilterStore.getState();
    // Page 3 at 20 per page => first visible row index 40.
    setPage(KEY, 3);
    setPageSize(KEY, 25);

    expect(readFilters()).toMatchObject({ page: 2, pageSize: 25 });
    // 40 / 25 = 1.6 => page 2 still starts at or before row 40.
    expect((readFilters().page - 1) * readFilters().pageSize).toBeLessThanOrEqual(40);
  });

  it("keeps page 1 on page 1 when the box shrinks", () => {
    const { setPageSize } = useAssetFilterStore.getState();
    setPageSize(KEY, 12);
    expect(readFilters()).toMatchObject({ page: 1, pageSize: 12 });
  });

  it("seeds a project with no entry yet from the defaults", () => {
    useAssetFilterStore.getState().setPageSize(KEY, 30);
    expect(readFilters()).toMatchObject({
      category: null,
      name: "",
      page: 1,
      pageSize: 30,
    });
  });

  it("ignores a repeated measurement and non-positive sizes", () => {
    const { setPage, setPageSize } = useAssetFilterStore.getState();
    setPageSize(KEY, 24);
    setPage(KEY, 4);

    const before = useAssetFilterStore.getState().filtersByProject;
    setPageSize(KEY, 24);
    setPageSize(KEY, 0);
    setPageSize(KEY, -3);

    // Identical object identity: zustand never notified, so no refetch.
    expect(useAssetFilterStore.getState().filtersByProject).toBe(before);
    expect(readFilters()).toMatchObject({ page: 4, pageSize: 24 });
  });
});
