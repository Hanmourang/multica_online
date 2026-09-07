import { describe, expect, it } from "vitest";
import {
  classifyArchiveScan,
  inferDocType,
  isArchiveResourceMissingError,
  normalizeScanRel,
  parseArchiveFrontmatter,
  resolveArchiveBindTarget,
  selectedImportRequests,
} from "./archive-import";
import { parseArchivePath } from "./archive-inspector";

describe("normalizeScanRel", () => {
  it("keeps project-relative contract paths", () => {
    expect(normalizeScanRel("overview/architecture/architecture.md")).toBe(
      "overview/architecture/architecture.md",
    );
    expect(
      normalizeScanRel("requirements/REQ-20260907-01/s2-plan/plan.md"),
    ).toBe("requirements/REQ-20260907-01/s2-plan/plan.md");
  });

  it("strips the webkitdirectory folder name", () => {
    expect(
      normalizeScanRel("dsh_desktop/overview/research/调研.md"),
    ).toBe("overview/research/调研.md");
  });

  it("strips projects/<key>/ so the path matches the CLI manifest", () => {
    expect(
      normalizeScanRel("projects/dsh_desktop/overview/architecture/a.md"),
    ).toBe("overview/architecture/a.md");
  });

  it("rehydrates a picked requirements/ or overview/ subdirectory", () => {
    expect(normalizeScanRel("REQ-20260907-01/s3-execution/design.md")).toBe(
      "requirements/REQ-20260907-01/s3-execution/design.md",
    );
    expect(normalizeScanRel("architecture/architecture.md")).toBe(
      "overview/architecture/architecture.md",
    );
  });

  it("rehydrates a workspace change_logs tree", () => {
    expect(
      normalizeScanRel("multica/daily_logs/20260907-客户端重启.md"),
    ).toBe("change_logs/multica/daily_logs/20260907-客户端重启.md");
    expect(normalizeScanRel("dsh_desktop/20260904-SIRI-13.md")).toBe(
      "change_logs/dsh_desktop/20260904-SIRI-13.md",
    );
    expect(normalizeScanRel("daily_logs/20260907-x.md")).toBe(
      "change_logs/daily_logs/20260907-x.md",
    );
  });
});

describe("parseArchiveFrontmatter", () => {
  it("reads doc_type, issue id and version", () => {
    const fm = parseArchiveFrontmatter(
      [
        "---",
        "doc_type: plan",
        "multica_issue_id: 11111111-1111-4111-8111-111111111111",
        "version: 2",
        "---",
        "# Plan",
      ].join("\n"),
    );
    expect(fm.docType).toBe("plan");
    expect(fm.issueId).toBe("11111111-1111-4111-8111-111111111111");
    expect(fm.version).toBe(2);
  });
});

describe("inferDocType", () => {
  it("prefers frontmatter then path hint then filename", () => {
    const req = parseArchivePath(
      "requirements/REQ-20260907-01/s2-plan/plan.md",
    );
    expect(inferDocType("requirements/REQ-20260907-01/s2-plan/plan.md", req, {})).toBe(
      "plan",
    );
    expect(
      inferDocType("requirements/REQ-20260907-01/requirement.md", parseArchivePath(
        "requirements/REQ-20260907-01/requirement.md",
      ), {}),
    ).toBe("requirement");
    expect(
      inferDocType(
        "requirements/REQ-20260907-01/s1-prototype/v1.html",
        parseArchivePath("requirements/REQ-20260907-01/s1-prototype/v1.html"),
        {},
      ),
    ).toBe("prototype");
    expect(
      inferDocType("overview/architecture/a.md", parseArchivePath("overview/architecture/a.md"), {
        docType: "architecture",
      }),
    ).toBe("architecture");
    expect(
      inferDocType(
        "overview/architecture/spec_infos/deepseek-harness/prototypes/pages/detail.html",
        parseArchivePath(
          "overview/architecture/spec_infos/deepseek-harness/prototypes/pages/detail.html",
        ),
        {},
      ),
    ).toBe("prototype");
  });
});

