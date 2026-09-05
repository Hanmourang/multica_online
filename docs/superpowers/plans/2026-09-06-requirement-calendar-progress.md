# 需求日历与角色化流水线 — 进度追踪（2026-09-06）

> 本文档是「需求日历」需求线的**进度事实源**，随每次推进更新。
> 设计事实源：`../specs/2026-09-04-requirement-calendar-design.md`（唯一设计契约）
> 计划事实源：`2026-09-04-requirement-calendar.md`（原始 21-Task 计划）+
> `2026-09-06-requirement-calendar-phase1-completion.md`（Phase I 补全计划 WS1~WS6）

- **仓库**：`ai_workspace_online/ai_agents/multica_online`
- **分支**：`feat/requirement-calendar`（基线 main = `7dcc53e`）
- **最近更新**：2026-09-06（WS3 daemon 侧完成、测试全绿，未提交）

---

## 1. 需求背景与技术方案（概要）

把「需求（顶层 issue）」升级为一等公民：带**目标 / git 库 / 分钟粒度时间窗（start_at + due_date）/ 角色班底（PM·原型师·研发·测试·data）**，落地**四阶段角色化流水线**：

| stage | 阶段 | 责任人 | 产出 |
|---|---|---|---|
| 1 | 原型 | 原型师 | `docs/prototypes/*.html` + 版本记录 + 逐项标记确认门 |
| 2 | plan + 拆解 | PM | plan 评论 + 子任务草稿（功能点/图谱上下文/验收规约/依赖/指派） |
| 3 | 执行 | 研发/data | 代码 + 交付物 |
| 4 | 验收 | 测试（停用回落 PM） | 验收报告 + verdict（pass→done；fail→打回 stage 3，上限 3 轮→第 10 态「验收失败」） |

配套：周/月**日历视图 + 拖拽调期**、**到点自动触发**（30s sweep + 手动触发）、**同模块跨需求组互斥**（ModuleLocker v2）、**10 态派生状态机**、**agent_run 投影**（migration 459）。

**关键技术决策（已定稿，勿重推导）：**

1. **触发幂等**：`MarkRequirementTriggered`（`:execrows`，`WHERE triggered_at IS NULL`）影响 0 行 = 已触发；触发状态由 `auto_trigger`/`triggered_at`/`decomposition_confirmed_at` 三列派生，无独立状态列。
2. **依赖放行模型**：stage 3 子任务触发时**全量入队** `queued`，由 `ClaimAgentTask` 的 `blocked_by` 闸门（`agent.sql`，前置须 done）在领取时挂起——与 451 既有模型一致；不新造依赖完成唤醒链。（偏离计划测试注释字面，已在 T16 提交信息注记）
3. **ModuleLocker v2 锁模型**：锁 key = `(moduleID, rootRequirementID)`——同组（含组内 exclusive）并发；同模块跨组**无条件互斥**（onWait 注明持有方需求标题）；异模块维持 451 exclusive 语义（onWait 注明模块名）；**任一方 rootID 为空 → 同模块维度退化为 451**（不互斥，保护存量）；`ReleaseGroup(rootID)` 整组释放 + Broadcast。
4. **互斥双层**：server 端 claim 闸门（全局、跨 daemon）+ daemon 端 ModuleLocker（同 daemon 第二层）；`waiting_module_lock` 行是 daemon-owned。
5. **root 终态释放**：主路径 = 任务逐个完成时 release；`ReleaseGroup` 兜底「root 终态但持有方任务未被回收」窗口；**不做** server→daemon 的 push 释放事件（wakeup WS 扩展成本过高，30s 轮询 + claim 闸门自足）。
6. **root 界定**：独立 issue（无 parent）root = 自身（452 递归 CTE 回填锚点）；创建路径 root 回填已在 T5 落地；**改 parent 级联重算属 WS3 缺口**。
7. **验收轮次**：`issue.acceptance_round DEFAULT 0`（452:15）；verdict 不落列，由 stage4 子任务 `properties->>'acceptance_verdict'` / 评论 / agent_run 投影承载。
8. **due_date 保持 DATE 日历日语义不变**；分钟粒度由新列 `start_at`（timestamptz）独立承载。

---

## 2. 已完成并提交（25 个提交，均 TDD 单测通过）

