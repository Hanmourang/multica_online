# 需求日历与角色化流水线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「需求」升级为带目标/git 库/分钟粒度时间窗口/角色班底的一等公民，落地四阶段角色化流水线（原型 → PM plan+拆解 → 执行 → 验收）+ 周/月日历视图 + 定时自动触发 + 同模块跨需求组互斥。

**Architecture:** 复用既有机制——`issue.stage` barrier（migration 123）、`project_module`/`issue_dependency`（451）、`waiting_module_lock` 队列态（451）、`issue_child_done.go` 唤醒链、autopilot scheduler 注册模式。新增：migration 452（issue 11 列扩展 + root 回填）、453（角色班底两表）、454（原型版本表）；server 端 requirement handler + 拆解编排 service + 提示词组装器 + 需求触发 loop；daemon 端 ModuleLocker v2（锁 key 加 root 维度）；前端 calendar-view + 需求详情四面板。

**Tech Stack:** Go 1.2x + sqlc（v1.31.1）+ Postgres（migration up/down）/ React + TypeScript + vitest（@multica/views · @multica/core）/ 原型基准 `docs/superpowers/specs/2026-09-04-requirement-calendar-prototype.html`（7 画面）。

**Specs:**
- 设计：`docs/superpowers/specs/2026-09-04-requirement-calendar-design.md`（数据模型/状态机/API/agent 协议的唯一事实源）
- 架构图：`docs/superpowers/specs/2026-09-04-requirement-calendar-architecture.html`
- 受影响既有文档：`docs/superpowers/specs/2026-09-04-module-dependency-scheduling-design.md`（Task 17 修订其 §1/§2/§5 语义）

**命令约定（已核实）**：
- 迁移：`cd server && go run ./cmd/migrate up`（回滚 `... down`）
- sqlc 代码生成：`make sqlc`
- server 测试：`cd server && go test ./internal/<pkg>/ -run <TestName> -v`
- 前端测试：`pnpm --filter @multica/views test` / `pnpm --filter @multica/core test`
- 构建：`make build`

---

## File Structure

**migration / DB**
- Create: `server/migrations/452_requirement_calendar.up.sql` / `.down.sql` — issue 扩展 11 列 + root 递归回填 + 3 索引
- Create: `server/migrations/453_requirement_roles.up.sql` / `.down.sql` — `project_role_default` + `issue_role_assignment`
- Create: `server/migrations/454_requirement_prototype.up.sql` / `.down.sql` — `issue_prototype_version`
- Create: `server/pkg/db/queries/requirement.sql` — 班底/原型/触发/派生状态投影全部 sqlc 查询
- Modify: `server/pkg/db/queries/issue.sql` — Create/Update 字段扩展 + list 投影列

**server**
- Create: `server/internal/handler/requirement_roles.go`(+`_test.go`) — 班底 API
- Create: `server/internal/handler/requirement_decompose.go`(+`_test.go`) — 拆解发起/草稿/确认
- Create: `server/internal/handler/requirement_prototype.go`(+`_test.go`) — 原型生成/标记/确认
- Create: `server/internal/handler/requirement_trigger.go`(+`_test.go`) — 手动触发
- Create: `server/internal/service/requirement_decompose.go`(+`_test.go`) — 确认校验 + 批量生效
- Create: `server/internal/service/prototype_prompt.go`(+`_test.go`) — 五段模板组装 + 标记回流
- Create: `server/internal/scheduler/jobs_requirement_trigger.go`(+`_test.go`) — 30s sweep
- Modify: `server/internal/handler/issue.go` — Create/Update 扩展字段 + root 维护
- Modify: `server/internal/issuestatus/issuestatus.go` — claim 闸门加 root 维度
- Modify: `server/internal/daemon/module_locker.go`(+`_test.go`) — v2 锁 key (module, root)
- Modify: `server/cmd/server/router.go` — 注册新路由

**前端**
- Create: `packages/views/issues/components/calendar-view.tsx`(+`.test.tsx`) — 月/周日历
- Create: `packages/views/issues/components/role-strip.tsx`(+`.test.tsx`) — 班底横向卡
- Create: `packages/views/issues/components/requirement-prototype-panel.tsx` — 画面 4
- Create: `packages/views/issues/components/requirement-decompose-panel.tsx` — 画面 5
- Create: `packages/views/issues/components/requirement-schedule-panel.tsx` — 画面 6
- Create: `packages/views/issues/components/requirement-acceptance-panel.tsx` — 画面 7
- Modify: `packages/core/issues/stores/view-store.ts` — view type 'calendar'
- Modify: `packages/core/issues/date.ts` — 分钟粒度序列化
- Modify: `packages/core/api/client.ts` — 新 API client 方法
- Modify: `packages/views/locales/{en,zh-Hans,ja,ko}/*.json` — i18n（parity.test.ts 强约束）

---

## Phase 0：数据基座（migration + sqlc）

### Task 1: migration 452 — issue 扩展 + root 回填

**Files:**
- Create: `server/migrations/452_requirement_calendar.up.sql`
- Create: `server/migrations/452_requirement_calendar.down.sql`

