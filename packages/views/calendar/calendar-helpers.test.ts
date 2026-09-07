import { describe, expect, it } from "vitest";
import type { Issue } from "@multica/core/types";
import {
  findModuleHolder,
  findRescheduleConflict,
  formatTriggerLabel,
  parseStageProgress,
  roleForRequirementStatus,
  showsTriggerLabel,
  firstWorkbenchStage,
  stageForRequirementStatus,
  suggestFreeWindow,
  windowsOverlap,
} from "./calendar-helpers";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "a",
    identifier: "REQ-1",
    number: 1,
    title: "A",
    parent_issue_id: null,
    module_id: "mod-1",
    ...overrides,
  } as unknown as Issue;
}

describe("parseStageProgress", () => {
  it("parses N/M and rejects empty or invalid strings", () => {
    expect(parseStageProgress("2/5")).toEqual({ done: 2, total: 5 });
    expect(parseStageProgress(" 1 / 3 ")).toEqual({ done: 1, total: 3 });
    expect(parseStageProgress("")).toBeNull();
    expect(parseStageProgress("n/a")).toBeNull();
    expect(parseStageProgress("1/0")).toBeNull();
  });
});

describe("roleForRequirementStatus", () => {
  it("maps pipeline statuses to the stage owner", () => {
    expect(roleForRequirementStatus("原型待确认")).toBe("prototyper");
    expect(roleForRequirementStatus("拆解待确认")).toBe("pm");
    expect(roleForRequirementStatus("待触发")).toBe("pm");
    expect(roleForRequirementStatus("执行中")).toBe("developer");
    expect(roleForRequirementStatus("等待模块释放")).toBe("developer");
    expect(roleForRequirementStatus("验收中")).toBe("tester");
    expect(roleForRequirementStatus("已完成")).toBeNull();
  });
});

describe("findModuleHolder", () => {
  it("returns the first occupying peer on the same module", () => {
    const self = issue({ id: "self", requirement_status: "等待模块释放" });
    const holder = issue({
      id: "hold",
      number: 8,
      title: "占用方",
      requirement_status: "执行中",
    });
    const otherMod = issue({
      id: "x",
      module_id: "mod-2",
      requirement_status: "执行中",
    });
    expect(findModuleHolder([self, otherMod, holder], self)).toEqual(holder);
  });

  it("returns null when module is missing or nobody is occupying", () => {
    const self = issue({ module_id: null, requirement_status: "等待模块释放" });
    expect(findModuleHolder([self, issue({ id: "b" })], self)).toBeNull();
    const waiting = issue({ requirement_status: "待触发" });
    expect(findModuleHolder([waiting], waiting)).toBeNull();
  });
});

describe("findRescheduleConflict / windowsOverlap", () => {
  it("detects an overlapping occupier after a proposed move", () => {
    const moving = issue({
      id: "m",
      start_at: "2026-09-20T09:00:00Z",
      due_date: "2026-09-21",
    });
    const occupier = issue({
      id: "o",
      requirement_status: "执行中",
      start_at: "2026-09-10T09:00:00Z",
      due_date: "2026-09-12",
    });
    expect(
      findRescheduleConflict(
        [moving, occupier],
        moving,
        new Date("2026-09-11T00:00:00Z"),
        new Date("2026-09-12T00:00:00Z"),
      )?.id,
    ).toBe("o");
    expect(
      windowsOverlap(
        new Date("2026-09-01T00:00:00Z"),
        new Date("2026-09-02T00:00:00Z"),
        new Date("2026-09-03T00:00:00Z"),
        new Date("2026-09-04T00:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("stageForRequirementStatus", () => {
  it("maps pending / running / acceptance statuses onto the four workbench stages", () => {
    expect(stageForRequirementStatus("原型待确认")).toBe(1);
    expect(stageForRequirementStatus("拆解待确认")).toBe(2);
    expect(stageForRequirementStatus("待触发")).toBe(3);
    expect(stageForRequirementStatus("验收中")).toBe(4);
    expect(stageForRequirementStatus(null)).toBe(2);
  });

  it("lands create on S1 when prototyper is on, otherwise S2", () => {
    expect(firstWorkbenchStage(true)).toBe(1);
    expect(firstWorkbenchStage(false)).toBe(2);
  });
});

describe("suggestFreeWindow", () => {
  it("returns the day after the latest occupier when a module is busy", () => {
    const moving = issue({
      id: "m",
      start_at: "2026-09-20T09:00:00Z",
      due_date: "2026-09-21",
    });
    const occupier = issue({
      id: "o",
      requirement_status: "执行中",
      start_at: "2026-09-10T09:00:00Z",
      due_date: "2026-09-12",
    });
    const free = suggestFreeWindow([moving, occupier], moving, 1);
    expect(free?.start.toISOString().slice(0, 10)).toBe("2026-09-13");
    expect(free?.end.toISOString().slice(0, 10)).toBe("2026-09-14");
  });
});

describe("trigger label", () => {
  it("formats UTC day+minute and only shows before trigger", () => {
    expect(formatTriggerLabel("2026-09-12T09:00:00Z")).toBe("9/12 09:00");
    expect(
      showsTriggerLabel(issue({ requirement_status: "待触发", start_at: "2026-09-12T09:00:00Z" })),
    ).toBe(true);
    expect(
      showsTriggerLabel(
        issue({
          requirement_status: "待触发",
          triggered_at: "2026-09-12T09:00:00Z",
        }),
      ),
    ).toBe(false);
  });
});