| 提交 | 内容 | 任务映射 |
|---|---|---|
| b7c8b38 | 原型 v7 + 架构 + 设计 + 计划文档 | 前置 |
| 80e5c5f | migration 452：issue 扩 11 列 + root 递归回填 + 3 索引 | T1 |
| f2587b5 | migration 453/454：班底两表 + 原型版本表 | T2 |
| 4adae65 | requirement.sql 查询层 + 派生状态投影（9 态 CASE） | T3 |
| f3eb7c7 | 项目默认班底 CRUD + 需求班底快照 API | T4/T5 |
| 37e9e56 | issue create 接受日历字段（start_at/goal/repo/mode/auto_trigger） | T5 配套 |
| 4aecbee | 前端 role-strip 班底卡 + 创建弹窗字段 | T6 |
| af4621e / 8a590af | view type 'calendar' + 分钟粒度日期管道 | T7 |
| dbac6ae | 日历月/周渲染（跨日色块/状态徽标/分钟 tooltip） | T8 |
| c1015d4 | 拖拽调期 + 已触发需求改 start_at 返 409 | T9 |
| 5b75c48 | 拆解发起 `POST /issues/{id}/decompose`（stage-2 PM 子任务） | T10 |
| a8917cc | 拆解确认：校验（fp kind/班底内/角色启用/依赖同 module）+ 批量生效 + 幂等 | T11 |
| e34edc7 | 前端拆解确认面板（画面 5） | T12 |
| 6a4bfcb / 2617b14 | 提示词五段组装 + 原型版本化生成 + 标记 + 确认门 | T13/T14 |
| e1e198b | 前端原型面板（画面 4） | T15 |
| 1e9bc9c | 触发 loop：30s sweep job + `POST /issues/{id}/trigger` 手动触发 | T16/WS2 |
| 21b7ee1 | **修复A**：日历视图挂载 issue-surface + 视图切换 tab | 产品接入 |
| 0677938 | **修复B**：原型面板接入需求详情（requirement-flow-section） | 产品接入 |
| c15fb72 + a1d5d95 | **修复C**：`GET /issues/{id}/decomposition` 读路径（plan+草稿）+ client 方法 | 产品接入 |
| f16e03a | **修复D**：拆解面板接入需求详情（stage2 三态：panel/running/start，草稿角色解析，PM 在跑 4s 轮询） | 产品接入 |
| 86047ef | **修复E**：IssueResponse 需求字段投影 | 产品接入 |
| 3ef0bbc | **修复F**：ListIssues/ListGroupedIssues 动态 SQL 补齐需求字段 + 派生状态投影（86047ef 修的 sqlc 静态查询是死代码，列表 handler 走手工拼 SQL） | 产品接入 |
| 5af7801 | **修复G**：`POST /issues/table/rows` 契约补齐同一投影（拆 `requirementCalendarColumns` 共享常量，三条动态 SQL 路径逐列对齐，测试锁死） | 产品接入 |
| 89fc327 | **修复H**：前端 calendar 纳入 `usesServerStatusSurface`（此前 `controller.issues` 恒为空，月历空白）+ 日历强制 `include_sub_issues=false` | 产品接入 |

**产品接入状态**：日历视图、原型面板、拆解面板均已实际挂载进 issue 详情页（不再是「做了没接」）。

**「看不到日历/需求模块」三层根因（2026-09-06 诊断闭环）**：
1. **落地页错误**：`/sirius-6cha` 非 dev 账号工作区（报「工作区不可用」），正确入口 `http://localhost:13147/dev/issues`；且 dev 库无需求数据 → 已造 DEV-1/DEV-2 演示数据（含时间窗/goal/班底，`auto_trigger=false` 防真触发）。
2. **列表投影缺失**：86047ef 修的 sqlc 静态 `ListIssues` 无调用方（死代码）；真正服务列表/看板的是 handler 手工拼的动态 SQL → 修复 F/G 补齐三条路径并用 `TestListIssues_RequirementFieldsProjection` 锁死。
3. **前端数据源遗漏**：calendar 不在 `usesServerStatusSurface`/`usesServerGroupSurface` 任何分支 → 修复 H；浏览器终验日历色块 DEV-1（9/6~9/11）/DEV-2（9/8~9/15）正常渲染。

---

## 3. 进行中：WS3/T17 ModuleLocker v2（代码完成，未提交）

**已落地（12/12 测试 PASS，工作区未提交）：**

- `server/internal/daemon/module_locker.go` — v2 锁模型（见 §1 决策 3）+ `ReleaseGroup(rootID)`
- `server/internal/daemon/module_locker_test.go` — 6 个 451 兼容用例 + 6 个 v2 组语义子测试
- `server/internal/daemon/types.go` — `Task.RootRequirementID` / `RootRequirementTitle`（omitempty，旧 server 空值 = 安全退化）
- `server/internal/daemon/daemon.go` — `acquireModuleLockIfNeeded` 传 root 维度；onWait 文案区分 `held by 需求「X」` / `held by 模块「Y」`

**WS3 剩余（server 侧投影链路 + spec 修订）：**

1. `server/pkg/db/queries/module.sql` `GetIssueModuleInfo` 加 `root_requirement_id`（+root title，COALESCE 自身）→ `make sqlc`
2. `server/internal/handler/daemon.go`（~L2331）claim 投影填充 + `server/internal/handler/agent.go` `AgentTaskResponse` 加同名字段
3. claim 闸门 SQL 加组间互斥（`ClaimAgentTask` 或 `CountRunningTasks`，按 phase1-completion plan 实证）：`NOT EXISTS(同 module、异 root(COALESCE(root,id))、active 状态)` → `make sqlc`
4. `TestClaimGateGroupMutex`（handler 包 DB 集成测试，用 testPool fixture）：同 module 异 root 有进行中 → 本组不派发；同组正常
5. UpdateIssue 改 parent 时级联重算 `root_requirement_id`（自身 + 全部子孙递归 UPDATE）
6. `go test ./internal/daemon/ -count=1` 全量（451 既有测试必须全绿）
7. 修订 451 spec（`../specs/2026-09-04-module-dependency-scheduling-design.md`）§1/§2/§5：同模块内「同组 DAG+并发；跨组互斥串行；组终态即释放」+ §5 表格加 root 维度
8. 提交：`feat(daemon): module locker v2 group mutex + terminal-release; docs: 451 spec semantic revision`

