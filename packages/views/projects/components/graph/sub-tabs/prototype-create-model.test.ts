import { describe, expect, it } from "vitest";
import {
  fileExtensionOf,
  filterArtifactsByKeyword,
  isPrototypeFile,
  nextPrototypeVersion,
  prototypePathSlug,
  prototypeRelPath,
  splitArtifactPath,
} from "./prototype-create-model";

describe("isPrototypeFile", () => {
  it("only accepts html / htm, case-insensitively", () => {
    expect(isPrototypeFile("design.html")).toBe(true);
    expect(isPrototypeFile("PROTOTYPE.HTM")).toBe(true);
    expect(isPrototypeFile("design.md")).toBe(false);
    expect(isPrototypeFile("design")).toBe(false);
    // 隐藏文件没有扩展名（".html" 是文件名本身）。
    expect(fileExtensionOf(".html")).toBe("");
  });
});

describe("nextPrototypeVersion", () => {
  it("takes the max across both axes and adds one", () => {
    expect(nextPrototypeVersion([])).toBe(1);
    expect(nextPrototypeVersion([3, 1, 2])).toBe(4);
    expect(nextPrototypeVersion([0, 0])).toBe(1);
    // 脏数据（NaN / 负数 / 小数）不应把版本号拖低或造出非整数。
    expect(nextPrototypeVersion([Number.NaN, -2, 2.7])).toBe(3);
  });
});

describe("prototypePathSlug", () => {
  it("keeps readable names and strips path separators", () => {
    expect(prototypePathSlug("1.1 AI助手")).toBe("1.1-AI助手");
    expect(prototypePathSlug(" a/b:c ")).toBe("a-b-c");
    expect(prototypePathSlug("")).toBe("module");
    expect(prototypePathSlug(null)).toBe("module");
  });
});

describe("splitArtifactPath", () => {
  it("splits the last segment off the directory", () => {
    expect(splitArtifactPath("change_logs/dsh_desktop/prototype-v2.html")).toEqual({
      dir: "change_logs/dsh_desktop",
      name: "prototype-v2.html",
    });
  });

  it("normalizes windows separators and leading/trailing slashes", () => {
    expect(splitArtifactPath("/a\\b\\c.htm")).toEqual({ dir: "a/b", name: "c.htm" });
  });

  it("returns an empty dir for a bare file name", () => {
    expect(splitArtifactPath("index.html")).toEqual({ dir: "", name: "index.html" });
    expect(splitArtifactPath("")).toEqual({ dir: "", name: "" });
  });
});

describe("filterArtifactsByKeyword", () => {
  const rows = [
    { id: "1", rel_path: "change_logs/dsk/Login-v2.html" },
    { id: "2", rel_path: "change_logs/dsk/Home-v2.html" },
    { id: "3", rel_path: "prototypes/dashboard/index.html" },
  ];

  it("returns every row for a blank keyword", () => {
    expect(filterArtifactsByKeyword(rows, "")).toHaveLength(3);
    expect(filterArtifactsByKeyword(rows, "   ")).toHaveLength(3);
  });

  it("matches the file name and the directory, case-insensitively", () => {
    expect(filterArtifactsByKeyword(rows, "login").map((r) => r.id)).toEqual(["1"]);
    // 目录段也算命中：用户记得“在哪棵树里”比记得文件名更常见。
    expect(filterArtifactsByKeyword(rows, "DASHBOARD").map((r) => r.id)).toEqual(["3"]);
    expect(filterArtifactsByKeyword(rows, " v2 ").map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterArtifactsByKeyword(rows, "nope")).toEqual([]);
  });

  it("does not mutate the input", () => {
    const before = rows.map((r) => r.id);
    filterArtifactsByKeyword(rows, "login");
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe("prototypeRelPath", () => {
  it("writes module-owned prototypes under prototypes/<slug>/", () => {
    expect(
      prototypeRelPath({ moduleName: "1.1 AI助手", version: 2, fileName: "原型.HTML" }),
    ).toBe("prototypes/1.1-AI助手/prototype-v2.html");
  });

  it("falls back to html extension and clamps the version", () => {
    expect(prototypeRelPath({ moduleName: null, version: 0, fileName: "design" })).toBe(
      "prototypes/module/prototype-v1.html",
    );
  });
});
