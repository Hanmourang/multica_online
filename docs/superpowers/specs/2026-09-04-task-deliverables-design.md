# 任务交付物展示能力 — 设计文档

- 日期：2026-09-04
- 状态：已评审（方向与原型经用户确认）
- 原型：`2026-09-04-task-deliverables-prototype.html`（同目录）

## 背景与目标

任务详情页的动态流中，agent 完成回复常以纯文本引用产出文件（如 `change_logs/.../xxx.md`），用户无法直接预览；执行记录弹窗的 `RunOutcomeRow` 也只有「N 个文件 +x/−y」聚合 chip，不可点击。

**目标**：每次任务（run）完成时，在动态流完成节点展示该次运行的**最终交付物卡片墙**（多交付物同时展示），点击卡片弹窗**快速预览**，支持多交付物间切换。

已确认的产品决策：
1. 交付物来源 = **轨迹派生 + 回复声明**（双通道合并去重）
2. 展示时机/入口 = **每次任务完成时**，挂在动态流完成事件处
3. 预览形态 = **弹窗预览 + 左右切换**

## 现状与数据基础（已核实）

- 前端可按任务拉取完整执行轨迹：`api.listTaskMessages(taskId)`（`packages/core/api/client.ts:2395`）→ `buildTimeline` → `buildSteps`（`packages/views/common/task-transcript/`）
- 轨迹事件详情（`trace-event-presenter.ts` 的 `traceEventDetail`）：
  - 写文件（write / patch added）→ `{ kind: "file", path, text, lineCount }` **含全文**
  - 编辑文件（edit / patch modified）→ `{ kind: "diff", path, lines }` 仅含变更行
- `RunOutcome`（`run-outcome.ts`）已示范从 steps 聚合 paths / +x / −y / commandCount
- 动态流 `task_completed` 活动由 `server/cmd/server/activity_listeners.go` 的 `handleTaskActivity` 写入，**Details 目前为 `{}`**；但事件 payload 已含 `task_id`（`taskEvent`，`server/internal/service/task.go:6988`）
- `task_completed` 在时间线中会被 coalesce（`coalesced_count`，多次完成合并为一条，见 `issue-detail.tsx` 的 NO_TIME_LIMIT_ACTIONS 逻辑）；coalesce 保留最新 entry，故其 details 对应**最近一次** run
- markdown 渲染复用 `packages/views/rich-content` 的 `RichContent`
- i18n：`packages/views/locales/<locale>/*.json`，由 `parity.test.ts` 强制四语言键一致（en / zh-Hans / ja / ko）

## 方案（已选定：方案 A）

完成事件挂载卡片墙 + 前端纯派生。无 DB 变更、无 daemon 变更、历史任务可追溯。

```
timeline 渲染含 task_completed 的 activity-group
  → entry.details.task_id（server 补写）
  → 懒加载 api.listTaskMessages(task_id) → buildTimeline → buildSteps
  → buildDeliverables(steps, 完成回复文本)
  → DeliverablesSection 卡片墙
  → 点击卡片 → DeliverablePreviewDialog（←→ 切换）
```

### 1. server 端（一处小改）

`handleTaskActivity`（`server/cmd/server/activity_listeners.go`）：从 payload 取 `task_id` 写入 `Details`（`{"task_id": "..."}`）。`task_failed` 同样补写（失败 run 也可能有半成品产出，前端可用同一板块展示，徽标区分；第一版仅 `task_completed` 渲染卡片墙，failed 仅做数据就绪）。

### 2. 交付物聚合：`packages/views/common/deliverables/build-deliverables.ts`

```ts
interface Deliverable {
  path: string;            // 完整相对路径
  name: string;            // 文件名
  kind: "added" | "modified";
  source: "trace" | "reply";          // trace=轨迹派生(可预览) reply=仅回复声明
  addedLines: number;
  removedLines: number;
  content?: string;        // write 最终全文（同路径多次写取最后一次）
  diff?: TraceDiffLine[];  // edit 的变更行（无全文时用于 diff 视图）
}
```

