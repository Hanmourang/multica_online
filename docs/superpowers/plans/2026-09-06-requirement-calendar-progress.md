# 需求日历与角色化流水线 — 进度追踪（2026-09-06）

> 本文档是「需求日历」需求线的**进度事实源**，随每次推进更新。
> 设计事实源：`../specs/2026-09-04-requirement-calendar-design.md`（唯一设计契约）
> 计划事实源：`2026-09-04-requirement-calendar.md`（原始 21-Task 计划）+
> `2026-09-06-requirement-calendar-phase1-completion.md`（Phase I 补全计划 WS1~WS6）

- **仓库**：`ai_workspace_online/ai_agents/multica_online`
- **分支**：`feat/requirement-calendar`（基线 main = `7dcc53e`）
- **最近更新**：2026-09-06（日历一级模块提升线 Task 1-6 完成，见 §2A；此前 archive 差距补齐线：d9aa3a2 三端点 + df5b689 CLI sync 管道，E2E 全链路验证通过）

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
| d9aa3a2 | **archive 差距补齐①**：migration 461（sync_diagnostics + project_archive_sync_config + confidence/override_reason）+ sync-config GET/PUT + diagnostics 上报/查询 + bind-candidates 三因子置信度端点 + workspace 删除 manifest 补齐 14 表 | archive Phase 1 |
| df5b689 | **archive 差距补齐②**：`multica archive sync` CLI 五阶段管道（扫描→CONTRACT.md §1 契约解析→blob_sha 差量上传→全量清单 sync→诊断上报）+ CONTRACT.md §5 存量迁移脚本 | archive Phase 2 |

**archive 线 E2E 证据（2026-09-06，dev api :18227 + dev 库 :55433）**：fixture 仓库 3 文件首次同步全量入库（frontmatter `multica_issue_id` 绑定成功 1 行）；幂等重跑「变更 0 · 未变 3 · 更新 3 · 软删 0」；`sync_diagnostics` 成功（scan/index info）与失败（index error，FK 违反）路径均正确落库。差距分析归档：`change_logs/multica/2026-09-06-双原型功能差距分析与补齐范围.md`。

**archive 线刻意不做项**：`migrate-archive-structure.sh --apply` 实跑（projects_mgmt 是用户真实文档仓库，20k+ 文件，dry-run 已验证 16 组映射全命中，实跑留给用户确认）；CONTRACT.md 已写入 projects_mgmt 仓库但未提交（该仓库有用户自己的未提交改动）。

**产品接入状态**：日历视图、原型面板、拆解面板均已实际挂载进 issue 详情页（不再是「做了没接」）。

**「看不到日历/需求模块」三层根因（2026-09-06 诊断闭环）**：
1. **落地页错误**：`/sirius-6cha` 非 dev 账号工作区（报「工作区不可用」），正确入口 `http://localhost:13147/dev/issues`；且 dev 库无需求数据 → 已造 DEV-1/DEV-2 演示数据（含时间窗/goal/班底，`auto_trigger=false` 防真触发）。
2. **列表投影缺失**：86047ef 修的 sqlc 静态 `ListIssues` 无调用方（死代码）；真正服务列表/看板的是 handler 手工拼的动态 SQL → 修复 F/G 补齐三条路径并用 `TestListIssues_RequirementFieldsProjection` 锁死。
3. **前端数据源遗漏**：calendar 不在 `usesServerStatusSurface`/`usesServerGroupSurface` 任何分支 → 修复 H；浏览器终验日历色块 DEV-1（9/6~9/11）/DEV-2（9/8~9/15）正常渲染。

---

## 2A. 日历一级模块提升（2026-09-06，spec：`../specs/2026-09-06-calendar-module-elevation-design.md`）

日历从 /issues 任务页的视图 tab 提升为侧边栏一级模块（/calendar）：工作区级需求日历页 + 需求抽屉五阶段 + 项目页「任务概览」改名与「需求详情」TAB + 任务子视图日历 tab 移除。子 agent 驱动执行（主会话内联 TDD + 每 Task CodeReview 子代理两阶段审查合并派发）。

