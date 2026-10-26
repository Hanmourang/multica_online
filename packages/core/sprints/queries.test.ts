import { describe, expect, it, vi } from "vitest";

// 迭代模块 query key / options 单测（spec 02_迭代模块.md §G：core queries 覆盖）。
// api 层整体 mock——这里锁的是缓存键结构与 queryFn 委托，不是传输。

vi.mock("../api", () => ({
  api: {
    listProjectSprints: vi.fn(async () => ({ sprints: [], total: 0 })),
    getProjectSprint: vi.fn(async () => ({ id: "s1" })),
    getSprintProgress: vi.fn(async () => ({ done_count: 0 })),
  },
}));

import { api } from "../api";
import type { Sprint } from "../types";
import {
  projectSprintsOptions,
  sprintDetailOptions,
  sprintKeys,
  sprintListSelect,
  sprintProgressOptions,
} from "./queries";

describe("sprintKeys", () => {
  it("nests project slices under wsId → projectId so a ws switch never serves stale data", () => {
    expect(sprintKeys.project("ws1", "p1")).toEqual(["sprints", "ws1", "p1"]);
    expect(sprintKeys.detail("ws1", "p1", "s1")).toEqual([
      "sprints",
      "ws1",
      "p1",
      "detail",
      "s1",
    ]);
  });

  it("keeps the ws-wide prefix for realtime invalidation and separates status-filtered lists", () => {
    expect(sprintKeys.all("ws1")).toEqual(["sprints", "ws1"]);
    expect(sprintKeys.list("ws1", "p1", "active")).toEqual([
      "sprints",
      "ws1",
      "p1",
      "list",
      "active",
    ]);
    // 无过滤时落在 "all" 段，与带状态的键互不串台。
    expect(sprintKeys.list("ws1", "p1")).toEqual([
      "sprints",
      "ws1",
      "p1",
      "list",
      "all",
    ]);
  });
});

describe("sprint query options", () => {
  it("projectSprintsOptions delegates to api.listProjectSprints with the status filter", async () => {
    const options = projectSprintsOptions("ws1", "p1", "planned");
    expect(options.queryKey).toEqual(sprintKeys.list("ws1", "p1", "planned"));
    await options.queryFn?.({} as never);
    expect(api.listProjectSprints).toHaveBeenCalledWith("p1", "planned");
  });

  it("sprintListSelect unwraps the envelope", () => {
    const sprints = [{ id: "s1" }, { id: "s2" }] as unknown as Sprint[];
    expect(sprintListSelect({ sprints, total: 2 }).map((s) => s.id)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("sprintProgressOptions hits the derived /progress endpoint (no column, computed server-side)", async () => {
    const options = sprintProgressOptions("ws1", "p1", "s1");
    expect(options.queryKey).toEqual(sprintKeys.progress("ws1", "p1", "s1"));
    await options.queryFn?.({} as never);
    expect(api.getSprintProgress).toHaveBeenCalledWith("p1", "s1");
  });

  it("sprintDetailOptions is keyed per sprint", async () => {
    const options = sprintDetailOptions("ws1", "p1", "s1");
    await options.queryFn?.({} as never);
    expect(api.getProjectSprint).toHaveBeenCalledWith("p1", "s1");
  });
});
