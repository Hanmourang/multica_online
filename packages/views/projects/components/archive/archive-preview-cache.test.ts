import { describe, expect, it } from "vitest";
import {
  getArchivePreviewText,
  putArchivePreviewTexts,
} from "./archive-preview-cache";

describe("archive preview cache", () => {
  it("resolves both raw and contract-normalized paths", () => {
    putArchivePreviewTexts([
      {
        relPath: "dsh_desktop/overview/product-design/01-可行性评估报告.md",
        text: "# 可行性",
      },
    ]);
    expect(
      getArchivePreviewText("overview/product-design/01-可行性评估报告.md"),
    ).toBe("# 可行性");
    expect(
      getArchivePreviewText("dsh_desktop/overview/product-design/01-可行性评估报告.md"),
    ).toBe("# 可行性");
    expect(getArchivePreviewText("overview/research/01-可行性评估报告.md")).toBe(
      "# 可行性",
    );
  });
});
