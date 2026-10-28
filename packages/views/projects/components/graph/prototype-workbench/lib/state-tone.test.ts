// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  RECONCILE_STATE_ORDER,
  STATE_TONE_CLASS,
  formatCoverageRate,
  stateToneClass,
} from "./state-tone";

// 展示层纯函数单测（M-14）：锁定「状态枚举完整 / 令牌稳定 / 覆盖率诚实边界」，
// 这些正是四态徽标与 KPI 最容易静默漂移的地方。⚠️ 不断言 covered/rate 的计算——
// 那属于后端 service.Reconcile 唯一口径，前端仅原样呈现。

describe("RECONCILE_STATE_ORDER", () => {
  it("covers exactly the five backend states, no drift", () => {
    expect([...RECONCILE_STATE_ORDER].sort()).toEqual(
      ["changed", "covered", "deprecated", "missing", "unregistered"].sort(),
    );
  });

  it("every state has a tone token", () => {
    for (const s of RECONCILE_STATE_ORDER) {
      expect(STATE_TONE_CLASS[s]).toBeTruthy();
    }
  });
});

describe("stateToneClass", () => {
  it("returns the mapped class for a known state", () => {
    expect(stateToneClass("covered")).toBe(STATE_TONE_CLASS.covered);
  });

  it("falls back to deprecated tone for an unknown state (forward-compat)", () => {
    // 后端若将来新增状态，前端不应崩成 undefined class。
    expect(stateToneClass("future_state" as never)).toBe(STATE_TONE_CLASS.deprecated);
  });
});

describe("formatCoverageRate", () => {
  it("rounds a fractional rate to a percent string", () => {
    expect(formatCoverageRate({ rate: 1, denominator: 3 })).toBe("100%");
    expect(formatCoverageRate({ rate: 2 / 3, denominator: 3 })).toBe("67%");
    expect(formatCoverageRate({ rate: 0, denominator: 3 })).toBe("0%");
  });

  it("shows an honest dash when nothing is in scope (all deprecated)", () => {
    // denominator=0 不能假装 100%——全废弃是「无从覆盖」而非「全覆盖」。
    expect(formatCoverageRate({ rate: 0, denominator: 0 })).toBe("—");
  });
});
