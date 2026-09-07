// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildSteps } from "../task-transcript/build-steps";
import type { TimelineItem } from "../task-transcript/build-timeline";
import {
  buildDeliverables,
  extractReplyFilePaths,
  previewContent,
  shortenDeliverablePath,
} from "./build-deliverables";

const T0 = "2026-08-15T10:00:00.000Z";
let seq = 0;
function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}
function call(tool: string, input: Record<string, unknown>): TimelineItem {
  return { seq: ++seq, type: "tool_use", tool, input, created_at: at(seq) };
}
function result(tool: string): TimelineItem {
  return { seq: ++seq, type: "tool_result", tool, output: "ok", created_at: at(seq) };
}
function write(path: string, content: string): TimelineItem[] {
  return [call("Write", { file_path: path, content }), result("Write")];
}
function edit(path: string, oldStr: string, newStr: string, replaceAll = false): TimelineItem[] {
  return [call("Edit", { file_path: path, old_string: oldStr, new_string: newStr, ...(replaceAll ? { replace_all: true } : {}) }), result("Edit")];
}

describe("buildDeliverables", () => {
  it("write 事件产出全文交付物", () => {
    const steps = buildSteps(write("docs/a.md", "# Hello\nworld\n"));
    const out = buildDeliverables(steps, null);
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({
      path: "docs/a.md",
      name: "a.md",
      kind: "added",
      source: "trace",
      content: "# Hello\nworld\n",
      // toLines splits on \n: a trailing newline yields a final empty row.
      addedLines: 3,
    });
  });

  it("同路径多次写取最后一次全文", () => {
    const steps = buildSteps([
      ...write("docs/a.md", "v1"),
      ...write("docs/a.md", "v2-final"),
    ]);
    const out = buildDeliverables(steps, null);
    expect(out).toHaveLength(1);
    expect(out![0]!.content).toBe("v2-final");
  });

  it("edit 事件产出 diff 交付物并累加行数", () => {
    const steps = buildSteps(edit("x.ts", "a\nb", "a\nc\nd"));
    const out = buildDeliverables(steps, null);
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({
      path: "x.ts",
      kind: "modified",
      source: "trace",
      addedLines: 2,
      removedLines: 1,
    });
    expect(out![0]!.content).toBeUndefined();
    expect(out![0]!.diff!.length).toBeGreaterThan(0);
  });

  it("write 之后再 edit：全文应用编辑保持最终态且行数累加", () => {
    const steps = buildSteps([
      ...write("docs/a.md", "line1\nline2\n"),
      ...edit("docs/a.md", "line2", "line2b\nline3"),
    ]);
    const out = buildDeliverables(steps, null);
    expect(out).toHaveLength(1);
    expect(out![0]!.content).toBe("line1\nline2b\nline3\n");
    expect(out![0]!.addedLines).toBe(3 + 2);
    expect(out![0]!.removedLines).toBe(1);
  });

  it("write 后再 edit 但 old_string 匹配不上已写入内容：全文保持原样不乱改", () => {
    const steps = buildSteps([
      ...write("docs/a.md", "line1\nline2\n"),
      ...edit("docs/a.md", "nonexistent", "replacement"),
    ]);
    const out = buildDeliverables(steps, null);
    expect(out![0]!.content).toBe("line1\nline2\n");
  });

  it("replace_all 的 edit 替换全文中所有出现", () => {
    const steps = buildSteps([
      ...write("docs/a.md", "foo\nbar\nfoo\n"),
      ...edit("docs/a.md", "foo", "baz", true),
    ]);
    const out = buildDeliverables(steps, null);
    expect(out![0]!.content).toBe("baz\nbar\nbaz\n");
  });

  it("回复里提到但未写入的路径不是交付物", () => {
    const steps = buildSteps(write("docs/a.md", "x"));
    const reply = "已新增 `docs/a.md`，归档见 `change_logs/proj/2026.md` 和 `src/types.ts`。";
    const out = buildDeliverables(steps, reply);
    expect(out).toHaveLength(1);
    expect(out![0]!.path).toBe("docs/a.md");
    expect(out!.find((d) => d.path === "change_logs/proj/2026.md")).toBeUndefined();
    expect(out!.find((d) => d.path === "src/types.ts")).toBeUndefined();
  });

  it("只有回复引用、没有任何写入时不渲染交付物", () => {
    expect(buildDeliverables([], "见 `docs/only-mentioned.md`")).toBeNull();
  });

  it("无产出返回 null", () => {
    expect(buildDeliverables([], null)).toBeNull();
    expect(buildDeliverables([], "没有任何文件路径")).toBeNull();
  });

  it("缩短过长绝对路径", () => {
    expect(shortenDeliverablePath("docs/a.md")).toBe("docs/a.md");
    expect(
      shortenDeliverablePath(
        "/Users/eleme/Documents/workspace/ai_workspace_online/docs/data-model.md",
      ),
    ).toBe("…/ai_workspace_online/docs/data-model.md");
  });

  it("非写/改类调用（如 Bash）不产生交付物", () => {
    const steps = buildSteps([call("Bash", { command: "pnpm test" }), result("Bash")]);
    expect(buildDeliverables(steps, null)).toBeNull();
  });
});

describe("extractReplyFilePaths", () => {
  it("提取反引号中含 / 且扩展名已知的路径", () => {
    const text = "更新了 `packages/views/x.tsx`；运行 `pnpm test`；`README.md` 不含斜杠不取；a/b.md 无反引号不取";
    expect(extractReplyFilePaths(text)).toEqual(["packages/views/x.tsx"]);
  });

  it("空文本与无 code span 返回空", () => {
    expect(extractReplyFilePaths("")).toEqual([]);
    expect(extractReplyFilePaths("纯文本无引用")).toEqual([]);
  });

  it("去重且保序", () => {
    expect(extractReplyFilePaths("`a/b.md` 然后 `c/d.ts` 再 `a/b.md`")).toEqual(["a/b.md", "c/d.ts"]);
  });
});

describe("previewContent", () => {
  const base = { name: "x", kind: "added" as const, source: "trace" as const, addedLines: 1, removedLines: 0 };

  it("markdown 文件原文返回（走富文本排版）", () => {
    expect(previewContent({ ...base, path: "docs/a.md", content: "# T\n正文" })).toBe("# T\n正文");
  });

  it("代码文件包 fence 并带语言标记", () => {
    expect(previewContent({ ...base, path: "src/a.ts", content: "const x = 1;" })).toBe(
      "```ts\nconst x = 1;\n```",
    );
  });

  it("txt 包无语言 fence（等宽纯文本，不高亮）", () => {
    expect(previewContent({ ...base, path: "notes/log.txt", content: "hello" })).toBe(
      "```\nhello\n```",
    );
  });

  it("内容含反引号串时 fence 自动加长", () => {
    const content = "示例：```js\ncode\n```";
    const out = previewContent({ ...base, path: "docs/a.md", content });
    // md 原文返回，不包 fence
    expect(out).toBe(content);
    const outTs = previewContent({ ...base, path: "docs/a.ts", content });
    expect(outTs).toBe("````ts\n" + content + "\n````");
  });

  it("无 content（仅引用）返回 undefined", () => {
    expect(previewContent({ ...base, path: "a/b.ts", source: "reply" as const, content: undefined })).toBeUndefined();
  });
});
