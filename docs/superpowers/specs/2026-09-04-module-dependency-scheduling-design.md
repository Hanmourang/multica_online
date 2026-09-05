# 模块 + 依赖调度：设计文档

日期：2026-09-04 · 状态：已确认（需求语义与实现方案均经用户逐项确认）

## 1. 背景与目标

现状：multica daemon 对挂载了 `local_directory` 项目资源的任务按**目录路径互斥**（`LocalPathLocker`，MUL-2663），同一本地目录上的任务强制串行，等待方显示"等待本地目录释放"。`issue_dependency` 表自 migration 001 起存在但从未接线（无 CRUD、无调度消费）。

目标：引入**模块（Module）**与**依赖（Dependency）**两个任务级概念。核心理念：**一个项目通常就是一个产品——同一模块下的修改通过显式依赖 + 需求组互斥串行编排，跨模块的修改默认互不阻塞、充分并发**，用显式依赖取代一刀切的目录锁：

- 相同模块内：**同一需求组（`root_requirement_id`）内**任务按依赖 DAG 拓扑执行、无依赖关系的并发；**跨需求组自动互斥串行**（同模块的不同需求不并发）。强制点在 daemon 内存 `ModuleLocker`（锁 key = `(moduleID, rootRequirementID)`），不再目录互斥。
- 不同模块间：创建任务时可选「避免冲突」（`avoid_conflict`），勾选则该任务与其他模块的任务在**模块粒度**互斥（与目录无关）；勾选后跨模块也互斥，锁 key 退化为 module 级。
- 无模块任务：不参与任何锁。

> **修订（requirement-calendar WS3）**：本文初版（451）的同模块语义为「无依赖即并发、同模块永不互斥」；需求日历 WS3 将其升级为 **ModuleLocker v2**——同模块**同组**按 DAG 并发、同模块**跨组**无条件互斥串行（详见 `2026-09-04-requirement-calendar-design.md` §7.3/§7.4 与 `ARCHITECTURE.md` §5.2）。下文 §5 的 total/exclusive 双计数为 v1 历史模型。

## 2. 已确认的需求语义

| 决策点 | 结论 |
| --- | --- |
| 模块 | issue 上的**单选**轻量标签，归属于项目（project） |
| 避免冲突 | 创建/编辑任务时勾选；勾选后**跨模块互斥**：异模块串行，与目录无关；一方勾选即双向生效（详见 §5 锁模型）。**WS3 注**：同模块跨需求组已自动互斥（不依赖本开关），本开关额外管跨模块 |
| 依赖 | 任务间多对多 DAG；**限定同模块内配置**；**同一需求组内**按拓扑序执行、入度为 0 的可并发；同模块跨需求组由 ModuleLocker v2 自动串行 |
| 前置失败/取消 | 后继**阻塞在 queued**，等人工修复前置（重跑至"已完成"）后自动放行 |
| 无模块任务 | 不参与任何锁（目录互斥语义废弃） |
| 实现方案 | A：server 端依赖闸门 + daemon 端模块锁（`ModuleLocker` v2：锁 key = `(moduleID, rootRequirementID)`，WS3） |

## 3. 数据模型（migration，编号按仓库现有序号顺延）

```sql
-- ① 模块表：项目下的轻量单选枚举
CREATE TABLE project_module (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    color        TEXT NOT NULL DEFAULT '#8A8F98',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

-- ② issue 扩展
ALTER TABLE issue
    ADD COLUMN module_id UUID REFERENCES project_module(id) ON DELETE SET NULL,
    ADD COLUMN avoid_conflict BOOLEAN NOT NULL DEFAULT false;

-- ③ 激活存量 issue_dependency 表
ALTER TABLE issue_dependency
    ADD CONSTRAINT uq_issue_dependency UNIQUE (issue_id, depends_on_issue_id),
    ADD CONSTRAINT no_self_dependency CHECK (issue_id <> depends_on_issue_id);
-- 依赖记录统一写 type = 'blocked_by'（"本任务被前置任务阻塞"）；
-- 'blocks' / 'related' 不在本期范围。

-- ④ 任务队列新状态
ALTER TABLE agent_task_queue DROP CONSTRAINT agent_task_queue_status_check;
ALTER TABLE agent_task_queue ADD CONSTRAINT agent_task_queue_status_check
    CHECK (status IN ('queued','dispatched','running','waiting_local_directory',
                      'waiting_module_lock','deferred','completed','failed','cancelled'));
```

