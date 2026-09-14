import { describe, expect, it } from "vitest";
import { parseRecognitionReport, resolveProjectsMgmtRoot } from "./archive-recognition";

describe("parseRecognitionReport", () => {
  it("reads coverage and attribution from classifier JSON", () => {
    const report = parseRecognitionReport(
      JSON.stringify({
        coverage: 81.2,
        total: 10,
        recognized: 8,
        unclassified: 2,
        by_source: { L1: 6, L3: 2 },
        attribution: { no_project: 2 },
        failures: [{ rel: "_shared/inbox/x.md", failure_attribution: "no_project" }],
      }),
    );
    expect(report?.coverage).toBe(81.2);
    expect(report?.failures?.[0]?.rel).toBe("_shared/inbox/x.md");
  });

  it("rejects unrelated JSON", () => {
    expect(parseRecognitionReport('{"hello":1}')).toBeNull();
  });
});

describe("resolveProjectsMgmtRoot", () => {
  it("walks up from a bound project directory", () => {
    expect(
      resolveProjectsMgmtRoot("/Users/me/workspace/projects_mgmt/projects/multica"),
    ).toBe("/Users/me/workspace/projects_mgmt");
  });
});