- [ ] **Step 1: 写 up migration**（DDL 全文以设计文档 §5.1 为准，核心如下）

```sql
ALTER TABLE issue
    ADD COLUMN start_at TIMESTAMPTZ,
    ADD COLUMN goal TEXT,
    ADD COLUMN repo_resource_id UUID REFERENCES project_resource(id) ON DELETE SET NULL,
    ADD COLUMN decompose_mode TEXT NOT NULL DEFAULT 'confirm'
        CHECK (decompose_mode IN ('auto','confirm','manual')),
    ADD COLUMN auto_trigger BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN decomposition_confirmed_at TIMESTAMPTZ,
    ADD COLUMN triggered_at TIMESTAMPTZ,
    ADD COLUMN root_requirement_id UUID REFERENCES issue(id) ON DELETE SET NULL,
    ADD COLUMN feature_points JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN graph_context JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN acceptance_spec JSONB NOT NULL DEFAULT '{}';

WITH RECURSIVE root AS (
    SELECT id, id AS root_id FROM issue WHERE parent_issue_id IS NULL
    UNION ALL
    SELECT i.id, r.root_id FROM issue i JOIN root r ON i.parent_issue_id = r.id
)
UPDATE issue i SET root_requirement_id = r.root_id FROM root r WHERE i.id = r.id;

CREATE INDEX idx_issue_trigger_sweep ON issue(start_at)
    WHERE auto_trigger = true AND triggered_at IS NULL AND decomposition_confirmed_at IS NOT NULL;
CREATE INDEX idx_issue_root_requirement ON issue(root_requirement_id);
CREATE INDEX idx_issue_repo_resource ON issue(repo_resource_id);
```

- [ ] **Step 2: 写 down migration**（逆序 drop 索引 → drop 列）

- [ ] **Step 3: 验证 up/down 对称**

Run: `cd server && go run ./cmd/migrate up && go run ./cmd/migrate down && go run ./cmd/migrate up`
Expected: 三条均成功；`\d issue` 含 11 个新列；回填后 `SELECT count(*) FROM issue WHERE root_requirement_id IS NULL` = 0

- [ ] **Step 4: 写回填正确性测试**：造三级链 A→B→C + 独立 issue D，断言 A/B/C 的 root=A、D 的 root=D（放在 `server/internal/handler/issue_test.go` 既有迁移测试工具上，若无迁移测试基建则在 Task 3 的 sqlc 测试中以 fixture 覆盖，二选一，不重复造）

- [ ] **Step 5: Commit**

```bash
git add server/migrations/452_requirement_calendar.*
git commit -m "feat(db): extend issue for requirement calendar (452)"
```

### Task 2: migration 453 + 454 — 班底与原型版本表

**Files:**
- Create: `server/migrations/453_requirement_roles.up.sql` / `.down.sql`
- Create: `server/migrations/454_requirement_prototype.up.sql` / `.down.sql`

- [ ] **Step 1: 写 453 up/down**（DDL 全文照设计文档 §5.2：`project_role_default` + `issue_role_assignment`，各带 workspace 索引与 UNIQUE 约束）

- [ ] **Step 2: 写 454 up/down**（DDL 全文照设计文档 §5.3：`issue_prototype_version`，`UNIQUE(issue_id, version)` + status CHECK）

- [ ] **Step 3: 验证**

Run: `cd server && go run ./cmd/migrate up && go run ./cmd/migrate down && go run ./cmd/migrate up`
Expected: 成功；`project_role_default` 上 `(project_id, role, assignee_type, assignee_id)` 唯一冲突报错符合预期

- [ ] **Step 4: Commit**

```bash
git add server/migrations/453_* server/migrations/454_*
git commit -m "feat(db): requirement role roster + prototype version tables (453/454)"
```

### Task 3: sqlc 查询层 — requirement.sql + issue.sql 扩展

**Files:**
- Create: `server/pkg/db/queries/requirement.sql`
- Modify: `server/pkg/db/queries/issue.sql`（Create/Update 加新列；Get 加投影）

- [ ] **Step 1: 写 requirement.sql**（命名查询清单，SQL 按 sqlc 注解规范）

```sql
-- name: ListProjectRoleDefaults :many
-- name: ReplaceProjectRoleDefaults :exec   -- 事务内先 DELETE 再批量 INSERT（whole-document replace）
-- name: ListIssueRoleAssignments :many
-- name: ReplaceIssueRoleAssignments :exec
-- name: CopyProjectRoleDefaultsToIssue :exec  -- INSERT ... SELECT 快照
-- name: CreatePrototypeVersion :one           -- version = COALESCE(MAX(version),0)+1，旧版置 superseded 由调用方同事务做
-- name: GetLatestPrototypeVersion :one
-- name: ListPrototypeVersions :many
-- name: UpdatePrototypeMarks :one
-- name: SetPrototypeStatus :exec
-- name: ListTriggerableRequirements :many     -- 命中 idx_issue_trigger_sweep
-- name: MarkRequirementTriggered :exec        -- UPDATE ... SET triggered_at=now() WHERE id=$1 AND triggered_at IS NULL（幂等）
-- name: ConfirmDecomposition :exec            -- SET decomposition_confirmed_at=now() WHERE ... IS NULL
-- name: ListRequirementChildren :many         -- 按 parent + stage 取子任务（派生状态用）
-- name: HasWaitingModuleLockDescendant :one   -- EXISTS queue waiting_module_lock
```

