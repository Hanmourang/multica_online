import { describe, expect, it } from "vitest";
import {
  artifactDisplayName,
  classifyArchivePreviewKind,
  resolveArchivePreviewRoots,
} from "./archive-display";

describe("artifactDisplayName", () => {
  it("strips overview/<type>/ so chips do not repeat the card header", () => {
    expect(artifactDisplayName("overview/architecture/architecture.md")).toBe(
      "architecture.md",
    );
    expect(
      artifactDisplayName(
        "overview/architecture/spec_infos/deepseek-harness/notes.md",
      ),
    ).toBe("spec_infos/deepseek-harness/notes.md");
    expect(
      artifactDisplayName("overview/product-design/dsh/交互说明.md"),
    ).toBe("dsh/交互说明.md");
  });

  it("classifies preview kinds from extension", () => {
    expect(classifyArchivePreviewKind("overview/a.md")).toBe("markdown");
    expect(classifyArchivePreviewKind("pages/x.html")).toBe("html");
    expect(classifyArchivePreviewKind("notes.json")).toBe("text");
    expect(classifyArchivePreviewKind("shot.png")).toBe("image");
    expect(classifyArchivePreviewKind("pack.pdf")).toBe("binary");
  });

  it("dedupes preview roots", () => {
    expect(resolveArchivePreviewRoots("/tmp/a", "/tmp/a")).toEqual(["/tmp/a"]);
    expect(resolveArchivePreviewRoots("/tmp/a", "/tmp/b")).toEqual([
      "/tmp/a",
      "/tmp/b",
    ]);
  });

  it("keeps project-root and change_logs tails", () => {
    expect(artifactDisplayName("PROJECT.md")).toBe("PROJECT.md");
    expect(
      artifactDisplayName("change_logs/dsh_desktop/daily_logs/20260907.md"),
    ).toBe("dsh_desktop/daily_logs/20260907.md");
  });
});
