import { describe, expect, it } from "vitest";
import { normalizeAssetPage, assetKeys } from "./queries";

// 分页信封防御式归一化单测（spec 03_资产管理模块.md §C）。
// 服务端始终返回完整信封，但降级 200 / 旧版响应 / 半截数据都不能打穿表格，
// 逐字段回落到安全默认。

describe("normalizeAssetPage", () => {
  it("passes a well-formed envelope through untouched", () => {
    const raw = {
      items: [{ id: "a1" }],
      page: 2,
      pageSize: 10,
      totalCount: 25,
      totalPages: 3,
    };
    expect(normalizeAssetPage(raw)).toEqual(raw);
  });

  it("returns an empty page for null / non-object input", () => {
    const empty = { items: [], page: 1, pageSize: 20, totalCount: 0, totalPages: 0 };
    expect(normalizeAssetPage(null)).toEqual(empty);
    expect(normalizeAssetPage(undefined)).toEqual(empty);
    expect(normalizeAssetPage("nope")).toEqual(empty);
  });

  it("coerces a non-array items field to []", () => {
    const page = normalizeAssetPage({ items: null, totalCount: 5 });
    expect(page.items).toEqual([]);
  });

  it("clamps a non-positive / non-numeric pageSize to 20", () => {
    expect(normalizeAssetPage({ pageSize: 0 }).pageSize).toBe(20);
    expect(normalizeAssetPage({ pageSize: -5 }).pageSize).toBe(20);
    expect(normalizeAssetPage({ pageSize: "20" }).pageSize).toBe(20);
  });

  it("derives totalCount from items when the wire count is invalid", () => {
    const page = normalizeAssetPage({ items: [{ id: "a" }, { id: "b" }], totalCount: -1 });
    expect(page.totalCount).toBe(2);
  });

  it("derives missing totalPages from ceil(totalCount / pageSize)", () => {
    const page = normalizeAssetPage({ items: [], totalCount: 45, pageSize: 20 });
    expect(page.totalPages).toBe(3);
  });

  it("defaults page to 1 when out of range", () => {
    expect(normalizeAssetPage({ page: 0 }).page).toBe(1);
    expect(normalizeAssetPage({ page: -3 }).page).toBe(1);
  });
});

describe("assetKeys", () => {
  it("nests project list under wsId → projectId so a ws switch never serves stale data", () => {
    expect(assetKeys.list("ws1", "p1", { page: 1 })).toEqual([
      "assets",
      "ws1",
      "p1",
      "list",
      { page: 1 },
    ]);
  });

  it("groups everything under the workspace prefix for realtime invalidation", () => {
    expect(assetKeys.all("ws1")).toEqual(["assets", "ws1"]);
    expect(assetKeys.issue("ws1", "i1")).toEqual(["assets", "ws1", "issue", "i1"]);
  });
});