| 提交 | 内容 | 任务映射 |
|---|---|---|
| 0c4893a | 实现计划（7 Task TDD 分解） | 计划 |
| 80e2edb | 日历一级导航注册（paths/route-icons 三联合契约/侧边栏/i18n 四语言 + 隐藏触点 diagnostic-context/search-command） | Task 1 |
| b9b99ed | CalendarView 搬家至 views/calendar + onOpenRequirement 回调（AppLink 拦截，修饰键放行） | Task 2 |
| 2f9f1bd | RequirementDrawer 需求五阶段抽屉（复用 RequirementFlowSection，SheetContent 宽度同 variant 栈覆盖） | Task 3 |
| 6eb4f35 | CalendarPage 工作区日历页 + /calendar 路由壳 + 抽屉接线 + views exports `./calendar` 子路径 | Task 4 |
| b49ebfc | 任务子视图移除日历 tab（modes 去 calendar + allowCalendar 透传链门控视图菜单，镜像 allowGantt） | Task 5 |
| fa7a799 | RequirementListPanel 项目维度需求列表（需求详情 TAB 面板：本项目顶层需求按 start_at 升序成卡，点击开抽屉） | Task 6 |

**交接面（未提交，并行 archive 会话领土，最小 diff 已写入工作树随其提交生效）**：`project-archive-views.tsx` 白名单/views 数组/渲染分支接线；`locales/*/archive.json` `views.overview` 改名「任务概览」+ 新增 `views.requirements`（四语言；类型经 resources-types.ts 的 `typeof archive.json` 自动扩展，无需手改）。

**计划偏差记录（均经审查核验）**：① Task 4 列表查询提至页面层供抽屉 statusBadge（CalendarView 无二次请求）；② Task 4 补 `./calendar` exports（契约强制）；③ Task 5 发现视图下拉硬编码五态不消费 modes → 引入 allowCalendar 透传链（controller→surface 默认 header/page 自定义 header→IssuesHeader/IssueDisplayControls 两层→RadioItem）；④ Task 6 面板补 statusBadge 接线（drawer 契约要求宿主传入）+ isPending 防空态闪烁；⑤ spec §4b 卡片的「班底头像/阶段进度」经计划骨架收敛为四要素（有意范围收敛，`Issue.stage_progress` 现成可补）。

**验证**：views 全量 424 文件 4968 测试（新增 16 个：抽屉 3 + 日历页 4 + controller 2 + issues-page 1 + 面板 4 + 侧边栏激活 2，余为既有改造；若计入 calendar-view 随迁的 onOpenRequirement 用例则 17，core 侧 route-icons 另有 +2）——唯一失败为既知 flake `issue-limit-upgrade-dialog` Escape 用例（顺序敏感，隔离 14/14 全绿，与本线零交集）；views/core tsc 零错误；core 143 文件 1695 测试全绿；web build 通过。

**终审修复（终审 CodeReview changes-requested → 已全部处理）**：

