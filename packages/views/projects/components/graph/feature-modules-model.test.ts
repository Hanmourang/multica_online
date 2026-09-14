import { describe, expect, it } from "vitest";
import { EMPTY_FEATURE_FILTERS, resolveFeatureFilters } from "./feature-modules-model";

describe("resolveFeatureFilters", () => {
  it("does not read .search on a missing filters object", () => {
    expect(resolveFeatureFilters(undefined)).toEqual(EMPTY_FEATURE_FILTERS);
    expect(resolveFeatureFilters(null)).toEqual(EMPTY_FEATURE_FILTERS);
    expect(() => resolveFeatureFilters(undefined).search.trim()).not.toThrow();
  });

  it("keeps provided values", () => {
    expect(
      resolveFeatureFilters({ search: "本体", bizKind: "page", unboundOnly: true }),
    ).toEqual({ search: "本体", bizKind: "page", unboundOnly: true });
  });
});
