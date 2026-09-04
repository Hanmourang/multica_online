# 任务交付物展示能力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务（run）完成时在动态流完成节点展示最终交付物卡片墙，支持弹窗快速预览与多交付物切换。

**Architecture:** server 在 `task_completed`/`task_failed` 活动 details 补写 `task_id`；前端从该 run 轨迹（`listTaskMessages` → `buildTimeline` → `buildSteps`）聚合交付物（write=全文 / edit=diff），再与完成回复中声明的文件路径合并去重；卡片墙挂在 issue-detail 动态流的完成事件处，点击卡片弹预览弹窗。

**Tech Stack:** Go（server, `go test`）、React + TS（`packages/views`，vitest）、`RichContent`（markdown 渲染）、lucide-react 图标。

**Spec:** `docs/superpowers/specs/2026-09-04-task-deliverables-design.md`（含原型 html）

---

### Task 1: server — 完成/失败活动 details 补写 task_id

**Files:**
- Modify: `server/cmd/server/activity_listeners.go`（`handleTaskActivity`）
- Test: `server/cmd/server/activity_listeners_test.go`

- [ ] **Step 1: 写失败测试**

在 `activity_listeners_test.go` 找到现有 `task_completed` 测试（约 line 289，`activities[0].Action != "task_completed"` 处），追加 details 断言（若无独立测试函数则新增一个）：

```go
// task_completed must carry task_id in details so the web client can lazily
// load that run's transcript and derive its deliverables.
func TestHandleTaskActivityDetailsCarryTaskID(t *testing.T) {
	// 复用现有测试的 bus/queries 夹具模式：发布 EventTaskCompleted，
	// payload 含 task_id / agent_id / issue_id，然后读回 activity 断言：
	var details map[string]string
	if err := json.Unmarshal(activities[0].Details, &details); err != nil {
		t.Fatalf("details must be a JSON object: %v", err)
	}
	if details["task_id"] == "" {
		t.Fatalf("task_completed details must carry task_id, got %v", details)
	}
}
```

（实现时对照现有测试夹具的变量名调整；断言是 RED 的核心。）

- [ ] **Step 2: 运行验证失败**

Run: `cd server && go test ./cmd/server/ -run TestHandleTaskActivityDetailsCarryTaskID -count=1`
Expected: FAIL（details 为 `{}`，`task_id` 为空）

- [ ] **Step 3: 最小实现**

`handleTaskActivity` 中把 `Details: []byte("{}")` 改为：

```go
taskID, _ := payload["task_id"].(string)
details, err := json.Marshal(map[string]string{"task_id": taskID})
if err != nil {
	details = []byte("{}")
}
```

并在 `CreateActivityParams{...}` 中用 `Details: details`。

- [ ] **Step 4: 运行验证通过**

Run: `cd server && go test ./cmd/server/ -run 'TaskActivity' -count=1`
Expected: PASS（含已有测试不回归）

- [ ] **Step 5: Commit**

```bash
git add server/cmd/server/activity_listeners.go server/cmd/server/activity_listeners_test.go
git commit -m "feat(server): carry task_id in task_completed/failed activity details"
```

---

### Task 2: 交付物聚合器 build-deliverables.ts

