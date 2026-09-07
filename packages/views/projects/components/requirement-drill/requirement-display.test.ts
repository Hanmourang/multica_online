import { describe, expect, it } from "vitest";
import {
  displayTaskTitle,
  isOpaqueTaskTitle,
  needsQuickConfirm,
} from "./requirement-display";

describe("displayTaskTitle", () => {
  it("keeps a real Chinese title", () => {
    expect(displayTaskTitle("PM plan + 拆解：数据模型分析", "需求")).toBe(
      "PM plan + 拆解：数据模型分析",
    );
  });

  it("replaces Task <hex> and bare ids", () => {
    expect(displayTaskTitle("Task 01a077a8", "数据模型分析")).toBe("数据模型分析");
    expect(displayTaskTitle("ac3a3432", "数据模型分析")).toBe("数据模型分析");
    expect(displayTaskTitle("", "数据模型分析")).toBe("数据模型分析");
  });
});

describe("isOpaqueTaskTitle", () => {
  it("detects queue fallbacks", () => {
    expect(isOpaqueTaskTitle("Task 01a077a8")).toBe(true);
    expect(isOpaqueTaskTitle("bf619b28")).toBe(true);
    expect(isOpaqueTaskTitle("#12 Task ac3a3432")).toBe(true);
    expect(isOpaqueTaskTitle("#12")).toBe(true);
    expect(isOpaqueTaskTitle("数据模型分析")).toBe(false);
  });
});

describe("needsQuickConfirm", () => {
  it("covers pending confirmation and in_review", () => {
    expect(needsQuickConfirm({ requirementStatus: "拆解待确认" })).toBe(true);
    expect(needsQuickConfirm({ requirementStatus: "原型待确认" })).toBe(true);
    expect(needsQuickConfirm({ status: "in_review" })).toBe(true);
    expect(needsQuickConfirm({ inboxType: "review_requested" })).toBe(true);
    expect(needsQuickConfirm({ inboxType: "task_completed" })).toBe(true);
    expect(needsQuickConfirm({ inboxType: "agent_completed" })).toBe(true);
    expect(needsQuickConfirm({ status: "todo" })).toBe(false);
  });
});