- [ ] **Step 2: issue.sql 扩展**——`CreateIssue`/`UpdateIssue` 参数加 `start_at/goal/repo_resource_id/decompose_mode/auto_trigger/root_requirement_id`；list 查询加派生投影（设计文档 §6 的 9 条规则实现为 `CASE WHEN` 嵌套 + 两个相关子查询：`requirement_status`、`stage_progress`）

- [ ] **Step 3: 生成并编译**

Run: `make sqlc && make build`
Expected: 生成 `server/pkg/db/requirement.sql.go` 等；编译通过

- [ ] **Step 4: 派生状态投影 SQL 测试**（关键测试，设计文档 §6 的 9 行规则逐条一个 case：造对应子任务/队列 fixture → 断言投影值）

Run: `cd server && go test ./internal/handler/ -run TestRequirementStatusProjection -v`
Expected: 9 case 全 PASS

- [ ] **Step 5: Commit**

```bash
git add server/pkg/db/queries/ server/pkg/db/
git commit -m "feat(db): requirement sqlc queries + derived status projection"
```

---

## Phase 1：角色班底

### Task 4: 项目默认班底 API

**Files:**
- Create: `server/internal/handler/requirement_roles.go`
- Create: `server/internal/handler/requirement_roles_test.go`
- Modify: `server/cmd/server/router.go`（projects 块挂子路由，模式照抄 project_module.go）

- [ ] **Step 1: 写失败测试**（模式照抄 `project_module_test.go` 的 `newRequest`/`withURLParam`/`serveRequest` 帮手）

```go
func TestProjectRoleDefaultsCRUD(t *testing.T) {
    // GET 空 → PUT 全量替换（pm=Atlas/prototyper=Nova/developer=[Orion,Rex]）
    // → GET 断言 4 行且 developer 两行 → PUT 停用 tester → GET 断言 enabled=false
    // 异常：PUT 把 pm.enabled=false → 409；developer 重复同一 assignee → 409
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/handler/ -run TestProjectRoleDefaultsCRUD -v`
Expected: FAIL（路由 404）

- [ ] **Step 3: 实现 handler**——`GET /api/projects/{id}/role-defaults`、`PUT`（whole-document replace，事务内 DELETE+INSERT；校验 pm/developer 至少一行 enabled）

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd server && go test ./internal/handler/ -v 2>&1 | tail -5`
Expected: PASS 且无其他包失败

- [ ] **Step 5: Commit** — `feat(server): project role defaults API`

### Task 5: 需求班底快照 + 必选校验

**Files:**
- Modify: `server/internal/handler/issue.go`（CreateIssue 拷贝快照）
- Create: `server/internal/handler/requirement_roster_test.go`（与 Task 4 测试文件分开，避免冲突）

- [ ] **Step 1: 写失败测试**

```go
func TestIssueRoleRosterSnapshot(t *testing.T) {
    // 项目默认 pm=Atlas+developer=Orion → 创建需求 → GET /issues/{id}/roles 含快照 2 行
    // 改项目默认（pm 换成 Kai）→ 需求快照不变
    // PUT 需求班底把 developer 全停用 → 409
    // PUT 指派一个不在班底的 assignee 到 prototyper → 201（班底内新增），但 enabled=false 的角色不可含指派 → 409
}
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现**（CreateIssue 事务尾部调 `CopyProjectRoleDefaultsToIssue`；`GET/PUT /issues/{id}/roles`；校验逻辑收敛在 handler 私有函数 `validateRoster`）

- [ ] **Step 4: 跑测试确认通过** → **Step 5: Commit** — `feat(server): requirement role roster snapshot + validation`

### Task 6: 前端 role-strip 班底组件 + 创建弹窗/项目设置接入

**Files:**
- Create: `packages/views/issues/components/role-strip.tsx`
- Create: `packages/views/issues/components/role-strip.test.tsx`
- Modify: 创建需求弹窗组件（以现状 issue 创建表单文件为准，挂 role-strip + 目标 textarea + git 库 select + datetime-local + 拆解模式 + auto_trigger 开关）
- Modify: `packages/core/api/client.ts` + `packages/core/types` + 四语言 i18n json

- [ ] **Step 1: 写失败测试**（vitest，照 `board-view-project-grouping.test.tsx` 模式）

```ts
it("班底卡横向渲染且停用卡置灰", () => { /* 5 卡渲染；data off → card 有 off 类；toggle 点击触发 onChange */ });
it("pm/developer 开关锁定不可点", () => { /* toggle mini lock 禁用态 */ });
it("developer 支持多选", () => { /* 添加第二个 agent 后 rtag 两个 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @multica/views test -- role-strip`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 role-strip + 弹窗接入**（视觉与交互以原型画面 3 为准：`.role-strip` 五卡、`toggle mini [lock|off]`、`rtag` 多选、`datetime-local step=60`）