说明：`agent_task_queue` **不加** module 列；模块信息在 claim 时实时 JOIN issue 下发（见 §4），入队无快照、编辑即时生效。

## 4. 依赖调度（server 端闸门）

**放行条件**：`issue_dependency`（type='blocked_by'）中该任务的全部前置 issue 的 **effective status = `done`**。判定用 migration 340 的 `issue_effective_status(workspace_id, status)` 函数而非裸 `status` 比较——自定义 done-category 状态（MUL-6460）的 key 不是字面量 'done'，裸比较会让这类前置永久阻塞后继。前置为 `cancelled` / `failed` 任务残留 / 任何非 done 状态一律不放行——人工把前置重跑到 done 后，daemon 下一轮 claim 轮询自然放行（"阻塞等人工处理"由此天然成立，无需独立恢复通道）。

**闸门位置**：`ClaimAgentTask`（server/pkg/db/queries/agent.sql）候选子查询追加：

```sql
AND NOT EXISTS (
    SELECT 1
    FROM issue_dependency d
    JOIN issue pre ON pre.id = d.depends_on_issue_id
    WHERE d.issue_id = atq.issue_id
      AND d.type = 'blocked_by'
      AND issue_effective_status(pre.workspace_id, pre.status) <> 'done'
)
```

依赖未满足的任务停在 `queued`，不派发、不占 agent `max_concurrent_tasks` 配额（`CountRunningTasks` 只数 dispatched/running/waiting_*）。

**配置约束**（服务端校验，违反返回 409）：

- 依赖双方必须**同模块**（`module_id` 相同且非空）；无模块任务不支持配置依赖。
- 防自环（CHECK 约束兜底）+ 防循环：写入时从 `depends_on_issue_id` 沿现有边 DFS，能回到本任务则拒绝。
- 依赖写入为**全量置换**语义（PUT），服务端在事务内 diff 增删。

**claim payload 投影**：`ClaimAgentTask` 的返回扩展 JOIN issue → `module_id`、module `name`、`avoid_conflict`；daemon `Task` 结构新增三个 `omitempty` 字段（旧 server 不下发时 daemon 视为无模块，行为安全退化）。chat / quick-create 等无 issue 的任务行三字段为空。

## 5. 模块锁（daemon 端，取代目录互斥）

> ⚠️ **本节为 451 初版（v1）锁模型的历史设计记录**。requirement-calendar **WS3 已升级为 ModuleLocker v2**：
> 锁 key = `(moduleID, rootRequirementID)`——同模块**同组不互斥**（组内并行子任务顺序由依赖 DAG 表达）、
> 同模块**跨组无条件互斥**、异模块维持 `avoid_conflict` 语义；root 终态 `ReleaseGroup` 整组释放。
> 下文 total/exclusive 双计数模型已被 `(moduleID, rootID)` 二维判定取代，详见 `ARCHITECTURE.md` §5.2。

`acquireLocalDirectoryLockIfNeeded`（server/internal/daemon/daemon.go）的互斥语义整体替换：

| 任务特征 | 锁行为 |
| --- | --- |
| 无模块 | 不取锁，直接执行 |
| 有模块且未勾选避免冲突 | `ModuleLocker.Acquire` 共享模式：仅当异模块有勾选方持锁时等待，否则直接执行 |
| 有模块且 `avoid_conflict=true` | `ModuleLocker.Acquire` 排他模式：等异模块持有全部归零 |
| worktree 模式 / 聊天任务 | 维持现状豁免（`localDirectoryLockExempt` 等逻辑保留） |

`ModuleLocker`：每个模块的持有计数拆为 `total` / `exclusive`（勾选方）两组，加 `sync.Mutex` + 条件变量，**判定与计入在同一临界区内完成**（防止两个异模块勾选方同时判定通过导致互斥失效）：

| Acquire 方 | 等待条件 | 计入 |
| --- | --- | --- |
| 勾选方 | 其他模块 `total` 总和为 0 | 本模块 `total` + `exclusive` |
| 未勾选方（有模块） | 其他模块 `exclusive` 总和为 0 | 本模块 `total` |
| 无模块 | 不 Acquire | — |