- **spec §5 错误处理落地**（终审 Warning 1）：CalendarPage 与 RequirementListPanel 的 `useQuery(issueListOptions)` 失败路径原为静默（`data=[]` 兑底使失败与真空不可区分）——现各补 toast + 页面级/面板级错误条 + `refetch()` 重试按钮，i18n 四语言 `page/list.load_failed` + `retry`，各加 1 个失败路径测试。
- **侧边栏 /calendar 前缀激活测试**（终审 Minor 1，spec §6 点名项）：`app-sidebar.test.tsx` 新增「workspace nav — Calendar」describe（/calendar 精确命中 + /calendar/* 子路由前缀激活 + 同级路由不激活）。
- **包出口补齐**（终审 Minor 3）：`calendar/index.ts` 补 `RequirementListPanel` 导出，与同包其余三组件一致。
- **已知限制（终审 Warning 2，有意保留）**：`issueListOptions` 走 `fetchFirstPages`——每 status_category 仅取首页 50 条（`ISSUE_PAGE_SIZE`），7 分类上限 350；任一类溢出时超出部分在日历与需求列表静默缺失。日历语义是完整集合，后续应镜像 `fetchProjectGanttIssues` 的 `(limit, offset)` 循环 + 封顶守卫做全量翻页。本线记录为已知限制不实现（零后端改动边界内影响面可控，且溢出阈值对当前数据量充裕）。

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

## 4. 待办核销（2026-09-06 双原型差距盘点实证）

按两个原型 HTML 逐画面盘点后发现：**并行会话实际进度远超本文件此前记录**，WS4/WS5/WS6 主体均已完成（测试实跑全绿）：

| 工作流 | 实证状态 | 证据 |
|---|---|---|
| **WS4** 验收闭环 | ✅ 已由并行会话完成 | `requirement_acceptance.go` + `POST /issues/{id}/acceptance/verdict`；日历第 10 态「验收失败」已入前端 |
| **WS5** agent_run 投影器 | ✅ 已由并行会话完成 | server `agent_run_projector.go`（提交 71a9f9d/df12b9a）；daemon CallID 已透传 |
| **WS6** 前端动线 | ✅ 已由并行会话完成 | schedule/acceptance 面板、create-issue git 库选择器、decompose 面板 graph/acceptance 摘要、client.triggerRequirement/submitAcceptanceVerdict |
| **archive server** | ✅ 大部分已由并行会话完成 | project_artifact/project_graph/project_filing/issue_archive handlers + migrations 455-460 + `source='manual'` P0 保护 |
| **archive 前端** | 🔄 并行会话在途（未提交） | `packages/views/projects/components/{archive,filing,graph,requirement-drill}/` 工作区 untracked，**不可触碰** |
| **archive 真缺口** | ✅ 本线已补齐 | d9aa3a2（461 + 三端点）+ df5b689（CLI + 迁移脚本）+ projects_mgmt/CONTRACT.md |
| **WS3** ModuleLocker v2 | 🔄 见 §3（并行会话在途，daemon 侧代码完成未提交；`ReleaseGroup` 已演进为带 isLive 回调签名） | 工作区 `module_locker*.go` 改动，**不可触碰** |
| **T21** 全量回归收尾 | 🔄 server 全量已跑：7 个失败全部为环境问题（pg 本地用户无 CREATEDB / 无权读 pg_statistic ×5；dashboard 两例为 DB 时区 UTC+8 与查询 tz=UTC 在凌晨时段的「今天」定义分歧，dashboard 文件自基线导入后无人改动）——与本线改动零交集；前端全量 + playwright e2e 仍待做 | 见 §5 |

---

## 5. 验收状态边界（诚实声明）

- ✅ **单测级**：T1~T16 + 修复 A~H + archive 差距补齐（461 三端点 + CLI）的 TDD 测试全部通过
- ✅ **archive CLI E2E**：dev api 全链路（上传→sync→绑定→诊断落库→幂等重跑）实测通过
- ⚠️ **未做**：前端全量回归、playwright e2e、迁移 down/up 幂等终验（均属 T21 剩余）
- ⚠️ **已知环境问题（T21 实证，均与代码无关）**：`backfill_codex_usage_cache` + `taskusagebackfill` 4 例需 CREATE DATABASE 权限；`cmd/migrate` 1 例需读 pg_statistic；handler dashboard 2 例为 UTC+8 凌晨时段 vs tz=UTC 的日期窗 flake（基线即存在）
- ✅ **已消解**：`TestWorkspaceDeletionManifestCoversPublicSchema` 此前因 455~459 未注册失败——d9aa3a2 已补齐 455-461 全部 14 张新表注册，测试转绿
- ⚠️ **WS5 的门禁提醒**：`agent_run` 端点用 handler 内原生 SQL，**勿**塞进 `pkg/db/queries/*.sql`（会触发 sqlc 重生成门禁）；461 新 schema 同此模式（committed generated 落后由并行会话统一 regen）

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