- [ ] **Step 4: 跑测试确认通过 + i18n parity**

Run: `pnpm --filter @multica/views test`
Expected: PASS（含 parity.test.ts 四语言键一致）

- [ ] **Step 5: Commit** — `feat(web): role strip roster + create-requirement form fields`

---

## Phase 2：日历视图

### Task 7: view type 'calendar' + 分钟粒度日期管道

**Files:**
- Modify: `packages/core/issues/stores/view-store.ts`（`GanttZoom` 同级加 calendar 粒度偏好）
- Modify: `packages/core/issues/date.ts`（`dateOnlyToUTCDate` 兼容全 ISO：解析容忍时间分量，渲染 floor 到日）
- Modify: `packages/core/issues/date.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("解析带时间分量的 ISO 并 floor 到 UTC 日", () => {
  expect(dateOnlyToUTCDate("2026-09-15T09:30:00Z")).toEqual(new Date(Date.UTC(2026, 8, 15)));
});
it("视图偏好支持 calendar 粒度 week|month", () => { /* store set/get */ });
```

- [ ] **Step 2-5:** 失败 → 实现 → 通过 → Commit（`feat(core): calendar view type + minute-granularity date pipe`）

### Task 8: calendar-view 月/周渲染

**Files:**
- Create: `packages/views/issues/components/calendar-view.tsx`
- Create: `packages/views/issues/components/calendar-view.test.tsx`

- [ ] **Step 1: 写失败测试**

```ts
it("月视图按 start_at/due_date 铺色块并显示状态徽标与进度", () => { /* fixture: 跨 3 日需求 → 3 格连续色块；requirement_status='执行中' 且 progress 2/5 */ });
it("周视图周六日置灰、跨周需求截断显示", () => { /* 复用 gantt 的 weekend/截断断言模式 */ });
it("tooltip 显示分钟级时间", () => { /* hover 数据含 09:30 */ });
```

- [ ] **Step 2: 失败 → Step 3: 实现**（布局与视觉以原型画面 1/2 为准：`computeRange` 复用 gantt；色块色 = `project_module.color`；状态徽标 = §6 派生投影；8 态图标映射照原型）

- [ ] **Step 4: 通过 → Step 5: Commit** — `feat(web): requirement calendar view (month/week)`

### Task 9: 拖拽调期 + 触发联动

**Files:**
- Modify: `packages/views/issues/components/calendar-view.tsx`
- Modify: `server/internal/handler/issue.go`（PATCH：已触发需求拒绝改 start_at）

- [ ] **Step 1: 写失败测试**

```go
func TestRescheduleAfterTriggerRejected(t *testing.T) {
    // triggered_at 非空的需求 PATCH start_at → 409
}
```
```ts
it("拖拽结束 PATCH start_at/due_date 且 toast 提示触发时间联动", () => { /* dnd 模拟 → fetch mock 断言负载 */ });
it("执行中/已完成需求拖拽被禁用并提示原因", () => { /* grip 不渲染 + title 提示 */ });
```

- [ ] **Step 2-5:** 失败 → 实现（server 409 分支 + 前端 HTML5 dnd：源格残影/目标格高亮/浮动提示，照原型画面 2）→ 通过 → Commit（`feat: drag reschedule with trigger linkage guard`）

---

## Phase 3：拆解流水线（PM plan + 草稿 + 确认生效）

### Task 10: 拆解发起 — 建 stage 2 PM 子任务

**Files:**
- Create: `server/internal/handler/requirement_decompose.go`
- Create: `server/internal/handler/requirement_decompose_test.go`
- Modify: `server/cmd/server/router.go`

- [ ] **Step 1: 写失败测试**

```go
func TestDecomposeStart(t *testing.T) {
    // POST /issues/{id}/decompose（confirm 模式）
    // → 201：创建 stage=2 子任务，assignee = 班底 pm 的 assignee
    // → 子任务 description 含需求目标/git 库/（已确认原型 html_path）
    // 异常：班底无启用 pm → 409；已拆解过（存在 stage2 子任务）→ 409
    // auto 模式：同时触发 PM agent 任务派发（断言 agent_task_queue 入队一条）
    // manual 模式：不建 stage2 子任务，仅返回拆解模板 schema
}
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现**

关键逻辑：`POST /issues/{id}/decompose`
1. 读班底：`ListIssueRoleAssignments`，pm 必须 enabled（409 `pm role disabled`）
2. `decompose_mode='manual'` → 返回模板 schema（feature_points/acceptance_spec 的 JSON schema），不建任务
3. 其他模式 → 建 stage=2 子 issue（title=「PM plan + 拆解」、assignee=pm、parent=需求、module_id 继承）；`auto` 模式追加派发 agent 任务（复用既有 assignee 触发管道，参考 `issue_child_done.go` 的 `triggerChildDoneAgent`）

- [ ] **Step 4: 跑测试确认通过** → **Step 5: Commit** — `feat(server): decompose start (stage-2 PM task)`

### Task 11: 拆解确认 — 校验 + 批量生效

**Files:**
- Create: `server/internal/service/requirement_decompose.go`
- Create: `server/internal/service/requirement_decompose_test.go`
- Modify: `server/internal/handler/requirement_decompose.go`

- [ ] **Step 1: 写失败测试**（service 层纯逻辑，fixture 直接造 DB 行）

```go
func TestConfirmDecompositionValidates(t *testing.T) {
    cases := []struct{ name string; draft DraftTask; wantErr string }{
        {"功能点缺 kind", DraftTask{FeaturePoints: []FeaturePoint{{Title: "账户模型"}}}, "feature_point kind required"},
        {"执行人不在班底", DraftTask{Assignee: outsider}, "assignee not in roster"},
        {"执行人角色已停用", DraftTask{Assignee: disabledDev}, "assignee role disabled"},
        {"依赖跨模块", DraftTask{DependsOn: otherModuleTask}, "dependency module mismatch"},
    }
    // 逐 case 断言 400/409 + 错误消息
}

