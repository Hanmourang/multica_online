import { describe, expect, it } from "vitest";
import {
  ancestorPaths,
  contractProjectsRoots,
  extractProjectKeysFromYaml,
  isContractRelPath,
  matchListedPath,
  previewProbeRoots,
  previewRelPathCandidates,
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

describe("previewRelPathCandidates", () => {
  it("adds the other three shelves and the basename", () => {
    const candidates = previewRelPathCandidates("overview/research/91-可行性评估.md");
    expect(candidates).toContain("overview/research/91-可行性评估.md");
    expect(candidates).toContain("overview/product-design/91-可行性评估.md");
    expect(candidates).toContain("overview/architecture/91-可行性评估.md");
    expect(candidates).toContain("overview/retrospective/91-可行性评估.md");
    expect(candidates).not.toContain("91-可行性评估.md");
  });

  it("does not invent overview shelves for requirement prototypes", () => {
    const path = "requirements/REQ-图谱邻域/s1-prototype/prototype-v3.html";
    expect(previewRelPathCandidates(path)).toEqual([path]);
  });

  it("keeps a projects/<key> prefix when rewriting the shelf", () => {
    expect(
      previewRelPathCandidates("projects/multica/overview/research/91-可行性评估.md"),
    ).toContain("projects/multica/overview/product-design/91-可行性评估.md");
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

  it("finds the same file after it was moved to another shelf", () => {
    expect(
      matchListedPath("overview/research/91-可行性评估.md", [
        "multica/overview/product-design/91-可行性评估.md",
      ]),
    ).toBe("multica/overview/product-design/91-可行性评估.md");
  });

  it("falls back to a unique basename under overview/", () => {
    expect(
      matchListedPath("overview/research/notes.md", [
        "inbox/notes.md",
        "multica/overview/architecture/spec/notes.md",
      ]),
    ).toBe("multica/overview/architecture/spec/notes.md");
  });
});

describe("contract tree preview", () => {
  it("treats overview/requirements/filing as contract paths", () => {
    expect(isContractRelPath("overview/product-design/prototype/index.html")).toBe(true);
    expect(isContractRelPath("requirements/REQ-图谱邻域/s1-prototype/prototype.html")).toBe(true);
    expect(isContractRelPath("change_logs/docs/prototypes/a.html")).toBe(false);
  });

  it("finds projects_mgmt/projects from a code-repo bind", () => {
    expect(
      contractProjectsRoots([
        "/Users/eleme/Documents/workspace/ai_workspace/github/ai_code/GitNexus-main",
      ]),
    ).toContain("/Users/eleme/Documents/workspace/projects_mgmt/projects");
  });

  it("parses project keys from the registry yaml", () => {
    expect(
      extractProjectKeysFromYaml("version: 1\nprojects:\n  - key: dsh_desktop\n  - key: multica\n"),
    ).toEqual(["dsh_desktop", "multica"]);
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
