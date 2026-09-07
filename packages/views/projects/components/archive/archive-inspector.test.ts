import { describe, expect, it } from "vitest";
import {
  inspectArchivePaths,
  parseArchivePath,
  suggestedRelPath,
} from "./archive-inspector";

describe("parseArchivePath", () => {
  it("accepts PROJECT.md at the project root", () => {
    const parsed = parseArchivePath("projects/dsh_desktop/PROJECT.md");
    expect(parsed.scope).toBe("project");
    expect(parsed.projectKey).toBe("dsh_desktop");
    expect(parsed.docTypeHint).toBe("project");
    expect(parsed.errors).toEqual([]);
  });

  it("accepts project-relative requirement paths", () => {
    const parsed = parseArchivePath(
      "requirements/REQ-20260907-01/s2-plan/plan.md",
    );
    expect(parsed.scope).toBe("requirement");
    expect(parsed.reqKey).toBe("REQ-20260907-01");
    expect(parsed.stage).toBe(2);
    expect(parsed.errors).toEqual([]);
  });

  it("rejects a bad REQ-KEY", () => {
    const parsed = parseArchivePath("requirements/req_1/s2-plan/design.md");
    expect(parsed.errors.some((error) => error.includes("REQ-KEY"))).toBe(true);
  });

  it("recognizes workspace change_logs without treating them as S2 plan", () => {
    const daily = parseArchivePath(
      "change_logs/multica/daily_logs/20260907-客户端重启.md",
    );
    expect(daily.scope).toBe("project");
    expect(daily.projectKey).toBe("multica");
    expect(daily.docTypeHint).toBe("change-log");
    expect(daily.stage).toBeNull();
    expect(daily.errors).toEqual([]);

    const workPlan = parseArchivePath(
      "change_logs/qoder-plans/团队模块系统性优化.md",
    );
    expect(workPlan.docTypeHint).toBe("work-plan");
    expect(workPlan.errors).toEqual([]);

    const backup = parseArchivePath("change_logs/qoder_backup/plans/old.md");
    expect(backup.scope).toBe("repo");
  });
});

describe("inspectArchivePaths", () => {
  it("flags missing architecture and requirement foursome", () => {
    const report = inspectArchivePaths([
      "overview/research/调研.md",
      "requirements/REQ-20260907-01/s1-prototype/v1.html",
    ]);
    expect(report.blocking).toBeGreaterThan(0);
    expect(
      report.findings.some((finding) => finding.rule === "checklist.proj-architecture"),
    ).toBe(true);
    expect(
      report.findings.some((finding) => finding.rule === "checklist.req-design"),
    ).toBe(true);
  });

  it("passes when the required set is present", () => {
    const report = inspectArchivePaths([
      "overview/architecture/architecture.md",
      "requirements/REQ-20260907-01/requirement.md",
      "requirements/REQ-20260907-01/s2-plan/plan.md",
      "requirements/REQ-20260907-01/s2-plan/decomposition.md",
      "requirements/REQ-20260907-01/s3-execution/design.md",
      "requirements/REQ-20260907-01/s3-execution/test-plan.md",
      "requirements/REQ-20260907-01/s4-acceptance/acceptance.md",
      "requirements/REQ-20260907-01/s4-acceptance/report-r1.md",
    ]);
    expect(
      report.findings.filter(
        (finding) =>
          finding.severity === "blocking" &&
          finding.rule.startsWith("checklist."),
      ),
    ).toEqual([]);
  });
});

describe("suggestedRelPath", () => {
  it("places design under s3-execution", () => {
    expect(
      suggestedRelPath({
        scope: "requirement",
        docType: "design",
        stage: 3,
        requirementKey: "REQ-20260907-01",
        filename: "design.md",
      }),
    ).toBe("requirements/REQ-20260907-01/s3-execution/design.md");
  });

  it("places change logs under change_logs/daily_logs", () => {
    expect(
      suggestedRelPath({
        scope: "project",
        docType: "change-log",
        filename: "20260907-客户端重启.md",
      }),
    ).toBe("change_logs/daily_logs/20260907-客户端重启.md");
  });
});