聚合规则：
- 遍历 steps 中 `kind === "call"` 的步骤，经 `traceEventDetail` 取 `file` / `diff` / `patch` 详情，按路径合并：后写覆盖先写；`file`（全文）优先于 `diff`（片段）；行数累加
- **write-then-edit**：write 之后同路径的 edit 会把 `old_string→new_string` 替换应用进已捕获的 `content` 快照（`old_string` 唯一匹配才应用；`replace_all` 全替换；匹配不上则保持写入时快照——宁陈旧不损坏），保持预览为最终态
- 回复声明：完成回复文本取「时间 ≤ 该 task_completed 且最近的 agent 评论」（挂载时由 issue-detail 从已有 timeline 数据传入，无额外请求）；从中提取反引号 code span，过滤「含 `/` 且以已知扩展名结尾」的路径 token；与 trace 集合按路径去重，仅回复独有的标 `source: "reply"`（无内容）
- 空结果返回 `null`（不渲染板块）

### 3. 卡片墙：`DeliverablesSection.tsx`

- 挂载：`issue-detail.tsx` `renderItem` 的 activity-group 分支——group 内含 `task_completed` 时，在 `ActivityBlock` 之后渲染
- 数据：挂载即用 `api.listTaskMessages(taskId)` 拉取（结果写入 `chatKeys.taskMessages(taskId)` 缓存，与 transcript 共享）；失败时板块内显示轻量错误态与重试按钮，不影响动态流其余部分
- 头部：「交付物 · N」＋ 汇总（+x/−y · n 写入 · m 引用）
- 网格卡片：类型图标、文件名、路径、徽标（新增/修改/仅引用）、+x/−y；hover 提示「点击预览」

### 4. 预览弹窗：`DeliverablePreviewDialog.tsx`

- 顶栏：文件名/路径、位置 `i/N`、←→、关闭
- 内容按数据形态自适应（`content`/`diff` 互斥，不设分段切换）：markdown 走 `RichContent`；其余代码/文本文件包语法高亮 fence 走 `RichContent`（fence 长度自动避开内容中的反引号串）；`diff` 行渲染变更片段；`source === "reply"` 显示「仅引用」说明（内容未在本次运行轨迹捕获）
- 键盘：←/→ 切换、Esc 关闭；点击遮罩关闭
- 组件挂在卡片墙所在 group 的局部 state，不污染全局

### 5. i18n

`issues.json`（四语言）新增 `deliverables` 命名空间：`section_title`、`badge_added`、`badge_modified`、`badge_reference`、`stats_summary`（写入/引用计数）、`preview`、`diff_view`、`reference_only_note`、`open_hint` 等。

## 边界与错误处理

- 旧 server 的 `task_completed` 无 `details.task_id` → 按 issue 任务列表兑底匹配（同 `agent_id` + `status=completed` + `completed_at ≤ 活动时间+5s` 容差，取最近一条）；匹配不上才不渲染板块（静默降级）。任务列表复用 `issueKeys.tasks(issueId)` 共享缓存（与执行记录板块同一查询），无额外请求
- `listTaskMessages` 失败 → 板块内显示轻量错误态与重试按钮，不影响动态流其余部分
- 交付物为 0（run 只读/只评论）→ 不渲染
- 同一 run 多次完成被 coalesce → 展示最新 entry 的 task_id（最近一次 run）
- 回复声明路径为幻觉（文件不存在于轨迹）→ 仍展示「仅引用」卡片，预览给说明；不阻塞

## 测试计划（TDD，vitest + go test）

1. server：`handleTaskActivity` 的 details 含 task_id（`activity_listeners_test.go` 扩展）
2. `build-deliverables.test.ts`：write 全文聚合、多次写取最终、edit diff 合并、patch 多文件、回复声明提取与去重、空结果 null
3. `deliverables-section.test.tsx`：空不渲染、卡片墙渲染 N 卡、徽标与行数、点击开弹窗
4. `deliverable-preview-dialog.test.tsx`：markdown/diff/仅引用三种内容、←→ 切换与边界禁用、Esc 关闭
5. issue-detail 挂载测试：含 task_completed 的 group 渲染板块，无 task_id 不渲染
6. i18n parity 测试自动覆盖新增键

## 明确不做（YAGNI）

- 不做 daemon 实时文件读取 API（「仅引用」内容补全留待后续）
- 不做交付物持久化快照到 DB（方案 B 的链路）
- 不做失败 run 的交付物展示（数据就绪，UI 后续开）
- 不做预览中的编辑/下载/复制按钮（第一版只读预览）
