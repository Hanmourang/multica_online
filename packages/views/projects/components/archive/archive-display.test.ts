import { describe, expect, it } from "vitest";
import {
  artifactDisplayName,
  artifactModuleTag,
  artifactModuleTagTone,
  artifactParentDir,
  classifyArchivePreviewKind,
  resolveArchivePreviewRoots,
} from "./archive-display";
import { persistDocModuleValue } from "./archive-module";

describe("artifactDisplayName", () => {
  it("shows only the file name, never a directory prefix", () => {
    expect(artifactDisplayName("overview/architecture/architecture.md")).toBe(
      "architecture.md",
    );
    expect(
      artifactDisplayName(
        "overview/architecture/spec_infos/deepseek-harness/notes.md",
      ),
    ).toBe("notes.md");
    expect(
      artifactDisplayName("overview/product-design/features/15-手机端.md"),
    ).toBe("15-手机端.md");
  });
});

describe("artifactModuleTag", () => {
  it("uses the immediate parent directory, or an explicit override", () => {
    expect(artifactParentDir("overview/architecture/architecture.md")).toBe(
      "architecture",
    );
    expect(
      artifactModuleTag("overview/product-design/features/15-手机端.md"),
    ).toBe("features");
    expect(
      artifactModuleTag(
        "overview/architecture/spec_infos/deepseek-harness/notes.md",
      ),
    ).toBe("deepseek-harness");
    expect(
      artifactModuleTag("requirements/REQ-20260913-01/s2-plan/plan.md"),
    ).toBe("s2-plan");
    expect(
      artifactModuleTag("requirements/REQ-20260913-01/s3-execution/billing/design.md"),
    ).toBe("billing");
    expect(
      artifactModuleTag(
        "overview/architecture/spec_infos/deepseek-harness/notes.md",
        "billing",
      ),
    ).toBe("billing");
    expect(artifactModuleTag("PROJECT.md")).toBeUndefined();
  });
});

describe("artifactModuleTagTone", () => {
  it("keeps the same tag on the same tone and splits common archive labels", () => {
    expect(artifactModuleTagTone("本体对象")).toBe("violet");
    expect(artifactModuleTagTone(" 本体对象 ")).toBe("violet");
    expect(artifactModuleTagTone("变更")).toBe("orange");
    expect(artifactModuleTagTone("查阅")).toBe("sky");
    expect(artifactModuleTagTone("申报稿")).toBe("teal");
    expect(artifactModuleTagTone("本体对象")).not.toBe(artifactModuleTagTone("变更"));
  });

  it("hashes unknown tags stably", () => {
    expect(artifactModuleTagTone("deepseek-harness")).toBe(
      artifactModuleTagTone("deepseek-harness"),
    );
    expect(artifactModuleTagTone("billing")).toBe("orange");
  });
});

describe("persistDocModuleValue", () => {
  it("clears an override that matches the parent directory", () => {
    expect(
      persistDocModuleValue(
        "overview/architecture/spec_infos/deepseek-harness/notes.md",
        " deepseek-harness ",
      ),
    ).toBe("");
    expect(
      persistDocModuleValue(
        "overview/architecture/spec_infos/deepseek-harness/notes.md",
        "billing",
      ),
    ).toBe("billing");
  });
});

describe("classifyArchivePreviewKind", () => {
  it("classifies preview kinds from extension", () => {
    expect(classifyArchivePreviewKind("overview/a.md")).toBe("markdown");
    expect(classifyArchivePreviewKind("pages/x.html")).toBe("html");
    expect(classifyArchivePreviewKind("notes.json")).toBe("text");
    expect(classifyArchivePreviewKind("shot.png")).toBe("image");
    expect(classifyArchivePreviewKind("pack.pdf")).toBe("binary");
  });
});

describe("resolveArchivePreviewRoots", () => {
  it("dedupes preview roots", () => {
    expect(resolveArchivePreviewRoots("/tmp/a", "/tmp/a")).toEqual(["/tmp/a"]);
    expect(resolveArchivePreviewRoots("/tmp/a", "/tmp/b")).toEqual([
      "/tmp/a",
      "/tmp/b",
    ]);
  });
});

describe("change_logs display", () => {
  it("keeps project-root and change_logs file names", () => {
    expect(artifactDisplayName("PROJECT.md")).toBe("PROJECT.md");
    expect(
      artifactDisplayName("change_logs/dsh_desktop/daily_logs/20260907.md"),
    ).toBe("20260907.md");
    expect(
      artifactModuleTag("change_logs/dsh_desktop/daily_logs/20260907.md"),
    ).toBe("daily_logs");
  });
});
