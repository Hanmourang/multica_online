import { describe, expect, it } from "vitest";
import {
  ONTOLOGY_PLATFORM_STORYBOOK_DEMOS,
  storybookDemoForModule,
} from "./catalog";

describe("storybookDemoForModule", () => {
  it("returns nothing when the module is unbound", () => {
    expect(storybookDemoForModule(null)).toBeUndefined();
    expect(storybookDemoForModule("comm-legacy")).toBeUndefined();
  });

  it("covers every seeded page community of 代码本体平台", () => {
    const ids = [
      "comm-ontology",
      "comm-graph",
      "comm-scan",
      "comm-extract",
      "comm-bus",
      "comm-archive",
      "comm-filing",
    ];
    expect(ONTOLOGY_PLATFORM_STORYBOOK_DEMOS.map((row) => row.communityId)).toEqual(ids);
    for (const id of ids) {
      const demo = storybookDemoForModule(id);
      expect(demo?.stories.length).toBeGreaterThan(0);
      expect(demo?.stories[0]?.storyId).toMatch(/^pages-/);
      expect(demo?.stories[0]?.points.length).toBeGreaterThan(0);
    }
  });
});
