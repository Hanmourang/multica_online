import { describe, expect, it } from "vitest";
import {
  PROTOTYPE_FIT_MESSAGE,
  __PROTOTYPE_FIT_SHIM__,
  __PROTOTYPE_MEASURE_SHIM__,
  readPrototypeFitHeight,
  withPrototypeFitShim,
} from "./prototype-fit";

describe("prototype fit shim", () => {
  it("appends the shim after the document and only for fixed-size prototypes", () => {
    const html = '<html style="width: 1322px; height: 868px"><body>x</body></html>';
    const next = withPrototypeFitShim(html);
    expect(next.startsWith(html)).toBe(true);
    expect(next).toContain(PROTOTYPE_FIT_MESSAGE);
    // 只在 <html> 上带 px 尺寸时缩放；响应式原型（且未要求量高度）靠这一句早退。
    expect(__PROTOTYPE_FIT_SHIM__).toContain("parseFloat(root.style.width)");
    expect(__PROTOTYPE_FIT_SHIM__).toContain("if (!fixed && !MEASURE) return;");
  });

  it("reports scrollHeight for responsive prototypes when asked", () => {
    // 默认不量：响应式原型行为不变。
    expect(withPrototypeFitShim("<html></html>")).not.toContain("var MEASURE = true;");
    // 原型画布需要内容高度，才能把超出的下半截缩进来。
    expect(withPrototypeFitShim("<html></html>", { measureScroll: true })).toContain(
      "var MEASURE = true;",
    );
    expect(__PROTOTYPE_MEASURE_SHIM__).toContain("Math.max(root.scrollHeight");
    expect(__PROTOTYPE_MEASURE_SHIM__).toContain("height > (window.innerHeight || 0) + 8");
  });

  it("reads the reported height and ignores anything else", () => {
    expect(readPrototypeFitHeight({ type: PROTOTYPE_FIT_MESSAGE, height: 231 })).toBe(231);
    expect(readPrototypeFitHeight({ type: PROTOTYPE_FIT_MESSAGE, height: "231.4" })).toBe(231);
    expect(readPrototypeFitHeight({ type: PROTOTYPE_FIT_MESSAGE, height: 0 })).toBeNull();
    expect(readPrototypeFitHeight({ type: PROTOTYPE_FIT_MESSAGE, height: Number.NaN })).toBeNull();
    expect(readPrototypeFitHeight({ type: "multica-prototype-fp", id: "fp.x" })).toBeNull();
    expect(readPrototypeFitHeight(null)).toBeNull();
    expect(readPrototypeFitHeight("231")).toBeNull();
  });
});
