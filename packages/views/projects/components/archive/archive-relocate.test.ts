import { describe, expect, it } from "vitest";
import {
  dragArtifactIds,
  parseArtifactDragIds,
  relocateOverviewPath,
  relocateToShelf,
  takePendingDragIds,
  setPendingDragIds,
} from "./archive-relocate";

describe("relocateOverviewPath", () => {
  it("rewrites only the shelf segment and keeps nested folders", () => {
    expect(
      relocateOverviewPath(
        "overview/product-design/features/15-手机端.md",
        "architecture",
      ),
    ).toBe("overview/architecture/features/15-手机端.md");
    expect(
      relocateOverviewPath(
        "overview/architecture/spec_infos/deepseek-harness/notes.md",
        "research",
      ),
    ).toBe("overview/research/spec_infos/deepseek-harness/notes.md");
    expect(
      relocateOverviewPath("overview/architecture/architecture.md", "product-design"),
    ).toBe("overview/product-design/architecture.md");
  });

  it("rejects paths that are not on a planning shelf", () => {
    expect(relocateOverviewPath("requirements/REQ-1/s2-plan/plan.md", "research")).toBeNull();
    expect(relocateOverviewPath("PROJECT.md", "research")).toBeNull();
    expect(relocateOverviewPath("overview/misc/note.md", "research")).toBeNull();
  });

  it("rewrites a prefixed overview shelf path", () => {
    expect(
      relocateOverviewPath("projects/multica/overview/research/mrd.md", "architecture"),
    ).toBe("projects/multica/overview/architecture/mrd.md");
  });

  it("keeps the same path when the shelf does not change", () => {
    expect(
      relocateOverviewPath("overview/research/mrd.md", "research"),
    ).toBe("overview/research/mrd.md");
  });

  it("rewrites a prefixed overview shelf path", () => {
    expect(
      relocateOverviewPath("projects/multica/overview/research/mrd.md", "architecture"),
    ).toBe("projects/multica/overview/architecture/mrd.md");
  });

  it("falls back to overview/<shelf>/<basename> for contract-foreign paths", () => {
    expect(relocateToShelf("PROJECT.md", "research")).toBe("overview/research/PROJECT.md");
  });
});

describe("drag ids", () => {
  it("moves the whole pick set when the dragged chip is already picked", () => {
    expect(dragArtifactIds("a", new Set(["a", "b"]))).toEqual(["a", "b"]);
    expect(dragArtifactIds("c", new Set(["a", "b"]))).toEqual(["c"]);
  });

  it("parses the drag payload", () => {
    expect(parseArtifactDragIds(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
    expect(parseArtifactDragIds("nope")).toEqual([]);
  });

  it("falls back to in-memory drag ids when the transfer payload is empty", () => {
    setPendingDragIds(["held"]);
    expect(takePendingDragIds("")).toEqual(["held"]);
    expect(takePendingDragIds("")).toEqual([]);
  });
});
