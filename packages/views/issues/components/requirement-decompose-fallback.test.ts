import { describe, expect, it } from "vitest";
import type { RoleAssignment } from "@multica/core/types";
import {
  draftsAreConfirmable,
  isFallbackDraftId,
  pickRosterRole,
  synthesizeFallbackDrafts,
} from "./requirement-decompose-fallback";
import { extractPlanWorkItems } from "./requirement-plan";

const roster: RoleAssignment[] = [
  { id: "r-pm", role: "pm", assignee_type: "agent", assignee_id: "pm-1", enabled: true, ordinal: 0 },
  { id: "r-dev", role: "developer", assignee_type: "agent", assignee_id: "dev-1", enabled: true, ordinal: 1 },
  { id: "r-qa", role: "tester", assignee_type: "agent", assignee_id: "qa-1", enabled: true, ordinal: 2 },
];

describe("extractPlanWorkItems", () => {
  it("reads phase list items first", () => {
    expect(
      extractPlanWorkItems(
        "## 目标分解\n- 梳理口径\n## 阶段\n1. 评估数据模型\n2. 写结论\n## 风险\n- 档案未就绪",
      ),
    ).toEqual(["评估数据模型", "写结论", "梳理口径"]);
  });

  it("falls back to the raw list when headings are missing", () => {
    expect(extractPlanWorkItems("- 账户模型\n- 规则引擎")).toEqual([
      "账户模型",
      "规则引擎",
    ]);
  });
});

describe("synthesizeFallbackDrafts", () => {
  it("builds exec + acceptance drafts from the title when the plan has no list", () => {
    const drafts = synthesizeFallbackDrafts({
      title: "本体能力评估",
      goal: "出具评估结论",
      plan: null,
      roster,
    });
    expect(drafts.map((d) => d.temp_id)).toEqual(["fallback-1", "fallback-accept"]);
    expect(drafts[0]?.title).toBe("完成本体能力评估");
    expect(drafts[0]?.assignee_id).toBe("dev-1");
    expect(drafts[0]?.feature_points?.[0]).toMatchObject({
      title: "出具评估结论",
      kind: "modify",
    });
    expect(drafts[1]?.stage).toBe(4);
    expect(drafts[1]?.depends_on).toEqual(["fallback-1"]);
    expect(isFallbackDraftId("fallback-1")).toBe(true);
    expect(draftsAreConfirmable(drafts)).toBe(true);
  });

  it("creates one exec draft per plan phase item", () => {
    const drafts = synthesizeFallbackDrafts({
      title: "积分体系",
      goal: "引擎化",
      plan: "## 阶段\n- 账户模型\n- 规则引擎",
      roster,
    });
    expect(drafts.filter((d) => d.stage === 3).map((d) => d.title)).toEqual([
      "账户模型",
      "规则引擎",
    ]);
    expect(drafts.at(-1)?.depends_on).toEqual(["fallback-1", "fallback-2"]);
  });
});

describe("pickRosterRole", () => {
  it("prefers developer over pm", () => {
    expect(pickRosterRole(roster, ["developer", "data"])?.assignee_id).toBe("dev-1");
  });
});