由此「一方勾选即锁」双向成立：勾选方等到异模块全部跑完才启动；异模块任务（无论是否勾选）在勾选方持有期间也无法启动。不保证严格 FIFO（等待中的勾选方不阻滞后来的异模块未勾选任务，极端情况下有饿死风险，任务量有限可接受，与现状 mutex 无公平性保证一致）。`Holder` 信息用于 wait_reason 文案，等待方（含被勾选方挡住的未勾选方）均上报 `waiting_module_lock`。

**等待上报**：新状态 `waiting_module_lock`；daemon 调 `MarkTaskWaitingModuleLock`（与 `MarkTaskWaitingLocalDirectory` 同管道，handler/service 增加状态值）。wait_reason 形如 `模块「X」（held by 模块「Y」）`。取消轮询（5s）、prepare 租约续期、`resourceWaitTasks` 计数全部复用现有等待管道。

**prepare 短锁（保护性保留）**：prepare 阶段 daemon 会往工作目录写上下文文件 / skills 暂存，同目录并发任务的写入可能撕裂。保留 per-路径短锁，**仅在 prepare 窗口持有**，执行期放开；短锁等待复用现有 `waiting_local_directory` 状态与文案。执行并发不受短锁影响。

**路径校验保留**：local_directory 资源解析失败、路径非法（不存在/不可读写/黑名单）、未知 execution_mode 仍 fail-fast，行为不变。

## 6. API（server/internal/handler）

| 端点 | 说明 |
| --- | --- |
| `GET/POST /projects/:id/modules` | 模块列表 / 创建（name+color，项目内唯一） |
| `PATCH/DELETE /projects/:id/modules/:sid` | 改名/改色；删除时 issue.module_id 级联 SET NULL，依赖边随 FK 级联清理 |
| `PATCH /issues/:id` | 扩展 `module_id`、`avoid_conflict` 字段（module 必须属于 issue 所在项目） |
| `PUT /issues/:id/dependencies` | 全量置换前置集合；校验同模块 + 防环，违反 409 |
| `GET /issues/:id/dependencies` | 返回前置列表（含各前置 status，供详情页渲染阻塞来源） |

queued 且被依赖阻塞的任务，在 issue 详情/列表经 `dependencies` 数据呈现"等待依赖：<前置标识列表>"。

## 7. 前端（packages/views + packages/core）

- **项目管理**：项目页新增「模块」管理入口（列表、增删改、颜色）；看板/列表新增按模块过滤。
- **任务创建/编辑表单**：模块下拉（单选，可就地新建）；选择模块后出现「避免与其他模块冲突」勾选框与「前置依赖」多选器（仅列同模块任务）。
- **任务详情**：模块徽章（色点+名称）、前置依赖区块（状态、增删）；依赖阻塞时显示"等待依赖：SIRI-9、SIRI-10"。
- **状态文案**：`waiting_module_lock` → "等待模块锁释放"；`waiting_local_directory` 保留（prepare 短锁）文案不变。
- 类型：`packages/core` 的 Issue 类型加 `module_id`/`avoid_conflict`，新增 `ProjectModule`、`IssueDependency` 类型。

## 8. 测试方案

- **server**：依赖闸门（done 放行；in_progress/failed 残留/cancelled 阻塞；无依赖正常）；依赖 API（防环 409、跨模块 409、无模块 409、置换 diff 正确）；模块 CRUD、唯一约束、删除级联；claim payload 投影三字段。
- **daemon**：`ModuleLocker` 单测（同模块并发、异模块互斥、无模块跳过、ctx 取消传播）；等待上报 `waiting_module_lock` 集成测试；prepare 短锁同目录并发回归；旧 server 无模块字段时的退化行为。
- **前端**：`tsc --noEmit` 及现有组件测试模式。

## 9. 兼容与迁移

- 无模块任务从"同目录互斥"变为"不锁"——已确认的行为变化，顺序改用依赖 DAG 表达。
- `waiting_local_directory` 状态保留（prepare 短锁）；存量 UI 渲染不受影响。
- worktree 模式、聊天豁免、`max_concurrent_tasks`（agent 默认 6 / daemon 默认 20）两道并行闸门不变。
- server/daemon 版本错位：旧 daemon 忽略新 payload 字段（无模块锁，退化为不锁）；旧 server 不下发字段，新 daemon 按无模块处理。

## 10. 非目标（YAGNI）

- 跨模块依赖、`blocks`/`related` 依赖类型、依赖可视化图。
- 模块级并发配额、严格公平的锁等待队列。
- 依赖失败自动级联取消（已明确选择阻塞等人工处理）。
