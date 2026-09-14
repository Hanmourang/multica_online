import { describe, expect, it } from "vitest";
import {
  INSPECTOR_WIDTH_DEFAULT,
  INSPECTOR_WIDTH_MAX,
  INSPECTOR_WIDTH_MIN,
  clampInspectorWidth,
} from "./use-prototype-inspector";

describe("clampInspectorWidth", () => {
  it("keeps values inside the product range", () => {
    expect(clampInspectorWidth(320)).toBe(320);
    expect(clampInspectorWidth(INSPECTOR_WIDTH_MIN - 80)).toBe(INSPECTOR_WIDTH_MIN);
    expect(clampInspectorWidth(INSPECTOR_WIDTH_MAX + 80)).toBe(INSPECTOR_WIDTH_MAX);
    expect(clampInspectorWidth(Number.NaN)).toBe(INSPECTOR_WIDTH_DEFAULT);
  });
});