**Files:**
- Create: `packages/views/common/deliverables/build-deliverables.ts`
- Test: `packages/views/common/deliverables/build-deliverables.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { buildSteps } from "../task-transcript/build-steps";
import { buildTimeline } from "../task-transcript/build-timeline";
import { buildDeliverables, extractReplyFilePaths } from "./build-deliverables";

// 构造一条 write 工具调用的 TimelineItem（对照 build-steps.test.ts 现有夹具写法）
// messages: tool_use(input: {file_path, content}) + tool_result
function writeTaskItems(path: string, content: string) {
  return buildTimeline([
    { seq: 1, message_type: "tool_use", data: { name: "Write", input: { file_path: path, content } } },
    { seq: 2, message_type: "tool_result", data: { output: "ok" } },
  ] as never);
}

describe("buildDeliverables", () => {
  it("write 事件产出全文交付物", () => {
    const items = writeTaskItems("docs/a.md", "# Hello\nworld\n");
    const out = buildDeliverables(buildSteps(items), null);
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({
      path: "docs/a.md", name: "a.md", kind: "added", source: "trace",
      content: "# Hello\nworld\n", addedLines: 2,
    });
  });

  it("同路径多次写取最后一次全文", () => {
    const items = [
      ...writeTaskItems("docs/a.md", "v1"),
      ...writeTaskItems("docs/a.md", "v2-final"),
    ].map((item, i) => ({ ...item, seq: i + 1 }));
    const out = buildDeliverables(buildSteps(items as never), null);
    expect(out).toHaveLength(1);
    expect(out![0].content).toBe("v2-final");
  });

  it("edit 事件产出 diff 交付物并累加行数", () => {
    const items = buildTimeline([
      { seq: 1, message_type: "tool_use", data: { name: "Edit", input: { file_path: "x.ts", old_string: "a\nb", new_string: "a\nc\nd" } } },
    ] as never);
    const out = buildDeliverables(buildSteps(items), null);
    expect(out![0]).toMatchObject({ path: "x.ts", kind: "modified", source: "trace", addedLines: 2, removedLines: 1 });
    expect(out![0].content).toBeUndefined();
    expect(out![0].diff!.length).toBeGreaterThan(0);
  });

  it("回复声明的路径合并去重，仅回复独有的标 source=reply", () => {
    const items = writeTaskItems("docs/a.md", "x");
    const reply = "已新增 `docs/a.md`，归档见 `change_logs/proj/2026.md`，README 无变化";
    const out = buildDeliverables(buildSteps(items), reply);
    expect(out).toHaveLength(2);
    const ref = out!.find((d) => d.path === "change_logs/proj/2026.md");
    expect(ref).toMatchObject({ source: "reply", kind: "added" });
    expect(ref!.content).toBeUndefined();
  });

  it("无产出返回 null", () => {
    expect(buildDeliverables([], null)).toBeNull();
    expect(buildDeliverables([], "没有任何文件路径")).toBeNull();
  });
});

describe("extractReplyFilePaths", () => {
  it("提取反引号中含 / 且扩展名已知的路径", () => {
    const text = "更新了 `packages/views/x.tsx` 和 `README.md`；运行 `pnpm test`；路径 a/b.md 无反引号不取";
    expect(extractReplyFilePaths(text)).toEqual(["packages/views/x.tsx"]);
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/views && npx vitest run common/deliverables/build-deliverables.test.ts`
Expected: FAIL（模块不存在 / 函数未定义）

- [ ] **Step 3: 最小实现**

