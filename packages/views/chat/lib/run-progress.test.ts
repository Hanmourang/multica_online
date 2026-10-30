import { describe, expect, it } from "vitest";
import type { TaskMessagePayload } from "@multica/core/types";
import { buildRunProgress, describeToolCall, skillNameFromPath } from "./run-progress";

function msg(
  seq: number,
  type: TaskMessagePayload["type"],
  extra: Partial<TaskMessagePayload> = {},
): TaskMessagePayload {
  return { task_id: "task-1", issue_id: "issue-1", seq, type, ...extra };
}

describe("describeToolCall", () => {
  it("命令类工具只留首行，避免多行 heredoc 撑满一行", () => {
    expect(describeToolCall("Bash", { command: "pnpm test\n第二行" })).toEqual({
      kind: "command",
      target: "pnpm test",
    });
  });

  it("按工具别名取路径 / 搜索词", () => {
    expect(describeToolCall("read_file", { path: "/a/b.ts" })).toEqual({
      kind: "read",
      target: "/a/b.ts",
    });
    expect(describeToolCall("grep", { pattern: "task_status" })).toEqual({
      kind: "search",
      target: "task_status",
    });
  });

  it("skill 工具取技能名", () => {
    expect(describeToolCall("skill", { name: "multica-feature-modules" })).toEqual({
      kind: "skill",
      target: "multica-feature-modules",
    });
  });

  it("MCP 工具按名字里的 mcp 归类", () => {
    expect(describeToolCall("getMcpTools").kind).toBe("mcp");
  });

  it("整条命令被塞进 tool 字段的脏数据按命令处理", () => {
    const dirty = "cat_>_/tmp/check8.mjs_<<'eof'\nimport { DatabaseSync } from 'node:sqlite'";
    expect(describeToolCall(dirty)).toEqual({
      kind: "command",
      target: "cat_>_/tmp/check8.mjs_<<'eof'",
    });
  });

  it("未知工具回落到第一个字符串参数", () => {
    expect(describeToolCall("some_new_tool", { query: "hello" })).toEqual({
      kind: "other",
      target: "hello",
    });
  });
});

describe("skillNameFromPath", () => {
  it("从 SKILL.md 路径取技能目录名", () => {
    expect(skillNameFromPath("/repo/builtin_skills/multica-feature-modules/SKILL.md")).toBe(
      "multica-feature-modules",
    );
    expect(skillNameFromPath("C:\\skills\\multica-assets\\SKILL.md")).toBe("multica-assets");
  });

  it("普通文件返回 null", () => {
    expect(skillNameFromPath("packages/views/chat/x.tsx")).toBeNull();
    expect(skillNameFromPath("SKILL.md")).toBeNull();
  });
});

describe("buildRunProgress", () => {
  it("把 tool_use / tool_result 配成一步，并统计完成数", () => {
    const progress = buildRunProgress([
      msg(1, "tool_use", {
        tool: "skill",
        input: { name: "multica-feature-modules" },
        created_at: "2026-10-30T09:00:00Z",
      }),
      msg(2, "tool_result", { tool: "skill", created_at: "2026-10-30T09:00:02Z" }),
      msg(3, "tool_use", {
        tool: "bash",
        input: { command: "multica module list --project p1" },
      }),
      msg(4, "tool_result", { tool: "bash" }),
      msg(5, "tool_use", { tool: "read", input: { file_path: "packages/views/chat/x.tsx" } }),
    ]);

    expect(progress.steps.map((step) => [step.kind, step.target, step.status])).toEqual([
      ["skill", "multica-feature-modules", "done"],
      ["command", "multica module list --project p1", "done"],
      ["read", "packages/views/chat/x.tsx", "running"],
    ]);
    expect(progress.steps[0]?.durationMs).toBe(2000);
    expect(progress.finished).toBe(2);
    expect(progress.total).toBe(3);
    // 没有 result 的那一步就是「当前正在做什么」。
    expect(progress.active?.kind).toBe("read");
  });

  it("skill 之后的步骤归到该 skill 名下", () => {
    const progress = buildRunProgress([
      msg(1, "tool_use", { tool: "skill", input: { name: "multica-feature-modules" } }),
      msg(2, "tool_result", { tool: "skill" }),
      msg(3, "tool_use", { tool: "bash", input: { command: "multica module list" } }),
      msg(4, "tool_result", { tool: "bash" }),
      msg(5, "tool_use", { tool: "skill", input: { name: "multica-assets" } }),
      msg(6, "tool_result", { tool: "skill" }),
      msg(7, "tool_use", { tool: "bash", input: { command: "multica asset list" } }),
    ]);

    expect(progress.skills.map((skill) => skill.name)).toEqual([
      "multica-feature-modules",
      "multica-assets",
    ]);
    expect(progress.steps[1]?.skillName).toBe("multica-feature-modules");
    expect(progress.steps[3]?.skillName).toBe("multica-assets");
    expect(progress.currentSkill).toBe("multica-assets");
  });

  it("读 SKILL.md 也算加载技能", () => {
    const progress = buildRunProgress([
      msg(1, "tool_use", {
        tool: "read",
        input: {
          file_path:
            "/repo/server/internal/service/builtin_skills/multica-feature-modules/SKILL.md",
        },
      }),
      msg(2, "tool_result", { tool: "read" }),
      msg(3, "tool_use", { tool: "bash", input: { command: "multica module list" } }),
    ]);

    expect(progress.steps[0]).toMatchObject({
      kind: "skill",
      target: "multica-feature-modules",
      status: "done",
    });
    expect(progress.steps[1]?.skillName).toBe("multica-feature-modules");
  });

  it("thinking 碎片不进步骤列表，error 只计数", () => {
    const progress = buildRunProgress([
      msg(1, "thinking", { content: "先看看模块" }),
      msg(2, "thinking", { content: "再看原型" }),
      msg(3, "error", { content: "provider 500" }),
      msg(4, "text", { content: "已完成" }),
    ]);

    expect(progress.steps).toEqual([]);
    expect(progress.errors).toBe(1);
    expect(progress.active).toBeNull();
  });
});
