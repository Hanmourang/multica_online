import { describe, expect, it } from "vitest";
import { readGraphContext, splitPlanSections, titleMatchesGoals } from "./requirement-plan";

describe("splitPlanSections", () => {
  it("splits standard headings and falls back to the whole plan", () => {
    const split = splitPlanSections(
      "## 目标\n积分引擎\n## 阶段\n先账户后规则\n## 风险\n回滚",
    );
    expect(split.split).toBe(true);
    expect(split.goals).toContain("积分引擎");
    expect(split.phases).toContain("先账户后规则");
    expect(split.risks).toContain("回滚");

    const raw = splitPlanSections("先做账户模型，再落地规则引擎。");
    expect(raw.split).toBe(false);
    expect(raw.raw).toContain("账户模型");
  });
});

describe("titleMatchesGoals / readGraphContext", () => {
  it("uses includes matching and extracts the four graph facets", () => {
    expect(titleMatchesGoals("积分引擎", "目标：积分引擎化")).toBe(true);
    expect(titleMatchesGoals("无关标题", "积分引擎")).toBe(false);
    const g = readGraphContext({
      nodes: ["n1", { label: "L" }],
      code_objects: ["a.go"],
      dependencies: ["d1"],
      impacts: ["i1"],
    });
    expect(g.nodes).toEqual(["n1", "L"]);
    expect(g.code_objects).toEqual(["a.go"]);
  });
});
