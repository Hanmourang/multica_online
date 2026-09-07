import { describe, expect, it } from "vitest";
import {
  ancestorPaths,
  matchListedPath,
  previewProbeRoots,
  shouldListProbe,
} from "./archive-preview-resolve";

describe("previewProbeRoots", () => {
  it("walks from a code-repo bind up to workspace/projects_mgmt", () => {
    const roots = previewProbeRoots([
      "/Users/eleme/Documents/workspace/ai_workspace_online/ai_agents/multica_online",
    ]);
    expect(roots).toContain(
      "/Users/eleme/Documents/workspace/projects_mgmt/projects",
    );
    expect(roots).toContain("/Users/eleme/Documents/workspace/projects_mgmt");
  });

  it("keeps a correctly bound archive project dir", () => {
    const root = "/Users/eleme/Documents/workspace/projects_mgmt/projects/dsh_desktop";
    expect(previewProbeRoots([root])).toContain(root);
  });
});

describe("shouldListProbe", () => {
  it("lists contract trees only", () => {
    expect(shouldListProbe("/tmp/projects_mgmt/projects")).toBe(true);
    expect(shouldListProbe("/tmp/multica_online")).toBe(false);
  });
});

describe("matchListedPath", () => {
  it("matches a project-prefixed listing", () => {
    expect(
      matchListedPath("overview/product-design/01-可行性评估报告.md", [
        "dsh_desktop/overview/product-design/01-可行性评估报告.md",
      ]),
    ).toBe("dsh_desktop/overview/product-design/01-可行性评估报告.md");
  });
});

describe("ancestorPaths", () => {
  it("stops before $HOME", () => {
    const paths = ancestorPaths(
      "/Users/eleme/Documents/workspace/ai_workspace_online/ai_agents/multica_online",
    );
    expect(paths[0]).toContain("multica_online");
    expect(paths.some((path) => path === "/Users/eleme")).toBe(false);
  });
});
