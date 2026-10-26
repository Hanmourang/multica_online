import { describe, expect, it, vi } from "vitest";
import type { AssetBinding } from "@multica/core/types";
import {
  CLEAR,
  UNCHANGED,
  buildBatchUpdateRequest,
  groupSelectedByProject,
  pruneSelectedIds,
  submitBatchByProject,
} from "./asset-batch-draft";

function binding(id: string, projectId: string, extra: Partial<AssetBinding> = {}): AssetBinding {
  return {
    id,
    workspace_id: "ws-1",
    project_id: projectId,
    asset_category: "knowledge_repo",
    external_ref: {},
    asset_name: `asset-${id}`,
    source: "manual",
    recommended: false,
    created_by_type: "member",
    created_by_id: "u-1",
    created_at: "2026-10-01T00:00:00Z",
    ...extra,
  };
}

const baseForm = {
  stage: UNCHANGED,
  role: UNCHANGED,
  category: UNCHANGED,
  tagsText: "",
  tagsMode: "add" as const,
};

describe("buildBatchUpdateRequest", () => {
  it("returns null when nothing changed（全 UNCHANGED 不提交）", () => {
    expect(buildBatchUpdateRequest({ ...baseForm }, ["a"])).toBeNull();
    // 空选择也不提交
    expect(buildBatchUpdateRequest({ ...baseForm, stage: "S1" }, [])).toBeNull();
  });

  it("maps stage/role CLEAR to empty string（后端空串=清除）", () => {
    const clear = buildBatchUpdateRequest({ ...baseForm, stage: CLEAR, role: CLEAR }, ["a"]);
    expect(clear).toEqual({ binding_ids: ["a"], lifecycle_stage: "", asset_role: "" });
  });

  it("passes enum values through and sets category", () => {
    const req = buildBatchUpdateRequest(
      { ...baseForm, stage: "S5", category: "package" },
      ["a", "b"],
    );
    expect(req).toEqual({
      binding_ids: ["a", "b"],
      lifecycle_stage: "S5",
      asset_category: "package",
    });
  });

  it("parses tags with mixed separators and dedups/blanks dropped", () => {
    const req = buildBatchUpdateRequest(
      { ...baseForm, tagsText: " design，api-doc; 复用 、 ,design ", tagsMode: "replace" },
      ["a"],
    );
    expect(req).toEqual({
      binding_ids: ["a"],
      tags: ["design", "api-doc", "复用"],
      tags_mode: "replace",
    });
  });

  it("omits tags field when text is blank", () => {
    const req = buildBatchUpdateRequest({ ...baseForm, stage: "S3", tagsText: "  ,, " }, ["a"]);
    expect(req).toEqual({ binding_ids: ["a"], lifecycle_stage: "S3" });
  });
});

describe("groupSelectedByProject", () => {
  const rows = [
    binding("1", "p-a"),
    binding("2", "p-b"),
    binding("3", "p-a", { asset_category: "package" }),
    binding("4", "p-c"),
  ];

  it("groups only selected & loaded rows by project_id", () => {
    const groups = groupSelectedByProject(rows, new Set(["1", "2", "3"]));
    expect([...groups.entries()].sort()).toEqual([
      ["p-a", ["1", "3"]],
      ["p-b", ["2"]],
    ]);
    // 未加载/未选中项目不入组（p-c 的 row 4 未被选中）
    expect(groups.has("p-c")).toBe(false);
  });

  it("returns empty map when nothing selected", () => {
    expect(groupSelectedByProject(rows, new Set()).size).toBe(0);
  });
});

describe("pruneSelectedIds", () => {
  it("drops ids no longer present in loaded rows（解绑/刷新后剔除失效选择）", () => {
    const rows = [binding("1", "p-a"), binding("2", "p-a")];
    const { ids, changed } = pruneSelectedIds(new Set(["1", "9", "2"]), rows);
    expect([...ids].sort()).toEqual(["1", "2"]);
    expect(changed).toBe(true);
  });

  it("keeps identity when all ids still valid", () => {
    const rows = [binding("1", "p-a")];
    const { ids, changed } = pruneSelectedIds(new Set(["1"]), rows);
    expect(changed).toBe(false);
    expect([...ids]).toEqual(["1"]);
  });
});

describe("submitBatchByProject", () => {
  it("sends groups sequentially and collects all ids on full success", async () => {
    const calls: string[] = [];
    const send = vi.fn(async (projectId: string) => {
      calls.push(`start:${projectId}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      calls.push(`end:${projectId}`);
    });
    const groups = new Map([
      ["p-a", ["1", "3"]],
      ["p-b", ["2"]],
    ]);
    const result = await submitBatchByProject(groups, send);
    expect(result.succeededIds).toEqual(["1", "3", "2"]);
    expect(result.failedGroups).toEqual([]);
    // 顺序而非并发：上一组 end 必须先于下一组 start
    expect(calls).toEqual(["start:p-a", "end:p-a", "start:p-b", "end:p-b"]);
  });

  it("keeps failed groups for retry and reports successes per project", async () => {
    const send = vi.fn(async (projectId: string) => {
      if (projectId === "p-b") throw new Error("boom");
    });
    const groups = new Map([
      ["p-a", ["1"]],
      ["p-b", ["2", "3"]],
      ["p-c", ["4"]],
    ]);
    const result = await submitBatchByProject(groups, send);
    expect(result.succeededIds).toEqual(["1", "4"]);
    // 失败组保留 projectId 与完整 bindingIds，供容器回滚选择/重试
    expect(result.failedGroups).toEqual([{ projectId: "p-b", bindingIds: ["2", "3"] }]);
    // 失败不应中断后续分组提交
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("returns empty result for empty groups without calling send", async () => {
    const send = vi.fn();
    const result = await submitBatchByProject(new Map(), send);
    expect(result).toEqual({ succeededIds: [], failedGroups: [] });
    expect(send).not.toHaveBeenCalled();
  });
});