```ts
import type { TraceStep } from "../task-transcript/build-steps";
import {
  traceEventDetail,
  type TraceDiffLine,
} from "../task-transcript/trace-event-presenter";

export interface Deliverable {
  path: string;
  name: string;
  kind: "added" | "modified";
  source: "trace" | "reply";
  addedLines: number;
  removedLines: number;
  content?: string;
  diff?: TraceDiffLine[];
}

const KNOWN_EXTS = new Set([
  "md", "markdown", "txt", "json", "jsonc", "yaml", "yml", "toml",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "py", "rs", "java",
  "kt", "swift", "sh", "sql", "html", "css", "scss", "vue", "svelte",
  "xml", "csv", "svg", "png", "jpg", "jpeg", "gif", "webp", "pdf",
]);

/** 提取回复文本中反引号 code span 里"像文件路径"的 token（含 / 且扩展名已知）。 */
export function extractReplyFilePaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim();
    if (!token.includes("/") || token.includes(" ")) continue;
    const ext = token.slice(token.lastIndexOf(".") + 1).toLowerCase();
    if (!KNOWN_EXTS.has(ext)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * 聚合一个 run 的最终交付物：轨迹派生（write 全文 / edit diff）为主，
 * 完成回复中声明的路径补充（source=reply，无内容）。同路径后写覆盖先写，
 * file（全文）优先于 diff（片段）。无产出返回 null。
 */
export function buildDeliverables(
  steps: TraceStep[],
  replyText: string | null | undefined,
): Deliverable[] | null {
  const byPath = new Map<string, Deliverable>();
  const order: string[] = [];

  const touch = (path: string): Deliverable => {
    let d = byPath.get(path);
    if (!d) {
      d = { path, name: baseName(path), kind: "modified", source: "trace", addedLines: 0, removedLines: 0 };
      byPath.set(path, d);
      order.push(path);
    }
    return d;
  };

  const applyFile = (path: string, text: string, lineCount: number, changeKind?: string) => {
    const d = touch(path);
    d.content = text;
    d.diff = undefined;
    d.addedLines += lineCount;
    if (changeKind === "add" || d.addedLines === lineCount) d.kind = "added";
  };
  const applyDiff = (path: string, lines: TraceDiffLine[]) => {
    const d = touch(path);
    if (d.content !== undefined) {
      // 已有全文：行数仍累加，内容保持最终全文
    } else {
      d.diff = [...(d.diff ?? []), ...lines];
    }
    for (const line of lines) {
      if (line.kind === "add") d.addedLines += 1;
      else if (line.kind === "remove") d.removedLines += 1;
    }
  };

  for (const step of steps) {
    if (step.kind !== "call" || !step.call) continue;
    const detail = traceEventDetail(step.call);
    switch (detail.kind) {
      case "file":
        applyFile(detail.path, detail.text, detail.lineCount);
        break;
      case "diff":
        applyDiff(detail.path, detail.lines);
        break;
      case "patch":
        for (const f of detail.files) {
          if (f.body.kind === "file") applyFile(f.path, f.body.text, f.body.lineCount, f.changeKind);
          else if (f.body.kind === "diff") applyDiff(f.path, f.body.lines);
        }
        break;
    }
  }

  // 写入先于任何编辑发生时（write 后又有 edit）kind 修正：trace 中首次出现即
  // 决定 added/modified 过于复杂，第一版规则：有全文且全程无 remove → added。
  for (const d of byPath.values()) {
    if (d.content !== undefined && d.removedLines === 0) d.kind = "added";
  }

  // 回复声明合并
  for (const path of replyText ? extractReplyFilePaths(replyText) : []) {
    if (byPath.has(path)) continue;
    byPath.set(path, {
      path, name: baseName(path), kind: "added", source: "reply",
      addedLines: 0, removedLines: 0,
    });
    order.push(path);
  }

  if (order.length === 0) return null;
  return order.map((p) => byPath.get(p)!);
}
```

注意：`traceEventDetail` 的入参是 `TraceEvent`，而 `step.call` 是 `TimelineItem`——`run-outcome.ts` 已示范 `traceEventDetail(step.call)` 可行（类型兼容）。测试夹具的 `TaskMessagePayload` 字段名（`message_type`/`data.name`/`data.input`）须对照 `build-steps.test.ts` 现有夹具校正。

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/views && npx vitest run common/deliverables/build-deliverables.test.ts`
Expected: PASS（6 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add packages/views/common/deliverables/
git commit -m "feat(views): add buildDeliverables run-outcome aggregator"
```

---

### Task 3: 预览弹窗 DeliverablePreviewDialog

**Files:**
- Create: `packages/views/common/deliverables/deliverable-preview-dialog.tsx`
- Test: `packages/views/common/deliverables/deliverable-preview-dialog.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeliverablePreviewDialog } from "./deliverable-preview-dialog";
import type { Deliverable } from "./build-deliverables";

const items: Deliverable[] = [
  { path: "docs/a.md", name: "a.md", kind: "added", source: "trace", addedLines: 2, removedLines: 0, content: "# Title\nbody" },
  { path: "src/b.ts", name: "b.ts", kind: "modified", source: "trace", addedLines: 1, removedLines: 1, diff: [{ kind: "remove", text: "old" }, { kind: "add", text: "new" }] },
  { path: "logs/c.md", name: "c.md", kind: "added", source: "reply", addedLines: 0, removedLines: 0 },
];

describe("DeliverablePreviewDialog", () => {
  it("渲染文件名/路径与位置指示", () => {
    render(<DeliverablePreviewDialog deliverables={items} index={0} onIndexChange={() => {}} onClose={() => {}} />);
    expect(screen.getByText("a.md")).toBeTruthy();
    expect(screen.getByText("docs/a.md")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
  });

  it("write 全文渲染 markdown 内容", () => {
    render(<DeliverablePreviewDialog deliverables={items} index={0} onIndexChange={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Title")).toBeTruthy();
  });

  it("diff 交付物渲染变更行", () => {
    render(<DeliverablePreviewDialog deliverables={items} index={1} onIndexChange={() => {}} onClose={() => {}} />);
    expect(screen.getByText("old")).toBeTruthy();
    expect(screen.getByText("new")).toBeTruthy();
  });

  it("source=reply 渲染仅引用说明", () => {
    render(<DeliverablePreviewDialog deliverables={items} index={2} onIndexChange={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId("deliverable-reference-note")).toBeTruthy();
  });

  it("左右切换与边界禁用", () => {
    const onIndexChange = vi.fn();
    render(<DeliverablePreviewDialog deliverables={items} index={0} onIndexChange={onIndexChange} onClose={() => {}} />);
    expect(screen.getByTestId("deliverable-prev")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByTestId("deliverable-next"));
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it("Esc 与遮罩点击触发 onClose", () => {
    const onClose = vi.fn();
    render(<DeliverablePreviewDialog deliverables={items} index={0} onIndexChange={() => {}} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
```

