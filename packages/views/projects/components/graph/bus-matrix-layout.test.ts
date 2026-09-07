import { describe, expect, it } from "vitest";
import { applyDomainLayout, type BusMatrixLayout } from "./bus-matrix-layout";

const empty: BusMatrixLayout = {
  domainOrder: [],
  hiddenDomains: [],
  aliases: {},
  hiddenRows: [],
  manualRows: [],
};

describe("applyDomainLayout", () => {
  it("keeps snapshot order when no layout is stored", () => {
    expect(applyDomainLayout(["pay", "cart", "home"], empty)).toEqual([
      "pay",
      "cart",
      "home",
    ]);
  });

  it("reorders, then appends unseen domains, then drops hidden columns", () => {
    expect(
      applyDomainLayout(["pay", "cart", "home", "stock"], {
        ...empty,
        domainOrder: ["home", "pay"],
        hiddenDomains: ["cart"],
      }),
    ).toEqual(["home", "pay", "stock"]);
  });
});