func TestConfirmDecompositionBatchEffect(t *testing.T) {
    // 合法草稿 4 执行 + 1 验收 → confirm
    // 断言：5 子 issue 生效（parent/stage=3,4/assignee/module_id）
    // 断言：issue_dependency 按草稿依赖链写入（type='blocked_by'）
    // 断言：需求 decomposition_confirmed_at 非空
    // 断言：重复 confirm → 409（幂等）
}
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现**

`ConfirmDecomposition(ctx, requirementID, drafts []DraftTask) error`：
1. 事务内逐项校验（功能点 `kind ∈ {new,modify}` 必填；执行人 ∈ 班底且角色 enabled；依赖双方同 module——复用 451 的校验函数）
2. 批量创建/更新子 issue：`parent_issue_id=需求`、`stage=3`（执行）或 `4`（验收）、`feature_points/graph_context/acceptance_spec` 原样落列、`root_requirement_id=需求.id`
3. 依赖链写 `issue_dependency`
4. `ConfirmDecomposition` sqlc 写 `decomposition_confirmed_at`（`WHERE ... IS NULL` 保证幂等，影响行数=0 → 409）
5. stage 4 验收子任务：assignee=班底 tester（停用则 pm），description 组装验收依据（原型 html_path + plan 评论链接 + 各子任务 acceptance_spec 汇总）

- [ ] **Step 4: 跑测试确认通过** → **Step 5: Commit** — `feat(server): decomposition confirm validation + batch materialization`

### Task 12: 前端拆解确认面板（画面 5：左基础信息 / 右子任务明细）

**Files:**
- Create: `packages/views/issues/components/requirement-decompose-panel.tsx`
- Create: `packages/views/issues/components/requirement-decompose-panel.test.tsx`

- [ ] **Step 1: 写失败测试**

```ts
it("左栏渲染需求基础信息 kv + plan", () => { /* 标识/模块/git库/分钟时间窗/班底 chips/目标 */ });
it("子任务功能点表标注新增/改造", () => { /* fp 表 tag-new/tag-mod 渲染 */ });
it("存在未标注 kind 的功能点时确认按钮禁用并提示", () => { /* disabled + 红字 */ });
it("执行人微调下拉仅列班底内启用角色成员", () => { /* asg 下拉选项集断言 */ });
it("确认后调用 confirm API 并展示 5 个子任务生效结果", () => { /* mock API + 断言请求体含全部草稿 */ });
```

- [ ] **Step 2: 失败 → Step 3: 实现**（布局照原型画面 5：左 `kv` 列表 + plan 块 + 依赖链总览；右子任务卡列表：fp 表（功能点/kind/代码对象 + ＋添加功能点）+ gn-box 图谱四要素 + acc-box 验收代码 + asg 执行人微调 + 依赖 chips）

- [ ] **Step 4: 通过 → Step 5: Commit** — `feat(web): decomposition confirm panel`

---

## Phase 4：原型师 stage

### Task 13: 提示词组装器 + 原型生成 API

**Files:**
- Create: `server/internal/service/prototype_prompt.go`
- Create: `server/internal/service/prototype_prompt_test.go`
- Create: `server/internal/handler/requirement_prototype.go`(+`_test.go`)

- [ ] **Step 1: 写失败测试**

