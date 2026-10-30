import { describe, expect, it } from "vitest";
import type { ModuleSpecFeature } from "@multica/core/types";
import {
  maxFeatureNumber,
  nextFeatureCode,
  reservedFeatureCodes,
  specFeaturesOf,
  specWithFeatures,
  withFeatureAdded,
  withFeatureRemoved,
  withFeatureUpdated,
} from "./module-spec-features";

const feature = (code: string, extra: Partial<ModuleSpecFeature> = {}): ModuleSpecFeature => ({
  code,
  title: `标题 ${code}`,
  kind: "core",
  ...extra,
});

describe("maxFeatureNumber", () => {
  it("takes the largest trailing number", () => {
    expect(maxFeatureNumber([])).toBe(0);
    expect(maxFeatureNumber([feature("FP-01"), feature("FP-07"), feature("FP-03")])).toBe(7);
  });

  it("ignores codes without a trailing number", () => {
    expect(maxFeatureNumber([feature("FP-02"), feature("导航"), feature("chat-9")])).toBe(9);
  });
});

describe("nextFeatureCode", () => {
  it("continues from the largest existing number", () => {
    expect(nextFeatureCode([])).toBe("FP-01");
    expect(nextFeatureCode([feature("FP-01"), feature("FP-02")])).toBe("FP-03");
  });

  it("skips numbers that only survive as orphan brief fields", () => {
    // 删掉 FP-02 之后 spec 只剩 FP-01，但 brief 里还留着 fp.FP-02.desc。
    // 直接复用 FP-02 会把上一份残留的四段详情复活到新功能点上。
    expect(nextFeatureCode([feature("FP-01")])).toBe("FP-02");
    expect(nextFeatureCode([feature("FP-01")], ["FP-02"])).toBe("FP-03");
    expect(nextFeatureCode([feature("FP-01")], ["FP-02", "FP-03"])).toBe("FP-04");
  });

  it("keeps advancing when the candidate collides with a live code", () => {
    expect(nextFeatureCode([feature("FP-01"), feature("FP-03")], ["FP-02"])).toBe("FP-04");
  });
});

describe("reservedFeatureCodes", () => {
  it("collects the FP code from fp.<code>.<field> keys", () => {
    const fields = {
      "fp.FP-01.desc": { value: "a" },
      "fp.FP-01.req": { value: [] },
      "fp.FP-02.acceptance": { value: [] },
      "brief.scope": { value: "b" },
      "module.owner": { value: "c" },
    };
    expect(reservedFeatureCodes(fields).sort()).toEqual(["FP-01", "FP-02"]);
  });

  it("ignores malformed keys and empty input", () => {
    expect(reservedFeatureCodes({ "fp.": 1, fp: 2, "fp.FP-09": 3 })).toEqual([]);
    expect(reservedFeatureCodes(null)).toEqual([]);
    expect(reservedFeatureCodes(undefined)).toEqual([]);
  });
});

describe("specFeaturesOf", () => {
  it("prefers the published spec", () => {
    const spec = { schema: "module_spec/v1", features: [feature("FP-01")] };
    expect(specFeaturesOf(spec, [feature("FP-99") as never])).toEqual([feature("FP-01")]);
  });

  it("falls back to workspace rows only when the module has no spec", () => {
    const rows = [
      { code: "FP-05", title: "导入的", kind: "edge", priority: "p1", group: "分析" },
    ] as never;
    expect(specFeaturesOf(null, rows)).toEqual([
      { code: "FP-05", title: "导入的", kind: "edge", priority: "p1", group: "分析" },
    ]);
    expect(specFeaturesOf(undefined, rows)).toHaveLength(1);
  });

  it("treats an empty feature list in a published spec as authoritative", () => {
    // 删掉最后一条后 spec.features = []：这时不能再回退到右栏行（那是上一版投影），
    // 否则紧接着新增一条会把刚删掉的功能点全带回来。
    const rows = [
      { code: "FP-05", title: "导入的", kind: "edge", priority: "p1", group: "分析" },
    ] as never;
    expect(specFeaturesOf({ schema: "module_spec/v1", features: [] }, rows)).toEqual([]);
  });
});

describe("specWithFeatures", () => {
  it("keeps schema and summary, replaces features", () => {
    const next = specWithFeatures(
      { schema: "module_spec/v2", summary: "保留我", features: [feature("FP-01")] },
      [feature("FP-02")],
    );
    expect(next).toEqual({
      schema: "module_spec/v2",
      summary: "保留我",
      features: [feature("FP-02")],
    });
  });

  it("defaults the schema when there is no previous spec", () => {
    expect(specWithFeatures(null, []).schema).toBe("module_spec/v1");
  });
});

describe("withFeatureAdded", () => {
  it("appends a core feature and normalizes a blank group", () => {
    const list = [feature("FP-01")];
    expect(withFeatureAdded(list, { code: "FP-02", title: "下单", group: " 交易 " })).toEqual([
      feature("FP-01"),
      { code: "FP-02", title: "下单", kind: "core", group: "交易" },
    ]);
    expect(withFeatureAdded(list, { code: "FP-03", title: "空组", group: "   " })[1]).toEqual({
      code: "FP-03",
      title: "空组",
      kind: "core",
      group: undefined,
    });
    expect(list).toHaveLength(1);
  });
});

describe("withFeatureRemoved", () => {
  it("drops only the target and leaves the input untouched", () => {
    const list = [feature("FP-01"), feature("FP-02"), feature("FP-03")];
    const next = withFeatureRemoved(list, "FP-02");
    expect(next.map((item) => item.code)).toEqual(["FP-01", "FP-03"]);
    expect(list).toHaveLength(3);
  });

  it("is a no-op for an unknown code", () => {
    expect(withFeatureRemoved([feature("FP-01")], "FP-09")).toHaveLength(1);
  });
});

describe("withFeatureUpdated", () => {
  it("updates title / kind / group on the target only", () => {
    const list = [feature("FP-01"), feature("FP-02", { group: "旧组" })];
    const next = withFeatureUpdated(list, "FP-02", {
      title: "新标题",
      kind: "edge",
      group: "新组",
    });
    expect(next[0]).toEqual(feature("FP-01"));
    expect(next[1]).toEqual({
      code: "FP-02",
      title: "新标题",
      kind: "edge",
      group: "新组",
    });
  });

  it("clears the group when given a blank string", () => {
    const next = withFeatureUpdated([feature("FP-01", { group: "旧组" })], "FP-01", {
      group: "  ",
    });
    expect(next[0]?.group).toBeUndefined();
  });

  it("never rewrites the code", () => {
    const next = withFeatureUpdated([feature("FP-01")], "FP-01", {
      title: "改标题",
    });
    expect(next[0]?.code).toBe("FP-01");
  });
});