describe("classifyArchiveScan", () => {
  it("marks contract files importable and skips existing / unclassified", () => {
    const rows = classifyArchiveScan(
      [
        { relPath: "overview/architecture/architecture.md", content: "# A" },
        { relPath: "overview/research/调研.md", content: "# R" },
        { relPath: "0.调研/旧文档.md", content: "# old" },
        { relPath: "docs/readme.md", content: "# docs" },
        {
          relPath: "multica/daily_logs/20260907-客户端重启.md",
          content: "# log",
        },
        {
          relPath: "qoder-plans/团队模块系统性优化_67bc0377.md",
          content: "# plan",
        },
        { relPath: "qoder_backup/plans/old.md", content: "# backup" },
      ],
      ["overview/research/调研.md"],
    );

    expect(rows.find((row) => row.relPath.endsWith("architecture.md"))?.status).toBe(
      "importable",
    );
    expect(rows.find((row) => row.relPath.endsWith("调研.md"))?.status).toBe("exists");
    expect(rows.find((row) => row.scannedPath.includes("0.调研"))?.status).toBe(
      "unclassified",
    );
    expect(rows.find((row) => row.relPath.startsWith("docs/"))?.status).toBe("skipped");
    const changeLog = rows.find((row) => row.relPath.includes("客户端重启"));
    expect(changeLog?.status).toBe("importable");
    expect(changeLog?.draft?.doc_type).toBe("change-log");
    expect(changeLog?.draft?.scope).toBe("project");
    const workPlan = rows.find((row) => row.relPath.includes("qoder-plans"));
    expect(workPlan?.status).toBe("importable");
    expect(workPlan?.draft?.doc_type).toBe("work-plan");
    expect(rows.find((row) => row.scannedPath.includes("qoder_backup"))?.status).toBe(
      "skipped",
    );
  });

  it("only turns selected importable rows into create requests, never a sync manifest", () => {
    const rows = classifyArchiveScan(
      [
        { relPath: "overview/architecture/architecture.md", content: "# A" },
        { relPath: "requirements/REQ-20260907-01/s2-plan/plan.md", content: "# P" },
      ],
      [],
    );
    rows[1]!.selected = false;
    const requests = selectedImportRequests(rows);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      scope: "project",
      doc_type: "architecture",
      rel_path: "overview/architecture/architecture.md",
    });
    expect(requests.some((item) => "blob_sha" in item)).toBe(false);
  });

  it("leaves harness prototype pages unselected and omits html content", () => {
    const rows = classifyArchiveScan(
      [
        {
          relPath:
            "overview/architecture/spec_infos/deepseek-harness/prototypes/pages/detail.html",
          content: "<html>huge</html>",
        },
        { relPath: "overview/architecture/architecture.md", content: "# A" },
      ],
      [],
    );
    const proto = rows.find((row) => row.relPath.endsWith("detail.html"));
    expect(proto?.status).toBe("importable");
    expect(proto?.selected).toBe(false);
    expect(proto?.draft?.doc_type).toBe("prototype");
    proto!.selected = true;
    const requests = selectedImportRequests(rows);
    expect(requests.find((item) => item.rel_path.endsWith("detail.html"))).toMatchObject({
      doc_type: "prototype",
    });
    expect(
      requests.find((item) => item.rel_path.endsWith("detail.html"))?.content,
    ).toBeUndefined();
    expect(
      requests.find((item) => item.rel_path.endsWith("architecture.md"))?.content,
    ).toBe("# A");
  });

  it("detects the unbound archive 404 from old and new servers", () => {
    expect(
      isArchiveResourceMissingError(
        new Error("project has no archive resource configured"),
      ),
    ).toBe(true);
    expect(
      isArchiveResourceMissingError(
        Object.assign(new Error("project has no archive resource configured"), {
          body: { code: "archive_resource_missing" },
        }),
      ),
    ).toBe(true);
    expect(isArchiveResourceMissingError(new Error("boom"))).toBe(false);
  });

  it("resolves archive bind from an existing local directory", () => {
    expect(resolveArchiveBindTarget(null, [])).toEqual({
      status: "missing",
      resourceId: null,
    });
    expect(
      resolveArchiveBindTarget("res-1", [
        { id: "res-1", resource_type: "local_directory" },
      ]),
    ).toEqual({ status: "bound", resourceId: "res-1" });
    expect(
      resolveArchiveBindTarget(null, [
        { id: "res-2", resource_type: "local_directory" },
      ]),
    ).toEqual({ status: "bind-local", resourceId: "res-2" });
  });

  it("does not emit an empty purge payload when nothing is selected", () => {
    const rows = classifyArchiveScan(
      [{ relPath: "overview/architecture/architecture.md", content: "# A" }],
      ["overview/architecture/architecture.md"],
    );
    expect(selectedImportRequests(rows)).toEqual([]);
  });
});