（测试渲染环境的 i18n provider 对照 `attribution-badge.test.tsx` 或 `comment-card.test.tsx` 的现有包装写法。）

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/views && npx vitest run common/deliverables/deliverable-preview-dialog.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 最小实现**

```tsx
import { useEffect } from "react";
import { ChevronLeft, ChevronRight, FileText, ScrollText, X } from "lucide-react";
import { Dialog, DialogContent } from "@multica/ui/components/ui/dialog";
import { useT } from "@multica/core/i18n";
import { RichContent } from "../../rich-content";
import { cn } from "@multica/ui/lib/utils";
import type { Deliverable } from "./build-deliverables";

export function DeliverablePreviewDialog({
  deliverables, index, onIndexChange, onClose,
}: {
  deliverables: Deliverable[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
}) {
  const { t } = useT("issues");
  const d = deliverables[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      if (e.key === "ArrowRight" && index < deliverables.length - 1) onIndexChange(index + 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, deliverables.length, onIndexChange, onClose]);

  if (!d) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-0 p-0">
        <div className="flex items-center gap-3 border-b px-4 py-2.5">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{d.name}</div>
            <div className="truncate font-mono text-micro text-muted-foreground">{d.path}</div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" data-testid="deliverable-prev" aria-label="previous"
              disabled={index === 0} onClick={() => onIndexChange(index - 1)}
              className="rounded p-1 hover:bg-accent disabled:opacity-40">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-1 font-mono text-micro text-muted-foreground">{index + 1}/{deliverables.length}</span>
            <button type="button" data-testid="deliverable-next" aria-label="next"
              disabled={index === deliverables.length - 1} onClick={() => onIndexChange(index + 1)}
              className="rounded p-1 hover:bg-accent disabled:opacity-40">
              <ChevronRight className="h-4 w-4" />
            </button>
            <button type="button" aria-label="close" onClick={onClose}
              className="ml-1 rounded p-1 hover:bg-accent">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          {d.source === "reply" ? (
            <div data-testid="deliverable-reference-note"
              className="rounded-md border border-dashed px-4 py-3 text-caption text-muted-foreground">
              {t(($) => $.deliverables.reference_only_note)}
            </div>
          ) : d.content !== undefined ? (
            <RichContent content={d.content} />
          ) : (
            <div className="font-mono text-caption">
              {d.diff?.map((line, i) => (
                <div key={i} className={cn("px-2 py-px whitespace-pre-wrap",
                  line.kind === "add" && "bg-success/10 text-success",
                  line.kind === "remove" && "bg-destructive/10 text-destructive")}>
                  {line.kind === "add" ? "+ " : line.kind === "remove" ? "− " : "  "}{line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

（`Dialog` 组件的确切导入路径对照 `packages/views/modals/` 或 `agent-transcript-dialog.tsx` 的现有用法校正；`text-micro`/`text-caption` 等为项目既有 utility class。）

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/views && npx vitest run common/deliverables/deliverable-preview-dialog.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/views/common/deliverables/
git commit -m "feat(views): add DeliverablePreviewDialog with prev/next navigation"
```