```go
func TestAssemblePrototypePrompt(t *testing.T) {
    // 需求（描述+目标+repo）→ 组装的 prompt 含〔需求〕〔目标〕〔仓库〕〔产出〕〔风格〕五段
    // 带 marks=[{verdict:no, note:"进度条太粗"}] → 追加〔本轮修正〕段且含 note 原文
    // marks 全 ok → 无〔本轮修正〕段
}

func TestPrototypeGenerateVersioning(t *testing.T) {
    // 首次 generate → version=1, status=pending
    // 再次 generate → version=2，v1 置 superseded
    // 已 confirmed 后 generate → 409（需先取消确认）
}
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现**

- `AssemblePrompt(issue, repo, marks) string`：五段模板 + 条件追加〔本轮修正〕（所有 `verdict='no'` 且 `note` 非空项）
- `POST /issues/{id}/prototype/generate`：同事务 `CreatePrototypeVersion`（version=MAX+1）+ 旧 pending 版本置 superseded → 建/复用 stage=1 子任务派给班底 prototyper，任务负载含组装 prompt + 产出约定路径 `docs/prototypes/<KEY>-<slug>.html`
- prototyper 停用 → 404/409（不该有 stage 1）

- [ ] **Step 4: 跑测试确认通过** → **Step 5: Commit** — `feat(server): prototype prompt assembly + versioned generate`

### Task 14: 原型标记 + 确认门

**Files:**
- Modify: `server/internal/handler/requirement_prototype.go`(+`_test.go`)

- [ ] **Step 1: 写失败测试**

```go
func TestPrototypeConfirmGate(t *testing.T) {
    // marks 含 {verdict:no, note:""} → confirm 409（未处理 ✗）
    // marks 含 {verdict:no, note:"已重生成v2覆盖"} → 可 confirm？——否：no 项必须随新版本消解；
    //   正确路径：generate v2 后 marks 重置，v2 marks 全 ok/pending → confirm 200
    // confirm 后：版本 status=confirmed，stage1 子任务置 done（触发 barrier 唤醒 PM）
}
```

- [ ] **Step 2: 失败 → Step 3: 实现**（`POST .../marks` 写 marks JSONB；`POST .../confirm` 校验当前 pending 版本无 `verdict='no'` 项 → status=confirmed + 关 stage 1 子任务 → 既有 `notifyParentOfChildDone` barrier 自动唤醒 stage 2）

- [ ] **Step 4: 通过 → Step 5: Commit** — `feat(server): prototype marks + confirm gate`

### Task 15: 前端原型面板（画面 4：一键生成 + 逐项标记 + 版本历史）

**Files:**
- Create: `packages/views/issues/components/requirement-prototype-panel.tsx`
- Create: `packages/views/issues/components/requirement-prototype-panel.test.tsx`

- [ ] **Step 1: 写失败测试**

```ts
it("一键生成按钮触发 generate 并轮询新版本", () => { /* mock POST + 版本历史新增 v1 */ });
it("细节标记三态切换且 ✗ 必填修正诉求", () => { /* mark no 无 note → 保存禁用 */ });
it("存在未处理 ✗ 时确认按钮禁用", () => { /* disabled + 红字提示 */ });
it("重新生成请求体携带当前 marks", () => { /* 断言 POST body.marks */ });
```

- [ ] **Step 2: 失败 → Step 3: 实现**（布局照原型画面 4：左 `.proto-preview` 线框打点 + 逐项标记列表；右 `.prompt` 卡片五段提示词只读展示 + 〔本轮修正〕红段 + 「⚡ 一键生成 / ↻ 重新生成」+ `.ver-row` 版本历史 + 目标覆盖对照）

- [ ] **Step 4: 通过 + i18n parity → Step 5: Commit** — `feat(web): prototype one-click generate + marks panel`

---

## Phase 5：定时触发 + 组间互斥

### Task 16: 需求触发 loop

**Files:**
- Create: `server/internal/scheduler/jobs_requirement_trigger.go`
- Create: `server/internal/scheduler/jobs_requirement_trigger_test.go`
- Modify: scheduler 注册处（照 `jobs_autopilot.go` 的注册方式）
- Create: `server/internal/handler/requirement_trigger.go`(+`_test.go`) — 手动触发

- [ ] **Step 1: 写失败测试**

```go
func TestRequirementTriggerSweep(t *testing.T) {
    // 需求 A：confirmed + auto_trigger + start_at=now()-1m → sweep 后 triggered_at 非空
    //   且 stage3 无依赖子任务入队 queued；有依赖链的 T2/T3 不入队（等 claim 闸门）
    // 需求 B：start_at=now()+1h → 不触发
    // 需求 C：auto_trigger=false → 不触发
    // 幂等：对 A 再 sweep → 无变化（MarkRequirementTriggered 影响 0 行）
    // 手动：POST /issues/{id}/trigger（B，未到点）→ 200 且立即入队；已触发再调 → 409
}
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现**

`sweepRequirementTriggers(ctx)`：每 30s `ListTriggerableRequirements` → 逐需求事务：`MarkRequirementTriggered`（影响 0 行则跳过，并发安全）→ 查 stage=3 子任务中**无未完成依赖**者（复用 claim 闸门的 `NOT EXISTS` 判定）→ 入 `agent_task_queue`。手动触发 handler 调同一函数（跳过 start_at 判定）。

- [ ] **Step 4: 跑测试确认通过** → **Step 5: Commit** — `feat(server): requirement trigger sweep + manual trigger`

### Task 17: ModuleLocker v2 — 组间互斥 + 终态即释放

**Files:**
- Modify: `server/internal/daemon/module_locker.go`
- Modify: `server/internal/daemon/module_locker_test.go`
- Modify: `server/internal/issuestatus/issuestatus.go`（claim 闸门加 root 维度）
- Modify: 451 spec `docs/superpowers/specs/2026-09-04-module-dependency-scheduling-design.md` §1/§2/§5

