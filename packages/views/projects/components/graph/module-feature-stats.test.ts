import { describe, expect, it } from "vitest";
import type { Issue } from "@multica/core/types";
import {
  decoratePrototypeFeatures,
  diffFeaturePoints,
  extractFeaturePoints,
  matchNodesForFeaturePoint,
  matchObjectForFeaturePoint,
  moduleHealth,
  moduleRequirements,
  moduleTasks,
  objectKind,
  objectTables,
  artifactForPrototypeVersion,
  pickPrototypePair,
  rollupTasks,
  strategyRows,
  summaryForModule,
} from "./module-feature-stats";

function issue(partial: Partial<Issue> & Pick<Issue, "id" | "status">): Issue {
  return {
    workspace_id: "ws",
    title: partial.title ?? partial.id,
    description: null,
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "u",
    parent_issue_id: null,
    project_id: "p",
    position: 0,
    stage: null,
    start_date: null,
    due_date: null,
    metadata: {},
    properties: {},
    created_at: "2026-09-13T00:00:00Z",
    updated_at: "2026-09-13T00:00:00Z",
    number: 1,
    ...partial,
  } as Issue;
}

describe("module feature stats", () => {
  it("splits requirements from tasks", () => {
    const rows = [
      issue({
        id: "r",
        status: "todo",
        start_at: "2026-09-01T00:00:00Z",
        title: "需求",
      }),
      issue({ id: "t", status: "todo", title: "任务" }),
    ];
    expect(moduleRequirements(rows).map((row) => row.id)).toEqual(["r"]);
    expect(moduleTasks(rows).map((row) => row.id)).toEqual(["t"]);
  });

  it("rolls up task bars and health", () => {
    const tasks = [
      issue({ id: "1", status: "done" }),
      issue({ id: "2", status: "in_progress" }),
      issue({ id: "3", status: "blocked" }),
      issue({ id: "4", status: "todo" }),
    ];
    expect(rollupTasks(tasks)).toEqual({
      done: 1,
      doing: 1,
      stuck: 1,
      other: 1,
      total: 4,
    });
    expect(moduleHealth(true, tasks)).toBe("warn");
    expect(moduleHealth(false, tasks)).toBe("unbound");
    expect(moduleHealth(true, [issue({ id: "x", status: "in_progress" })])).toBe("busy");
  });

  it("projects unbound modules by community name", () => {
    expect(
      summaryForModule(
        [{ node_id: "comm-legacy", name: "legacy-import", obj_count: 23, strategy_count: 0, edge_stats: { calls_internal: 0, calls_external: 0 }, tables_touched: [] }],
        null,
        "legacy-import",
      )?.obj_count,
    ).toBe(23);
  });

  it("reads data-kind from either side of data-fp", () => {
    const points = extractFeaturePoints(
      `<div data-kind="modify" data-fp="fp.refund.retry" data-title="重试">上限 3 次</div>
       <section data-fp="fp.refund.status" data-kind="new">状态条</section>`,
    );
    expect(points.map((row) => `${row.id}:${row.kind}`)).toEqual([
      "fp.refund.retry:modify",
      "fp.refund.status:new",
    ]);
  });

  it("pairs marks onto extracted prototype modules", () => {
    const rows = decoratePrototypeFeatures(
      [{ id: "fp.refund.retry", title: "重试", text: "上限 3 次", source: "fp", kind: "modify" }],
      [{ detail_id: "fp.refund.retry", verdict: "no", note: "去掉自动升级" }],
    );
    expect(rows[0]?.mark?.verdict).toBe("no");
  });

  it("diffs prototype feature points by data-fp", () => {
    const left = extractFeaturePoints(
      `<div data-fp="fp.a" data-title="A">old</div><div data-fp="fp.b" data-title="B">keep</div>`,
    );
    const right = extractFeaturePoints(
      `<div data-fp="fp.a" data-title="A">new</div><div data-fp="fp.c" data-title="C">added</div>`,
    );
    expect(diffFeaturePoints(left, right).map((row) => `${row.id}:${row.kind}`)).toEqual([
      "fp.a:modified",
      "fp.b:removed",
      "fp.c:added",
    ]);
  });

  it("matches prototype html_path to archive rows by suffix or unique basename", () => {
    const version = {
      id: "v",
      issue_id: "i",
      version: 3,
      html_path: "requirements/REQ-x/s1-prototype/prototype-v3.html",
      prompt: "",
      marks: [],
      status: "confirmed" as const,
      created_by_type: "member" as const,
      created_by_id: null,
      created_at: "2026-09-08T00:00:00Z",
    };
    const row = {
      id: "a1",
      workspace_id: "ws",
      project_id: "p",
      resource_id: "r",
      issue_id: "i",
      scope: "requirement" as const,
      stage: 1,
      doc_type: "prototype",
      version: 3,
      rel_path: "requirements/REQ-x/s1-prototype/prototype-v3.html",
      blob_sha: "sha",
      size_bytes: 10,
      source: "server" as const,
      synced_at: version.created_at,
      created_at: version.created_at,
      updated_at: version.created_at,
    };
    expect(artifactForPrototypeVersion(version, [row], { workspace_id: "ws", project_id: "p" }).id).toBe("a1");
    expect(
      artifactForPrototypeVersion(
        { ...version, html_path: "prototype-v3.html" },
        [row],
        { workspace_id: "ws", project_id: "p" },
      ).id,
    ).toBe("a1");
  });

  it("picks confirmed current and previous baseline", () => {
    const pair = pickPrototypePair([
      { id: "1", issue_id: "i", version: 1, html_path: "a.html", prompt: "", marks: [], status: "superseded", created_by_type: "member", created_by_id: null, created_at: "2026-09-01T00:00:00Z" },
      { id: "2", issue_id: "i", version: 2, html_path: "b.html", prompt: "", marks: [], status: "superseded", created_by_type: "member", created_by_id: null, created_at: "2026-09-04T00:00:00Z" },
      { id: "3", issue_id: "i", version: 3, html_path: "c.html", prompt: "", marks: [], status: "confirmed", created_by_type: "member", created_by_id: null, created_at: "2026-09-08T00:00:00Z" },
    ]);
    expect(pair.current?.id).toBe("3");
    expect(pair.baseline?.id).toBe("2");
  });

  it("matches objects and nodes by fp id without inventing hits", () => {
    expect(
      matchObjectForFeaturePoint("fp.graph.list", [
        { id: "o1", entity_type: "code", qualified_name: "views/graph/CommunityList.tsx" },
      ])?.qualified_name,
    ).toBe("views/graph/CommunityList.tsx");
    expect(
      matchObjectForFeaturePoint("fp.cart.coupon", [
        { id: "o1", entity_type: "code", qualified_name: "views/graph/CommunityList.tsx" },
      ]),
    ).toBeUndefined();
    expect(
      matchNodesForFeaturePoint("fp.graph.route", [
        { id: "n1", type: "Route", name: "GET /graph/route" },
      ]).map((node) => node.id),
    ).toEqual(["n1"]);
  });

  it("reads object kind / tables and prefers S* strategies", () => {
    expect(objectKind({ kind: "Hook" }, "code")).toBe("Hook");
    expect(objectTables({ tables: ["issue", "attachment"] })).toBe("issue · attachment");
    expect(
      strategyRows([
        { key: "community_id" },
        { key: "S3" },
        { key: "S8" },
      ]).map((row) => row.key),
    ).toEqual(["S3", "S8"]);
  });
});