---

### Task 4: 卡片墙 DeliverablesSection

**Files:**
- Create: `packages/views/common/deliverables/deliverables-section.tsx`
- Test: `packages/views/common/deliverables/deliverables-section.test.tsx`
- Create: `packages/views/common/deliverables/index.ts`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@multica/core/api", () => ({
  api: { listTaskMessages: vi.fn() },
}));
import { api } from "@multica/core/api";
import { DeliverablesSection } from "./deliverables-section";

const writeMsgs = [
  { seq: 1, message_type: "tool_use", data: { name: "Write", input: { file_path: "docs/a.md", content: "# A" } } },
  { seq: 2, message_type: "tool_result", data: { output: "ok" } },
];

beforeEach(() => vi.mocked(api.listTaskMessages).mockReset());

describe("DeliverablesSection", () => {
  it("加载后渲染卡片墙与汇总", async () => {
    vi.mocked(api.listTaskMessages).mockResolvedValue(writeMsgs as never);
    render(<DeliverablesSection taskId="t1" replyText={null} />);
    await waitFor(() => expect(screen.getByText("a.md")).toBeTruthy());
    expect(screen.getByTestId("deliverables-section")).toBeTruthy();
  });

  it("交付物为空时不渲染", async () => {
    vi.mocked(api.listTaskMessages).mockResolvedValue([] as never);
    const { container } = render(<DeliverablesSection taskId="t1" replyText={null} />);
    await waitFor(() => expect(api.listTaskMessages).toHaveBeenCalled());
    expect(container.querySelector("[data-testid=deliverables-section]")).toBeNull();
  });

  it("加载失败显示错误态与重试", async () => {
    vi.mocked(api.listTaskMessages).mockRejectedValue(new Error("boom"));
    render(<DeliverablesSection taskId="t1" replyText={null} />);
    await waitFor(() => expect(screen.getByTestId("deliverables-error")).toBeTruthy());
  });

  it("点击卡片打开预览弹窗并可切换", async () => {
    vi.mocked(api.listTaskMessages).mockResolvedValue(writeMsgs as never);
    render(<DeliverablesSection taskId="t1" replyText="归档 `logs/c.md`" />);
    await waitFor(() => expect(screen.getByText("a.md")).toBeTruthy());
    fireEvent.click(screen.getByText("c.md"));
    expect(screen.getByTestId("deliverable-reference-note")).toBeTruthy();
    fireEvent.click(screen.getByTestId("deliverable-prev"));
    expect(screen.getByText("1/2")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/views && npx vitest run common/deliverables/deliverables-section.test.tsx`
Expected: FAIL

- [ ] **Step 3: 最小实现**

```tsx
import { useEffect, useMemo, useState } from "react";
import { FilePlus2, FilePen, FileText, PackageOpen } from "lucide-react";
import { api } from "@multica/core/api";
import { useT } from "@multica/core/i18n";
import { buildTimeline } from "../task-transcript/build-timeline";
import { buildSteps } from "../task-transcript/build-steps";
import { buildDeliverables, type Deliverable } from "./build-deliverables";
import { DeliverablePreviewDialog } from "./deliverable-preview-dialog";

export function DeliverablesSection({
  taskId, replyText,
}: { taskId: string; replyText?: string | null }) {
  const { t } = useT("issues");
  const [state, setState] = useState<
    { status: "loading" } | { status: "error" } | { status: "ready"; items: Deliverable[] | null }
  >({ status: "loading" });
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    api.listTaskMessages(taskId)
      .then((msgs) => {
        if (cancelled) return;
        const items = buildDeliverables(buildSteps(buildTimeline(msgs)), replyText);
        setState({ status: "ready", items });
      })
      .catch(() => { if (!cancelled) setState({ status: "error" }); });
    return () => { cancelled = true; };
  }, [taskId, replyText, reloadKey]);

  const summary = useMemo(() => {
    if (state.status !== "ready" || !state.items) return null;
    let add = 0, del = 0, written = 0, refs = 0;
    for (const d of state.items) {
      add += d.addedLines; del += d.removedLines;
      d.source === "reply" ? refs++ : written++;
    }
    return { add, del, written, refs };
  }, [state]);

  if (state.status === "error") {
    return (
      <div data-testid="deliverables-error" className="pb-3 px-4 max-md:px-3 text-caption text-muted-foreground">
        {t(($) => $.deliverables.load_error)}
        <button type="button" className="ml-2 underline" onClick={() => setReloadKey((k) => k + 1)}>
          {t(($) => $.deliverables.retry)}
        </button>
      </div>
    );
  }
  if (state.status !== "ready" || !state.items) return null;

  return (
    <div data-testid="deliverables-section" className="pb-3 px-4 max-md:px-3">
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
          <PackageOpen className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-caption font-medium">{t(($) => $.deliverables.section_title)}</span>
          <span className="rounded-full border px-1.5 text-micro text-muted-foreground">{state.items.length}</span>
          {summary && (
            <span className="ml-auto font-mono text-micro text-muted-foreground">
              {summary.add > 0 && <span className="text-success">+{summary.add}</span>}{" "}
              {summary.del > 0 && <span className="text-destructive">−{summary.del}</span>}
              {" · "}{t(($) => $.deliverables.stats_written, { count: summary.written })}
              {summary.refs > 0 && <>{" · "}{t(($) => $.deliverables.stats_referenced, { count: summary.refs })}</>}
            </span>
          )}
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 p-2.5">
          {state.items.map((d, i) => (
            <button key={d.path} type="button" onClick={() => setPreviewIndex(i)}
              className="rounded-md border px-2.5 py-2 text-left transition-colors hover:border-primary/60 hover:bg-accent/40">
              <div className="flex items-center gap-2">
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate text-caption font-medium">{d.name}</span>
              </div>
              <div className="mt-0.5 truncate font-mono text-micro text-muted-foreground" title={d.path}>{d.path}</div>
              <div className="mt-1.5 flex items-center gap-1.5">
                {d.source === "reply"
                  ? <span className="rounded bg-amber-500/10 px-1 text-micro text-amber-600">{t(($) => $.deliverables.badge_reference)}</span>
                  : d.kind === "added"
                    ? <span className="rounded bg-success/10 px-1 text-micro text-success">{t(($) => $.deliverables.badge_added)}</span>
                    : <span className="rounded bg-info/10 px-1 text-micro text-info">{t(($) => $.deliverables.badge_modified)}</span>}
                <span className="ml-auto font-mono text-micro">
                  {d.addedLines > 0 && <span className="text-success">+{d.addedLines}</span>}
                  {d.removedLines > 0 && <span className="text-destructive"> −{d.removedLines}</span>}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>
      {previewIndex !== null && (
        <DeliverablePreviewDialog
          deliverables={state.items}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </div>
  );
}
```

`index.ts` 导出：

```ts
export { DeliverablesSection } from "./deliverables-section";
export { buildDeliverables, extractReplyFilePaths, type Deliverable } from "./build-deliverables";
```

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/views && npx vitest run common/deliverables/`
Expected: PASS（Task 2/3/4 全部）

- [ ] **Step 5: Commit**

```bash
git add packages/views/common/deliverables/
git commit -m "feat(views): add DeliverablesSection card wall with lazy trace loading"
```

---

### Task 5: issue-detail 动态流挂载 + i18n

**Files:**
- Modify: `packages/views/issues/components/issue-detail.tsx`（renderItem 的 activity-group 分支）
- Modify: `packages/views/locales/en/issues.json`、`zh-Hans/issues.json`、`ja/issues.json`、`ko/issues.json`
- Test: `packages/views/issues/components/issue-detail-deliverables.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**

构造 timeline entries：一条 `task_completed` activity（details 含 `{"task_id":"t-1"}`，actor_type "agent"）+ 一条之前的 agent comment（body 含反引号路径）。断言：
- 渲染出 `[data-testid=deliverables-section]`
- details 无 task_id 的 task_completed → 不渲染
- group 中无 task_completed → 不渲染

（夹具对照 `issue-detail.test.tsx` 现有渲染方式；api.listTaskMessages mock 同 Task 4。）

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/views && npx vitest run issues/components/issue-detail-deliverables.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现挂载**

`renderItem` activity-group 分支中，`ActivityBlock` 之后追加：

```tsx
// Deliverables wall: pin to the most recent task_completed in this group.
// Old servers wrote no task_id into details — the section stays hidden then.
const completedEntry = [...item.entries].reverse().find((e) => e.action === "task_completed");
const completedTaskId = completedEntry
  ? (JSON.parse(completedEntry.details ?? "{}") as { task_id?: string }).task_id
  : undefined;
```

（`details` 在前端 TimelineEntry 上的实际形态若不是 JSON string 而是已解析对象，则直接读取——实现时对照 `packages/core/types/inbox.ts` 的 `TimelineEntry.details` 类型校正。）

回复文本查找（同一组件内，利用已有 timeline 数据）：

```tsx
// 时间 ≤ 完成事件且最近的 agent 评论，作为"完成回复"用于交付物声明提取
const completionReply = completedEntry
  ? allTimelineEntries
      .filter((e) => e.kind === "comment" && e.actor_type === "agent"
        && e.created_at <= completedEntry.created_at)
      .at(-1)?.body ?? null
  : null;
```

渲染：

```tsx
<ActivityBlock ... />
{completedTaskId && (
  <DeliverablesSection taskId={completedTaskId} replyText={completionReply} />
)}
```

注意 `allTimelineEntries` 需从 IssueDetail 内现有的 timeline 数据源取得（实现时定位保存全部 entries 的变量，勿新增请求）。

i18n 键（四语言 `issues.json` 的顶层新增 `"deliverables"` 对象）：

```json
"deliverables": {
  "section_title": "交付物",
  "badge_added": "新增",
  "badge_modified": "修改",
  "badge_reference": "仅引用",
  "stats_written": "{count} 写入",
  "stats_referenced": "{count} 引用",
  "load_error": "交付物加载失败",
  "retry": "重试",
  "reference_only_note": "该文件由智能体在完成回复中声明，内容未在本次运行轨迹中捕获，暂不支持预览。"
}
```

en：`Deliverables` / `Added` / `Modified` / `Referenced` / `{count} written` / `{count} referenced` / `Failed to load deliverables` / `Retry` / `Declared in the completion reply but not captured in this run's transcript, preview unavailable.`
ja / ko 同步补齐（parity.test.ts 强制键一致）。

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/views && npx vitest run issues/components/issue-detail-deliverables.test.tsx locales/parity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/views/issues/components/ packages/views/locales/
git commit -m "feat(views): mount deliverables wall on task completion in issue timeline"
```

---

### Task 6: 全量验证与部署

- [ ] **Step 1: 前端全量**

Run: `cd packages/views && npm run typecheck && npm run lint && npm test`
Expected: 全绿（lint 若有既有告警则确认无新增）

- [ ] **Step 2: server 全量**

Run: `cd server && go build ./... && go vet ./cmd/server/ && go test ./cmd/server/ -count=1`
Expected: 全绿

- [ ] **Step 3: 构建并组件级重启**

```bash
make build
scripts/dev-env.sh down multica-566 --components api,web
scripts/dev-env.sh up --name multica-566 --components api,web
```

Expected: Backend http://localhost:18646 正常 LISTEN，Electron 窗口保留

- [ ] **Step 4: 人工验收**

打开任一已完成任务的详情页 → 动态流完成事件处出现交付物卡片墙 → 点击卡片弹窗预览 → ←→ 切换正常。

- [ ] **Step 5: 变更日志归档**

按规范写入 `/Users/eleme/Documents/workspace/change_logs/multica/daily_logs/20260904-任务交付物展示能力.md`。

---

## Self-Review 记录

- Spec 覆盖：server task_id（Task 1）✓ 聚合器（Task 2）✓ 卡片墙（Task 4）✓ 预览弹窗（Task 3）✓ 挂载+i18n（Task 5）✓ 验证部署（Task 6）✓
- 占位符：无 TBD；两处"实现时对照现有夹具校正"属夹具变量名对齐，非逻辑占位
- 类型一致：`Deliverable` 在 Task 2 定义，Task 3/4/5 引用一致；`buildDeliverables(steps, replyText)` 签名全程一致