- [ ] **Step 1: 写失败测试**

```go
func TestModuleLockerGroupMutex(t *testing.T) {
    // 同 module 同 root：两个任务都 Acquire 成功（组内并发）
    // 同 module 跨 root：第二个 Acquire 阻塞/onWait 回调持有组名
    // 持有组 root 终态（done）→ release → 等待方按 start_at 升序唤醒
    // root=failed/cancelled 同样释放（终态即释放）
    // avoid_conflict=true 且跨模块：锁退化为 module 级（兼容 451 语义）
}
func TestClaimGateGroupMutex(t *testing.T) {
    // claim 查询：同 module 他组有非终态进行中任务 → 本组任务不被派发（返回空）
    // 同组任务 → 正常派发
}
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现**

- `ModuleLocker`：锁 key 从 `moduleID` 改为 `moduleID + "|" + rootRequirementID`；`Acquire` 签名加 `rootID`；同 key 并发计数，异 key 同 module 互斥；新增 `ReleaseGroup(rootID)`（root 终态时由任务终态回传路径调用）
- claim 闸门：派发查询加 `NOT EXISTS（同 module、异 root、进行中）` 子查询（root 由 issue.root_requirement_id 投影）
- server 侧在 root 需求转终态的 handler 路径上发释放事件 → daemon 收到后 `ReleaseGroup` + 唤醒 waiting 队列（按需求 start_at 升序）

- [ ] **Step 4: 跑测试确认通过 + 451 既有测试全绿**（`go test ./internal/daemon/ -v`）

- [ ] **Step 5: 修订 451 spec 语义**

把 `2026-09-04-module-dependency-scheduling-design.md` §1/§2 的「相同模块内无依赖关系的任务并发执行」修订为：「相同模块内——同任务组按 DAG + 并发；跨任务组自动互斥串行；组终态（done/failed/cancelled）即释放模块占用」；§5 ModuleLocker 表格加 root 维度行。

- [ ] **Step 6: Commit** — `feat(daemon): module locker v2 group mutex + terminal-release; docs: 451 spec semantic revision`

### Task 18: 前端执行调度面板（画面 6）

**Files:**
- Create: `packages/views/issues/components/requirement-schedule-panel.tsx`
- Create: `packages/views/issues/components/requirement-schedule-panel.test.tsx`

- [ ] **Step 1: 写失败测试**

```ts
it("待触发显示分钟级倒计时与触发前预检清单", () => { /* start_at 倒计时 + 班底/拆解/依赖三项 check */ });
it("执行中展示子任务进度与 waiting_module_lock 等待原因", () => { /* wait_reason 渲染 held by 模块「X」 */ });
it("立即触发按钮调 trigger API", () => { /* mock 断言 */ });
```

- [ ] **Step 2: 失败 → Step 3: 实现**（照原型画面 6：倒计时卡 + 预检清单 + 子任务进度列 + 组间互斥等待态）

- [ ] **Step 4: 通过 → Step 5: Commit** — `feat(web): requirement schedule panel`

---

## Phase 6：验收 stage

### Task 19: 验收执行与打回环

**Files:**
- Create: `server/internal/handler/requirement_acceptance.go`(+`_test.go`)
- Modify: `server/internal/service/requirement_decompose.go`（Task 11 已建 stage4 子任务，此处补验收结果处理）

- [ ] **Step 1: 写失败测试**

```go
func TestAcceptanceVerdictFlow(t *testing.T) {
    // 测试 agent 提交 verdict=pass → stage4 子任务 done → barrier → 需求可关
    // verdict=fail（附失败断言清单）→ 自动建 stage3 修复子任务：
    //   parent=需求、stage=3、依赖=相关执行任务、assignee=原执行人
    //   评论附件：失败日志 + 断言位置 + 图谱影响面
    // 轮次：acceptance_round 计数从 graph_context/评论解析或需求列（见下）≥3 →
    //   不再建修复任务；需求转「验收失败」评论通知负责人+PM；模块占用释放
}
```

**验收轮次存储决策**：新增列 `issue.acceptance_round INT NOT NULL DEFAULT 0` 并入 452（若 452 已合入则在 Task 内补一个 455 migration，二选一以执行时点为准）。

- [ ] **Step 2: 失败 → Step 3: 实现**

- `POST /issues/{id}/acceptance/verdict`（测试 agent 回调）：pass → 关 stage4；fail → 事务内 round+1 → round≤3 建修复子任务 + 打回评论；round>3 → 需求评论通知 + 状态转 failed 路径（终态即释放已由 Task 17 保证）
- 验收代码版本约束校验：verdict 负载声明 `acceptance_spec_version` 与子任务 `acceptance_spec.version` 不一致且无非功能变更确认 → 409（防 agent 自行改断言）

- [ ] **Step 4: 通过 → Step 5: Commit** — `feat(server): acceptance verdict + bounce loop with round cap`

### Task 20: 前端验收报告面板（画面 7）

**Files:**
- Create: `packages/views/issues/components/requirement-acceptance-panel.tsx`
- Create: `packages/views/issues/components/requirement-acceptance-panel.test.tsx`

- [ ] **Step 1: 写失败测试**

```ts
it("验收报告四板块渲染：溯源/执行/回归/目标覆盖", () => { /* rep-sec 四块 + score */ });
it("不通过显示 verdict.bad 与打回链（修复子任务链接）", () => { /* bounce 四步渲染 */ });
it("轮次上限超限显示转人工提示", () => { /* R3 失败 → 超限兵推文案 */ });
```

- [ ] **Step 2: 失败 → Step 3: 实现**（照原型画面 7：`.rep` 报告卡 + `.verdict` + `.bounce` 打回链 + 轮次时间线 + 验收代码版本说明）

- [ ] **Step 4: 通过 → Step 5: Commit** — `feat(web): acceptance report panel`

---

## Phase 7：全量验证与收尾

### Task 21: 全量回归 + e2e + 文档

**Files:**
- Modify: `e2e/`（新增需求流水线 e2e，或既有 e2e 套件内补一节）

- [ ] **Step 1: server 全量**

Run: `cd server && go test ./... 2>&1 | grep -E "FAIL|ok " | tail -20`
Expected: 无 FAIL

- [ ] **Step 2: 前端全量**

Run: `pnpm --filter @multica/views test && pnpm --filter @multica/core test`
Expected: PASS（含 parity.test.ts）

- [ ] **Step 3: e2e 主链路**（playwright，环境允许时）：创建需求（班底+分钟时间）→ 原型生成/标记/确认 → 拆解确认 → 手动触发 → 子任务执行态 → 验收通过 → 需求 done。逐步断言 URL 与状态徽标。

- [ ] **Step 4: 迁移幂等终验**

Run: `cd server && go run ./cmd/migrate down && go run ./cmd/migrate up`
Expected: 成功，`\d issue` 列齐全，回填无 NULL root

- [ ] **Step 5: 文档收尾**——设计文档状态从「待评审」改为「已落地」，在文件头补实际落地的 migration 编号；451 spec 修订已在 Task 17 完成，此处复核 diff。

- [ ] **Step 6: Commit** — `chore: requirement calendar full regression + docs finalization`

---

## 依赖顺序与并行化

```
Phase 0（Task 1-3）──┬─→ Phase 1（Task 4-6）──┐
                     ├─→ Phase 2（Task 7-9）─┼─→ Phase 3（Task 10-12）─→ Phase 4（13-15）
                     └─→ Task 17 可并行 ─────┘                                    │