---

## 4. 待办（功能未实现）

| 工作流 | 范围 | 状态 |
|---|---|---|
| **WS4** 验收闭环 | `POST /issues/{id}/acceptance/verdict`：pass→关 stage4→需求可 done；fail→round+1→建 stage3 修复子任务（依赖=相关执行任务、assignee=原执行人、附失败断言清单）→打回；round>3→第 10 态「验收失败」+ 评论通知负责人+PM；验收代码版本约束（agent 不得自行改断言，需求变更回退 PM 确认后同 PR 升版）；派生状态 CASE 增第 10 态 | 未开始 |
| **WS5** agent_run 投影器 | daemon 上报 `call_id`（tool_use/tool_result 配对键）→ server ingest 派生 `agent_run`/`agent_run_todo`/`agent_run_event`（459 表已建，server 只读不反写之外的唯一写入方是 ingest）；终态收尾（complete/fail/cancel→run 终态，不被晚到回调覆盖）+ token 累计；**原生 SQL 写，不进 sqlc 查询文件**；run id 用确定性 UUID v5 免新迁移；旧 daemon 无 call_id 降级（不建 tool 待办） | 未开始 |
| **WS6** 前端动线补全 | 画面 6 执行调度面板（分钟倒计时/触发前预检清单/子任务进度/waiting_module_lock 等待原因渲染/立即触发按钮）；画面 7 验收报告面板（溯源/执行/回归/目标覆盖四板块 + verdict + 打回链 + 轮次时间线）；decompose 面板 DraftCard 补 gn-box/acc-box；日历拖拽视觉反馈 + RequirementBlock 角色头像；创建弹窗补 git 库选择器；client 增 `triggerRequirement`/`submitAcceptanceVerdict`；view-store FilterSnapshot 增 PM/拆解状态过滤；module-filter-bar 补控件 | 未开始（phase1-completion plan 仅列文件清单，详细步骤待展开） |
| **T21** 全量回归收尾 | server 全量 `go test ./...`；前端全量 + parity；playwright e2e 主链路（创建→原型→拆解→触发→执行→验收→done）；迁移 down/up 幂等终验；设计文档状态收尾 | 未开始 |

---

## 5. 验收状态边界（诚实声明）

- ✅ **单测级**：T1~T16 + 修复 A~E + ModuleLocker v2 的 TDD 测试全部通过
- ⚠️ **未做**：server/前端全量回归、playwright e2e、迁移终验（均属 T21）
- ⚠️ **已知无关失败**：`TestWorkspaceDeletionManifestCoversPublicSchema` 因 archive 并行流的 untracked migration 455~459 失败，与本需求线无关，不在本线修
- ⚠️ **WS5 的门禁提醒**：`agent_run` 端点用 handler 内原生 SQL，**勿**塞进 `pkg/db/queries/*.sql`（会触发 sqlc 重生成门禁）

---

## 6. 工作区卫生（提交约束）

工作区存在**并行的 project-archive 工作流**未提交改动（untracked migrations 455-459、packages/core/agent-runs、filing、graph、archive locales 等）。本线提交必须 **hunk 级拆分，绝不混入 archive 改动**。

archive 流已触碰的共享文件（提交时需甄别 hunk）：`packages/core/api/client.ts`、`packages/core/types/api.ts`、`packages/core/types/index.ts`、`packages/core/types/project.ts`、`server/cmd/server/router.go`、`packages/views/issues/components/issue-detail.tsx`、`packages/views/locales/*`、`packages/views/projects/components/project-detail.tsx`、`server/internal/handler/project_module.go`、`server/pkg/db/generated/*`。

当前 WS3 未提交改动（`module_locker.go` / `module_locker_test.go` / `types.go` / `daemon.go`）**与 archive 无文件重叠**，可直接提交。

---

## 7. 工具与环境经验（本线实测）

- `go test` 跑 daemon 包首次编译耗时数分钟；测试默认超时 600s，锁类测试建议显式 `-timeout 90s`
- Read 工具必须同时给 start_line + end_line（大文件）；Grep 工具在 workspace 根搜不到本仓库（gitignore），用 `bash grep`
- Go 文件 tab 缩进，SearchReplace 易失败 → 用 python 按真实字节替换；新 Go 文件写后 `gofmt -w`
- handler 测试基建：`testPool/testWorkspaceID/testUserID/testHandler/dbfx`（handler_test.go TestMain）；agent fixture 名 `Handler Test Agent`
- 前端测试：`pnpm --filter @multica/views test -- <path>`；面板内 ActorAvatar 需 mock `@multica/core/workspace/hooks` + `../../common/actor-avatar`