Phase 5（Task 16）依赖 Task 11（confirmed_at）与 Task 17 ─────────────────────────┘
Phase 6（Task 19-20）依赖 Task 11（stage4 子任务）
Phase 7 最后
```

**关键路径**：Phase 0 → 1 → 3 → 5 → 6 → 7。Phase 2（日历视图）与 Phase 4（原型面板）可与关键路径并行。

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| `due_date` 序列化变更影响 gantt 存量渲染 | Task 7 的 date.ts 兼容测试先行；gantt 既有测试必须全绿 |
| ModuleLocker v2 改变 451 已交付语义 | Task 17 保留 avoid_conflict 退化路径；451 既有测试不得修改预期（除明确语义升级点） |
| 触发 sweep 误派发 | `triggered_at` 幂等 + 30s 周期 + 手动触发同函数复用 |
| agent 端 MCP 不可达（GitNexus 离线） | PM 拆解任务负载标注 `graph_context` 缺失原因，拆解不阻断（影响面标「未知」），验收阶段按 acceptance_spec 兜底 |
| 大工作区日历性能 | 派生投影 SQL 仅对当前窗口内需求计算；超 500 需求时再加物化列（设计 §6 已注） |

## Self-Review 记录（已完成）

1. **Spec 覆盖**：设计文档 §5（DDL）→ Task 1-3；§5.2/5.3（班底/原型表）→ Task 2/4/5/6；§6（状态机）→ Task 3 Step 4 + Task 8；§7.1（触发）→ Task 16；§7.2（改期）→ Task 9；§7.3/7.4（互斥+spec 修订）→ Task 17；§8（agent 协议）→ Task 10/13/19；§9（API）→ Task 4/5/10/11/13/14/16/19 全覆盖；§10（前端）→ Task 6/7/8/9/12/15/18/20；§11（兼容）→ Task 3/7/21；§12（测试）→ 各 Task TDD + Task 21。无缺口。
2. **占位符扫描**：无 TBD/TODO；唯一执行时点二选一（Task 19 验收轮次列并入 452 或补 455）已写明判定规则。
3. **类型一致性**：`feature_points/graph_context/acceptance_spec`（452 列）↔ Task 11 `DraftTask` 字段 ↔ 前端 fp/gn-box/acc-box 渲染源，三处命名一致；`root_requirement_id` 在 Task 1（列）/3（sqlc）/17（锁 key）一致。
4. **待用户确认遗留**：设计文档 §14 两条（任务组界定默认值、451 spec 修订时机已定为 Task 17）——执行 Task 17 前若用户对「独立 issue 自成一组」有新决策，仅需改 claim 子查询一处。
