# 需求日历 Phase I 能力补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全 multica「需求日历」Phase I 的 web/desktop 核心闭环——到点自动触发、ModuleLocker 需求组互斥、验收打回闭环、agent_run 投影器、前端动线画面 6/7 与日历补全——使一个已确认拆解的顶层需求能在 `start_at` 到点后被自动派发、按需求组互斥执行、经 stage4 验收 pass/fail 打回，直至终态。

**Architecture:** 复用现有 DB-backed scheduler（`sys_cron_executions` 作为分布式租约+审计）新增一个 30s 全局 sweep job 驱动触发；把 `ModuleLocker` 的锁维度从 `moduleID` 升级为 `(moduleID, rootRequirementID)`，使同一需求组内的子任务不再互相阻塞、不同需求组之间维持互斥；验收闭环落在 issue stage barrier + `issue.sql` 的派生状态 CASE 上，新增第 10 态「验收失败」；agent_run 投影器在 daemon 侧解析 CLI 会话流，回写已存在的 `POST /api/agent-runs` 端点（migration 459）。前端在既有 monorepo 包（`@multica/views` / `@multica/core`）内补全画面 6/7 与日历交互，严守包边界（views 禁 import `next/*`）。

**Tech Stack:** Go 1.x + chi router + pgx/v5 + sqlc v1.31.1 + Postgres（migration up/down）；React 18 + TypeScript + vitest + TanStack Query；pnpm workspace monorepo（`@multica/core` / `@multica/views` / `@multica/ui`）。

**根目录约定：** 全文 `$ROOT = /Users/eleme/Documents/workspace/ai_workspace_online/ai_agents/multica_online`。所有相对路径以 `$ROOT` 为基准。

---

## 命令约定（每个 Task 通用）

后端（Go）：

- 编译：`cd $ROOT/server && go build ./...`
- sqlc 重生成：`cd $ROOT/server && go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate`（或 `make sqlc`）
- 单包测试：`cd $ROOT/server && go test ./internal/<pkg>/ -run <TestName> -v`
- 全量测试（含 DB）：`cd $ROOT && make test`（会先 `migrate up` 再 `go test ./...`，带 `-race`）
- 数据库迁移：`cd $ROOT/server && go run ./cmd/migrate up`

前端（pnpm workspace）：

- 类型检查：`cd $ROOT && pnpm --filter @multica/views typecheck`（core 包同理 `--filter @multica/core`）
- Lint：`cd $ROOT && pnpm --filter @multica/views lint`
- 单测：`cd $ROOT && pnpm --filter @multica/views test -- <相对包根的文件路径>`（vitest run，透传路径过滤）

Git：每个 Task 末尾单独提交，commit message 用约定式前缀（`feat:` / `fix:` / `test:` / `refactor:`）。

> **门禁提醒**：`agent_run` 相关端点使用原生 SQL（`h.DB.QueryRow`）而非 sqlc，勿把它们塞进 `pkg/db/queries/*.sql`（会触发 sqlc 重生成门禁与列名校验）。issue/requirement/agent/module 的查询走 sqlc，改完 `.sql` 必须 `make sqlc` 后再 `go build`。

---

## 前置上下文：WS1 文档 / 数据模型校订（已完成，不在本 plan 展开）

WS1 由并行 agent 产出，是本 plan 的**只读前置上下文**，实现时以这些文档为准，不要再改：

- `$ROOT/docs/superpowers/specs/2026-09-04-requirement-calendar-design.md` — 设计规范（§6 状态机、§7 触发/互斥、§8 agent 协议、§9 API、§10 前端架构）。
- `$ROOT/docs/superpowers/specs/2026-09-06-requirement-calendar-er.md` — ER 文档（数据模型定稿）。
- `$ROOT/docs/superpowers/specs/2026-09-04-requirement-calendar-architecture.html` — 架构图。
- `ARCHITECTURE.md`（校订版）与 `design.md` 校订。

**Phase I 已定稿的开放问题（不可更改，实现时严格遵守）：**

- **#1** 独立 issue 的 `root_requirement_id = 自身`。保留 `server/migrations/452_requirement_calendar.up.sql` L21-28 的递归 CTE 回填 + `server/internal/service/issue.go:366-437` 的创建逻辑，**不改**。
- **#4** 派生态增补第 10 态「验收失败」（WS4 落地）。
- **#5** 维持严格 ✗ 门：`server/internal/service/prototype.go:161-169` 的原型覆盖率 + 细节任一未 `yes` 即阻断的逻辑**不动**。
- **#7** `data` 角色归 stage3（拆解时按 developer 同类处理，见 `service/requirement_decompose.go`）。
- **#8** 不建里程碑表，复用 `project_calendar_config`。
- **#10** v1 **不做**「执行人在线」预检；触发前置条件仅为：拆解已生效（`decomposition_confirmed_at IS NOT NULL`）+ 依赖无环 + 验收代码存在（stage3 子任务 `acceptance_spec` 非空）+ ModuleLocker 互斥窗口可用。
- **#11** agent 端图谱缺失时降级为「档案未就绪」文案；后端仍原样注入 `graph_context`（WS5 落地）。
- `due_date` = date-only 日历日（保持现状，**不做** →ISO 迁移）；`start_at` = 分钟级 t0（已落地）。

---

## 依赖与交付顺序

```
WS1(docs, 已完成)
   │
   ├──► WS2 (触发 loop) ──► WS3 (ModuleLocker v2) ──► WS4 (验收闭环)
   │        后端主链，串行：WS4 依赖 WS2/WS3 的 root 维度与入队能力
   │
   ├──► WS5 (agent_run 投影器)  ← 独立，可与 WS2/WS3/WS4 并行
   │
   └──► WS6 (前端动线补全)      ← 在 WS2/WS3/WS4 端点契约确定后进行
```

- **后端主链串行**：WS2 → WS3 → WS4。WS4 的验收 pass/fail 需要 WS3 的 `ReleaseGroup(rootRequirementID)` 释放需求组锁、需要 WS2 的入队能力重排 stage3 修复子任务。
- **WS5 独立并行**：只依赖已存在的 `POST /api/agent-runs` 端点（migration 459）与 daemon 消息流，不触碰 WS2/3/4。
- **WS6 后置**：需要 WS2 的 `POST /issues/{id}/trigger`、WS4 的 `POST /issues/{id}/acceptance/verdict` 契约稳定后再联调画面 6/7。
- **每个 WS 收尾**：后端跑 `cd $ROOT/server && go build ./... && go test ./internal/<改动的包>/...`；前端跑 `pnpm --filter @multica/views typecheck && pnpm --filter @multica/views lint`。
- **全量收尾**：`cd $ROOT && make test`（后端）+ 关键动线 Browser E2E + 3 维 CodeReview（见文末「验证与交付」）。

---

## File Structure（本 plan 创建 / 修改的全部文件）

**新建（后端）：**

- `server/internal/scheduler/jobs_requirement_trigger.go` — WS2 触发 loop 的 JobSpec + scope/handler + 预检。
- `server/internal/scheduler/jobs_requirement_trigger_test.go` — WS2 单测（预检纯函数）。
- `server/internal/handler/requirement_trigger.go` — WS2 手动 `POST /issues/{id}/trigger` handler。
- `server/internal/handler/requirement_trigger_test.go` — WS2 handler 测试。
- `server/internal/handler/requirement_acceptance.go` — WS4 `POST /issues/{id}/acceptance/verdict` handler（`RecordAcceptanceVerdict`，verdict pass/fail；fail → `IncrementAcceptanceRound`，>3 转验收失败终态 + 人工仲裁）。
- `server/internal/handler/requirement_acceptance_test.go` — WS4 handler 测试。
- `server/internal/handler/agent_run_projector.go` — WS5 **server 侧 ingest 投影**：纯派生 `projectAgentRunFromMessages` + `classifyErrorEvent`、写入器 `applyAgentRunProjection`、终态收尾 `finalizeAgentRunStatus` / `addAgentRunTokens`、确定性 run id `agentRunIDForTask`。
- `server/internal/handler/agent_run_projector_test.go` — WS5 纯派生单测（无 DB）+ 写入器 / 终态收尾 DB 集成测试。

**修改（后端）：**

- `server/cmd/server/main.go:749-766` — WS2 注册 `RequirementTriggerJob`。
- `server/cmd/server/router.go:1884-1936` — WS2 挂 `/trigger`、WS4 挂 `/acceptance/verdict`。
- `server/internal/daemon/module_locker.go` — WS3 锁维度升级 + `ReleaseGroup`。
- `server/internal/daemon/module_locker_test.go` — WS3 单测更新/新增。
- `server/internal/daemon/daemon.go:5734-5837` — WS3 `acquireModuleLockIfNeeded` 传 root 维度 + onWait 文案。
- `server/internal/daemon/types.go:79-83` — WS3 Task 增 `RootRequirementID`。
- `server/pkg/db/queries/module.sql:29-34` — WS3 `GetIssueModuleInfo` 增 `root_requirement_id`。
- `server/internal/handler/daemon.go:2329-2337` — WS3 claim 投影 root 维度。
- `server/internal/handler/agent.go:342-460` — WS3 `AgentTaskResponse` 增 `RootRequirementID`。
- `server/pkg/db/queries/agent.sql:1742-1749` — WS3 `CountRunningTasks` root 维度闸门。
- `server/pkg/db/queries/issue.sql:18-33` — WS4 派生状态 CASE 增第 10 态 + 修正规则 6。
- `server/internal/handler/issue_child_done.go:119-147` — WS4 barrier 唤醒/入队 stage4 tester。
- `server/internal/handler/daemon.go:4573-4580` — WS5 `TaskMessageRequest` 增 `CallID`（tool_use/tool_result 配对键）。
- `server/internal/handler/daemon.go:4693`（`ReportTaskMessages` 落 task_message 后）— WS5 挂 ingest 投影（best-effort）。
- `server/internal/handler/daemon.go:3856`（`CompleteTask`）/ `:4543`（`failTask`）/ `:4742`（`AckTaskCancelled`）/ `:4422-4468`（`ReportTaskUsage`）— WS5 终态收尾 + token 累计。
- `server/internal/daemon/client.go:492-499` — WS5 `TaskMessageData` 增 `CallID`（omitempty，向后兼容）。
- `server/internal/daemon/daemon.go:8901,8945` — WS5 drain loop 的 tool_use / tool_result 两处 populate `CallID`。

**新建 / 修改（前端）：**

- `packages/core/types/issue.ts:224-245`（需求日历字段块）— WS6 Issue 增 `acceptance_round?`（服务端 `issue.go:93` 已发该列、前端类型漏声明）。
- `packages/core/types/api.ts:137`（`GetDecompositionResponse` 之后）— WS6 增 `TriggerRequirementResponse` / `AcceptanceVerdictResponse` 类型。
- `packages/core/api/client.ts:1407`（`decomposeRequirement` 之后）— WS6 增 `triggerRequirement` / `submitAcceptanceVerdict`（`getDecomposition` 已在 1409）。
- `packages/views/issues/components/requirement-decompose-panel.tsx:270-289`（DraftCard 尾部）— WS6 补 gn-box(`graph_context`)/acc-box(`acceptance_spec`)；i18n 键 `decompose_panel.graph_title`/`acc_title` 已存在（en:977-978）。
- `packages/views/issues/components/requirement-schedule-panel.tsx` — WS6 新建（画面 6：倒计时 + 进度 + 互斥等待 + 手动触发）。
- `packages/views/issues/components/requirement-acceptance-panel.tsx` — WS6 新建（画面 7：轮次 + 报告 + 打回链 + pass/fail 人工仲裁）。
- `packages/views/issues/components/requirement-flow-section.tsx:165-184,299-336` — WS6 挂载 stage3→schedule、stage4→acceptance 面板 + trigger/verdict 回调。
- `packages/views/issues/components/calendar-view.tsx:141-173`（STATUS_ICON/STATUS_TONE/RESCHEDULE_LOCKED_STATUSES）— WS6 补第 10 态「验收失败」色块映射（§6.1:272 要求前端同步）。
- `packages/views/modals/create-issue.tsx:344,596-601,1538`（需求字段块）— WS6 补 `repo_resource_id` git 库选择器（§10:378）。
- `packages/views/locales/{en,zh-Hans,ja,ko}/issues.json` — WS6 增 `schedule_panel`/`acceptance_panel` 段（四语言同步，`parity.test.ts` 双向门禁）。
- `packages/views/locales/{en,zh-Hans,ja,ko}/modals.json` — WS6 在 `create_issue` 段增 `repo_*` 键（`create-issue.tsx:138` 用 `useT("modals")`，故归 modals.json 而非 issues.json；同受 `parity.test.ts` 门禁，该测试扫描全部命名空间）。
- 对应 `*.test.tsx`/`*.test.ts` 测试文件（与被测组件同目录）+ `packages/core/api/client.test.ts`。

> **WS6 实证校正（撰写前直读确认，详见 WS6 章节「实证校正」表）**：① 拖拽改期 + 视觉反馈**已落地**（`calendar-view.tsx:309-343` `handleDrop`、`:418-432` `dragOverKey` ring），无需新任务；② `requirement_status` 是 `issue.sql:18-33` 派生投影（§6:230），**不可作 server 过滤维度**，故 `view-store.FilterSnapshot` 过滤维度 + `module-filter-bar` 待确认 chip **不在 Phase I 范围**（module bar 维持模块单一职责）；③ `RequirementBlock` 角色头像非 spec 要求（§10:377 只述状态 + 进度），**丢弃**。

---


## WS2 — 到点自动触发 loop

**目标：** 一个已确认拆解、`auto_trigger=TRUE`、`start_at <= now()` 的顶层需求，能被 30s sweep 自动命中、通过触发前置预检、幂等标记 `triggered_at`，并把其 stage3 子任务入队 `agent_task_queue`。同时提供手动 `POST /issues/{id}/trigger` 走同一套预检+入队逻辑。

**已存在、零业务调用的基建（本 WS 直接复用，勿重写）：**

- `queries.ListTriggerableRequirements(ctx) ([]db.Issue, error)` — `requirement.sql:89-100` / 生成于 `requirement.sql.go:428`。SQL 已过滤：`parent_issue_id IS NULL AND auto_trigger=TRUE AND triggered_at IS NULL AND decomposition_confirmed_at IS NOT NULL AND start_at IS NOT NULL AND start_at <= now() AND issue_effective_status(...) NOT IN ('done','cancelled')`。
- `queries.MarkRequirementTriggered(ctx, id) (int64, error)` — `requirement.sql:102-106` / 生成于 `requirement.sql.go:497`。幂等：`UPDATE issue SET triggered_at=now() WHERE id=$1 AND triggered_at IS NULL`；返回 0 = 已被并发触发。
- `queries.ListRequirementChildren(ctx, parentID) ([]db.Issue, error)` — `requirement.sql:112-116`，按 `stage ASC` 排序。
- `queries.ListDependencyEdgesForProject(ctx, projectID) ([]db.ListDependencyEdgesForProjectRow, error)` — `module.sql:52-57`，返回项目内全部 `blocked_by` 边（`issue_id` / `depends_on_issue_id`），供判环。
- `(*service.TaskService).EnqueueTaskForIssue(ctx, issue db.Issue, triggerCommentID ...pgtype.UUID) (db.AgentTaskQueue, error)` — `service/task.go:1093`。
- scheduler 注册模式：`cmd/server/main.go:749-766`（`schedulerMgr.Register(...)`）。
- JobSpec 模板：`scheduler/jobs_autopilot.go`（本 WS 镜像其结构，但用 `StaticScopes(ScopeGlobal)` + `Cadence=30s`，不用 `PlansForScope`）。

> **关键澄清：** `service.ConfirmDecomposition`（`requirement_decompose.go:80`）只落库子任务与依赖、置 `decomposition_confirmed_at`，**不派发** stage3（源码注释明确「stage3 推进归触发 loop 管」）。因此 stage3 的首次入队**必须由本 WS 的触发 loop 承担**——这是本 WS 存在的核心理由。

---

### Task 2.1: 触发前置预检纯函数（`triggerPreflight` + `dependencyGraphAcyclic`）

**Files:**
- Create: `server/internal/scheduler/jobs_requirement_trigger.go`
- Test: `server/internal/scheduler/jobs_requirement_trigger_test.go`

- [ ] **Step 1: 写失败测试**

创建 `server/internal/scheduler/jobs_requirement_trigger_test.go`：

```go
package scheduler

import "testing"

func TestTriggerPreflight(t *testing.T) {
	ok := triggerPreflightInput{
		DecompositionConfirmed: true,
		DependencyAcyclic:      true,
		AcceptanceSpecPresent:  true,
		ModuleWindowFree:       true,
	}
	cases := []struct {
		name       string
		mutate     func(*triggerPreflightInput)
		wantPass   bool
		wantReason string
	}{
		{"all green passes", func(*triggerPreflightInput) {}, true, ""},
		{"decomposition not confirmed", func(in *triggerPreflightInput) { in.DecompositionConfirmed = false }, false, "decomposition_not_confirmed"},
		{"dependency cycle", func(in *triggerPreflightInput) { in.DependencyAcyclic = false }, false, "dependency_cycle"},
		{"acceptance spec missing", func(in *triggerPreflightInput) { in.AcceptanceSpecPresent = false }, false, "acceptance_spec_missing"},
		{"module window busy", func(in *triggerPreflightInput) { in.ModuleWindowFree = false }, false, "module_window_busy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := ok
			tc.mutate(&in)
			pass, reason := triggerPreflight(in)
			if pass != tc.wantPass || reason != tc.wantReason {
				t.Fatalf("triggerPreflight(%+v) = (%v,%q), want (%v,%q)", in, pass, reason, tc.wantPass, tc.wantReason)
			}
		})
	}
}

func TestDependencyGraphAcyclic(t *testing.T) {
	acyclic := [][2]string{{"a", "b"}, {"b", "c"}, {"a", "c"}}
	if !dependencyGraphAcyclic(acyclic) {
		t.Fatal("expected acyclic graph to report true")
	}
	cyclic := [][2]string{{"a", "b"}, {"b", "c"}, {"c", "a"}}
	if dependencyGraphAcyclic(cyclic) {
		t.Fatal("expected cyclic graph to report false")
	}
	if !dependencyGraphAcyclic(nil) {
		t.Fatal("empty edge set is trivially acyclic")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/scheduler/ -run 'TestTriggerPreflight|TestDependencyGraphAcyclic' -v`
Expected: 编译失败 `undefined: triggerPreflightInput` / `undefined: triggerPreflight` / `undefined: dependencyGraphAcyclic`。

- [ ] **Step 3: 写最小实现**

创建 `server/internal/scheduler/jobs_requirement_trigger.go`（本步只放纯函数，JobSpec 在 Task 2.2 追加）：

```go
package scheduler

// triggerPreflightInput 是触发前置判定的纯输入，由 handler 从 DB 读齐后填入。
// 对应开放问题 #10：v1 触发前置 = 拆解已生效 + 依赖无环 + 验收代码存在 +
// ModuleLocker 互斥窗口可用（不做「执行人在线」预检）。
type triggerPreflightInput struct {
	DecompositionConfirmed bool // issue.decomposition_confirmed_at IS NOT NULL
	DependencyAcyclic      bool // 组内子任务 blocked_by DAG 无环
	AcceptanceSpecPresent  bool // 至少一个 stage3 子任务 acceptance_spec 非空
	ModuleWindowFree       bool // 同模块无「其它 root 需求组」的活动任务
}

// triggerPreflight 返回是否放行 + 阻断原因（写入 sys_cron_executions.result 供审计）。
// 判定顺序固定，原因串稳定，便于前端/E2E 断言。
func triggerPreflight(in triggerPreflightInput) (bool, string) {
	switch {
	case !in.DecompositionConfirmed:
		return false, "decomposition_not_confirmed"
	case !in.DependencyAcyclic:
		return false, "dependency_cycle"
	case !in.AcceptanceSpecPresent:
		return false, "acceptance_spec_missing"
	case !in.ModuleWindowFree:
		return false, "module_window_busy"
	default:
		return true, ""
	}
}

// dependencyGraphAcyclic 用三色 DFS 判有向边集是否无环。edges[i] = {from, to}。
func dependencyGraphAcyclic(edges [][2]string) bool {
	adj := make(map[string][]string, len(edges))
	for _, e := range edges {
		adj[e[0]] = append(adj[e[0]], e[1])
	}
	const (
		white = 0 // 未访问
		gray  = 1 // 访问中（在当前 DFS 栈上）
		black = 2 // 已完成
	)
	color := make(map[string]int)
	var visit func(n string) bool
	visit = func(n string) bool {
		color[n] = gray
		for _, next := range adj[n] {
			switch color[next] {
			case gray:
				return false // 后向边 ⇒ 有环
			case white:
				if !visit(next) {
					return false
				}
			}
		}
		color[n] = black
		return true
	}
	for n := range adj {
		if color[n] == white && !visit(n) {
			return false
		}
	}
	return true
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd $ROOT/server && go test ./internal/scheduler/ -run 'TestTriggerPreflight|TestDependencyGraphAcyclic' -v`
Expected: `--- PASS: TestTriggerPreflight`（5 子测试）+ `--- PASS: TestDependencyGraphAcyclic`，`ok`。

- [ ] **Step 5: 提交**

```bash
cd $ROOT && git add server/internal/scheduler/jobs_requirement_trigger.go server/internal/scheduler/jobs_requirement_trigger_test.go
git commit -m "feat(scheduler): requirement trigger preflight pure functions"
```

---

### Task 2.2: `RequirementTriggerJob` JobSpec + sweep handler

**Files:**
- Modify: `server/internal/scheduler/jobs_requirement_trigger.go`
- Reference（镜像模板，勿改）: `server/internal/scheduler/jobs_autopilot.go:89-121`

- [ ] **Step 1: 追加 JobSpec 与 dispatcher 接口**

在 `jobs_requirement_trigger.go` 顶部补 import 并追加（import 块与 `jobs_autopilot.go:3-17` 对齐）：

```go
import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// JobNameRequirementTrigger 是写入 sys_cron_executions 的稳定 job 名（勿改名，
// 改名会孤立历史审计行）。
const JobNameRequirementTrigger = "requirement_trigger_dispatch"

// RequirementTriggerDispatcher 是本 job 对 service.TaskService 的窄契约。
// 签名与 (*service.TaskService).EnqueueTaskForIssue 完全一致（含可变参），
// 因此 *service.TaskService 直接满足，单测可用 stub 替换。
type RequirementTriggerDispatcher interface {
	EnqueueTaskForIssue(ctx context.Context, issue db.Issue, triggerCommentID ...pgtype.UUID) (db.AgentTaskQueue, error)
}

// RequirementTriggerJob 返回 30s 全局 sweep 的 JobSpec。
// 镜像 AutopilotScheduleDispatchJob 结构，但用 StaticScopes(ScopeGlobal) +
// Cadence（不用 PlansForScope）——触发时机由 start_at <= now() 的 SQL 过滤决定，
// sweep 只是周期性重扫，无需 cron 表达式枚举。
func RequirementTriggerJob(
	pool *pgxpool.Pool,
	queries *db.Queries,
	dispatcher RequirementTriggerDispatcher,
) JobSpec {
	_ = pool // 预留：未来可把 sweep 包进单个 tx
	return JobSpec{
		Name:              JobNameRequirementTrigger,
		Cadence:           30 * time.Second,
		ScheduleDelay:     0,
		CatchUpMode:       CatchUpLatestOnly, // 停机后只补最近一次 sweep，历史到点需求本轮一次扫全
		CatchUpWindow:     1 * time.Hour,
		RunTimeout:        1 * time.Minute,
		StaleTimeout:      3 * time.Minute,
		HeartbeatInterval: 20 * time.Second,
		AllowStaleReentry: true, // MarkRequirementTriggered 幂等 ⇒ 重入安全
		MaxAttempts:       3,
		RetryBackoff:      []time.Duration{30 * time.Second, 2 * time.Minute},
		MaxPlansPerTick:   1,
		Scopes:            StaticScopes(ScopeGlobal),
		Handler:           requirementTriggerHandler(queries, dispatcher),
	}
}
```

- [ ] **Step 2: 追加 sweep handler**

同文件继续追加：

```go
// requirementTriggerHandler 单次 sweep：扫全量到点需求，逐个跑预检 → 幂等标记
// triggered_at → 入队 stage3 子任务。返回审计结果（命中数/入队数/各阻断原因计数）。
func requirementTriggerHandler(
	queries *db.Queries,
	dispatcher RequirementTriggerDispatcher,
) Handler {
	return func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
		reqs, err := queries.ListTriggerableRequirements(ctx)
		if err != nil {
			return HandlerResult{}, fmt.Errorf("requirement trigger: list triggerable: %w", err)
		}
		result := map[string]any{"scanned": len(reqs), "triggered": 0, "enqueued": 0}
		blocked := map[string]int{}
		for _, req := range reqs {
			pass, reason, enq, err := triggerOneRequirement(ctx, queries, dispatcher, req)
			if err != nil {
				// 单需求失败不阻断整轮 sweep；记入审计，下一 tick 重试。
				blocked["error"]++
				continue
			}
			if !pass {
				blocked[reason]++
				continue
			}
			result["triggered"] = result["triggered"].(int) + 1
			result["enqueued"] = result["enqueued"].(int) + enq
		}
		if len(blocked) > 0 {
			result["blocked"] = blocked
		}
		return HandlerResult{RowsAffected: int64(result["triggered"].(int)), Result: result}, nil
	}
}

// triggerOneRequirement 处理单个到点需求：预检 → 幂等标记 → 入队 stage3。
// 返回 (是否放行, 阻断原因, 入队任务数, error)。
func triggerOneRequirement(
	ctx context.Context,
	queries *db.Queries,
	dispatcher RequirementTriggerDispatcher,
	req db.Issue,
) (bool, string, int, error) {
	children, err := queries.ListRequirementChildren(ctx, req.ID)
	if err != nil {
		return false, "", 0, fmt.Errorf("list children: %w", err)
	}
	// 验收代码存在：至少一个 stage3 子任务 acceptance_spec 非空。
	acceptancePresent := false
	var stage3 []db.Issue
	for _, c := range children {
		if c.Stage.Valid && c.Stage.Int32 == 3 {
			stage3 = append(stage3, c)
			if len(c.AcceptanceSpec) > 0 {
				acceptancePresent = true
			}
		}
	}
	// 依赖无环：取项目内全部 blocked_by 边，裁剪到组内子任务后判环。
	groupIDs := make(map[string]bool, len(children))
	for _, c := range children {
		groupIDs[util.UUIDToString(c.ID)] = true
	}
	edges, err := queries.ListDependencyEdgesForProject(ctx, req.ProjectID)
	if err != nil {
		return false, "", 0, fmt.Errorf("list dependency edges: %w", err)
	}
	var groupEdges [][2]string
	for _, e := range edges {
		from := util.UUIDToString(e.IssueID)
		to := util.UUIDToString(e.DependsOnIssueID)
		if groupIDs[from] && groupIDs[to] {
			groupEdges = append(groupEdges, [2]string{from, to})
		}
	}
	// 互斥窗口：同模块无其它 root 组活动任务（Task 2.3 接入 ModuleBusyForOtherRoot）。
	windowFree, err := moduleWindowFree(ctx, queries, req)
	if err != nil {
		return false, "", 0, fmt.Errorf("module window check: %w", err)
	}

	pass, reason := triggerPreflight(triggerPreflightInput{
		DecompositionConfirmed: req.DecompositionConfirmedAt.Valid,
		DependencyAcyclic:      dependencyGraphAcyclic(groupEdges),
		AcceptanceSpecPresent:  acceptancePresent,
		ModuleWindowFree:       windowFree,
	})
	if !pass {
		return false, reason, 0, nil
	}

	// 幂等标记；0 行 = 已被并发 sweep 触发，本轮跳过（不重复入队）。
	rows, err := queries.MarkRequirementTriggered(ctx, req.ID)
	if err != nil {
		return false, "", 0, fmt.Errorf("mark triggered: %w", err)
	}
	if rows == 0 {
		return false, "already_triggered", 0, nil
	}
	// 入队全部 stage3 子任务（依赖闸门由 ClaimAgentTask 在领取时把关，
	// 这里一次性入队，未满足依赖的会停在 queued）。
	enqueued := 0
	for _, c := range stage3 {
		if _, err := dispatcher.EnqueueTaskForIssue(ctx, c); err != nil {
			return true, "", enqueued, fmt.Errorf("enqueue stage3 %s: %w", util.UUIDToString(c.ID), err)
		}
		enqueued++
	}
	return true, "", enqueued, nil
}
```

> 注：`moduleWindowFree` 在 Task 2.3 定义（依赖新 sqlc 查询）。**本步先在文件末尾加临时桩**以便编译通过，Task 2.3 替换为真实现：
>
> ```go
> // moduleWindowFree 临时桩：Task 2.3 用 ModuleBusyForOtherRoot 查询替换。
> func moduleWindowFree(ctx context.Context, queries *db.Queries, req db.Issue) (bool, error) {
> 	return true, nil
> }
> ```

- [ ] **Step 3: 编译**

Run: `cd $ROOT/server && go build ./internal/scheduler/`
Expected: 无输出（成功）。若报 `ListDependencyEdgesForProjectRow` 字段名不符，用 `cd $ROOT/server && grep -n "type ListDependencyEdgesForProjectRow" pkg/db/generated/module.sql.go` 核对生成结构体字段（应为 `IssueID` / `DependsOnIssueID`）。

- [ ] **Step 4: 跑既有 scheduler 测试确认无回归**

Run: `cd $ROOT/server && go test ./internal/scheduler/ -v`
Expected: 全部 `PASS`（含 Task 2.1 的两个新测试）。

- [ ] **Step 5: 提交**

```bash
cd $ROOT && git add server/internal/scheduler/jobs_requirement_trigger.go
git commit -m "feat(scheduler): RequirementTriggerJob 30s sweep + stage3 enqueue"
```

---

### Task 2.3: 互斥窗口预检查询 `ModuleBusyForOtherRoot`

**Files:**
- Modify: `server/pkg/db/queries/requirement.sql`（文件末尾追加）
- Modify: `server/internal/scheduler/jobs_requirement_trigger.go`（替换 Task 2.2 的桩）

- [ ] **Step 1: 追加 sqlc 查询**

在 `server/pkg/db/queries/requirement.sql` 末尾（L127 之后）追加：

```sql
-- name: ModuleBusyForOtherRoot :one
-- 触发窗口预检（开放问题 #10）：同 module 上是否存在「其它 root 需求组」的活动任务
-- （dispatched/running/waiting_local_directory/waiting_module_lock）。有则本轮不触发，
-- 等下一个 30s sweep 重扫；避免把需求推进一个已被别组占用的互斥窗口。
-- module_id 为 NULL（无模块需求）时恒不忙 —— 无模块任务不参与互斥。
SELECT EXISTS (
    SELECT 1
    FROM agent_task_queue q
    JOIN issue ti ON ti.id = q.issue_id
    WHERE ti.module_id = @module_id
      AND ti.root_requirement_id <> @root_requirement_id
      AND q.status IN ('dispatched', 'running', 'waiting_local_directory', 'waiting_module_lock')
) AS busy;
```

- [ ] **Step 2: 重生成 sqlc**

Run: `cd $ROOT/server && go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate`
Expected: 无报错；`pkg/db/generated/requirement.sql.go` 新增 `func (q *Queries) ModuleBusyForOtherRoot(ctx, params ModuleBusyForOtherRootParams) (bool, error)`。
核对：`grep -n "ModuleBusyForOtherRootParams" $ROOT/server/pkg/db/generated/requirement.sql.go`（应含 `ModuleID pgtype.UUID` / `RootRequirementID pgtype.UUID` 两字段）。

- [ ] **Step 3: 用真实现替换桩**

把 Task 2.2 Step 2 末尾的 `moduleWindowFree` 桩替换为：

```go
// moduleWindowFree 报告该需求所在模块是否对其 root 组空闲（无其它组活动任务）。
// 无模块需求（module_id 为 NULL）恒返回 true —— 不参与互斥。
func moduleWindowFree(ctx context.Context, queries *db.Queries, req db.Issue) (bool, error) {
	if !req.ModuleID.Valid {
		return true, nil
	}
	busy, err := queries.ModuleBusyForOtherRoot(ctx, db.ModuleBusyForOtherRootParams{
		ModuleID:          req.ModuleID,
		RootRequirementID: req.RootRequirementID,
	})
	if err != nil {
		return false, err
	}
	return !busy, nil
}
```

- [ ] **Step 4: 编译**

Run: `cd $ROOT/server && go build ./...`
Expected: 无输出（成功）。

- [ ] **Step 5: 提交**

```bash
cd $ROOT && git add server/pkg/db/queries/requirement.sql server/pkg/db/generated/requirement.sql.go server/internal/scheduler/jobs_requirement_trigger.go
git commit -m "feat(scheduler): module mutex-window preflight for requirement trigger"
```

---

### Task 2.4: 在 main.go 注册 job

**Files:**
- Modify: `server/cmd/server/main.go:759-766`（在 autopilot/plugin 注册之后追加）

- [ ] **Step 1: 追加注册**

在 `main.go` 的 `schedulerMgr.Register(scheduler.PluginHookScheduleDispatchJob(...))` 块（L764-766）之后、`go func() { _ = schedulerMgr.Run(sweepCtx) }()`（L767）之前插入：

```go
	// 需求日历（spec 2026-09-04 §7.1）：到点自动触发 loop。30s 全局 sweep，
	// 命中 start_at <= now() 的已确认拆解需求，跑触发前置预检后入队 stage3。
	// 复用 taskSvc（与 router 同一个 TaskService，见 backgroundServices）以免
	// EmptyClaim 缓存版本不同步导致 daemon 空领取。
	if err := schedulerMgr.Register(scheduler.RequirementTriggerJob(pool, queries, taskSvc)); err != nil {
		slog.Warn("scheduler: failed to register requirement_trigger_dispatch job", "error", err)
	}
```

> `taskSvc` 已在 `main.go:661`（`taskSvc, autopilotSvc := backgroundServices(h)`）就位；`pool` / `queries` 是同函数内既有变量。

- [ ] **Step 2: 编译**

Run: `cd $ROOT/server && go build ./cmd/server/`
Expected: 无输出（成功）。

- [ ] **Step 3: 校验 JobSpec 通过 validate()**

Run: `cd $ROOT/server && go test ./internal/scheduler/ -run TestSpec -v`
Expected: `PASS`（`spec_test.go` 覆盖 validate 不变式）。补充人工核对：`RunTimeout(1m) < StaleTimeout(3m)`、`HeartbeatInterval(20s) < StaleTimeout(3m)`、`MaxAttempts(3) >= 1`、`Scopes`/`Handler` 非 nil —— 均满足 `spec.go:205-234` 的 validate 约束。

- [ ] **Step 4: 提交**

```bash
cd $ROOT && git add server/cmd/server/main.go
git commit -m "feat(scheduler): register requirement_trigger_dispatch job"
```

---

### Task 2.5: 手动触发端点 `POST /issues/{id}/trigger`

**Files:**
- Create: `server/internal/handler/requirement_trigger.go`
- Create: `server/internal/handler/requirement_trigger_test.go`
- Modify: `server/cmd/server/router.go:1910`（在 issue `/{id}` 段内追加一行）

- [ ] **Step 1: 写失败测试**

创建 `server/internal/handler/requirement_trigger_test.go`：

```go
package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestTriggerRequirementRejectsNonRequirement 校验：对子任务（有 parent_issue_id）
// 触发返回 409 —— 只有顶层需求可被触发。用最小 handler 单测（不连 DB）验证
// 输入校验分支：nil body / 非法 issue。完整 DB 路径由 E2E 覆盖。
func TestTriggerRequirementValidatesBody(t *testing.T) {
	// triggerRequirement 在解析 body 前应先校验 method/body；这里验证一个
	// 空 body 的 POST 不会 panic，并返回 4xx（而非 5xx）。
	h := &Handler{}
	req := httptest.NewRequest(http.MethodPost, "/api/issues/not-a-uuid/trigger", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	// 非法 UUID 应在 loadIssueForUser 阶段被拒（400/404），不 panic。
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("handler panicked on invalid id: %v", r)
			}
		}()
		h.TriggerRequirement(w, req)
	}()
	if w.Code < 400 || w.Code >= 500 {
		t.Fatalf("expected 4xx for invalid issue id, got %d", w.Code)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/handler/ -run TestTriggerRequirementValidatesBody -v`
Expected: 编译失败 `h.TriggerRequirement undefined (type *Handler has no field or method TriggerRequirement)`。

- [ ] **Step 3: 写 handler 实现**

创建 `server/internal/handler/requirement_trigger.go`（镜像 `requirement_prototype.go` 的 loadIssueForUser + service 调用 + 错误映射模式）：

```go
package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/util"
)

// TriggerRequirement 实现 POST /api/issues/{id}/trigger（spec §7.1 手动触发）。
// 与自动 sweep 共用同一套触发前置预检 + 幂等标记 + stage3 入队逻辑：直接调用
// scheduler 包导出的 TriggerRequirementNow，避免逻辑分叉。
//
// 前置：必须是顶层需求（parent_issue_id IS NULL）——子任务触发返回 409。
// 幂等：已触发（triggered_at 非空）返回 409 already_triggered。
// 预检失败：返回 409，body 带 reason（decomposition_not_confirmed /
// dependency_cycle / acceptance_spec_missing / module_window_busy）。
func (h *Handler) TriggerRequirement(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if issue.ParentIssueID.Valid {
		writeError(w, http.StatusConflict, "only top-level requirements can be triggered")
		return
	}
	result, err := h.RequirementTrigger.TriggerRequirementNow(r.Context(), issue)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to trigger requirement: "+err.Error())
		return
	}
	if !result.Pass {
		writeError(w, http.StatusConflict, result.Reason)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"triggered": true,
		"enqueued":  result.Enqueued,
		"issue_id":  util.UUIDToString(issue.ID),
	})
}
```

> `h.RequirementTrigger` 是一个新 handler 依赖字段，类型 `*scheduler.RequirementTriggerService`。见 Step 4/5：把 Task 2.2 的 `triggerOneRequirement` 提炼成一个可被 handler 与 sweep 共用的导出服务。

- [ ] **Step 4: 提炼共用服务 `RequirementTriggerService`**

在 `server/internal/scheduler/jobs_requirement_trigger.go` 追加导出服务，让 sweep handler 与 HTTP handler 共用同一逻辑（DRY）：

```go
// TriggerResult 是一次触发尝试的结果。
type TriggerResult struct {
	Pass     bool   // 是否放行并已入队
	Reason   string // 阻断原因（Pass=false 时非空）
	Enqueued int    // 入队的 stage3 任务数
}

// RequirementTriggerService 封装「预检 → 幂等标记 → 入队 stage3」，供 30s sweep
// 与手动 POST /issues/{id}/trigger 共用。
type RequirementTriggerService struct {
	queries    *db.Queries
	dispatcher RequirementTriggerDispatcher
}

// NewRequirementTriggerService 构造共用触发服务。
func NewRequirementTriggerService(queries *db.Queries, dispatcher RequirementTriggerDispatcher) *RequirementTriggerService {
	return &RequirementTriggerService{queries: queries, dispatcher: dispatcher}
}

// TriggerRequirementNow 对单个需求立即执行触发（手动入口）。
func (s *RequirementTriggerService) TriggerRequirementNow(ctx context.Context, req db.Issue) (TriggerResult, error) {
	pass, reason, enq, err := triggerOneRequirement(ctx, s.queries, s.dispatcher, req)
	if err != nil {
		return TriggerResult{}, err
	}
	return TriggerResult{Pass: pass, Reason: reason, Enqueued: enq}, nil
}
```

同时把 Task 2.2 的 `requirementTriggerHandler` 改为经由该服务（保持 sweep 与手动同源）：

```go
func requirementTriggerHandler(svc *RequirementTriggerService) Handler {
	return func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
		reqs, err := svc.queries.ListTriggerableRequirements(ctx)
		if err != nil {
			return HandlerResult{}, fmt.Errorf("requirement trigger: list triggerable: %w", err)
		}
		result := map[string]any{"scanned": len(reqs), "triggered": 0, "enqueued": 0}
		blocked := map[string]int{}
		for _, req := range reqs {
			res, err := svc.TriggerRequirementNow(ctx, req)
			if err != nil {
				blocked["error"]++
				continue
			}
			if !res.Pass {
				blocked[res.Reason]++
				continue
			}
			result["triggered"] = result["triggered"].(int) + 1
			result["enqueued"] = result["enqueued"].(int) + res.Enqueued
		}
		if len(blocked) > 0 {
			result["blocked"] = blocked
		}
		return HandlerResult{RowsAffected: int64(result["triggered"].(int)), Result: result}, nil
	}
}
```

并相应把 `RequirementTriggerJob` 的构造改为先建 service 再传给 handler：

```go
func RequirementTriggerJob(pool *pgxpool.Pool, queries *db.Queries, dispatcher RequirementTriggerDispatcher) JobSpec {
	_ = pool
	svc := NewRequirementTriggerService(queries, dispatcher)
	return JobSpec{
		// ... 同 Task 2.2 的全部字段不变 ...
		Scopes:  StaticScopes(ScopeGlobal),
		Handler: requirementTriggerHandler(svc),
	}
}
```

- [ ] **Step 5: 挂 handler 依赖字段 + router**

在 `server/internal/handler/handler.go` 的 `Handler` struct（`IssueService *service.IssueService` 附近，L196）追加字段：

```go
	RequirementTrigger *scheduler.RequirementTriggerService
```

并在 `handler.go` 顶部 import 块加 `"github.com/multica-ai/multica/server/internal/scheduler"`。在构造 Handler 处（`cmd/server` 内 `handler.New(...)` 或字段赋值处，与 `TaskService` 同处装配）赋值：

```go
	h.RequirementTrigger = scheduler.NewRequirementTriggerService(queries, taskSvc)
```

> 定位装配点：`grep -n "TaskService:" $ROOT/server/cmd/server/*.go` 找到 Handler 字面量装配处，在同处补 `RequirementTrigger:` 字段（或构造后赋值，取决于既有风格）。

在 `router.go:1910`（`r.Post("/rerun", h.RerunIssue)` 行之后）追加：

```go
					r.Post("/trigger", h.TriggerRequirement)
```

- [ ] **Step 6: 编译 + 跑测试**

Run: `cd $ROOT/server && go build ./... && go test ./internal/handler/ -run TestTriggerRequirementValidatesBody -v`
Expected: build 无输出；测试 `PASS`（非法 UUID → loadIssueForUser 返回 4xx，不 panic）。

- [ ] **Step 7: 跑 scheduler 回归**

Run: `cd $ROOT/server && go test ./internal/scheduler/ -v`
Expected: 全 `PASS`。

- [ ] **Step 8: 提交**

```bash
cd $ROOT && git add server/internal/handler/requirement_trigger.go server/internal/handler/requirement_trigger_test.go server/internal/handler/handler.go server/internal/scheduler/jobs_requirement_trigger.go server/cmd/server/router.go server/cmd/server/main.go
git commit -m "feat(api): POST /issues/{id}/trigger shares requirement trigger service"
```

---


## 实现前实证校正（直读代码/migration 得出，全文以此为准）

> 本节回应并行审计（Felix/Taylor）与 leader 的校正请求，全部经**直读源码/migration** 敲定，plan 后续任务据此描述，勿沿用旧审计口径。

1. **migration 452 给 `issue` 新增 12 列**（直读 `server/migrations/452_requirement_calendar.up.sql:7-19`，Felix 记 12 正确、13 有误）。清单：`start_at`(TIMESTAMPTZ)、`goal`(TEXT)、`repo_resource_id`(UUID→project_resource)、`decompose_mode`(TEXT NOT NULL DEFAULT 'confirm'，CHECK∈auto/confirm/manual)、`auto_trigger`(BOOLEAN NOT NULL DEFAULT true)、`decomposition_confirmed_at`(TIMESTAMPTZ)、`triggered_at`(TIMESTAMPTZ)、`acceptance_round`(INT NOT NULL **DEFAULT 0**)、`root_requirement_id`(UUID→issue)、`feature_points`(JSONB NOT NULL DEFAULT '[]')、`graph_context`(JSONB NOT NULL DEFAULT '{}')、`acceptance_spec`(JSONB NOT NULL DEFAULT '{}')。
2. **无独立 `trigger_status` 列**。直读 `requirement.sql:89-100`（生成于 `requirement.sql.go:414-424`）确认触发判定谓词为：`parent_issue_id IS NULL AND auto_trigger=TRUE AND triggered_at IS NULL AND decomposition_confirmed_at IS NOT NULL AND start_at IS NOT NULL AND start_at <= now() AND issue_effective_status(workspace_id,status) NOT IN ('done','cancelled')`。触发态由 `auto_trigger + triggered_at + decomposition_confirmed_at` **派生**（design §7.5①）。WS2 已据实描述，**无 trigger_status**。
3. **`acceptance_round` 从 0 起**（452:15 DEFAULT 0）。直读确认现有代码只读透传该列（`service/task.go:7390` 附近的 `"acceptance_round": issue.AcceptanceRound`）、**从不 +1**。WS4 负责补「verdict=fail → +1；round>3 → 验收失败终态」。
4. **ModuleLocker 现状 = 锁 key `module_id` + `avoid_conflict` 双计数**：同模块**永不互斥**、异模块「一方勾选 `avoid_conflict` 即锁」（直读 `module_locker.go:94-104` blockerLocked + `module_locker_test.go` 6 例）。`root_requirement_id` 当前仅用于归组/agent_run 上卷，**不参与锁**。这与用户诉求「同模块不同需求组串行、同组并行」不符——WS3 正解见下「共存决策」。
5. **WS5 只碰 `agent_run`/`agent_run_todo`/`agent_run_event`（migration 459，名称无误）**；不涉 457（ontology_object/link/changelog，无 embedding/vector 列）/458（filing_item/check_run/export_log）。
6. **`agent_run` 端点走原生 SQL**（`handler/agent_run.go` 的 `h.DB.QueryRow`），路由是 `POST /api/agent-runs` + `/api/agent-runs/{runId}/todos|events`（`router.go:2052-2060`），**非** sqlc、**非** `/agent/{id}/runs`。WS5 据此描述。

---

## WS3 — ModuleLocker v2（高风险，组级互斥）

**目标：** 把跨模块「避免冲突」互斥升级为**需求组级互斥**——同一 `root_requirement_id` 组内的子任务（含并行研发子任务）互不阻塞；**同模块跨组自动串行**；组到达终态即释放全组 hold 并唤醒等待队列。

### 共存决策（务必先读，回应 leader「共存 or 取代、低回归」）

直读 `module_locker.go` + `daemon.go:5734-5837` claim 闸门 + `agent.sql:1742-1749 CountRunningTasks` 后，定稿如下：

- **A. 锁维度：`avoid_conflict` 语义保留并与组级互斥共存（不取代）。** `blockerLocked` 升级为二维判定：
  - **同模块**（`h.moduleID == moduleID`）：v1 是「永不互斥」；v2 **新增组级互斥**——`root` 双方均非空且 `h.rootRequirementID != rootRequirementID` ⇒ 阻塞（跨组串行）；同组 ⇒ 并行（`continue`）。`root` 维度缺省（空串，兼容旧 server 不下发 / 非日历任务）⇒ **精确退化为 v1「同模块永不互斥」**，零回归。
  - **异模块**：完全保留 v1 的 `avoid_conflict` 语义（`exclusive || h.exclusive` ⇒ 阻塞），**不改**。
- **B. 强制点：模块互斥的唯一事实源仍是 daemon 侧内存 `ModuleLocker`（与 v1 同级保证，不新增跨 daemon 回归）。** v1 的互斥本就只在单 daemon 内生效（内存锁）；v2 沿用同一强制点，只升级 key。**不把阻塞谓词塞进 `ClaimAgentTask` 热查询**——因为 migration 452 已把所有独立 issue 的 `root_requirement_id` 回填为自身（非空），若在 claim 查询加「同模块跨组」NOT EXISTS，会让**存量所有同模块任务**从并行变串行，且被 claim 阻塞的任务停在 `queued` 而非 `waiting_module_lock`，破坏派生态序 6「等待模块释放」（`issue.sql:25-29`）。故 claim 热路径**不动**。
- **C. `CountRunningTasks`（`agent.sql:1742-1749`）不改。** 它是 agent 的 `MaxConcurrentTasks` 容量闸（`task.go:3499-3509`），**不是**模块互斥闸。`waiting_module_lock` 保持计入容量（源码注释 `agent.sql:1743-1747` 明确：移除会导致 resume 时突破 `MaxConcurrentTasks`）。root 维度通过 **A 的锁 key 升级 + 组终态 `ReleaseGroup`** 进入「闸门」，而非改这条计数 SQL——这是「精确、低回归、不盲目替换」的落点。Task 3.5 用回归测试钉死该决策（同组并行可领 + parker 仍计容量）。

> **一句话**：WS3 = 给 daemon 内存锁加 `root` 维度（同模块跨组串行、同组并行、空 root 退化 v1）+ 组终态 `ReleaseGroup` + 把 `root_requirement_id` 沿 claim 载荷透传到 daemon。**不碰** `ClaimAgentTask` / `CountRunningTasks` 两条热 SQL。

---

### Task 3.1: ModuleLocker 锁 key 升级为 (moduleID, rootRequirementID)

**Files:**
- Modify: `server/internal/daemon/module_locker.go`
- Modify: `server/internal/daemon/module_locker_test.go`（6 例调用签名 + 新增组级互斥例）

- [ ] **Step 1: 更新既有测试签名 + 写新的失败测试**

`module_locker_test.go` 全部 `l.Acquire(ctx, moduleID, moduleName, taskID, exclusive, onWait)` 调用**插入 root 参数**（位置在 moduleName 之后、taskID 之前）。既有 6 例传 `""`（验证 v1 退化零回归），例如 `TestModuleLocker_SameModuleNeverBlocks`：

```go
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "", "t1", true, nil)
	// ...
	rel2, err := l.Acquire(context.Background(), "m1", "内核", "", "t2", false, nil)
```

`TestModuleLocker_ExclusiveBlocksOtherModules` 的 onWait 断言 `blocker != "内核"` **保持不变**（异模块仍返回 moduleName）。

追加两例新测试：

```go
// v2 组级互斥：同模块 + 不同 root 组 ⇒ 串行（第二个阻塞）。
func TestModuleLocker_SameModuleDifferentRootBlocks(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "rootA", "t1", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel1()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var label string
	waited := false
	_, err = l.Acquire(ctx, "m1", "内核", "rootB", "t2", false, func(holder string) { waited = true; label = holder })
	if err == nil {
		t.Fatal("expected ctx deadline: different root group must serialize on same module")
	}
	if !waited {
		t.Fatal("onWait not fired")
	}
	if label != "需求组「rootA」" {
		t.Fatalf("onWait label = %q, want %q", label, "需求组「rootA」")
	}
}

// v2 同组并行：同模块 + 同 root 组 ⇒ 互不阻塞（即使一方勾选 avoid_conflict）。
func TestModuleLocker_SameModuleSameRootParallel(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "rootA", "t1", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel1()
	rel2, err := l.Acquire(context.Background(), "m1", "内核", "rootA", "t2", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel2()
}
```

> 注：`shortID` 对非 UUID 字符串的行为需在实现里兜底——`blockerLocked` 组级分支返回 `"需求组「" + groupLabel(h.rootRequirementID) + "」"`，其中 `groupLabel` 对合法 UUID 取 `shortID`、否则原样返回（测试传 "rootA" 非 UUID，故断言为 "rootA"）。见 Step 3。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/daemon/ -run TestModuleLocker -v`
Expected: 编译失败 `too many arguments in call to l.Acquire`（旧签名 6 参，新调用 7 参）。

- [ ] **Step 3: 升级 module_locker.go**

`moduleHold` 增 root 字段（`module_locker.go:29-33`）：

```go
type moduleHold struct {
	moduleID          string
	moduleName        string
	rootRequirementID string
	exclusive         bool
}
```

`Acquire` 签名加 `rootRequirementID`（`module_locker.go:50`），并在存 hold 时写入：

```go
func (l *ModuleLocker) Acquire(ctx context.Context, moduleID, moduleName, rootRequirementID, taskID string, exclusive bool, onWait func(holderLabel string)) (func(), error) {
	if moduleID == "" {
		return nil, errors.New("module_locker: moduleID required")
	}
	if taskID == "" {
		return nil, errors.New("module_locker: taskID required")
	}
	stop := context.AfterFunc(ctx, func() {
		l.mu.Lock()
		l.cond.Broadcast()
		l.mu.Unlock()
	})
	defer stop()

	waited := false
	for {
		l.mu.Lock()
		if err := ctx.Err(); err != nil {
			l.mu.Unlock()
			return nil, err
		}
		blocker, blocked := l.blockerLocked(moduleID, rootRequirementID, exclusive)
		if !blocked {
			l.holders[taskID] = moduleHold{moduleID: moduleID, moduleName: moduleName, rootRequirementID: rootRequirementID, exclusive: exclusive}
			l.mu.Unlock()
			var once sync.Once
			return func() { once.Do(func() { l.release(taskID) }) }, nil
		}
		if !waited {
			waited = true
			if onWait != nil {
				l.mu.Unlock()
				onWait(blocker) // 锁外：可能是一次 HTTP 上报
				continue
			}
		}
		l.cond.Wait()
		l.mu.Unlock()
	}
}
```

`blockerLocked` 升级为二维判定（`module_locker.go:92-104` 整体替换）：

```go
// blockerLocked 返回挡住本次获取的持有者标签（用于 wait_reason）。
// 规则（v2，共存决策 A）：
//   - 同模块：root 双方非空且不同组 ⇒ 阻塞（跨组串行，返回「需求组「<短id>」」）；
//     同组或 root 缺省 ⇒ 不阻塞（同组并行 / v1 退化）。
//   - 异模块：保留 v1 avoid_conflict 语义 —— 本请求排他 或 持有方排他 ⇒ 阻塞（返回模块名）。
func (l *ModuleLocker) blockerLocked(moduleID, rootRequirementID string, exclusive bool) (string, bool) {
	for _, h := range l.holders {
		if h.moduleID == moduleID {
			if rootRequirementID != "" && h.rootRequirementID != "" && h.rootRequirementID != rootRequirementID {
				return "需求组「" + groupLabel(h.rootRequirementID) + "」", true
			}
			continue
		}
		if exclusive || h.exclusive {
			return h.moduleName, true
		}
	}
	return "", false
}

// groupLabel 对合法 UUID 取短 id（复用 daemon 包 shortID），否则原样返回。
func groupLabel(rootRequirementID string) string {
	if u, err := uuid.Parse(rootRequirementID); err == nil {
		_ = u
		return shortID(rootRequirementID)
	}
	return rootRequirementID
}
```

> `shortID` 已在 daemon 包定义（`daemon.go:5854` 有用例）。`uuid.Parse` 需 import `"github.com/google/uuid"`；若 daemon 包已有等价判定，复用之（`grep -n "google/uuid" $ROOT/server/internal/daemon/*.go` 确认后再决定 import）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd $ROOT/server && go test ./internal/daemon/ -run TestModuleLocker -v`
Expected: 8 例全 `PASS`（原 6 例签名更新后行为不变 + 2 例新增组级互斥）。

- [ ] **Step 5: 提交**

```bash
cd $ROOT && git add server/internal/daemon/module_locker.go server/internal/daemon/module_locker_test.go
git commit -m "feat(daemon): ModuleLocker v2 group-level mutex on (module,root_requirement)"
```

---

### Task 3.2: `ReleaseGroup(rootRequirementID)` 组终态释放

**Files:**
- Modify: `server/internal/daemon/module_locker.go`
- Modify: `server/internal/daemon/module_locker_test.go`

- [ ] **Step 1: 写失败测试**

追加到 `module_locker_test.go`：

```go
// ReleaseGroup 释放某 root 组的全部 hold 并唤醒等待者（design §7.3 终态即释放）。
func TestModuleLocker_ReleaseGroupFreesWaiters(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "rootA", "t1", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = rel1 // 故意不单独释放，靠 ReleaseGroup 批量回收
	// 同模块另一组第二个任务：也持有 rootA（同组），应一并被 ReleaseGroup 回收
	rel2, err := l.Acquire(context.Background(), "m1", "内核", "rootA", "t2", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = rel2

	acquired := make(chan struct{})
	go func() {
		rel3, err := l.Acquire(context.Background(), "m1", "内核", "rootB", "t3", false, nil)
		if err == nil {
			rel3()
			close(acquired)
		}
	}()
	select {
	case <-acquired:
		t.Fatal("rootB acquired while rootA still holds the module")
	case <-time.After(50 * time.Millisecond):
	}

	l.ReleaseGroup(context.Background(), "rootA")
	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("rootB not released after ReleaseGroup(rootA)")
	}
}

// ReleaseGroup 幂等 + 对空 root / 不存在的 root 无副作用。
func TestModuleLocker_ReleaseGroupIdempotent(t *testing.T) {
	l := NewModuleLocker()
	l.ReleaseGroup(context.Background(), "rootMissing") // 不 panic
	l.ReleaseGroup(context.Background(), "")            // 空 root 不 panic、不误删
	rel, err := l.Acquire(context.Background(), "m1", "内核", "rootA", "t1", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	rel()
	l.ReleaseGroup(context.Background(), "rootA") // 已空，幂等
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/daemon/ -run TestModuleLocker_ReleaseGroup -v`
Expected: 编译失败 `l.ReleaseGroup undefined (type *ModuleLocker has no field or method ReleaseGroup)`。

- [ ] **Step 3: 实现 ReleaseGroup**

在 `module_locker.go` 的 `release`（L106-111）之后追加：

```go
// ReleaseGroup 释放某 root 需求组在本 daemon 上的全部 hold，并 Broadcast 唤醒
// 等待队列（design §7.3：root 到达终态 → 释放全组 → server 侧等待任务按 start_at
// 升序被唤醒）。空 rootRequirementID 直接 no-op（不误删无组任务）。幂等：对已无
// hold 的组重复调用无副作用。
func (l *ModuleLocker) ReleaseGroup(_ context.Context, rootRequirementID string) {
	if rootRequirementID == "" {
		return
	}
	l.mu.Lock()
	changed := false
	for taskID, h := range l.holders {
		if h.rootRequirementID == rootRequirementID {
			delete(l.holders, taskID)
			changed = true
		}
	}
	if changed {
		l.cond.Broadcast()
	}
	l.mu.Unlock()
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd $ROOT/server && go test ./internal/daemon/ -run TestModuleLocker -v`
Expected: 10 例全 `PASS`。

- [ ] **Step 5: 提交**

```bash
cd $ROOT && git add server/internal/daemon/module_locker.go server/internal/daemon/module_locker_test.go
git commit -m "feat(daemon): ModuleLocker.ReleaseGroup for requirement-group terminal release"
```

---

### Task 3.3: 沿 claim 载荷透传 `root_requirement_id`（SQL→wire→daemon Task）

**Files:**
- Modify: `server/pkg/db/queries/module.sql:29-34`（`GetIssueModuleInfo` 增列）
- Modify: `server/internal/handler/agent.go:342-460`（`AgentTaskResponse` 增字段）
- Modify: `server/internal/handler/daemon.go:2329-2337`（claim 投影赋值）
- Modify: `server/internal/daemon/types.go:79-83`（Task 增字段）

- [ ] **Step 1: 扩展 GetIssueModuleInfo**

`module.sql:29-34` 替换为（增 `i.root_requirement_id`）：

```sql
-- name: GetIssueModuleInfo :one
-- claim 投影：模块 id/名称 + 避免冲突标志 + 任务组 root（ModuleLocker v2 组级互斥）。
-- 无模块时 module_id/module_name 为 NULL；root_requirement_id 由 452 回填恒非空。
SELECT i.module_id, i.avoid_conflict, i.root_requirement_id, m.name AS module_name
FROM issue i
LEFT JOIN project_module m ON m.id = i.module_id
WHERE i.id = $1;
```

- [ ] **Step 2: 重生成 sqlc**

Run: `cd $ROOT/server && go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate`
Expected: 无报错。核对 `grep -n "RootRequirementID" $ROOT/server/pkg/db/generated/module.sql.go`（`GetIssueModuleInfoRow` 应新增 `RootRequirementID pgtype.UUID`）。

- [ ] **Step 3: AgentTaskResponse 增 wire 字段**

`handler/agent.go` 的 `AgentTaskResponse`（`ModuleID`/`ModuleName`/`AvoidConflict` 附近，~L352-354）追加：

```go
	RootRequirementID string `json:"root_requirement_id,omitempty"`
```

- [ ] **Step 4: claim 投影赋值**

`handler/daemon.go:2333-2337` 的 `else if info.ModuleID.Valid { ... }` 块内追加一行（与 ModuleID 同源，故 root 也在有模块时透传；无模块任务 daemon 不取锁，root 空即可）：

```go
		} else if info.ModuleID.Valid {
			resp.ModuleID = uuidToString(info.ModuleID)
			resp.ModuleName = info.ModuleName.String
			resp.AvoidConflict = info.AvoidConflict
			resp.RootRequirementID = uuidToString(info.RootRequirementID)
		}
```

- [ ] **Step 5: daemon Task 增字段**

`daemon/types.go:80-82`（`ModuleID`/`ModuleName`/`AvoidConflict` 之后）追加：

```go
	// root_requirement_id：ModuleLocker v2 组级互斥维度。omitempty 兼容旧 server
	// 不下发（空 = 无组，blockerLocked 退化为 v1 同模块永不互斥）。
	RootRequirementID string `json:"root_requirement_id,omitempty"`
```

- [ ] **Step 6: 编译**

Run: `cd $ROOT/server && go build ./...`
Expected: 无输出（成功）。

- [ ] **Step 7: 提交**

```bash
cd $ROOT && git add server/pkg/db/queries/module.sql server/pkg/db/generated/module.sql.go server/internal/handler/agent.go server/internal/handler/daemon.go server/internal/daemon/types.go
git commit -m "feat(claim): thread root_requirement_id through claim payload to daemon"
```

---

### Task 3.4: daemon claim 闸门传入 root 维度 + wait_reason 文案

**Files:**
- Modify: `server/internal/daemon/daemon.go:5769-5805`

- [ ] **Step 1: onWait 文案改「held by 需求组」+ Acquire 传 root**

`daemon.go:5769` 的 onWait 闭包：形参 `holderModule` 改名 `holderLabel`，reason 拼接改为 `(held by %s)`（blockerLocked 已返回带「模块「」/「需求组「」」前缀的完整标签，避免二次包裹）：

```go
	onWait := func(holderLabel string) {
		d.resourceWaitTasks.Add(1)
		waitCounted = true
		reason := fmt.Sprintf("模块「%s」", task.ModuleName)
		if holderLabel != "" {
			reason = fmt.Sprintf("%s (held by %s)", reason, holderLabel)
		}
		taskLog.Info("module lock: waiting", "module", task.ModuleName, "holder", holderLabel)
		if waitErr := d.client.MarkTaskWaitingModuleLock(ctx, task.ID, reason); waitErr != nil {
			taskLog.Warn("module lock: mark waiting status failed", "error", waitErr)
		}
		prepareLeaseOnce.Do(func() {
			stopPrepareLease = d.startTaskPrepareLeaseExtender(waitCtx, task, taskLog)
		})
		watcherOnce.Do(func() {
			cancelledByPoll = d.watchTaskCancellation(waitCtx, task.ID, pollInterval, taskLog)
			go func() {
				select {
				case <-cancelledByPoll:
					waitCancel()
				case <-waitCtx.Done():
				}
			}()
		})
	}
```

`daemon.go:5805` 的 Acquire 调用插入 `task.RootRequirementID`（在 `task.ModuleName` 之后、`task.ID` 之前）：

```go
	releaseFn, err := d.moduleLocks.Acquire(waitCtx, task.ModuleID, task.ModuleName, task.RootRequirementID, task.ID, task.AvoidConflict, onWait)
```

- [ ] **Step 2: 编译**

Run: `cd $ROOT/server && go build ./...`
Expected: 无输出（成功）。若报其它 `Acquire(` 调用点参数不符，用 `grep -rn "moduleLocks.Acquire(" $ROOT/server/internal/daemon/` 找全并同步补 root 参数（应仅此一处生产调用）。

- [ ] **Step 3: 跑 daemon 集成测试确认无回归**

Run: `cd $ROOT/server && go test ./internal/daemon/ -run 'TestModuleLock|TestTaskWaitsOnModuleLock' -v`
Expected: 全 `PASS`（`module_lock_integration_test.go` 6 例 + locker 10 例）。若集成测试内构造 Task 未设 `RootRequirementID`，其行为等同空 root（v1 退化），断言不变即应通过。

- [ ] **Step 4: 提交**

```bash
cd $ROOT && git add server/internal/daemon/daemon.go
git commit -m "feat(daemon): pass root_requirement_id into module lock acquire + group wait_reason"
```

---

### Task 3.5: root 维度并发闸门——决策固化 + 回归测试（不改 CountRunningTasks）

**Files:**
- Reference（勿改）: `server/pkg/db/queries/agent.sql:1742-1749`（CountRunningTasks）、`server/internal/service/task.go:3499-3509`（容量闸）
- Test: `server/internal/service/task_claim_group_test.go`（新建；若已有 claim 测试文件则追加）

- [ ] **Step 1: 写回归测试（钉死共存决策 C）**

新建 `server/internal/service/task_claim_group_test.go`（DB 集成测试，沿用 `service` 包既有测试的 DB fixture 风格——先 `grep -rln "func TestMain" $ROOT/server/internal/service/` 找到测试入口/setup 复用）：

```go
package service

import (
	"context"
	"testing"
)

// TestCountRunningTasksIncludesModuleLockWaiters 钉死共存决策 C：
// waiting_module_lock 的任务仍计入 agent 容量闸（CountRunningTasks），
// 保证 resume 时不突破 MaxConcurrentTasks（agent.sql:1743-1747 rationale）。
// 组级互斥由 daemon ModuleLocker 强制，不改这条计数 SQL。
func TestCountRunningTasksIncludesModuleLockWaiters(t *testing.T) {
	// 用既有 fixture 建一个 agent + 一个 waiting_module_lock 任务，
	// 断言 CountRunningTasks(agentID) >= 1。
	ctx := context.Background()
	// ... 复用本包 DB 测试 helper 建 agent/task（见同目录既有 _test.go 的 setup）...
	_ = ctx
	t.Skip("wired in Step 2 against the package DB fixture")
}
```

> 说明：`service` 包的 claim 测试依赖 DB fixture。Step 1 先落一个可编译的骨架 + 明确断言意图；Step 2 用同目录既有 `_test.go` 的建 agent/task helper 填充（**填充时用真实 helper，不留 Skip**——Skip 仅为 Step 1 编译占位，Step 2 必删）。

- [ ] **Step 2: 用真实 fixture 填充并删除 Skip**

Run: `grep -rln "MaxConcurrentTasks\|CountRunningTasks\|agent_task_queue" $ROOT/server/internal/service/*_test.go` 定位既有建 agent + 入队任务的 helper，照其模式把 Step 1 骨架填成：建 1 个 agent（`MaxConcurrentTasks=1`）→ 入队 1 个任务并置 `waiting_module_lock` → 断言 `CountRunningTasks` 返回 1（容量已满，claim 闸拒绝再领）。删除 `t.Skip`。

- [ ] **Step 3: 跑测试**

Run: `cd $ROOT/server && go test ./internal/service/ -run TestCountRunningTasksIncludesModuleLockWaiters -v`
Expected: `PASS`（`CountRunningTasks` 未改，parker 计入容量 = 1）。

- [ ] **Step 4: 提交**

```bash
cd $ROOT && git add server/internal/service/task_claim_group_test.go
git commit -m "test(service): pin CountRunningTasks capacity gate unchanged under group mutex"
```

---

### Task 3.6: 组终态调 ReleaseGroup（daemon 侧联动）

**Files:**
- Modify: `server/internal/daemon/daemon.go`（任务终态上报/取消清理路径）

- [ ] **Step 1: 定位终态清理点**

Run: `grep -n "reportTerminalTask\|func (d \*Daemon) release\|releaseFn\|ReleaseGroup" $ROOT/server/internal/daemon/daemon.go | head -40`
Expected: 找到 `acquireModuleLockIfNeeded` 返回的 `release func()` 的调用方（任务结束时 `defer release()` 或显式调用处）与 `reportTerminalTask` 定义。

- [ ] **Step 2: 在 root 需求任务终态处调 ReleaseGroup**

在 daemon 处理任务终态（completed/failed/cancelled）的清理路径中，**除既有 per-task `release()` 外**，当终态任务本身是 root 需求（`task.RootRequirementID != "" && task.IssueID == task.RootRequirementID`，即顶层需求任务）时，追加组级批量释放（幂等、best-effort）：

```go
	// design §7.3：root 需求到达终态 → 释放该组全部 hold + 唤醒该模块等待队列。
	// per-task release 已回收本任务 hold；此处批量回收同组可能残留的 hold
	// （如级联取消时尚未各自 release 的兄弟子任务），ReleaseGroup 幂等安全。
	if task.RootRequirementID != "" && task.IssueID == task.RootRequirementID {
		d.moduleLocks.ReleaseGroup(ctx, task.RootRequirementID)
	}
```

> 落点：紧跟该任务既有 `release()`（模块锁释放）调用之后、`reportTerminalTask` 成功分支内。若 daemon 的取消级联有独立入口（如 `watchTaskCancellation` 收到 root 取消），在该入口同样调用 `ReleaseGroup(task.RootRequirementID)`。

- [ ] **Step 3: 编译 + 回归**

Run: `cd $ROOT/server && go build ./... && go test ./internal/daemon/ -run TestModuleLock -v`
Expected: build 无输出；测试全 `PASS`。

- [ ] **Step 4: 提交**

```bash
cd $ROOT && git add server/internal/daemon/daemon.go
git commit -m "feat(daemon): release whole requirement group lock on root terminal"
```

---

### WS3 收尾验证

- [ ] `cd $ROOT/server && go build ./...` → 无输出。
- [ ] `cd $ROOT/server && go test ./internal/daemon/ -race -run 'TestModuleLock|TestTaskWaits'` → 全 `PASS`。
- [ ] 人工核对共存决策：`grep -n "ClaimAgentTask\|CountRunningTasks" $ROOT/server/pkg/db/queries/agent.sql` 两条 SQL **未被本 WS 修改**（`git diff --stat` 不含 agent.sql）。

---


## WS4 — 验收闭环（acceptance verdict loop）

**目标**：补齐「验收 → 通过/打回 → 修复 → 重验收」的闭环。stage4 tester 完成验收后调用
`POST /api/issues/{id}/acceptance/verdict` 上报裁决；`pass` 让需求（root）落 `done`（触发 WS3
的组锁释放）；`fail` 让 `acceptance_round + 1` 并新建一个 stage3 修复子任务重新入队；累计
`acceptance_round > 3` 判「验收失败」终态并发人工仲裁通知。同时修正派生投影的第 10 态与规则 6，
并修正 `issue_child_done.go` 的 stage barrier，使 stage3 全部终态时**直接入队 stage4 tester**
（现状只唤醒父需求 PM，无人入队 tester，验收永远不会启动）。

**依赖**：WS2（`EnqueueTaskForIssue` 触发入队能力、root 维度）、WS3（root 终态释放组锁）。
**必须在 WS2、WS3 之后进行。**

### WS4 现状实证（撰写前已直读确认，实现时以真实代码为准）

| 事项 | 真实结论（直读出处） |
| --- | --- |
| `acceptance_round` 默认值 | **DEFAULT 0**（`migrations/452_requirement_calendar.up.sql:15` `acceptance_round INT NOT NULL DEFAULT 0`）。轮次从 0 起，每次 `fail` +1，`> 3` 判验收失败终态。 |
| 现有代码是否 +1 | **否**。全仓 `grep -rn "acceptance_round" $ROOT/server` 只在 `issue.sql:15`（SELECT 透传）与 generated model 出现，从无 `+ 1` 写入 —— 这正是 WS4 要补的。 |
| stage4 tester 创建 | `ConfirmDecomposition`（`service/requirement_decompose.go:266-288`）把 stage3 **与 stage4** 子任务一并建为 `status='todo'`、`stage=3/4`；stage4 assignee = 班底第一个 enabled `tester`，缺省回落 `pm`（`:207-222`）。 |
| stage4 是否被入队 | **否**。`todo` 子任务不会自动进 `agent_task_queue`；只有 `EnqueueTaskForIssue` 才建队列行。现状 stage3 barrier 关闭时 `postChildDoneComment`（`issue_child_done.go:272-351`）只发系统评论 + `dispatchParentAssigneeTrigger` 唤醒**父需求 assignee（PM）**，从不入队 stage4 tester → 验收永远不启动。这是 Task 4.5 的修正点。 |
| barrier 关闭判定 | `stageBarrierClosed`（`issue_child_done.go:404-428`）：staged 集合下，completed 的 stage=S，所有 `stage <= S` 的子任务终态才 closed。stage3 全终态 → closedStage=3。 |
| `EnqueueTaskForIssue` 语义 | `service/task.go:1093` → `enqueueIssueTask`（`:1213`）：**不去重**，无条件建队列行；要求 `issue.AssigneeID.Valid` 且 assignee 是未归档、有 runtime 的 agent，否则返回 error（`:1218-1235`）。因此入队前须自行做 `HasPendingTaskForIssueAndAgent` 幂等保护（模式见 `issue_child_done.go:655-663`）。 |
| `UpdateIssueStatus` | `issue.sql:336-357` `:one RETURNING *`；签名 `UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{ID, Status, WorkspaceID}) (db.Issue, error)`。 |
| verdict 路由挂载点 | `server/cmd/server/router.go`，`r.Route("/{id}")` 块内 `r.Post("/decomposition/confirm", ...)`（`:1893`）之后。 |
| handler 端点测试骨架 | `newRequest(method, path, body)`（`handler_test.go:189`，自动置 `X-User-ID=testUserID`/`X-Workspace-ID=testWorkspaceID`）+ `withURLParam(req, "id", issueID)`（`:201`）+ `testutil.Call(t, testHandler.Xxx, req).Want(code)`（`testutil/http.go:93/103`）+ `.JSON(&dest)`（`:128`）/`.Map()`（`:139`）。 |
| 投影测试骨架 | `requirement_status_projection_test.go`：`dbfx.QueryRow(t, ...)`/`dbfx.Exec(t, ...)`、helper `newProject`/`newRequirement`/`newStageChild`/`markWaitingModuleLock`/`projectStatus`，断言 `db.ListIssuesRow.RequirementStatus`/`.StageProgress`。 |

**新建/修改文件（WS4）**：
- 修改 `server/pkg/db/queries/issue.sql`（CASE 增补第 10 态 + 修正规则 6）
- 修改 `server/pkg/db/queries/requirement.sql`（新增 `IncrementAcceptanceRound`）
- 重生成 `server/pkg/db/generated/*.go`（`make sqlc`）
- 新建 `server/internal/handler/requirement_acceptance.go`（verdict handler + 修复子任务 + 仲裁通知）
- 修改 `server/cmd/server/router.go`（挂载 verdict 路由）
- 修改 `server/internal/handler/issue_child_done.go`（barrier 关闭时入队 stage4 tester）
- 新建 `server/internal/handler/requirement_acceptance_test.go`（端点测试）
- 修改 `server/internal/handler/requirement_status_projection_test.go`（第 10 态 + 规则 6 修正用例）

---

### Task 4.1: 派生投影增补第 10 态「验收失败」+ 修正规则 6 + `IncrementAcceptanceRound`

**Files:**
- Modify: `server/pkg/db/queries/issue.sql:18-33`（ListIssues 的 requirement_status CASE）
- Modify: `server/pkg/db/queries/requirement.sql`（文件末尾追加 `IncrementAcceptanceRound`）
- Modify: `server/internal/handler/requirement_status_projection_test.go`（新增 2 个子测试 + `markRunning` helper）
- Regenerate: `server/pkg/db/generated/`（`make sqlc`）

- [ ] **Step 1: 先写失败测试（第 10 态 + 规则 6 修正）**

在 `requirement_status_projection_test.go` 的 `markWaitingModuleLock` helper（`:66-75`）之后，新增一个 `markRunning` helper（插入一条 `running` 队列行，用于验证「有 stage3 正在跑时不算等待模块释放」）：

```go
	markRunning := func(t *testing.T, issueID string) {
		t.Helper()
		var agentID string
		dbfx.QueryRow(t, `SELECT id FROM agent WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1`,
			testWorkspaceID).Scan(&agentID)
		dbfx.Exec(t, `
			INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority)
			VALUES ($1, $2, $3, 'running', 5)`,
			agentID, testRuntimeID, issueID)
	}
```

在最后一个子测试 `规则9 全部终态→已完成（兜底）`（`:198-207`）之后、函数收尾 `}`（`:208`）之前，追加三个子测试：

```go
	t.Run("规则10 acceptance_round>3→验收失败", func(t *testing.T) {
		proj := newProject(t, "accfail")
		reqID := newRequirement(t, proj, "todo", true, true)
		newStageChild(t, proj, reqID, 3, "done")
		newStageChild(t, proj, reqID, 4, "done")
		// 4 轮打回后仍未过：acceptance_round 累加到 4（>3）判验收失败终态。
		dbfx.Exec(t, `UPDATE issue SET acceptance_round = 4 WHERE id = $1`, reqID)
		row := projectStatus(t, proj)
		if row.RequirementStatus != "验收失败" {
			t.Errorf("requirement_status = %q, want 验收失败", row.RequirementStatus)
		}
	})

	t.Run("规则10 acceptance_round=3 未越界→不判验收失败", func(t *testing.T) {
		proj := newProject(t, "acc3")
		reqID := newRequirement(t, proj, "todo", true, true)
		newStageChild(t, proj, reqID, 3, "todo")
		dbfx.Exec(t, `UPDATE issue SET acceptance_round = 3 WHERE id = $1`, reqID)
		row := projectStatus(t, proj)
		if row.RequirementStatus != "执行中" {
			t.Errorf("requirement_status = %q, want 执行中（round=3 仍在修复）", row.RequirementStatus)
		}
	})

	t.Run("规则6修正 有stage3正在跑→执行中而非等待模块释放", func(t *testing.T) {
		proj := newProject(t, "waitlock-running")
		reqID := newRequirement(t, proj, "todo", true, true)
		running := newStageChild(t, proj, reqID, 3, "in_progress")
		waiting := newStageChild(t, proj, reqID, 3, "in_progress")
		markRunning(t, running)        // 有一个 stage3 正在跑：需求仍在推进
		markWaitingModuleLock(t, waiting) // 另一个在等锁：不应盖过「执行中」
		row := projectStatus(t, proj)
		if row.RequirementStatus != "执行中" {
			t.Errorf("requirement_status = %q, want 执行中（父状态优先于子计数）", row.RequirementStatus)
		}
	})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/handler/ -run 'TestRequirementStatusProjection/规则10|TestRequirementStatusProjection/规则6修正' -v`
Expected: FAIL —— `规则10` 两个用例得到 `已完成`/`执行中` 而非 `验收失败`；`规则6修正` 得到 `等待模块释放` 而非 `执行中`（编译先失败于 `IncrementAcceptanceRound` 尚未生成时可跳过本步，直接进 Step 3；投影 CASE 未改时这三条断言必挂）。

- [ ] **Step 3: 改 `issue.sql` 的 requirement_status CASE**

把 `issue.sql:18-33` 的 CASE 整体替换为下面版本（新增 `WHEN i.acceptance_round > 3 THEN '验收失败'`，置于 `已取消` 之后、`原型待确认` 之前——它是终态派生，优先于所有阶段态；并给规则 6 加「无 stage3 正在跑」守卫）：

```sql
       CASE
           WHEN issue_effective_status(i.workspace_id, i.status) = 'done' THEN '已完成'
           WHEN issue_effective_status(i.workspace_id, i.status) = 'cancelled' THEN '已取消'
           -- 第 10 态（spec §6 增补 / 开放问题 #4）：累计 4 轮打回仍未过 = 验收失败终态。
           -- 置于阶段态之前：一旦越界即终态，不再被残留的 open 子任务翻回「执行中/验收中」。
           WHEN i.acceptance_round > 3 THEN '验收失败'
           WHEN COALESCE(prog.has_open_stage1, FALSE) THEN '原型待确认'
           WHEN i.decomposition_confirmed_at IS NULL AND COALESCE(prog.has_stage2, FALSE) THEN '拆解待确认'
           WHEN i.decomposition_confirmed_at IS NULL THEN '未拆解'
           WHEN i.triggered_at IS NULL THEN '待触发'
           -- 规则 6 修正（父状态优先于子计数）：仅当没有任何 stage3 子任务正在推进
           -- （dispatched/running）且确有子任务在等模块锁时，才判「等待模块释放」；
           -- 否则只要还有 stage3 在跑就是「执行中」，等锁只是局部阻塞不代表整体停摆。
           WHEN NOT EXISTS (
               SELECT 1 FROM issue rc
               JOIN agent_task_queue rq ON rq.issue_id = rc.id
               WHERE rc.parent_issue_id = i.id AND rq.status IN ('dispatched', 'running')
           ) AND EXISTS (
               SELECT 1 FROM issue wc
               JOIN agent_task_queue wq ON wq.issue_id = wc.id
               WHERE wc.parent_issue_id = i.id AND wq.status = 'waiting_module_lock'
           ) THEN '等待模块释放'
           WHEN COALESCE(prog.has_open_stage3, FALSE) THEN '执行中'
           WHEN COALESCE(prog.has_open_stage4, FALSE) THEN '验收中'
           ELSE '已完成'
       END AS requirement_status,
```

- [ ] **Step 4: 在 `requirement.sql` 末尾追加 `IncrementAcceptanceRound`**

在 `requirement.sql` 文件末尾（`HasWaitingModuleLockDescendant` 之后，`:127`）追加：

```sql

-- name: IncrementAcceptanceRound :one
-- 验收打回：acceptance_round + 1 并返回新值（DEFAULT 0，见 migration 452:15）。
-- 调用方据返回值判「> 3 = 验收失败终态」。updated_at 同步刷新以驱动列表重排。
UPDATE issue
SET acceptance_round = acceptance_round + 1, updated_at = now()
WHERE id = $1
RETURNING acceptance_round;
```

- [ ] **Step 5: 重新生成 sqlc**

Run: `cd $ROOT && make sqlc`
Expected: 无错误；`git diff --stat server/pkg/db/generated/` 显示 `issue.sql.go`（ListIssuesRow 不变，CASE 是表达式）与 `requirement.sql.go`（新增 `IncrementAcceptanceRound` 方法）变更。

- [ ] **Step 6: 确认生成签名**

Run: `cd $ROOT/server && grep -n "func (q \*Queries) IncrementAcceptanceRound" pkg/db/generated/requirement.sql.go`
Expected: 输出形如 `func (q *Queries) IncrementAcceptanceRound(ctx context.Context, id pgtype.UUID) (int32, error) {`（返回 `int32` = 新的 acceptance_round）。

- [ ] **Step 7: 跑测试确认通过**

Run: `cd $ROOT/server && go test ./internal/handler/ -run TestRequirementStatusProjection -v`
Expected: PASS —— 原 9 个子测试 + 新增 3 个（`规则10 acceptance_round>3`、`规则10 acceptance_round=3 未越界`、`规则6修正`）全绿。

- [ ] **Step 8: 提交**

```bash
cd $ROOT && git add server/pkg/db/queries/issue.sql server/pkg/db/queries/requirement.sql server/pkg/db/generated/ server/internal/handler/requirement_status_projection_test.go
git commit -m "feat(requirement): add 验收失败 derived state, fix rule-6 priority, add IncrementAcceptanceRound"
```

---

### Task 4.2: `POST /issues/{id}/acceptance/verdict` handler 骨架 + `pass` 分支

**Files:**
- Create: `server/internal/handler/requirement_acceptance.go`
- Modify: `server/cmd/server/router.go:1893`（追加路由）
- Test: `server/internal/handler/requirement_acceptance_test.go`

- [ ] **Step 1: 先写失败测试（pass 让需求落 done）**

新建 `server/internal/handler/requirement_acceptance_test.go`：

```go
package handler

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

// 验收裁决闭环（spec §8 / WS4）：pass→需求 done；fail→round+1 建修复子任务；round>3→验收失败终态。
// 每个用例独立 project 隔离 fixture，直接调 handler 并断言 DB 事实。
func newAcceptanceProject(t *testing.T, name string) string {
	t.Helper()
	var id string
	dbfx.QueryRow(t, `INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id`,
		testWorkspaceID, "acc-"+name).Scan(&id)
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE project_id = $1)`, id)
		testPool.Exec(context.Background(), `DELETE FROM issue WHERE project_id = $1`, id)
		testPool.Exec(context.Background(), `DELETE FROM project WHERE id = $1`, id)
	})
	return id
}

// newAcceptanceRequirement 建一个已确认、已触发的顶层需求（stage 子任务由用例按需补）。
func newAcceptanceRequirement(t *testing.T, projectID string) string {
	t.Helper()
	var id string
	dbfx.QueryRow(t, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number, project_id,
		                   decomposition_confirmed_at, triggered_at)
		VALUES ($1, '需求-验收', 'todo', 'medium', 'member', $2,
		        (SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE workspace_id = $1), $3, now(), now())
		RETURNING id`,
		testWorkspaceID, testUserID, projectID).Scan(&id)
	return id
}

func issueStatus(t *testing.T, issueID string) string {
	t.Helper()
	var status string
	idUUID, err := util.ParseUUID(issueID)
	if err != nil {
		t.Fatalf("parse issue id: %v", err)
	}
	row, err := testHandler.Queries.GetIssue(context.Background(), idUUID)
	if err != nil {
		t.Fatalf("GetIssue: %v", err)
	}
	status = row.Status
	return status
}

func TestAcceptanceVerdictPassMarksRequirementDone(t *testing.T) {
	proj := newAcceptanceProject(t, "pass")
	reqID := newAcceptanceRequirement(t, proj)

	req := newRequest(http.MethodPost, "/api/issues/"+reqID+"/acceptance/verdict",
		map[string]any{"verdict": "pass", "evidence": "全部验收点通过"})
	req = withURLParam(req, "id", reqID)
	testutil.Call(t, testHandler.RecordAcceptanceVerdict, req).Want(http.StatusOK)

	if got := issueStatus(t, reqID); got != "done" {
		t.Errorf("requirement status = %q, want done", got)
	}
}

func TestAcceptanceVerdictRejectsBadVerdict(t *testing.T) {
	proj := newAcceptanceProject(t, "bad")
	reqID := newAcceptanceRequirement(t, proj)

	req := newRequest(http.MethodPost, "/api/issues/"+reqID+"/acceptance/verdict",
		map[string]any{"verdict": "maybe"})
	req = withURLParam(req, "id", reqID)
	testutil.Call(t, testHandler.RecordAcceptanceVerdict, req).Want(http.StatusBadRequest)
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/handler/ -run TestAcceptanceVerdict -v`
Expected: 编译失败 —— `testHandler.RecordAcceptanceVerdict undefined`。

- [ ] **Step 3: 写 handler 骨架 + pass 分支**

新建 `server/internal/handler/requirement_acceptance.go`：

```go
package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// recordAcceptanceVerdictRequest 是 stage4 tester 上报验收裁决的 body。
// verdict: "pass"（验收通过）| "fail"（打回修复）；evidence: 裁决依据/缺陷说明。
type recordAcceptanceVerdictRequest struct {
	Verdict  string `json:"verdict"`
	Evidence string `json:"evidence"`
}

// RecordAcceptanceVerdict 处理 POST /api/issues/{id}/acceptance/verdict（spec §8 / WS4）。
// {id} 为需求（root）本身。pass → 需求落 done（WS3 的 root 终态钩子随后释放组锁）；
// fail → acceptance_round + 1，未越界则建 stage3 修复子任务并入队，越界（>3）则发人工仲裁通知。
func (h *Handler) RecordAcceptanceVerdict(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var body recordAcceptanceVerdictRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ctx := r.Context()

	switch body.Verdict {
	case "pass":
		updated, err := h.Queries.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{
			ID:          issue.ID,
			Status:      "done",
			WorkspaceID: issue.WorkspaceID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to mark requirement done: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"verdict":          "pass",
			"acceptance_round": updated.AcceptanceRound,
			"terminal":         true,
		})
	case "fail":
		// Task 4.3 实现。
		writeError(w, http.StatusInternalServerError, "fail verdict not implemented")
	default:
		writeError(w, http.StatusBadRequest, "verdict must be pass or fail")
	}
}
```

- [ ] **Step 4: 挂载路由**

在 `server/cmd/server/router.go:1893`（`r.Post("/decomposition/confirm", h.ConfirmDecomposition)`）之后插入一行：

```go
					r.Post("/acceptance/verdict", h.RecordAcceptanceVerdict)
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd $ROOT/server && go build ./... && go test ./internal/handler/ -run TestAcceptanceVerdict -v`
Expected: build 无输出；`TestAcceptanceVerdictPassMarksRequirementDone` PASS、`TestAcceptanceVerdictRejectsBadVerdict` PASS。

- [ ] **Step 6: 提交**

```bash
cd $ROOT && git add server/internal/handler/requirement_acceptance.go server/cmd/server/router.go server/internal/handler/requirement_acceptance_test.go
git commit -m "feat(requirement): add acceptance verdict endpoint with pass branch"
```

---

### Task 4.3: `fail` 分支 —— round + 1 + 新建 stage3 修复子任务 + 入队

**Files:**
- Modify: `server/internal/handler/requirement_acceptance.go`（替换 `case "fail"` 占位）
- Test: `server/internal/handler/requirement_acceptance_test.go`（新增 fail 用例）

- [ ] **Step 1: 先写失败测试（fail 让 round+1 并建 stage3 修复子任务 + 入队）**

在 `requirement_acceptance_test.go` 末尾追加：

```go
func TestAcceptanceVerdictFailIncrementsRoundAndCreatesRepairTask(t *testing.T) {
	proj := newAcceptanceProject(t, "fail")
	reqID := newAcceptanceRequirement(t, proj)
	// 需求归属一个有 runtime 的 agent，修复子任务继承该 assignee 才能入队。
	var agentID string
	dbfx.QueryRow(t, `SELECT id FROM agent WHERE workspace_id = $1 AND runtime_id IS NOT NULL
	                  ORDER BY created_at ASC LIMIT 1`, testWorkspaceID).Scan(&agentID)
	dbfx.Exec(t, `UPDATE issue SET assignee_type = 'agent', assignee_id = $1 WHERE id = $2`, agentID, reqID)

	req := newRequest(http.MethodPost, "/api/issues/"+reqID+"/acceptance/verdict",
		map[string]any{"verdict": "fail", "evidence": "登录态在刷新后丢失"})
	req = withURLParam(req, "id", reqID)
	resp := testutil.Call(t, testHandler.RecordAcceptanceVerdict, req).Want(http.StatusOK)
	body := resp.Map()
	if body["acceptance_round"].(float64) != 1 {
		t.Errorf("acceptance_round = %v, want 1", body["acceptance_round"])
	}

	// 事实核验：需求 round=1、多了一个 stage3 修复子任务、该子任务已入队。
	var round int
	dbfx.QueryRow(t, `SELECT acceptance_round FROM issue WHERE id = $1`, reqID).Scan(&round)
	if round != 1 {
		t.Errorf("db acceptance_round = %d, want 1", round)
	}
	var repairCount, queuedCount int
	dbfx.QueryRow(t, `SELECT count(*) FROM issue WHERE parent_issue_id = $1 AND stage = 3`, reqID).Scan(&repairCount)
	if repairCount != 1 {
		t.Errorf("stage3 repair children = %d, want 1", repairCount)
	}
	dbfx.QueryRow(t, `
		SELECT count(*) FROM agent_task_queue q
		JOIN issue c ON c.id = q.issue_id
		WHERE c.parent_issue_id = $1 AND c.stage = 3`, reqID).Scan(&queuedCount)
	if queuedCount != 1 {
		t.Errorf("repair task queue rows = %d, want 1", queuedCount)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/handler/ -run TestAcceptanceVerdictFailIncrementsRoundAndCreatesRepairTask -v`
Expected: FAIL —— 500 `fail verdict not implemented`。

- [ ] **Step 3: 实现 fail 分支**

把 `requirement_acceptance.go` 中的 `case "fail":` 占位块替换为：

```go
	case "fail":
		newRound, err := h.Queries.IncrementAcceptanceRound(ctx, issue.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to increment acceptance_round: "+err.Error())
			return
		}
		// Task 4.4 补越界终态；本轮先按「未越界 → 建修复子任务」实现。
		repair, err := h.createAcceptanceRepairTask(ctx, issue, newRound, body.Evidence)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to create repair task: "+err.Error())
			return
		}
		// 入队 best-effort：assignee 无 runtime / 已归档时 EnqueueTaskForIssue 返回 error，
		// 记录但不回滚 round 与修复子任务（子任务已建，后续可人工重派）。
		if _, err := h.TaskService.EnqueueTaskForIssue(ctx, repair); err != nil {
			slog.Warn("acceptance fail: enqueue repair task failed",
				"error", err, "repair_id", uuidToString(repair.ID))
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"verdict":           "fail",
			"acceptance_round":    newRound,
			"terminal":            false,
			"repair_issue_id":     uuidToString(repair.ID),
		})
```

并在文件末尾追加 `createAcceptanceRepairTask`（镜像 `service/requirement_decompose.go:266-288` 的建子任务模式，stage=3、status=todo、继承需求 module/root/project/priority；assignee 取班底第一个 enabled `dev`，缺省回落需求自身 assignee）：

```go
// createAcceptanceRepairTask 为验收打回新建一个 stage3 修复子任务（status=todo）。
// assignee 优先取需求班底第一个 enabled 'dev'，缺省回落需求自身 assignee；root/module/
// project/priority 全部继承需求，保证 WS3 组锁与派生投影把它算进同一需求组。
func (h *Handler) createAcceptanceRepairTask(ctx context.Context, req db.Issue, round int32, evidence string) (db.Issue, error) {
	assigneeType, assigneeID := h.resolveRepairAssignee(ctx, req)

	rootID := req.RootRequirementID
	if !rootID.Valid {
		rootID = req.ID
	}
	description := "## 验收打回（第 " + strconv.Itoa(int(round)) + " 轮）\n\n" + evidence
	position, err := issueposition.NextTopPosition(ctx, h.DB, req.WorkspaceID, "todo")
	if err != nil {
		return db.Issue{}, fmt.Errorf("next top position: %w", err)
	}
	// number 分配镜像 service/requirement_decompose.go:201/233（AllocateIssueNumber 是 service 包级函数）。
	policy := service.ResolveIssueCountPolicy(ctx, h.Entitlements, req.WorkspaceID)
	number, err := service.AllocateIssueNumber(ctx, h.Queries, req.WorkspaceID, policy)
	if err != nil {
		return db.Issue{}, fmt.Errorf("allocate issue number: %w", err)
	}
	return h.Queries.CreateIssue(ctx, db.CreateIssueParams{
		ID:                dbid.NewV7(),
		WorkspaceID:       req.WorkspaceID,
		Title:             "验收修复（第 " + strconv.Itoa(int(round)) + " 轮）：" + req.Title,
		Description:       pgtype.Text{String: description, Valid: true},
		Status:            "todo",
		Priority:          req.Priority,
		AssigneeType:      pgtype.Text{String: assigneeType, Valid: assigneeType != ""},
		AssigneeID:        assigneeID,
		CreatorType:       "system",
		CreatorID:         pgtype.UUID{Valid: true},
		ParentIssueID:     req.ID,
		Position:          position,
		Number:            number,
		ProjectID:         req.ProjectID,
		Stage:             pgtype.Int4{Int32: 3, Valid: true},
		ModuleID:          req.ModuleID,
		AvoidConflict:     pgtype.Bool{Bool: false, Valid: true},
		RootRequirementID: rootID,
	})
}

// resolveRepairAssignee 取班底第一个 enabled 'dev' 角色；缺省回落需求自身 assignee。
// 返回值直接喂给 CreateIssueParams（assigneeID 为 pgtype.UUID，可能 invalid=无 assignee）。
func (h *Handler) resolveRepairAssignee(ctx context.Context, req db.Issue) (string, pgtype.UUID) {
	roster, err := h.Queries.ListIssueRoleAssignments(ctx, req.ID)
	if err == nil {
		for _, r := range roster {
			if r.Role == "dev" && r.Enabled && r.AssigneeID.Valid {
				return r.AssigneeType, r.AssigneeID
			}
		}
	}
	return req.AssigneeType.String, req.AssigneeID
}
```

- [ ] **Step 4: 补 import 与依赖 helper 核对**

在 `requirement_acceptance.go` 的 import 块补齐（路径均已在仓内核实）：

```go
import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issueposition"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)
```

复用符号定位（均已直读确认，实现时对照）：
- `issueposition.NextTopPosition(ctx, q queryRower, workspaceID pgtype.UUID, status string) (float64, error)`（`internal/issueposition/position.go:21`）——`h.DB`（`dbExecutor`，含 `QueryRow`）满足 `queryRower`。
- `service.AllocateIssueNumber(ctx, q *db.Queries, workspaceID pgtype.UUID, policy IssueCountPolicy) (int32, error)`（`internal/service/issue_limit.go:87`）。
- `service.ResolveIssueCountPolicy(ctx, provider entitlement.Provider, workspaceID pgtype.UUID) IssueCountPolicy`（`internal/service/issue_limit.go:34`）；`h.Entitlements` 见 `handler.go:200`。
- `uuidToString`（handler 包既有）、`dbid.NewV7()`（`pkg/dbid`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd $ROOT/server && go build ./... && go test ./internal/handler/ -run TestAcceptanceVerdict -v`
Expected: PASS（pass / bad-verdict / fail 三个用例全绿）。

- [ ] **Step 6: 提交**

```bash
cd $ROOT && git add server/internal/handler/requirement_acceptance.go server/internal/handler/requirement_acceptance_test.go
git commit -m "feat(requirement): acceptance fail branch creates stage3 repair task and enqueues"
```

---

### Task 4.4: `round > 3` → 验收失败终态 + 人工仲裁通知

**Files:**
- Modify: `server/internal/handler/requirement_acceptance.go`（fail 分支加越界守卫 + 仲裁通知）
- Test: `server/internal/handler/requirement_acceptance_test.go`（新增越界用例）

- [ ] **Step 1: 先写失败测试（第 4 次打回不再建修复子任务，发仲裁评论）**

在 `requirement_acceptance_test.go` 末尾追加：

```go
func TestAcceptanceVerdictFailBeyondLimitIsTerminal(t *testing.T) {
	proj := newAcceptanceProject(t, "beyond")
	reqID := newAcceptanceRequirement(t, proj)
	var agentID string
	dbfx.QueryRow(t, `SELECT id FROM agent WHERE workspace_id = $1 AND runtime_id IS NOT NULL
	                  ORDER BY created_at ASC LIMIT 1`, testWorkspaceID).Scan(&agentID)
	dbfx.Exec(t, `UPDATE issue SET assignee_type = 'agent', assignee_id = $1 WHERE id = $2`, agentID, reqID)
	// 已经打回 3 轮（round=3），本次是第 4 次 → 越界终态。
	dbfx.Exec(t, `UPDATE issue SET acceptance_round = 3 WHERE id = $1`, reqID)

	req := newRequest(http.MethodPost, "/api/issues/"+reqID+"/acceptance/verdict",
		map[string]any{"verdict": "fail", "evidence": "第 4 次仍未过"})
	req = withURLParam(req, "id", reqID)
	resp := testutil.Call(t, testHandler.RecordAcceptanceVerdict, req).Want(http.StatusOK)
	body := resp.Map()
	if body["acceptance_round"].(float64) != 4 {
		t.Errorf("acceptance_round = %v, want 4", body["acceptance_round"])
	}
	if body["terminal"] != true {
		t.Errorf("terminal = %v, want true", body["terminal"])
	}

	// 越界不再建修复子任务；发一条 system 仲裁评论。
	var repairCount, commentCount int
	dbfx.QueryRow(t, `SELECT count(*) FROM issue WHERE parent_issue_id = $1 AND stage = 3`, reqID).Scan(&repairCount)
	if repairCount != 0 {
		t.Errorf("stage3 repair children = %d, want 0 (terminal, no more repair)", repairCount)
	}
	dbfx.QueryRow(t, `SELECT count(*) FROM comment WHERE issue_id = $1 AND author_type = 'system'`, reqID).Scan(&commentCount)
	if commentCount < 1 {
		t.Errorf("system arbitration comments = %d, want >= 1", commentCount)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/handler/ -run TestAcceptanceVerdictFailBeyondLimitIsTerminal -v`
Expected: FAIL —— round=4 时当前实现仍建修复子任务（repairCount=1）、无仲裁评论（commentCount=0）、`terminal` 字段为 false。

- [ ] **Step 3: 在 fail 分支加越界守卫**

把 Task 4.3 写的 `case "fail":` 中「`// Task 4.4 补越界终态`」注释与其后到 `writeJSON(... "repair_issue_id" ...)` 之间的逻辑，改为在 `IncrementAcceptanceRound` 之后先判越界：

```go
	case "fail":
		newRound, err := h.Queries.IncrementAcceptanceRound(ctx, issue.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to increment acceptance_round: "+err.Error())
			return
		}
		// 越界终态（spec §6 第 10 态 / 开放问题 #4）：累计 >3 轮仍打回 = 验收失败，
		// 不再建修复子任务，改发人工仲裁 system 评论；派生投影据 acceptance_round>3 显示「验收失败」。
		if newRound > 3 {
			h.postAcceptanceFailedComment(ctx, issue, newRound, body.Evidence)
			writeJSON(w, http.StatusOK, map[string]any{
				"verdict":          "fail",
				"acceptance_round":   newRound,
				"terminal":          true,
			})
			return
		}
		repair, err := h.createAcceptanceRepairTask(ctx, issue, newRound, body.Evidence)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to create repair task: "+err.Error())
			return
		}
		if _, err := h.TaskService.EnqueueTaskForIssue(ctx, repair); err != nil {
			slog.Warn("acceptance fail: enqueue repair task failed",
				"error", err, "repair_id", uuidToString(repair.ID))
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"verdict":         "fail",
			"acceptance_round":  newRound,
			"terminal":          false,
			"repair_issue_id":   uuidToString(repair.ID),
		})
```

并在文件末尾追加 `postAcceptanceFailedComment`（镜像 `issue_child_done.go:316-325` 的 `CreateComment` system 评论模式）：

```go
// postAcceptanceFailedComment 在验收失败终态时，于需求上发一条 system 评论请求人工仲裁。
// author_type='system'、author_id=zero UUID（与 postChildDoneComment 同约定，见 issue_child_done.go:313-325）。
// best-effort：失败仅记录，不影响 verdict 响应（round 已落库，投影已判验收失败）。
func (h *Handler) postAcceptanceFailedComment(ctx context.Context, req db.Issue, round int32, evidence string) {
	content := "验收失败（累计 " + strconv.Itoa(int(round)) + " 轮打回，超过 3 轮上限）——需人工仲裁。最近一次裁决依据：" + evidence
	if _, err := h.Queries.CreateComment(ctx, db.CreateCommentParams{
		ID:          dbid.NewV7(),
		IssueID:     req.ID,
		WorkspaceID: req.WorkspaceID,
		AuthorType:  "system",
		AuthorID:    pgtype.UUID{Valid: true},
		Content:     content,
		Type:        "system",
		ParentID:    pgtype.UUID{Valid: false},
	}); err != nil {
		slog.Warn("acceptance failed: create arbitration comment failed",
			"error", err, "requirement_id", uuidToString(req.ID))
	}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd $ROOT/server && go build ./... && go test ./internal/handler/ -run TestAcceptanceVerdict -v`
Expected: PASS（pass / bad / fail / beyond-limit 四个用例全绿）。

- [ ] **Step 5: 提交**

```bash
cd $ROOT && git add server/internal/handler/requirement_acceptance.go server/internal/handler/requirement_acceptance_test.go
git commit -m "feat(requirement): acceptance fail beyond 3 rounds is terminal with arbitration notice"
```

---

### Task 4.5: 修正 stage barrier —— stage3 全终态时直接入队 stage4 tester

**Files:**
- Modify: `server/internal/handler/issue_child_done.go:272-351`（`postChildDoneComment` 末尾追加入队）+ 新增 `enqueueStageChildren`
- Test: `server/internal/handler/requirement_acceptance_test.go`（新增 barrier 唤醒 tester 用例）

**背景（实证）**：现状 stage3 barrier 关闭时只 `dispatchParentAssigneeTrigger` 唤醒父需求 PM，stage4 tester 子任务（decomposition 时已建为 `todo`）从不入队 → 验收永不启动。修正：barrier 关闭且 `closedStage==3` 时，直接把 stage4 子任务入队。

- [ ] **Step 1: 先写失败测试（stage3 全终态后 stage4 tester 入队）**

在 `requirement_acceptance_test.go` 末尾追加。`notifyParentOfChildDone(ctx, prev, issue)`（`issue_child_done.go:70`）只在 **prev 非终态 → issue 终态** 的转移上 fire（`:84-88`），所以用例先把 stage3 子任务建为 `in_progress`、载入为 `prev`，再翻 `done` 重载为 `issue`：

```go
func TestStage3BarrierEnqueuesStage4Tester(t *testing.T) {
	ctx := context.Background()
	proj := newAcceptanceProject(t, "barrier")
	reqID := newAcceptanceRequirement(t, proj)
	var agentID string
	dbfx.QueryRow(t, `SELECT id FROM agent WHERE workspace_id = $1 AND runtime_id IS NOT NULL
	                  ORDER BY created_at ASC LIMIT 1`, testWorkspaceID).Scan(&agentID)
	// 需求 assignee = agent（barrier 关闭后 dispatchParentAssigneeTrigger 唤醒父需求的前提）。
	dbfx.Exec(t, `UPDATE issue SET assignee_type = 'agent', assignee_id = $1 WHERE id = $2`, agentID, reqID)

	// stage3 一个子任务（先 in_progress，后翻 done 触发 barrier）+ stage4 一个 todo tester 子任务。
	// 两者 assignee 同为有 runtime 的 agent，EnqueueTaskForIssue 才能成功入队。
	newStageChildAgent := func(stage int, status string) string {
		var id string
		dbfx.QueryRow(t, `
			INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number, project_id,
			                   parent_issue_id, stage, assignee_type, assignee_id)
			VALUES ($1, $2, $3, 'medium', 'member', $4,
			        (SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE workspace_id = $1), $5, $6, $7, 'agent', $8)
			RETURNING id`,
			testWorkspaceID, fmt.Sprintf("stage%d-%s", stage, status), status, testUserID, proj, reqID, stage, agentID).Scan(&id)
		return id
	}
	stage3 := newStageChildAgent(3, "in_progress")
	stage4 := newStageChildAgent(4, "todo")

	stage3UUID, err := util.ParseUUID(stage3)
	if err != nil {
		t.Fatalf("parse stage3 id: %v", err)
	}
	prev, err := testHandler.Queries.GetIssue(ctx, stage3UUID)
	if err != nil {
		t.Fatalf("load stage3 prev: %v", err)
	}
	dbfx.Exec(t, `UPDATE issue SET status = 'done' WHERE id = $1`, stage3)
	now, err := testHandler.Queries.GetIssue(ctx, stage3UUID)
	if err != nil {
		t.Fatalf("load stage3 done: %v", err)
	}
	// 同包测试可直接调私有方法；内部 ListChildIssues 判 closedStage=3 并入队 stage4。
	testHandler.notifyParentOfChildDone(ctx, prev, now)

	var queued int
	dbfx.QueryRow(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id = $1`, stage4).Scan(&queued)
	if queued != 1 {
		t.Errorf("stage4 tester queue rows = %d, want 1", queued)
	}
}
```

> `util` 与 `fmt` 已在本测试文件 import（`util` 见 `issueStatus` helper，`fmt` 见 `newStageChildAgent`）。`GetIssue(ctx, pgtype.UUID) (db.Issue, error)` 与 `notifyParentOfChildDone(ctx, prev, issue db.Issue)` 均为同包可直读/直调的真实符号。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/handler/ -run TestStage3BarrierEnqueuesStage4Tester -v`
Expected: FAIL —— `stage4 tester queue rows = 0, want 1`（barrier 只唤醒父需求，未入队 tester）。

- [ ] **Step 3: 在 `postChildDoneComment` 末尾追加入队 + 新增 `enqueueStageChildren`**

在 `issue_child_done.go` 的 `postChildDoneComment` 函数体末尾（`:350` `h.dispatchParentAssigneeTrigger(ctx, parent, comment)` 之后、`:351` 收尾 `}` 之前）追加：

```go
	// 需求流水线：stage3 执行 barrier 关闭 → 直接入队 stage4 tester 子任务，
	// 让验收真正启动（现状只唤醒父需求 PM，无人入队 tester，验收永不触发）。
	// 非需求场景（无 stage4 子任务）时 enqueueStageChildren 自然 no-op。
	if staged && closedStage == 3 {
		h.enqueueStageChildren(ctx, parent, children, 4)
	}
```

在 `issue_child_done.go` 末尾（`triggerChildDoneSquad` 之后，`:730`）追加：

```go
// enqueueStageChildren 把 parent 下处于指定 stage、非终态、有 agent assignee 的子任务入队。
// 幂等保护：先查 HasPendingTaskForIssueAndAgent，已有 pending 行则跳过（镜像 triggerChildDoneAgent
// 的 dedup，见 issue_child_done.go:655-663）。EnqueueTaskForIssue 本身不去重（service/task.go:1213）。
// best-effort：单个子任务入队失败仅记录，不影响其余子任务与父需求唤醒。
func (h *Handler) enqueueStageChildren(ctx context.Context, parent db.Issue, children []db.Issue, stage int32) {
	for _, c := range children {
		if !c.Stage.Valid || c.Stage.Int32 != stage {
			continue
		}
		if isTerminalChildStatus(issuestatus.Effective(ctx, h.Queries, c.WorkspaceID, c.Status)) {
			continue
		}
		if !c.AssigneeID.Valid {
			continue
		}
		hasPending, err := h.Queries.HasPendingTaskForIssueAndAgent(ctx, db.HasPendingTaskForIssueAndAgentParams{
			IssueID: c.ID,
			AgentID: c.AssigneeID,
			HeadSha: h.TaskService.ResolveIssueReviewSHAParam(ctx, c.ID),
		})
		if err != nil || hasPending {
			continue
		}
		if _, err := h.TaskService.EnqueueTaskForIssue(ctx, c); err != nil {
			slog.Warn("child done: enqueue stage tester failed",
				"error", err, "child_id", uuidToString(c.ID))
		}
	}
}
```

- [ ] **Step 4: 跑测试确认通过 + barrier 回归**

Run: `cd $ROOT/server && go build ./... && go test ./internal/handler/ -run 'TestStage3BarrierEnqueuesStage4Tester|TestChildDone|TestRequirementStatusProjection|TestAcceptanceVerdict' -v`
Expected: PASS —— 新用例绿；既有 child-done barrier 测试与投影测试无回归（非需求场景 `enqueueStageChildren` no-op）。

- [ ] **Step 5: 提交**

```bash
cd $ROOT && git add server/internal/handler/issue_child_done.go server/internal/handler/requirement_acceptance_test.go
git commit -m "fix(child-done): enqueue stage4 tester when stage3 barrier closes"
```

---

### WS4 收尾验证

- [ ] `cd $ROOT/server && go build ./...` → 无输出。
- [ ] `cd $ROOT/server && go test ./internal/handler/ -run 'TestAcceptanceVerdict|TestStage3Barrier|TestRequirementStatusProjection'` → 全 PASS。
- [ ] `cd $ROOT && make sqlc` 后 `git diff --stat server/pkg/db/generated/` 只含 `requirement.sql.go`（新增 `IncrementAcceptanceRound`）；`issue.sql.go` 的 `ListIssuesRow` 结构不变（CASE 是表达式，不新增列）。
- [ ] 人工核对闭环：`pass` → 需求 `status=done`（WS3 root 终态钩子释放组锁）；`fail`(round≤3) → round+1 + stage3 修复子任务入队；`fail`(round>3) → 无新子任务 + system 仲裁评论 + 投影显示「验收失败」；stage3 全终态 → stage4 tester 入队。

---


## WS5 — agent_run 投影器（server 侧 ingest 派生）

> **独立性**：WS5 与 WS2/WS3/WS4 无代码耦合，可并行。唯一前置是 migration 459（`agent_run` / `agent_run_todo` / `agent_run_event` 三表 + 三写端点）已落库——现状已满足。

### WS5 实证校正与架构决策（对原任务描述的 pivot）

原任务描述为「**daemon 侧回写三端点**」。直读代码后确认该路径**不可行**，据实改为 **server 侧 ingest 投影**。证据链：

| # | 实证 | 文件:行 | 结论 |
|---|------|---------|------|
| 1 | `/api/agent-runs` 三写端点（`UpsertAgentRun` / `UpsertAgentRunTodos` / `AppendAgentRunEvents`）挂在 `RequireWorkspaceMember` 路由组内 | `cmd/server/router.go:1859-1860, 2058-2065` | 需**成员用户**鉴权 |
| 2 | 三 handler 首行均 `requireUserID(w, r)` | `internal/handler/agent_run.go:189, 535, 703` | 无 user id 直接 401 |
| 3 | daemon 持 runtime token，只走 `/api/daemon/*` 鉴权链（`requireDaemonTaskAccess` / `…WithWorkspace`） | `internal/handler/daemon.go:105, 117` | daemon **无法**通过成员鉴权 |
| 4 | migration 459 头注：「会话流（`task_message`）是事实源，`agent_run` / `_todo` / `_event` 是单向投影」 | `migrations/459_agent_run_projection.up.sql:1-2` | 投影应**贴着事实源**做 |
| 5 | `task_message` 的唯一写入点是 `ReportTaskMessages`，且该处 `task`（`db.AgentTaskQueue`）、`wsID`、`req.Messages` 全在 scope，鉴权已就绪 | `internal/handler/daemon.go:4587, 4606, 4693` | **天然投影点** |

**决策**：WS5 在 `ReportTaskMessages` 落 `task_message` 之后，就地把**同一批** messages 派生为 `agent_run` / `_todo` / `_event`。收益：零新端点、零鉴权改动、事实源与投影共址、投影失败降级不阻断热路径（`task_message` 才是事实源，已提交）。

**daemon 侧唯一改动**：把 `agent.Message.CallID` 透传进上传的 `TaskMessageData`。原因：`CallID` 是 tool_use ↔ tool_result 的**天然配对键**（`pkg/agent/agent.go:169` 注释「tool call ID (ToolUse, ToolResult)」），但它当前**止步于 daemon**——`daemon.go:8894-8898` 只用它维护本地 `callIDToTool` 映射，从不上传；`TaskMessageData`（`client.go:492-499`）与 `TaskMessageRequest`（`daemon.go:4573-4580`）都无此字段；`task_message` 表（`migrations/026_task_messages.up.sql`）也无 `call_id` 列。不透传则投影无法把一次工具调用的「开始/结束」合并成一条待办。透传是**纯增量**（`omitempty`，全部 keyed 字面量，`grep TaskMessageData{` 无位置字面量、测试零命中），旧 daemon 不发也能跑（投影对无 `CallID` 的 tool 消息降级为「仅计心跳、不建待办」）。

### WS5 消息面实证（drain loop 实际上传哪些 type）

`executeAndDrain` 的 drain loop（`daemon.go:8844-8979`）+ flush 闭包（`daemon.go:8791-8810`）实际发往 server 的消息 type：

| type | 来源 | 投影用途 |
|------|------|----------|
| `thinking` | flush 累积（8795） | 仅计心跳 |
| `text` | flush 累积（8804） | 仅计心跳 |
| `tool_use` | drain loop（8901），带 `Tool` / `Input` / `CallID` | → 待办 `in_progress` |
| `tool_result` | drain loop（8945），带 `Tool` / `Output` / `CallID` | → 同 key 待办翻 `done` |
| `error` | drain loop（8969），带 `Content` | → 分类事件 `rate_limit`/`net_err`/`crash` |

> `MessageStatus`（8857）就地处理（pin session），**不入 batch、不上传**。故投影只需处理上述 5 类。

### WS5 run id 决策（免新迁移）

`agent_run.task_queue_id` 在 459 只有**非唯一**索引 `idx_agent_run_task`（`459:28`），无法直接 `ON CONFLICT(task_queue_id)`。两条路：(A) 加部分唯一索引迁移；(B) 用**确定性 UUID v5** 从 `task_queue_id` 派生 run id，复用现有 PK 冲突路径 `ON CONFLICT(id)`（与 `UpsertAgentRun` 同构，`agent_run.go:286`）。

**选 B**：`github.com/google/uuid@v1.6.0` 已在 `daemon.go:19` 引入，`uuid.NewSHA1(space, data)` 可用。`agentRunIDForTask(taskID)` = `uuid.NewSHA1(固定命名空间, taskID.Bytes[:])` → 同一 task 恒定映射同一 run，竞态安全、**零 schema 变更、零 sqlc 重生成**。

### WS5 待办 / 事件派生规则（定稿）

- **心跳**：任意非空批 → 1 条 `heartbeat` 事件（`detail = {"messages": n}`）。
- **待办**：`tool_use` 且 `CallID != ""` → `{todo_key: CallID, title: Tool（空则 "tool"）, status: in_progress, seq: Seq, source: tool_trace}` + 1 条 `todo_change` 事件；`tool_result` 且 `CallID != ""` → 同 `todo_key` 翻 `status: done` + 1 条 `todo_change`。写入器按 `ON CONFLICT(run_id, todo_key) DO UPDATE` 合并，故同批 / 跨批的 use→result 都收敛成**一条**待办。`CallID == ""`（旧 daemon）→ **跳过待办派生**（不建孤儿待办），仅计心跳。
- **错误事件**：`error` → `classifyErrorEvent(Content)` 归一到 `rate_limit`/`net_err`/`crash`（对齐 `agent_run.go:61` `validRunEventType` 与 `459:62-63` CHECK），`detail = {"error": <截断 512 字>}`；同时把该批**最后一条**错误映射的 `stall_reason`（`rate_limited`/`network_lost`/`crashed`，对齐 `459:18-20`）带进 run upsert，`DO UPDATE` 用 `COALESCE(EXCLUDED.stall_reason, agent_run.stall_reason)`——有错才写、干净批不清空。
- **phase / superseded_by**：投影待办恒为 NULL（tool_trace 无阶段/血缘），`DO UPDATE` **不触碰** phase / superseded_by，避免抹掉 reply/manual 源可能写入的值。

---

### Task 5.1: 透传 CallID（daemon → server 线协议）

**Files:**
- Modify: `server/internal/daemon/client.go:492-499`（`TaskMessageData` 增 `CallID`）
- Modify: `server/internal/daemon/daemon.go:8901-8915`（tool_use append 增 `CallID`）
- Modify: `server/internal/daemon/daemon.go:8945-8950`（tool_result append 增 `CallID`）
- Modify: `server/internal/handler/daemon.go:4573-4580`（`TaskMessageRequest` 增 `CallID`）

> 本任务是**纯增量线协议字段**，无独立行为可单测（`CallID` 的消费方是 5.2 的派生函数与 5.3 的写入器，行为测试在那里）。故本任务的验证是「编译通过 + daemon 现有测试零回归」，符合 additive-field 的 TDD 例外。

- [ ] **Step 1: server 侧 `TaskMessageRequest` 增 `CallID`**

`server/internal/handler/daemon.go:4573-4580`，在 `Output` 后加一行：

```go
type TaskMessageRequest struct {
	Seq     int            `json:"seq"`
	Type    string         `json:"type"`
	Tool    string         `json:"tool,omitempty"`
	Content string         `json:"content,omitempty"`
	Input   map[string]any `json:"input,omitempty"`
	Output  string         `json:"output,omitempty"`
	CallID  string         `json:"call_id,omitempty"`
}
```

- [ ] **Step 2: daemon 侧 `TaskMessageData` 增 `CallID`**

`server/internal/daemon/client.go:492-499`：

```go
// TaskMessageData represents a single agent execution message for batch reporting.
type TaskMessageData struct {
	Seq     int            `json:"seq"`
	Type    string         `json:"type"`
	Tool    string         `json:"tool,omitempty"`
	Content string         `json:"content,omitempty"`
	Input   map[string]any `json:"input,omitempty"`
	Output  string         `json:"output,omitempty"`
	CallID  string         `json:"call_id,omitempty"`
}
```

- [ ] **Step 3: drain loop tool_use 处 populate `CallID`**

`server/internal/daemon/daemon.go:8900-8916`，在 `batch = append(batch, TaskMessageData{…})` 里 `Input:` 之后加 `CallID: msg.CallID`（`msg.CallID` 已在 8894 用于 `callIDToTool`，此处直接复用）：

```go
					mu.Lock()
					batch = append(batch, TaskMessageData{
						Seq:  int(s),
						Type: "tool_use",
						Tool: msg.Tool,
						Input: redact.InputMap(msg.Input),
						CallID: msg.CallID,
					})
					mu.Unlock()
```

> 保留 8905-8913 原有 redact 注释不动，仅在 `Input:` 行后插入 `CallID: msg.CallID,`。

- [ ] **Step 4: drain loop tool_result 处 populate `CallID`**

`server/internal/daemon/daemon.go:8944-8951`：

```go
					mu.Lock()
					batch = append(batch, TaskMessageData{
						Seq:    int(s),
						Type:   "tool_result",
						Tool:   toolName,
						Output: output,
						CallID: msg.CallID,
					})
					mu.Unlock()
```

- [ ] **Step 5: 编译 + daemon 回归**

Run:
```bash
cd $ROOT/server && gofmt -w internal/daemon/client.go internal/daemon/daemon.go internal/handler/daemon.go && go build ./... && go test ./internal/daemon/ -run 'TestExecuteAndDrain|TestReportTaskMessages|TestDrain' -count=1
```
Expected: `go build` 无输出；测试 PASS 或 `no tests to run`（现有 drain 测试若有则须绿；`TaskMessageData` 全为 keyed 字面量，加字段不破任何构造点）。

- [ ] **Step 6: 提交**

```bash
cd $ROOT && git add server/internal/daemon/client.go server/internal/daemon/daemon.go server/internal/handler/daemon.go
git commit -m "feat(daemon): thread tool CallID through task message wire protocol"
```

---

### Task 5.2: 纯派生函数 `projectAgentRunFromMessages` + `classifyErrorEvent`

**Files:**
- Create: `server/internal/handler/agent_run_projector.go`
- Test: `server/internal/handler/agent_run_projector_test.go`

- [ ] **Step 1: 写失败测试**

`server/internal/handler/agent_run_projector_test.go`：

```go
package handler

import (
	"encoding/json"
	"testing"
)

// TestProjectAgentRunFromMessages_PairsToolCallByCallID 验证：一次工具调用的
// tool_use（in_progress）与 tool_result（done）按 CallID 合并成同一条待办，
// 且各产生一条 todo_change 事件；非空批产生一条 heartbeat。
func TestProjectAgentRunFromMessages_PairsToolCallByCallID(t *testing.T) {
	msgs := []TaskMessageRequest{
		{Seq: 1, Type: "tool_use", Tool: "bash", CallID: "call_1"},
		{Seq: 2, Type: "tool_result", Tool: "bash", CallID: "call_1", Output: "ok"},
	}
	proj := projectAgentRunFromMessages(msgs)

	if !proj.Heartbeat {
		t.Fatalf("Heartbeat = false, want true (non-empty batch)")
	}
	if len(proj.Todos) != 2 {
		t.Fatalf("Todos len = %d, want 2 (use + result, merged by writer)", len(proj.Todos))
	}
	if proj.Todos[0].Key != "call_1" || proj.Todos[0].Status != "in_progress" || proj.Todos[0].Title != "bash" || proj.Todos[0].Source != "tool_trace" {
		t.Fatalf("Todos[0] = %+v, want key=call_1 status=in_progress title=bash source=tool_trace", proj.Todos[0])
	}
	if proj.Todos[1].Key != "call_1" || proj.Todos[1].Status != "done" {
		t.Fatalf("Todos[1] = %+v, want key=call_1 status=done", proj.Todos[1])
	}
	// heartbeat(1) + todo_change(2)
	var hb, tc int
	for _, ev := range proj.Events {
		switch ev.Type {
		case "heartbeat":
			hb++
		case "todo_change":
			tc++
		}
	}
	if hb != 1 || tc != 2 {
		t.Fatalf("events: heartbeat=%d todo_change=%d, want 1 and 2", hb, tc)
	}
}

// TestProjectAgentRunFromMessages_SkipsTodosWithoutCallID 验证旧 daemon 降级：
// 无 CallID 的 tool 消息不建待办（不留孤儿），但仍计心跳。
func TestProjectAgentRunFromMessages_SkipsTodosWithoutCallID(t *testing.T) {
	proj := projectAgentRunFromMessages([]TaskMessageRequest{
		{Seq: 1, Type: "tool_use", Tool: "bash"},
		{Seq: 2, Type: "thinking", Content: "..."},
	})
	if !proj.Heartbeat {
		t.Fatalf("Heartbeat = false, want true")
	}
	if len(proj.Todos) != 0 {
		t.Fatalf("Todos len = %d, want 0 (no CallID → no orphan todo)", len(proj.Todos))
	}
}

// TestProjectAgentRunFromMessages_ClassifiesErrorAndSetsStall 验证 error 消息
// 归类为事件并带出 stall_reason；空批不产生心跳。
func TestProjectAgentRunFromMessages_ClassifiesErrorAndSetsStall(t *testing.T) {
	proj := projectAgentRunFromMessages([]TaskMessageRequest{
		{Seq: 1, Type: "error", Content: "HTTP 429 Too Many Requests: rate limit exceeded"},
	})
	if len(proj.Events) != 2 { // heartbeat + rate_limit
		t.Fatalf("Events len = %d, want 2 (heartbeat + rate_limit)", len(proj.Events))
	}
	var sawRateLimit bool
	for _, ev := range proj.Events {
		if ev.Type == "rate_limit" {
			sawRateLimit = true
		}
	}
	if !sawRateLimit {
		t.Fatalf("no rate_limit event derived from a 429 error")
	}
	if proj.StallReason != "rate_limited" {
		t.Fatalf("StallReason = %q, want rate_limited", proj.StallReason)
	}

	if empty := projectAgentRunFromMessages(nil); empty.Heartbeat || len(empty.Todos) != 0 || len(empty.Events) != 0 {
		t.Fatalf("empty batch projection = %+v, want zero value", empty)
	}
}

// TestClassifyErrorEvent 覆盖三类归一。
func TestClassifyErrorEvent(t *testing.T) {
	cases := map[string]string{
		"rate limit exceeded":        "rate_limit",
		"429 too many requests":      "rate_limit",
		"quota exceeded for key":     "rate_limit",
		"connection reset by peer":   "net_err",
		"dial tcp: i/o timeout":      "net_err",
		"unexpected EOF":             "net_err",
		"segmentation fault (core)":  "crash",
		"something went very wrong":  "crash",
	}
	for content, want := range cases {
		if got := classifyErrorEvent(content); got != want {
			t.Errorf("classifyErrorEvent(%q) = %q, want %q", content, got, want)
		}
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/handler/ -run 'TestProjectAgentRunFromMessages|TestClassifyErrorEvent' -count=1`
Expected: 编译失败 —— `undefined: projectAgentRunFromMessages` / `undefined: classifyErrorEvent` / `unknown field StallReason`。

- [ ] **Step 3: 写实现**

`server/internal/handler/agent_run_projector.go`：

```go
package handler

import (
	"encoding/json"
	"strings"
)

// WS5（需求日历 Phase I）：server 侧 ingest 投影。
//
// migration 459 头注明确 task_message 是事实源、agent_run/_todo/_event 是单向
// 投影；而 /api/agent-runs 三写端点挂在 RequireWorkspaceMember 组下
// （router.go:1859-1860 + agent_run.go:189/535/703 requireUserID），daemon 的
// runtime token 无法调用。故投影贴着事实源做：ReportTaskMessages 落 task_message
// 后，就地把同一批 messages 派生为 run/todo/event（见 applyAgentRunProjection）。
//
// 本文件只放**纯派生**逻辑（无 DB、无 IO），便于单测；写入器与终态收尾另见
// applyAgentRunProjection / finalizeAgentRunStatus。

// projectedTodo 是一条待办的派生结果，写入 agent_run_todo。
type projectedTodo struct {
	Key    string // todo_key：tool_use/tool_result 的 CallID（配对键）
	Title  string // 工具名
	Status string // in_progress（tool_use）/ done（tool_result）
	Seq    int    // 消息序号
	Source string // 恒为 tool_trace
}

// projectedEvent 是一条事件的派生结果，写入 agent_run_event。
type projectedEvent struct {
	Type    string          // heartbeat / todo_change / rate_limit / net_err / crash
	Payload json.RawMessage // 恒为 JSON 对象
}

// agentRunProjection 是一批 messages 的完整派生结果。
type agentRunProjection struct {
	Heartbeat   bool             // 非空批 → true
	StallReason string           // 该批最后一条 error 映射的 stall_reason，无则 ""
	Todos       []projectedTodo  // 按消息序，写入器按序 upsert
	Events      []projectedEvent // 含 1 条 heartbeat（若非空）+ todo_change + error 事件
}

// projectAgentRunFromMessages 从一批已解码的 task messages 派生 run 投影。纯函数。
func projectAgentRunFromMessages(msgs []TaskMessageRequest) agentRunProjection {
	var proj agentRunProjection
	if len(msgs) == 0 {
		return proj
	}
	proj.Heartbeat = true
	proj.Events = append(proj.Events, projectedEvent{
		Type:    "heartbeat",
		Payload: mustJSONObject(map[string]any{"messages": len(msgs)}),
	})

	for _, msg := range msgs {
		switch msg.Type {
		case "tool_use", "tool_result":
			if strings.TrimSpace(msg.CallID) == "" {
				// 旧 daemon 未透传 CallID：无法把 use/result 配对成一条待办，
				// 宁可不建（避免孤儿 in_progress），心跳已计。
				continue
			}
			status := "in_progress"
			if msg.Type == "tool_result" {
				status = "done"
			}
			title := strings.TrimSpace(msg.Tool)
			if title == "" {
				title = "tool"
			}
			proj.Todos = append(proj.Todos, projectedTodo{
				Key:    msg.CallID,
				Title:  title,
				Status: status,
				Seq:    msg.Seq,
				Source: "tool_trace",
			})
			proj.Events = append(proj.Events, projectedEvent{
				Type: "todo_change",
				Payload: mustJSONObject(map[string]any{
					"todo_key": msg.CallID,
					"status":   status,
					"tool":     title,
				}),
			})
		case "error":
			eventType := classifyErrorEvent(msg.Content)
			proj.Events = append(proj.Events, projectedEvent{
				Type:    eventType,
				Payload: mustJSONObject(map[string]any{"error": truncateRunError(msg.Content)}),
			})
			proj.StallReason = stallReasonForEvent(eventType)
		}
	}
	return proj
}

// classifyErrorEvent 把 error 文本归一到 agent_run_event.event_type 的三类
// （对齐 459:62-63 CHECK 与 agent_run.go:61 validRunEventType）。
func classifyErrorEvent(content string) string {
	lower := strings.ToLower(content)
	switch {
	case strings.Contains(lower, "rate limit"),
		strings.Contains(lower, "429"),
		strings.Contains(lower, "too many requests"),
		strings.Contains(lower, "quota"):
		return "rate_limit"
	case strings.Contains(lower, "connection"),
		strings.Contains(lower, "network"),
		strings.Contains(lower, "timeout"),
		strings.Contains(lower, "dial"),
		strings.Contains(lower, "tls"),
		strings.Contains(lower, "eof"):
		return "net_err"
	default:
		return "crash"
	}
}

// stallReasonForEvent 把事件类型映射到 agent_run.stall_reason
// （对齐 459:18-20 CHECK）；非 stall 类事件返回 ""。
func stallReasonForEvent(eventType string) string {
	switch eventType {
	case "rate_limit":
		return "rate_limited"
	case "net_err":
		return "network_lost"
	case "crash":
		return "crashed"
	default:
		return ""
	}
}

// truncateRunError 把错误文本截断到 512 字，避免 detail JSONB 膨胀。
func truncateRunError(s string) string {
	const max = 512
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// mustJSONObject 把 map 序列化为 JSON 对象；map 只含 string/int，序列化不会失败，
// 兜底返回 "{}"（与 agent_run.go:739 的默认 detail 一致）。
func mustJSONObject(m map[string]any) json.RawMessage {
	b, err := json.Marshal(m)
	if err != nil || len(b) == 0 {
		return json.RawMessage("{}")
	}
	return b
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd $ROOT/server && go test ./internal/handler/ -run 'TestProjectAgentRunFromMessages|TestClassifyErrorEvent' -count=1`
Expected: PASS（4 个测试全绿）。

- [ ] **Step 5: 提交**

```bash
cd $ROOT && git add server/internal/handler/agent_run_projector.go server/internal/handler/agent_run_projector_test.go
git commit -m "feat(agent-run): derive run/todo/event projection from task messages"
```

---

### Task 5.3: 写入器 `applyAgentRunProjection` + hook 进 `ReportTaskMessages`

**Files:**
- Modify: `server/internal/handler/agent_run_projector.go`（增写入器 + run id 派生 + import `db`/`uuid`/`pgtype`/`context`/`log/slog`）
- Modify: `server/internal/handler/daemon.go:4693`（`ReportTaskMessages` 落库后挂投影）
- Test: `server/internal/handler/agent_run_projector_test.go`（增 DB 集成测试）

- [ ] **Step 1: 写失败测试（DB 集成）**

追加到 `server/internal/handler/agent_run_projector_test.go`（复用 `agent_run_write_test.go` 的 harness：`testHandler` / `testWorkspaceID` / `dbfx` / `parseUUID`）：

```go
func TestApplyAgentRunProjection_UpsertsRunTodosEvents(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID := dbfx.Runtime(t, "proj-rt", testutil.Cols{"provider": "anthropic"})
	agentID := dbfx.Agent(t, "proj-agent", runtimeID)
	issueID := dbfx.Issue(t, "投影需求")
	taskID := dbfx.Task(t, agentID, testutil.Cols{
		"issue_id":   issueID,
		"runtime_id": runtimeID,
		"status":     "running",
	})
	task := db.AgentTaskQueue{
		ID:        parseUUID(taskID),
		AgentID:   parseUUID(agentID),
		IssueID:   parseUUID(issueID),
		RuntimeID: parseUUID(runtimeID),
	}

	// 第一批：一次工具调用开始 + 一次限流错误。
	testHandler.applyAgentRunProjection(context.Background(), task, testWorkspaceID,
		projectAgentRunFromMessages([]TaskMessageRequest{
			{Seq: 1, Type: "tool_use", Tool: "bash", CallID: "call_1"},
			{Seq: 2, Type: "error", Content: "429 rate limit exceeded"},
		}))

	var runID, cliKind, status, stallReason string
	var tokenUsed int64
	dbfx.QueryRow(t,
		`SELECT id::text, cli_kind, status, COALESCE(stall_reason,''), token_used
		   FROM agent_run WHERE task_queue_id = $1`, taskID).
		Scan(&runID, &cliKind, &status, &stallReason, &tokenUsed)
	if cliKind != "anthropic" {
		t.Fatalf("cli_kind = %q, want anthropic (from runtime provider)", cliKind)
	}
	if status != "running" {
		t.Fatalf("status = %q, want running", status)
	}
	if stallReason != "rate_limited" {
		t.Fatalf("stall_reason = %q, want rate_limited", stallReason)
	}
	// issue_id / root_issue_id 落到 run 上（独立需求 root=自身，见 452）。
	var issueCol, rootCol string
	dbfx.QueryRow(t,
		`SELECT COALESCE(issue_id::text,''), COALESCE(root_issue_id::text,'') FROM agent_run WHERE id = $1`, runID).
		Scan(&issueCol, &rootCol)
	if issueCol != issueID {
		t.Fatalf("issue_id = %q, want %q", issueCol, issueID)
	}
	if rootCol != issueID {
		t.Fatalf("root_issue_id = %q, want %q (independent issue root = self)", rootCol, issueID)
	}
	// 待办 call_1 = in_progress；事件含 heartbeat + todo_change + rate_limit。
	var todoStatus string
	dbfx.QueryRow(t, `SELECT status FROM agent_run_todo WHERE run_id = $1 AND todo_key = 'call_1'`, runID).Scan(&todoStatus)
	if todoStatus != "in_progress" {
		t.Fatalf("todo status = %q, want in_progress", todoStatus)
	}
	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run_event WHERE run_id = $1 AND event_type = 'rate_limit'`, runID); got != 1 {
		t.Fatalf("rate_limit events = %d, want 1", got)
	}

	// 第二批（同 task）：工具调用结束。**同一 run**（确定性 id），待办翻 done，
	// stall_reason 不被干净批清空（COALESCE 保留）。
	testHandler.applyAgentRunProjection(context.Background(), task, testWorkspaceID,
		projectAgentRunFromMessages([]TaskMessageRequest{
			{Seq: 3, Type: "tool_result", Tool: "bash", CallID: "call_1", Output: "ok"},
		}))
	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run WHERE task_queue_id = $1`, taskID); got != 1 {
		t.Fatalf("run rows = %d, want 1 (deterministic id upsert)", got)
	}
	dbfx.QueryRow(t, `SELECT status FROM agent_run_todo WHERE run_id = $1 AND todo_key = 'call_1'`, runID).Scan(&todoStatus)
	if todoStatus != "done" {
		t.Fatalf("todo status after result = %q, want done", todoStatus)
	}
	dbfx.QueryRow(t, `SELECT COALESCE(stall_reason,'') FROM agent_run WHERE id = $1`, runID).Scan(&stallReason)
	if stallReason != "rate_limited" {
		t.Fatalf("stall_reason after clean batch = %q, want rate_limited (preserved)", stallReason)
	}
}
```

> 测试文件顶部 import 需补：`"context"`、`testutil "github.com/multica-ai/multica/server/internal/testutil"`、`db "github.com/multica-ai/multica/server/pkg/db/generated"`（`dbfx` / `parseUUID` / `testHandler` / `testWorkspaceID` 均为 handler 包内既有测试全局，无需 import）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/handler/ -run 'TestApplyAgentRunProjection' -count=1`
Expected: 编译失败 —— `testHandler.applyAgentRunProjection undefined`。

- [ ] **Step 3: 写实现（run id 派生 + 写入器）**

在 `server/internal/handler/agent_run_projector.go` 顶部把 import 补全为：

```go
import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	obsmetrics "github.com/multica-ai/multica/server/internal/metrics"
)
```

在文件末尾追加：

```go
// agentRunProjNamespace 是固定的 UUID v5 命名空间，使同一 agent_task_queue 行
// 恒定派生同一 agent_run.id —— 从而复用 run PK 的 ON CONFLICT(id)（与
// UpsertAgentRun 同构，agent_run.go:286），无需在 task_queue_id 上另建唯一索引。
var agentRunProjNamespace = uuid.MustParse("2f6d0a4e-7c31-4b9a-9e55-1a2b3c4d5e6f")

// agentRunIDForTask 从 task_queue_id 确定性派生 run id。
func agentRunIDForTask(taskID pgtype.UUID) pgtype.UUID {
	id := uuid.NewSHA1(agentRunProjNamespace, taskID.Bytes[:])
	return pgtype.UUID{Bytes: id, Valid: true}
}

// applyAgentRunProjection 把一批 messages 的派生结果写入 agent_run/_todo/_event。
// best-effort：任何错误只记日志、不返回 —— task_message 才是事实源且已提交，
// 投影失败绝不能 500 系统最热的写路径（MUL-6523）。
func (h *Handler) applyAgentRunProjection(ctx context.Context, task db.AgentTaskQueue, wsID string, proj agentRunProjection) {
	if !task.ID.Valid || !proj.Heartbeat {
		return
	}
	wsUUID := parseUUID(wsID)
	if !wsUUID.Valid {
		slog.Warn("agent run projection: invalid workspace id", "task_id", uuidToString(task.ID))
		return
	}

	agentID := uuidToString(task.AgentID)
	if agentID == "" {
		agentID = "unknown"
	}
	cliKind := h.resolveRunCliKind(ctx, task.RuntimeID)
	runID := agentRunIDForTask(task.ID)

	var stallReason pgtype.Text
	if proj.StallReason != "" {
		stallReason = pgtype.Text{String: proj.StallReason, Valid: true}
	}

	// run upsert：确定性 id → ON CONFLICT(id)。root_issue_id 由 issue 行的
	// root_requirement_id 子查询取得（独立需求 root=自身，452 回填）。干净批
	// 用 COALESCE 保留既有 stall_reason，不因一次心跳清空。
	if _, err := h.DB.Exec(ctx, `
		INSERT INTO agent_run (
			id, workspace_id, task_queue_id, issue_id, root_issue_id,
			agent_id, cli_kind, status, stall_reason, last_heartbeat_at
		) VALUES (
			$1, $2, $3, $4, (SELECT root_requirement_id FROM issue WHERE id = $4),
			$5, $6, 'running', $7, now()
		)
		ON CONFLICT (id) DO UPDATE SET
			last_heartbeat_at = now(),
			stall_reason = COALESCE(EXCLUDED.stall_reason, agent_run.stall_reason),
			updated_at = now()`,
		runID, wsUUID, task.ID, task.IssueID, agentID, cliKind, stallReason,
	); err != nil {
		slog.Warn("agent run projection: upsert run failed",
			"task_id", uuidToString(task.ID), "error", err)
		return
	}

	if len(proj.Todos) == 0 && len(proj.Events) == 0 {
		return
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		slog.Warn("agent run projection: begin tx failed", "task_id", uuidToString(task.ID), "error", err)
		return
	}
	defer tx.Rollback(ctx)

	for _, td := range proj.Todos {
		// 镜像 UpsertAgentRunTodos（agent_run.go:585-596），但 phase /
		// superseded_by 恒 NULL 且 DO UPDATE 不触碰二者（保留 reply/manual 源的值）。
		if _, err := tx.Exec(ctx, `
			INSERT INTO agent_run_todo (
				workspace_id, run_id, todo_key, phase, title, status, seq, source, superseded_by
			) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, NULL)
			ON CONFLICT (run_id, todo_key) DO UPDATE SET
				title = EXCLUDED.title,
				status = EXCLUDED.status,
				seq = EXCLUDED.seq,
				source = EXCLUDED.source,
				updated_at = now()`,
			wsUUID, runID, td.Key, td.Title, td.Status, td.Seq, td.Source,
		); err != nil {
			slog.Warn("agent run projection: upsert todo failed",
				"task_id", uuidToString(task.ID), "todo_key", td.Key, "error", err)
			return
		}
	}
	for _, ev := range proj.Events {
		// 镜像 AppendAgentRunEvents（agent_run.go:766-769）：append-only。
		if _, err := tx.Exec(ctx, `
			INSERT INTO agent_run_event (workspace_id, run_id, event_type, detail)
			VALUES ($1, $2, $3, $4::jsonb)`,
			wsUUID, runID, ev.Type, string(ev.Payload),
		); err != nil {
			slog.Warn("agent run projection: append event failed",
				"task_id", uuidToString(task.ID), "event_type", ev.Type, "error", err)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Warn("agent run projection: commit failed", "task_id", uuidToString(task.ID), "error", err)
		return
	}
}

// resolveRunCliKind 经 task.RuntimeID → agent_runtime.provider 解析 cli_kind，
// 失败回落 "unknown"（cli_kind TEXT NOT NULL，459:13）。server 侧唯一可得的
// agent 身份串就是 runtime.provider；若日后需要更细的 CLI 种类，由 daemon 的
// backend 名透传，届时替换此函数即可。
func (h *Handler) resolveRunCliKind(ctx context.Context, runtimeID pgtype.UUID) string {
	if !runtimeID.Valid {
		return "unknown"
	}
	rt, err := h.getAgentRuntime(ctx, obsmetrics.RuntimeLookupSourceTask, runtimeID)
	if err != nil || strings.TrimSpace(rt.Provider) == "" {
		return "unknown"
	}
	return rt.Provider
}
```

> `h.DB`（`dbExecutor`：Exec/Query/QueryRow，`handler.go:62, 186`）、`h.TxStarter`（`txStarter.Begin`，`handler.go:187`）、`h.getAgentRuntime`（`runtime.go:640`）、`parseUUID`/`uuidToString`（`handler.go:594-595`）、`obsmetrics.RuntimeLookupSourceTask`（`internal/metrics/labels.go:272`，import 别名见 `daemon.go:27`）均为既有符号。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd $ROOT/server && go test ./internal/handler/ -run 'TestApplyAgentRunProjection' -count=1`
Expected: PASS（需 DB；无 DB 时 SKIP `database not available`）。

- [ ] **Step 5: hook 进 `ReportTaskMessages`**

`server/internal/handler/daemon.go`，在 `CreateTaskMessages` 成功、publishTask 循环之后、`writeJSON(w, http.StatusOK, …)`（4716）之前插入：

```go
	// WS5：从同一批 messages 就地派生 agent_run 投影。best-effort —— task_message
	// 是事实源（migration 459）且已在上面提交；投影失败只记日志，绝不 500 这条
	// 每 500ms 触发一次的最热写路径（MUL-6523）。
	h.applyAgentRunProjection(r.Context(), task, wsID, projectAgentRunFromMessages(req.Messages))

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
```

> `task`（`db.AgentTaskQueue`）、`wsID`（`requireDaemonTaskAccessWithWorkspace` 返回，4606）、`req.Messages`（`[]TaskMessageRequest`）均在 scope。用 `wsID`（真实工作区 id），**不是** 4614 的局部 `workspaceID`（那是广播开关，非 issue/chat 任务时为 ""）。

- [ ] **Step 6: 编译 + handler 回归**

Run:
```bash
cd $ROOT/server && gofmt -w internal/handler/agent_run_projector.go internal/handler/daemon.go && go build ./... && go test ./internal/handler/ -run 'TestApplyAgentRunProjection|TestProjectAgentRun|TestClassifyErrorEvent|TestReportTaskMessages' -count=1
```
Expected: `go build` 无输出；测试 PASS / SKIP（无 DB）。

- [ ] **Step 7: 提交**

```bash
cd $ROOT && git add server/internal/handler/agent_run_projector.go server/internal/handler/agent_run_projector_test.go server/internal/handler/daemon.go
git commit -m "feat(agent-run): project run/todo/event on task message ingest"
```

---

### Task 5.4: 终态收尾 `finalizeAgentRunStatus` + `addAgentRunTokens`

**Files:**
- Modify: `server/internal/handler/agent_run_projector.go`（增两个终态写入器）
- Modify: `server/internal/handler/daemon.go:3856`（`CompleteTask`）/ `:4543`（`failTask`）/ `:4742`（`AckTaskCancelled`）/ `:4422-4468`（`ReportTaskUsage`）
- Test: `server/internal/handler/agent_run_projector_test.go`（增 DB 测试）

- [ ] **Step 1: 写失败测试（DB 集成）**

追加到 `server/internal/handler/agent_run_projector_test.go`：

```go
func TestFinalizeAgentRunStatus_AndTokens(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID := dbfx.Runtime(t, "fin-rt", testutil.Cols{"provider": "openai"})
	agentID := dbfx.Agent(t, "fin-agent", runtimeID)
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "status": "running"})
	task := db.AgentTaskQueue{
		ID: parseUUID(taskID), AgentID: parseUUID(agentID), RuntimeID: parseUUID(runtimeID),
	}
	ctx := context.Background()

	// 先由投影建出一条 running run。
	testHandler.applyAgentRunProjection(ctx, task, testWorkspaceID,
		projectAgentRunFromMessages([]TaskMessageRequest{{Seq: 1, Type: "tool_use", Tool: "bash", CallID: "c1"}}))

	// 终态：completed。
	testHandler.finalizeAgentRunStatus(ctx, task.ID, "completed")
	var status string
	dbfx.QueryRow(t, `SELECT status FROM agent_run WHERE task_queue_id = $1`, taskID).Scan(&status)
	if status != "completed" {
		t.Fatalf("status = %q, want completed", status)
	}

	// 幂等守卫：已终态的 run 不被后续 failed 覆盖（WHERE status='running'）。
	testHandler.finalizeAgentRunStatus(ctx, task.ID, "failed")
	dbfx.QueryRow(t, `SELECT status FROM agent_run WHERE task_queue_id = $1`, taskID).Scan(&status)
	if status != "completed" {
		t.Fatalf("terminal run clobbered: status = %q, want completed", status)
	}

	// token 累加。
	testHandler.addAgentRunTokens(ctx, task.ID, 100)
	testHandler.addAgentRunTokens(ctx, task.ID, 50)
	var tokens int64
	dbfx.QueryRow(t, `SELECT token_used FROM agent_run WHERE task_queue_id = $1`, taskID).Scan(&tokens)
	if tokens != 150 {
		t.Fatalf("token_used = %d, want 150", tokens)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT/server && go test ./internal/handler/ -run 'TestFinalizeAgentRunStatus_AndTokens' -count=1`
Expected: 编译失败 —— `testHandler.finalizeAgentRunStatus undefined` / `addAgentRunTokens undefined`。

- [ ] **Step 3: 写实现（两个终态写入器）**

在 `server/internal/handler/agent_run_projector.go` 末尾追加：

```go
// finalizeAgentRunStatus 把 run 置为终态（completed/failed/cancelled）。
// WHERE status='running' 是幂等 + 防覆盖守卫：daemon 可能对同一 task 多次回调
// （如 cancel ack 与 fail 竞态），只有仍 running 的 run 才翻终态，已终态的不动。
// best-effort：错误只记日志，绝不阻断终态回调自身的权威事务。
func (h *Handler) finalizeAgentRunStatus(ctx context.Context, taskID pgtype.UUID, status string) {
	if !taskID.Valid {
		return
	}
	if _, err := h.DB.Exec(ctx, `
		UPDATE agent_run SET status = $2, updated_at = now()
		WHERE id = $1 AND status = 'running'`,
		agentRunIDForTask(taskID), status,
	); err != nil {
		slog.Warn("agent run finalize: update status failed",
			"task_id", uuidToString(taskID), "status", status, "error", err)
	}
}

// addAgentRunTokens 把一次 usage 上报的 token 数累加到 run.token_used。
// best-effort，同上。
func (h *Handler) addAgentRunTokens(ctx context.Context, taskID pgtype.UUID, tokens int64) {
	if !taskID.Valid || tokens <= 0 {
		return
	}
	if _, err := h.DB.Exec(ctx, `
		UPDATE agent_run SET token_used = token_used + $2, updated_at = now()
		WHERE id = $1`,
		agentRunIDForTask(taskID), tokens,
	); err != nil {
		slog.Warn("agent run tokens: accumulate failed",
			"task_id", uuidToString(taskID), "tokens", tokens, "error", err)
	}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd $ROOT/server && go test ./internal/handler/ -run 'TestFinalizeAgentRunStatus_AndTokens' -count=1`
Expected: PASS（需 DB；无 DB SKIP）。

- [ ] **Step 5: hook `CompleteTask`（daemon.go:3856 后）**

在 `task, err := h.TaskService.CompleteTask(…)` 成功、`h.emitIssueExecutedOnFirstCompletion(r, task)`（3868）之后插入：

```go
	// WS5：把该 task 的 agent_run 置为 completed（best-effort）。
	h.finalizeAgentRunStatus(r.Context(), task.ID, "completed")
```

> `task` 是 `*db.AgentTaskQueue`（`TaskService.CompleteTask` 返回），`task.ID` 有效。

- [ ] **Step 6: hook `failTask`（daemon.go:4543 后）**

在 `task, err := h.TaskService.FailTask(…)` 成功、`h.TaskService.NotifyTaskFinished(*task)`（4556）之后插入：

```go
	// WS5：把该 task 的 agent_run 置为 failed（best-effort）。
	h.finalizeAgentRunStatus(r.Context(), task.ID, "failed")
```

> 覆盖 `/fail` 端点与 `CompleteTask` 的 context-exhaustion 改道（3835 `h.failTask(…)`）两条路径——二者共用 `failTask`。

- [ ] **Step 7: hook `AckTaskCancelled`（daemon.go:4742 后）**

在 `task, ok := h.requireDaemonTaskAccess(w, r, taskID)`（4742）成功之后、函数体前部插入（cancelled 是权威终态，尽早置）：

```go
	// WS5：把该 task 的 agent_run 置为 cancelled（best-effort；WHERE status='running'
	// 守卫确保晚到的 ack 不覆盖已由 complete/fail 落定的终态）。
	h.finalizeAgentRunStatus(r.Context(), task.ID, "cancelled")
```

> `task` 是 `db.AgentTaskQueue` 值（`requireDaemonTaskAccess` 返回）。

- [ ] **Step 8: hook `ReportTaskUsage`（daemon.go:4422-4468）**

在 usage 循环（`for _, u := range req.Usage {`，4422）**之前**声明累加器，循环体内 `UpsertTaskUsage` 成功后累加，循环**之后**（4468 与 4470 之间）一次性写入：

```go
	var runTokens int64 // WS5：本批 usage 的总 token，循环后一次性累加到 agent_run
	for _, u := range req.Usage {
		provider := normalizeProvider(u.Provider)
		// …（原有 provider 回落 + UpsertTaskUsage + CaptureTaskUsage 逻辑不动）…
		if err := h.Queries.UpsertTaskUsage(r.Context(), db.UpsertTaskUsageParams{
			// …原样…
		}); err != nil {
			slog.Warn("upsert task usage failed", "task_id", taskID, "model", u.Model, "error", err)
			continue
		}
		runTokens += u.InputTokens + u.OutputTokens + u.CacheReadTokens + u.CacheWriteTokens
		h.TaskService.CaptureTaskUsage(r.Context(), task, provider, u.Model, u.InputTokens, u.OutputTokens, u.CacheReadTokens, u.CacheWriteTokens, u.CostUSDTicks)
		// …（原有 prompt-cache 日志不动）…
	}

	// WS5：把本批 token 累加到 agent_run.token_used（best-effort）。
	h.addAgentRunTokens(r.Context(), task.ID, runTokens)

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
```

> 只在 `UpsertTaskUsage` **成功**后累加（失败的 usage 行不计入 run token，与 runtime_usage 保持一致）。`runTokens` 声明在循环外、`continue` 之后累加，确保跳过的行不计。

- [ ] **Step 9: 编译 + 全 handler 回归**

Run:
```bash
cd $ROOT/server && gofmt -w internal/handler/agent_run_projector.go internal/handler/daemon.go && go build ./... && go test ./internal/handler/ -run 'AgentRun|TaskUsage|CompleteTask|FailTask|Cancel' -count=1
```
Expected: `go build` 无输出；测试 PASS / SKIP。

- [ ] **Step 10: 提交**

```bash
cd $ROOT && git add server/internal/handler/agent_run_projector.go server/internal/handler/agent_run_projector_test.go server/internal/handler/daemon.go
git commit -m "feat(agent-run): finalize run status and accumulate tokens on task terminal callbacks"
```

---

### WS5 收尾验证

- [ ] `cd $ROOT/server && go build ./...` → 无输出。
- [ ] `cd $ROOT/server && go test ./internal/handler/ -run 'AgentRun|ProjectAgentRun|ClassifyErrorEvent|ApplyAgentRunProjection|FinalizeAgentRunStatus'` → 全 PASS（无 DB 时 DB 用例 SKIP，纯派生用例仍 PASS）。
- [ ] `cd $ROOT/server && go test ./internal/daemon/ -count=1` → 全 PASS（CallID 透传零回归）。
- [ ] `cd $ROOT && make sqlc && git diff --exit-code -- server/pkg/db/generated` → 无 diff（WS5 全程用 handler 内原生 SQL，不碰 `pkg/db/queries/*.sql`，不触发 sqlc 门禁；run id 走确定性 UUID v5，**无需新迁移**）。
- [ ] 人工核对闭环：daemon 上报含 `call_id` 的 tool_use/tool_result → `agent_run` 出现一条 running run（cli_kind=runtime provider、root_issue_id 正确）；`agent_run_todo` 一条待办随 result 翻 done；`agent_run_event` 有 heartbeat/todo_change（+ 错误分类事件）；task complete/fail/cancel → run status 翻对应终态且不被晚到回调覆盖；usage 上报 → token_used 累加。
- [ ] 人工核对降级：旧 daemon（不发 `call_id`）→ 仍建 run + heartbeat + error 事件，只是不建 tool 待办（无孤儿 in_progress）；投影写库失败 → `ReportTaskMessages` 仍返回 200（task_message 已落），错误进日志。

---


## WS6 — 前端动线补全（画面 5 补全 + 画面 6/7 新建 + 画面 3 补全）

**目标**：把需求详情流水线补齐到 spec §10 的四面板终态——画面 5 拆解面板补 graph/acceptance 摘要框；画面 6 执行调度面板（倒计时 + 进度 + 互斥等待 + 手动触发）与画面 7 验收报告面板（轮次 + 报告 + 打回链 + pass/fail 人工仲裁）新建并挂到 flow-section 的 stage3/stage4；同时补齐 client.ts 的 trigger/verdict 端点、`Issue.acceptance_round` 类型、日历第 10 态「验收失败」色块映射、创建弹窗的 git 库选择器。

**依赖**：WS2 的 `POST /issues/{id}/trigger` 与 WS4 的 `POST /issues/{id}/acceptance/verdict` 契约（本 WS 的 client.ts 方法签名严格对齐二者的请求/响应体）。**画面 6/7（Task 6.1/6.3/6.4/6.5）必须在 WS2、WS4 之后进行**（端点契约稳定后联调）；画面 5 补全（Task 6.2）、日历色块（Task 6.6）、创建弹窗（Task 6.7）不依赖后端 WS，可独立先行。

### WS6 实证校正（撰写前直读确认，实现时以真实代码为准）

| 事项 | 真实结论（直读出处） | 对 WS6 的影响 |
| --- | --- | --- |
| 拖拽改期 + 视觉反馈 | **已完整落地**：`calendar-view.tsx:309-343` `handleDrop`（按日 delta 平移 start_at/due_date）、`:509` `draggable={!rescheduleLocked}`、`:515-522` `onDragStart` 写 `text/plain`=issue.id、`:418-432` `dragOverKey` + `ring-2 ring-inset ring-primary/50` 拖入高亮、`:167-173` `RESCHEDULE_LOCKED_STATUSES`（已触发态不可拖，对齐 §7.2 的 409）。 | **无需新任务**（原设想的「拖拽视觉反馈」是伪 gap）。 |
| `requirement_status` 可过滤性 | 它是 `issue.sql:18-33` 的 **CASE 实时派生投影**（§6:230「不落列」），非物理列；`view-store.FilterSnapshot`（`:125-135`）是「九个 **server-query-defining** 过滤字段」，派生态无法进 server 过滤。`module-filter-bar.tsx` 是**模块单一职责**的 client-only chip 行（`:22-24`）。 | **丢弃** FilterSnapshot 过滤维度 + module bar 待确认 chip（架构上不成立 / 非 Phase I spec 要求）。 |
| `RequirementBlock` 角色头像 | `calendar-view.tsx:473-564` 的 block 渲染 icon+identifier+title+status+progress；§10:377 对日历块的描述只到「派生态徽标 + 阶段进度」，未要求角色头像。 | **丢弃**（非 spec 要求，避免臆造）。 |
| DraftCard gn-box/acc-box | `requirement-decompose-panel.tsx:211-292` 的 DraftCard **实际未渲染** `graph_context`/`acceptance_spec`（只渲染 feature_points + assignee，且二者都被 `!isAcceptance` 门控 → stage4 卡片只剩标题 + 徽标）；但**文件头注释**（`:5-7`）、**测试头注释**（`requirement-decompose-panel.test.tsx:6-8`）与 **i18n 键** `decompose_panel.graph_title`/`acc_title`（en:977-978、zh-Hans:947-948，四语言齐备）**都已就位**——即原实现者意图渲染却漏了代码。 | **Task 6.2 补全**（i18n 键已存在，无需新增）。 |
| flow-section stage3/4 面板 | `requirement-flow-section.tsx:243-337` 的 return 块**只有 stage1（原型面板）与 stage2（拆解面板/进行中/发起按钮）分支**；`deriveFlowStage`（`:53-70`）会返回 3/4，但 3/4 **无任何面板渲染**（走到 337 直接 `</section>`）。 | **Task 6.3/6.4/6.5 新建 + 挂载**。 |
| `acceptance_round` 前端可见性 | 服务端**已发**：`issue.sql:15,444` SELECT `i.acceptance_round`、`issue.go:93` `AcceptanceRound int32 \`json:"acceptance_round"\``、`:351/400/479` 映射进响应；但前端 `Issue` 类型（`issue.ts:160-245`）**未声明** `acceptance_round`（`grep -rn acceptance_round packages/` 零命中）。 | **Task 6.1 补类型声明**（画面 7 轮次显示的数据源）。 |
| verdict 端点调用方 | WS4 的 `POST /issues/{id}/acceptance/verdict` 挂在 **member-authed** 组（`router.go:1893` 之后，测试用 `X-User-ID`）；而 daemon 只走 `/api/daemon/*` runtime-token 鉴权、**无法调用 member 路由**（WS5 pivot 已证）。§7.5③ 明确验收失败「转**人工仲裁**」。 | **画面 7 的 pass/fail 按钮 = 人工仲裁入口**，前端是合法调用方（Task 6.1 `submitAcceptanceVerdict` + Task 6.4 按钮）。 |
| 日历第 10 态色块 | `calendar-view.tsx:141-159` 的 `STATUS_ICON`/`STATUS_TONE` 只有 9 态（未拆解/原型待确认/拆解待确认/待触发/执行中/等待模块释放/验收中/已完成/已取消），**缺「验收失败」**；`:167-173` `RESCHEDULE_LOCKED_STATUSES` 也未含它。§6.1:272 要求第 10 态落地时「同步更新前端色块映射」。 | **Task 6.6 补映射**（WS4→WS6 联动）。 |
| 创建弹窗 git 库选择器 | `create-issue.tsx` 的 `showRequirementFields`（`:344`）块已含 goal/start_at/decompose_mode/auto_trigger/role-strip（`:1524-1611`），但 `grep repo_resource\|project_resource\|git` **零命中** → **无 git 库选择器**，创建 payload（`:596-601`）也不带 `repo_resource_id`；§10:378 要求「git 库选择（project_resource）」位于目标与分钟时间之间。 | **Task 6.7 补选择器**（复用 `projectResourcesOptions`，flow-section:135 已用同款）。 |

### WS6 端点契约（严格对齐 WS2/WS4，client.ts 签名以此为准）

| 端点 | 方法/鉴权 | 请求体 | 响应体（200） | 出处 |
| --- | --- | --- | --- | --- |
| `/api/issues/{id}/trigger` | POST / member | 无（空 body） | `{triggered:true, enqueued:<int>, issue_id:<string>}`；非顶层或预检不过 → 409（`this.fetch` 抛 `ApiError`，面板 catch + toast reason） | WS2 Task 2.5（plan:704-708） |
| `/api/issues/{id}/acceptance/verdict` | POST / member | `{verdict:"pass"\|"fail", evidence:<string>}` | pass→`{verdict:"pass", acceptance_round:<int>, terminal:true}`；fail→`{verdict:"fail", acceptance_round:<int>, terminal:false, repair_issue_id:<string>}`；非法 verdict→400 | WS4 Task 4.2/4.3（plan:1715-1719,1829-1834） |

### WS6 i18n 约束（贯穿全 WS）

新增的任何 i18n 键**必须同步写入四个 locale 文件**：`packages/views/locales/{en,zh-Hans,ja,ko}/issues.json`。`packages/views/locales/parity.test.ts` 双向断言 EN 与每个非 EN bundle 的**键集完全相等**（`:73-85`），漏一个语言即 FAIL。本 WS 新增段分属两个命名空间：`schedule_panel`（Task 6.3）、`acceptance_panel`（Task 6.4）写入 **`issues.json`**（面板用 `useT("issues")`）；`create_issue.repo_*`（Task 6.7）写入 **`modals.json`** 的既有 `create_issue` 段（`create-issue.tsx:138` 用 `useT("modals")`，`goal_label`/`start_at_label` 等已在此段，en:253-255）。`parity.test.ts:25-30` 从磁盘扫描**全部** `.json` 命名空间，故 issues.json 与 modals.json 同受双向门禁。Task 6.2 复用已存在的 `decompose_panel.graph_title`/`acc_title`（en:977-978），无新增。

**前端测试骨架**（全 WS 通用，直读 `requirement-decompose-panel.test.tsx` / `requirement-flow-section.test.tsx` / `client.test.ts` 得出）：

- 组件测试：文件头 `// @vitest-environment jsdom`（实为 `/** @vitest-environment jsdom */` 块注释）+ `renderWithI18n(ui)`（`packages/views/test/i18n.tsx:25`，默认 locale `en`，包裹生产 `RESOURCES`）；需 QueryClient 时用 `renderWithI18n(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)`（flow-section.test:112-119）。
- 面板回调**注入式**（`confirmDecomposition` 等由 props 传入，注释「Injected so tests can capture the payload」）→ 测试用 `vi.fn().mockResolvedValue(...)` 注入并断言 payload。
- mock 外部 hook：`vi.mock("@multica/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: (_t: string, id: string) => \`actor-${id}\` }) }))`、`vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }))`。
- client 测试：`const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({...}), { status: 200, headers: { "Content-Type": "application/json" } })); vi.stubGlobal("fetch", fetchMock); await new ApiClient("https://api.example.test").method(...); expect(fetchMock.mock.calls[0]?.[0]).toBe(<url>); expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });`（client.test.ts:264-283）；body 断言 `JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))`。
- 命令：`cd $ROOT && pnpm --filter @multica/views test -- <file>` / `pnpm --filter @multica/core test -- <file>`（vitest）；类型检查 `pnpm --filter @multica/views typecheck` / `pnpm --filter @multica/core typecheck`；i18n 门禁 `pnpm --filter @multica/views test -- locales/parity.test.ts`。

---

### Task 6.1: client.ts + 类型 —— trigger / acceptance verdict 端点 + `Issue.acceptance_round`

**Files:**
- Modify: `packages/core/types/issue.ts:244`（`stage_progress?` 之后、接口闭合 `}` 之前）
- Modify: `packages/core/types/api.ts:137`（`GetDecompositionResponse` 之后）
- Modify: `packages/core/api/client.ts:11-13`（类型 import 块）+ `:1407`（`decomposeRequirement` 之后）
- Test: `packages/core/api/client.test.ts`（文件末尾追加一个 describe）

- [ ] **Step 1: 先写失败测试（client.test.ts 末尾追加）**

在 `packages/core/api/client.test.ts` 末尾追加：

```ts
describe("ApiClient requirement calendar endpoints", () => {
  it("triggerRequirement POSTs an empty body to /trigger", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ triggered: true, enqueued: 2, issue_id: "req-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await new ApiClient("https://api.example.test").triggerRequirement("req-1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.test/api/issues/req-1/trigger");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(res).toEqual({ triggered: true, enqueued: 2, issue_id: "req-1" });
  });

  it("submitAcceptanceVerdict POSTs verdict+evidence to /acceptance/verdict", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ verdict: "fail", acceptance_round: 1, terminal: false, repair_issue_id: "child-9" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await new ApiClient("https://api.example.test").submitAcceptanceVerdict(
      "req-1",
      { verdict: "fail", evidence: "登录态刷新后丢失" },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/issues/req-1/acceptance/verdict",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      verdict: "fail",
      evidence: "登录态刷新后丢失",
    });
    expect(res.repair_issue_id).toBe("child-9");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT && pnpm --filter @multica/core test -- client.test.ts -t "requirement calendar"`
Expected: FAIL —— `client.triggerRequirement is not a function` / `submitAcceptanceVerdict is not a function`（typecheck 亦报方法不存在）。

- [ ] **Step 3: 加类型（issue.ts + api.ts）**

`packages/core/types/issue.ts` —— 在 `stage_progress?: string | null;`（`:244`）之后、接口闭合 `}`（`:245`）之前插入：

```ts
  /** 验收轮次（DEFAULT 0）；每次 verdict=fail +1，>3 判「验收失败」终态。服务端 issue.go:93 恒发。 */
  acceptance_round?: number;
```

`packages/core/types/api.ts` —— 在 `GetDecompositionResponse`（`:133-137`）之后插入：

```ts
/** POST /issues/{id}/trigger 的响应（spec §7.1 手动触发，与 30s sweep 共用服务）。 */
export interface TriggerRequirementResponse {
  triggered: boolean;
  /** 本次入队 agent_task_queue 的 stage3 子任务数。 */
  enqueued: number;
  issue_id: string;
}

/** POST /issues/{id}/acceptance/verdict 的响应（WS4 / spec §7.5③）。 */
export interface AcceptanceVerdictResponse {
  verdict: "pass" | "fail";
  /** 裁决后的轮次：pass 不变，fail 已 +1。 */
  acceptance_round: number;
  /** pass=true（需求转 done）；fail 未越界=false，越界（>3）由派生态呈现「验收失败」。 */
  terminal: boolean;
  /** 仅 fail 分支：新建的 stage3 修复子任务 id。 */
  repair_issue_id?: string;
}
```

> `packages/core/types/index.ts:140` 是 `export type * from "./api"` 通配 re-export，两个新类型**自动**从 `@multica/core/types` 导出，无需手改 index.ts。

- [ ] **Step 4: 加 client.ts 方法**

`packages/core/api/client.ts` —— 先在顶部从 `../types` 的 import 清单（`:11-13`，已含 `DecomposeDraftTask`/`ConfirmDecompositionResponse`/`GetDecompositionResponse`）补两行 `TriggerRequirementResponse,` 与 `AcceptanceVerdictResponse,`；再在 `decomposeRequirement`（`:1401-1407`）之后插入：

```ts
  /** 手动触发需求（spec §7.1/§9）：与 30s sweep 共用触发服务，幂等写 triggered_at
   *  并把无未完成依赖的 stage3 子任务入队。非顶层 / 预检不过 → 服务端 409，this.fetch 抛 ApiError。 */
  async triggerRequirement(issueId: string): Promise<TriggerRequirementResponse> {
    return this.fetch(`/api/issues/${issueId}/trigger`, { method: "POST" });
  }

  /** 上报验收裁决（WS4 / spec §7.5③，member-authed）：pass 让需求落 done；fail 让
   *  acceptance_round+1 并新建 stage3 修复子任务。画面 7 的人工仲裁按钮调用。 */
  async submitAcceptanceVerdict(
    issueId: string,
    body: { verdict: "pass" | "fail"; evidence: string },
  ): Promise<AcceptanceVerdictResponse> {
    return this.fetch(`/api/issues/${issueId}/acceptance/verdict`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
```

- [ ] **Step 5: 跑测试确认通过 + 类型检查**

Run: `cd $ROOT && pnpm --filter @multica/core test -- client.test.ts -t "requirement calendar"`
Expected: PASS（2 用例）。
Run: `cd $ROOT && pnpm --filter @multica/core typecheck`
Expected: 无类型错误。

- [ ] **Step 6: 提交**

```bash
cd $ROOT && git add packages/core/types/issue.ts packages/core/types/api.ts packages/core/api/client.ts packages/core/api/client.test.ts
git commit -m "feat(api): add triggerRequirement + submitAcceptanceVerdict and Issue.acceptance_round"
```

---

### Task 6.2: DraftCard 补 graph_context / acceptance_spec 摘要框（画面 5 补全）

**背景（实证）**：`requirement-decompose-panel.tsx` 文件头注释（`:5-7`）、测试头注释（`requirement-decompose-panel.test.tsx:6-8`）与 i18n 键 `decompose_panel.graph_title`/`acc_title`（en:977-978，四语言齐备）**都已声明要渲染「graph + acceptance summaries」**，但 `DraftCard`（`:211-292`）实际只渲染了 feature_points（`:239-270`）与 assignee（`:272-289`），二者都被 `!isAcceptance` 门控 —— 即原实现者意图渲染却漏了代码。本任务补齐这两个 **display-only** 摘要框。`graph_context`/`acceptance_spec` 在 `DecomposeDraftTask`（`api.ts:127-128`）里是 `unknown`（PM agent 产出形状尚未定型），故用防御式提取，**不新增 i18n 键**（复用已存在的 `graph_title`/`acc_title`）。

**Files:**
- Modify: `packages/views/issues/components/requirement-decompose-panel.tsx`（在 `DraftCard` 之前加两个纯函数；在 `:289` assignee `</label>` 之后、`:290` `</section>` 之前插入两个摘要框）
- Test: `packages/views/issues/components/requirement-decompose-panel.test.tsx`（新增 1 个 `it`）

- [ ] **Step 1: 先写失败测试**

在 `requirement-decompose-panel.test.tsx` 的 `子任务功能点表标注新增/改造`（`:142-150`）之后、`存在未标注 kind…`（`:152`）之前，插入一个 `it`（默认 `renderPanel()` 的 t1/t2 是 `execDraft`，带 `graph_context:{nodes:["n1"],edges:[]}`、`acceptance_spec:{version:1,cases:[{name:"c1"}]}`；t3 是 stage4 验收草稿，二者皆无）：

```tsx
  it("草稿卡渲染图谱上下文与验收代码摘要框（display-only）", () => {
    renderPanel();
    // exec 草稿 t1 带 graph_context.nodes=["n1"] 与 acceptance_spec.cases=[{name:"c1"}]。
    const gn = screen.getByTestId("draft-gn-t1");
    expect(within(gn).getByText("Graph context")).toBeTruthy();
    expect(within(gn).getByText("n1")).toBeTruthy();
    const acc = screen.getByTestId("draft-acc-t1");
    expect(within(acc).getByText("Acceptance spec")).toBeTruthy();
    expect(within(acc).getByText("c1")).toBeTruthy();
    // stage4 验收草稿 t3 二者皆无 → 不渲染摘要框（防御式：空数据不出框）。
    expect(screen.queryByTestId("draft-gn-t3")).toBeNull();
    expect(screen.queryByTestId("draft-acc-t3")).toBeNull();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT && pnpm --filter @multica/views test -- requirement-decompose-panel.test.tsx -t "摘要框"`
Expected: FAIL —— `Unable to find an element by: [data-testid="draft-gn-t1"]`（摘要框尚未渲染）。

- [ ] **Step 3: 加两个防御式提取纯函数**

在 `requirement-decompose-panel.tsx` 的 `hasUnmarkedFeaturePoint`（`:51-58`）之后、`export function RequirementDecomposePanel`（`:60`）之前插入：

```tsx
/**
 * graph_context / acceptance_spec 在 DecomposeDraftTask 里是 `unknown`（api.ts:127-128，
 * PM agent 产出形状未定型）。防御式提取可识别的数组项作为 display-only 芯片：
 * nodes 取字符串或 {id|label}，cases 取字符串或 {name}；无法识别 → 空数组（不出框）。
 */
function graphNodeLabels(graph: unknown): string[] {
  if (!graph || typeof graph !== "object") return [];
  const nodes = (graph as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((n) =>
      typeof n === "string"
        ? n
        : n && typeof n === "object"
          ? String((n as Record<string, unknown>).id ?? (n as Record<string, unknown>).label ?? "")
          : "",
    )
    .filter((s) => s.length > 0);
}

function acceptanceCaseNames(spec: unknown): string[] {
  if (!spec || typeof spec !== "object") return [];
  const cases = (spec as Record<string, unknown>).cases;
  if (!Array.isArray(cases)) return [];
  return cases
    .map((c) =>
      typeof c === "string"
        ? c
        : c && typeof c === "object"
          ? String((c as Record<string, unknown>).name ?? "")
          : "",
    )
    .filter((s) => s.length > 0);
}
```

- [ ] **Step 4: 在 DraftCard 尾部插入两个摘要框**

在 `DraftCard` 的 assignee `<label>…</label>` 块结束（`:289` 的 `)}`）之后、`</section>`（`:290`）之前插入（**不加 `!isAcceptance` 门控** —— 摘要框对任何带数据的草稿都渲染，与文件头注释「draft cards … graph + acceptance summaries」一致）：

```tsx
      {graphNodeLabels(draft.graph_context).length > 0 && (
        <div className="mt-1" data-testid={`draft-gn-${draft.temp_id}`}>
          <h5 className="text-2xs text-muted-foreground">{t(($) => $.decompose_panel.graph_title)}</h5>
          <div className="flex flex-wrap gap-1">
            {graphNodeLabels(draft.graph_context).map((n) => (
              <code key={n} className="rounded bg-muted px-1 text-2xs">{n}</code>
            ))}
          </div>
        </div>
      )}

      {acceptanceCaseNames(draft.acceptance_spec).length > 0 && (
        <div className="mt-1" data-testid={`draft-acc-${draft.temp_id}`}>
          <h5 className="text-2xs text-muted-foreground">{t(($) => $.decompose_panel.acc_title)}</h5>
          <div className="flex flex-wrap gap-1">
            {acceptanceCaseNames(draft.acceptance_spec).map((c) => (
              <code key={c} className="rounded bg-muted px-1 text-2xs">{c}</code>
            ))}
          </div>
        </div>
      )}
```

- [ ] **Step 5: 跑测试确认通过 + 类型检查**

Run: `cd $ROOT && pnpm --filter @multica/views test -- requirement-decompose-panel.test.tsx`
Expected: PASS（原 5 用例 + 新 1 用例 = 6 全过）。
Run: `cd $ROOT && pnpm --filter @multica/views typecheck`
Expected: 无类型错误。

- [ ] **Step 6: 提交**

```bash
cd $ROOT && git add packages/views/issues/components/requirement-decompose-panel.tsx packages/views/issues/components/requirement-decompose-panel.test.tsx
git commit -m "feat(decompose-panel): render graph_context/acceptance_spec summary boxes in DraftCard"
```

---

### Task 6.3: 新建 `RequirementSchedulePanel`（画面 6：倒计时 + 进度 + 互斥等待 + 手动触发）

**背景（spec §10 画面 6）**：执行阶段（stage3）面板，展示：① 触发倒计时 / 已触发时刻；② stage3 子任务进度（`issue.stage_progress` "N/M" + 子任务状态清单）；③ 互斥等待 banner（`requirement_status === "等待模块释放"`，对齐 WS3 组锁）；④ 手动触发按钮（调 `client.triggerRequirement` → `POST /issues/{id}/trigger`，409 时 toast 原因）。数据源全部来自 `Issue` 既有字段（`start_at`/`triggered_at`/`requirement_status`/`stage_progress`，`issue.ts:229-244`）与挂载点传入的 `childIssues`。触发回调**注入式**（与 `confirmDecomposition` 同约定，注释「Injected so tests can capture the call」）。

**Files:**
- Create: `packages/views/issues/components/requirement-schedule-panel.tsx`
- Create: `packages/views/issues/components/requirement-schedule-panel.test.tsx`
- Modify: `packages/views/locales/{en,zh-Hans,ja,ko}/issues.json`（新增 `schedule_panel` 段，11 键 × 4 语言）

- [ ] **Step 1: 先写失败测试**

新建 `packages/views/issues/components/requirement-schedule-panel.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 *
 * RequirementSchedulePanel（spec 画面 6）：执行阶段面板 —— 触发倒计时 / 已触发时刻、
 * stage3 子任务进度、互斥等待 banner（等待模块释放）、手动触发按钮（调注入的
 * triggerRequirement，409 时 toast 原因）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { RequirementSchedulePanel } from "./requirement-schedule-panel";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function requirement(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "req-1",
    identifier: "REQ-101",
    stage_progress: "1/3",
    triggered_at: null,
    start_at: "2026-09-10T09:30:00Z",
    requirement_status: "待触发",
    ...overrides,
  } as unknown as Issue;
}

function child(id: string, status: string): Issue {
  return { id, identifier: `REQ-${id}`, title: `子任务 ${id}`, stage: 3, status } as unknown as Issue;
}

describe("RequirementSchedulePanel", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("未触发时渲染倒计时 + 手动触发按钮 + stage3 进度清单", () => {
    renderWithI18n(
      <RequirementSchedulePanel
        issue={requirement()}
        childIssues={[child("c1", "todo"), child("c2", "done")]}
        triggerRequirement={vi.fn()}
      />,
    );
    expect(screen.getByTestId("schedule-countdown").textContent).toMatch(/09:30/);
    expect(screen.getByTestId("schedule-trigger")).toBeTruthy();
    expect(screen.getByTestId("schedule-progress").textContent).toContain("1/3");
    expect(screen.getByTestId("schedule-child-c1")).toBeTruthy();
    expect(screen.getByTestId("schedule-child-c2")).toBeTruthy();
  });

  it("等待模块释放时渲染互斥 banner；无子任务时渲染空态", () => {
    renderWithI18n(
      <RequirementSchedulePanel
        issue={requirement({ requirement_status: "等待模块释放" })}
        childIssues={[]}
        triggerRequirement={vi.fn()}
      />,
    );
    expect(screen.getByTestId("schedule-waiting-lock")).toBeTruthy();
    expect(screen.getByTestId("schedule-progress").textContent).toContain("No execution subtasks yet");
  });

  it("已触发时显示已触发徽标、不渲染触发按钮", () => {
    renderWithI18n(
      <RequirementSchedulePanel
        issue={requirement({ triggered_at: "2026-09-10T09:30:05Z" })}
        childIssues={[]}
        triggerRequirement={vi.fn()}
      />,
    );
    expect(screen.getByTestId("schedule-triggered")).toBeTruthy();
    expect(screen.queryByTestId("schedule-trigger")).toBeNull();
    expect(screen.getByTestId("schedule-countdown").textContent).toMatch(/09:30/);
  });

  it("点击触发调用 triggerRequirement(issueId)", async () => {
    const trigger = vi.fn().mockResolvedValue({ triggered: true, enqueued: 2, issue_id: "req-1" });
    renderWithI18n(
      <RequirementSchedulePanel issue={requirement()} childIssues={[]} triggerRequirement={trigger} />,
    );
    fireEvent.click(screen.getByTestId("schedule-trigger"));
    await waitFor(() => expect(trigger).toHaveBeenCalledWith("req-1"));
  });

  it("触发被拒（409）时 toast 服务端原因", async () => {
    const trigger = vi.fn().mockRejectedValue(new Error("module_window_busy"));
    renderWithI18n(
      <RequirementSchedulePanel issue={requirement()} childIssues={[]} triggerRequirement={trigger} />,
    );
    fireEvent.click(screen.getByTestId("schedule-trigger"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("module_window_busy"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT && pnpm --filter @multica/views test -- requirement-schedule-panel.test.tsx`
Expected: FAIL —— `Cannot find module './requirement-schedule-panel'`（组件尚未创建）。

- [ ] **Step 3: 新建组件**

新建 `packages/views/issues/components/requirement-schedule-panel.tsx`：

```tsx
/**
 * RequirementSchedulePanel — 执行阶段面板（spec 2026-09-04-requirement-calendar
 * 画面 6）：触发倒计时 / 已触发时刻、stage3 子任务进度、互斥等待 banner
 * （requirement_status==="等待模块释放"，对齐 WS3 组锁）、手动触发按钮
 * （POST /issues/{id}/trigger，与 30s sweep 共用触发服务；409 → toast 原因）。
 *
 * 触发回调由挂载点（flow-section）注入，与 confirmDecomposition 同约定，便于测试
 * 捕获调用。所有数据取自 Issue 既有投影字段，面板本身不发查询。
 */
import { useState } from "react";
import type { Issue, TriggerRequirementResponse } from "@multica/core/types";
import { toast } from "sonner";
import { useT } from "../../i18n";

/** Minute-granularity UTC timestamp（与 decompose-panel / calendar 同一约定）。 */
function formatMinuteUTC(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

interface RequirementSchedulePanelProps {
  issue: Issue;
  /** 挂载点已查询的子任务列表；面板只取 stage3 展示执行进度。 */
  childIssues: Issue[];
  /** Calls POST /issues/{id}/trigger. Injected so tests can capture the call. */
  triggerRequirement: (issueId: string) => Promise<TriggerRequirementResponse>;
}

export function RequirementSchedulePanel({
  issue,
  childIssues,
  triggerRequirement,
}: RequirementSchedulePanelProps) {
  const { t } = useT("issues");
  const [triggering, setTriggering] = useState(false);
  const triggered = issue.triggered_at != null;
  const waitingLock = issue.requirement_status === "等待模块释放";
  const stage3 = childIssues.filter((c) => c.stage === 3);

  const onTrigger = async () => {
    setTriggering(true);
    try {
      await triggerRequirement(issue.id);
      toast.success(t(($) => $.schedule_panel.trigger_ok));
    } catch (e) {
      // 服务端 409 带 reason（decomposition_not_confirmed / dependency_cycle /
      // acceptance_spec_missing / module_window_busy）；this.fetch 抛 ApiError(message=reason)。
      toast.error(e instanceof Error ? e.message : t(($) => $.schedule_panel.trigger_failed));
    } finally {
      setTriggering(false);
    }
  };

  return (
    <section className="rounded-md border bg-card p-3" data-testid="schedule-panel">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t(($) => $.schedule_panel.title)}</h4>
        {triggered ? (
          <span
            className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-2xs text-emerald-600"
            data-testid="schedule-triggered"
          >
            {t(($) => $.schedule_panel.already_triggered)}
          </span>
        ) : (
          <button
            type="button"
            data-testid="schedule-trigger"
            disabled={triggering}
            onClick={() => void onTrigger()}
            className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
          >
            {triggering
              ? t(($) => $.schedule_panel.triggering)
              : t(($) => $.schedule_panel.trigger)}
          </button>
        )}
      </header>

      {/* 倒计时 / 触发时刻：start_at 是分钟精度 t0（design §5）。 */}
      <div className="mb-2 text-xs text-muted-foreground" data-testid="schedule-countdown">
        {triggered
          ? `${t(($) => $.schedule_panel.started_at)} ${formatMinuteUTC(issue.triggered_at) ?? "—"}`
          : `${t(($) => $.schedule_panel.countdown_label)} ${formatMinuteUTC(issue.start_at) ?? "—"}`}
      </div>

      {/* 互斥等待：WS3 组锁未释放时派生态为「等待模块释放」。 */}
      {waitingLock && (
        <p
          className="mb-2 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-600"
          data-testid="schedule-waiting-lock"
        >
          {t(($) => $.schedule_panel.waiting_lock)}
        </p>
      )}

      {/* 进度：stage_progress 是 server 投影的 "N/M"（issue.sql §6）。 */}
      <div data-testid="schedule-progress">
        <h5 className="text-2xs text-muted-foreground">
          {t(($) => $.schedule_panel.progress_label)}
          {issue.stage_progress ? ` · ${issue.stage_progress}` : ""}
        </h5>
        {stage3.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t(($) => $.schedule_panel.no_children)}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {stage3.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-1.5 text-xs"
                data-testid={`schedule-child-${c.id}`}
              >
                <span>{c.identifier}</span>
                <span className="text-muted-foreground">{c.title}</span>
                <span className="ml-auto rounded bg-muted px-1 text-2xs">{c.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: 新增 `schedule_panel` i18n 段（四语言同步）**

在四个 locale 的 `issues.json` 里、`requirement_flow` 段（en:1019-1028）**之后**、文件收尾 `}` 之前，各加一个 `schedule_panel` 段（11 键，顺序一致，`parity.test.ts` 双向断言键集相等）。

`packages/views/locales/en/issues.json`：

```json
  "schedule_panel": {
    "title": "Execution schedule",
    "countdown_label": "Starts at",
    "started_at": "Triggered at",
    "already_triggered": "Triggered",
    "waiting_lock": "Waiting for the module lock — another requirement group is running on this module",
    "progress_label": "Stage progress",
    "no_children": "No execution subtasks yet",
    "trigger": "Trigger now",
    "triggering": "Triggering…",
    "trigger_ok": "Requirement triggered — execution subtasks enqueued",
    "trigger_failed": "Failed to trigger requirement"
  }
```

`packages/views/locales/zh-Hans/issues.json`：

```json
  "schedule_panel": {
    "title": "执行调度",
    "countdown_label": "计划开始",
    "started_at": "已触发于",
    "already_triggered": "已触发",
    "waiting_lock": "正在等待模块锁释放 —— 本模块上有其他需求组正在执行",
    "progress_label": "阶段进度",
    "no_children": "暂无执行子任务",
    "trigger": "立即触发",
    "triggering": "触发中…",
    "trigger_ok": "需求已触发 —— 执行子任务已入队",
    "trigger_failed": "触发需求失败"
  }
```

`packages/views/locales/ja/issues.json`：

```json
  "schedule_panel": {
    "title": "実行スケジュール",
    "countdown_label": "開始時刻",
    "started_at": "トリガー時刻",
    "already_triggered": "トリガー済み",
    "waiting_lock": "モジュールロックの解放を待機中 —— このモジュールでは他の要求グループが実行中です",
    "progress_label": "ステージ進捗",
    "no_children": "実行サブタスクはまだありません",
    "trigger": "今すぐトリガー",
    "triggering": "トリガー中…",
    "trigger_ok": "要求をトリガーしました —— 実行サブタスクをキューに追加しました",
    "trigger_failed": "要求のトリガーに失敗しました"
  }
```

`packages/views/locales/ko/issues.json`：

```json
  "schedule_panel": {
    "title": "실행 스케줄",
    "countdown_label": "시작 시각",
    "started_at": "트리거 시각",
    "already_triggered": "트리거됨",
    "waiting_lock": "모듈 락 해제 대기 중 —— 이 모듈에서 다른 요구 사항 그룹이 실행 중입니다",
    "progress_label": "단계 진행률",
    "no_children": "실행 하위 작업이 아직 없습니다",
    "trigger": "지금 트리거",
    "triggering": "트리거 중…",
    "trigger_ok": "요구 사항이 트리거되었습니다 —— 실행 하위 작업이 대기열에 추가되었습니다",
    "trigger_failed": "요구 사항 트리거에 실패했습니다"
  }
```

> **类型自动跟随（已直读确认）**：`packages/views/i18n/resources-types.ts:51` 是 `issues: typeof issues`，而 `issues` 来自 `:9` 的 `import type issues from "../locales/en/issues.json"` —— 即 `issues` 命名空间类型**从 en JSON 推导**。故在 en/issues.json 加 `schedule_panel` 段后，`t(($) => $.schedule_panel.*)` 的类型自动生效，**无需手改 resources-types.ts**（modals 命名空间同理，`:24/66`）。

- [ ] **Step 5: 跑测试确认通过 + i18n 门禁 + 类型检查**

Run: `cd $ROOT && pnpm --filter @multica/views test -- requirement-schedule-panel.test.tsx`
Expected: PASS（5 用例）。
Run: `cd $ROOT && pnpm --filter @multica/views test -- locales/parity.test.ts`
Expected: PASS（`issues: zh-Hans/ja/ko covers every EN key` 与反向均绿 —— `schedule_panel` 11 键四语言齐备）。
Run: `cd $ROOT && pnpm --filter @multica/views typecheck`
Expected: 无类型错误。

- [ ] **Step 6: 提交**

```bash
cd $ROOT && git add packages/views/issues/components/requirement-schedule-panel.tsx packages/views/issues/components/requirement-schedule-panel.test.tsx packages/views/locales/en/issues.json packages/views/locales/zh-Hans/issues.json packages/views/locales/ja/issues.json packages/views/locales/ko/issues.json
git commit -m "feat(schedule-panel): add RequirementSchedulePanel (画面6) with countdown/progress/lock-wait/manual-trigger"
```

---

### Task 6.4: 新建 `RequirementAcceptancePanel`（画面 7：轮次 + 报告 + 打回链 + pass/fail 人工仲裁）

**背景（spec §10 画面 7 + §7.5③）**：验收阶段（stage4）面板，展示：① 验收轮次（`issue.acceptance_round`，DEFAULT 0、每 fail +1、>3 判验收失败终态 —— 对齐 WS4 Task 4.1/4.4 与 migration 452:15）；② stage4 tester 子任务的验收报告清单；③ 打回链（fail 分支新建的 stage3 修复子任务，WS4 Task 4.3）；④ **pass/fail 人工仲裁入口** —— evidence 文本框 + 两个按钮，调 `client.submitAcceptanceVerdict` → `POST /issues/{id}/acceptance/verdict`（member-authed；§7.5③ 明确「验收失败转人工仲裁」，daemon 无法调 member 路由，故前端按钮是合法仲裁入口，见 WS6 实证校正表）。`round > 3` 时渲染验收失败仲裁 banner。

**Files:**
- Create: `packages/views/issues/components/requirement-acceptance-panel.tsx`
- Create: `packages/views/issues/components/requirement-acceptance-panel.test.tsx`
- Modify: `packages/views/locales/{en,zh-Hans,ja,ko}/issues.json`（新增 `acceptance_panel` 段，13 键 × 4 语言）

- [ ] **Step 1: 先写失败测试**

新建 `packages/views/issues/components/requirement-acceptance-panel.test.tsx`：

```tsx
/**
 * @vitest-environment jsdom
 *
 * RequirementAcceptancePanel（spec 画面 7）：验收阶段面板 —— 验收轮次、stage4 tester
 * 报告清单、stage3 打回链、pass/fail 人工仲裁（evidence 必填，调注入的
 * submitAcceptanceVerdict）；round>3 渲染验收失败仲裁 banner。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { RequirementAcceptancePanel } from "./requirement-acceptance-panel";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function requirement(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "req-1",
    identifier: "REQ-101",
    acceptance_round: 0,
    requirement_status: "验收中",
    ...overrides,
  } as unknown as Issue;
}

function child(id: string, stage: number, status: string): Issue {
  return { id, identifier: `REQ-${id}`, title: `子任务 ${id}`, stage, status } as unknown as Issue;
}

describe("RequirementAcceptancePanel", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("渲染轮次 + stage4 验收报告 + stage3 打回链", () => {
    renderWithI18n(
      <RequirementAcceptancePanel
        issue={requirement({ acceptance_round: 1 })}
        childIssues={[child("t1", 4, "todo"), child("r1", 3, "done")]}
        submitAcceptanceVerdict={vi.fn()}
      />,
    );
    expect(screen.getByTestId("acceptance-round").textContent).toContain("1");
    expect(screen.getByTestId("acceptance-tester-t1")).toBeTruthy();
    expect(screen.getByTestId("acceptance-repair-r1")).toBeTruthy();
  });

  it("round>3 渲染验收失败仲裁 banner", () => {
    renderWithI18n(
      <RequirementAcceptancePanel
        issue={requirement({ acceptance_round: 4 })}
        childIssues={[]}
        submitAcceptanceVerdict={vi.fn()}
      />,
    );
    expect(screen.getByTestId("acceptance-failed-banner")).toBeTruthy();
  });

  it("evidence 为空时 pass/fail 均禁用", () => {
    renderWithI18n(
      <RequirementAcceptancePanel issue={requirement()} childIssues={[]} submitAcceptanceVerdict={vi.fn()} />,
    );
    expect((screen.getByTestId("acceptance-pass") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("acceptance-fail") as HTMLButtonElement).disabled).toBe(true);
  });

  it("填 evidence 后点 pass 调用 submitAcceptanceVerdict(pass)", async () => {
    const submit = vi.fn().mockResolvedValue({ verdict: "pass", acceptance_round: 0, terminal: true });
    renderWithI18n(
      <RequirementAcceptancePanel issue={requirement()} childIssues={[]} submitAcceptanceVerdict={submit} />,
    );
    fireEvent.change(screen.getByTestId("acceptance-evidence"), { target: { value: "全部用例通过" } });
    fireEvent.click(screen.getByTestId("acceptance-pass"));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith("req-1", { verdict: "pass", evidence: "全部用例通过" }),
    );
  });

  it("点 fail 调用 submitAcceptanceVerdict(fail) 并带 evidence", async () => {
    const submit = vi
      .fn()
      .mockResolvedValue({ verdict: "fail", acceptance_round: 1, terminal: false, repair_issue_id: "r2" });
    renderWithI18n(
      <RequirementAcceptancePanel issue={requirement()} childIssues={[]} submitAcceptanceVerdict={submit} />,
    );
    fireEvent.change(screen.getByTestId("acceptance-evidence"), { target: { value: "用例 c1 失败" } });
    fireEvent.click(screen.getByTestId("acceptance-fail"));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith("req-1", { verdict: "fail", evidence: "用例 c1 失败" }),
    );
  });

  it("裁决被拒时 toast 服务端原因", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("invalid verdict"));
    renderWithI18n(
      <RequirementAcceptancePanel issue={requirement()} childIssues={[]} submitAcceptanceVerdict={submit} />,
    );
    fireEvent.change(screen.getByTestId("acceptance-evidence"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("acceptance-pass"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("invalid verdict"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT && pnpm --filter @multica/views test -- requirement-acceptance-panel.test.tsx`
Expected: FAIL —— `Cannot find module './requirement-acceptance-panel'`。

- [ ] **Step 3: 新建组件**

新建 `packages/views/issues/components/requirement-acceptance-panel.tsx`：

```tsx
/**
 * RequirementAcceptancePanel — 验收阶段面板（spec 2026-09-04-requirement-calendar
 * 画面 7）：验收轮次（acceptance_round，DEFAULT 0 / 每 fail +1 / >3 判验收失败终态）、
 * stage4 tester 报告清单、stage3 打回链（fail 分支新建的修复子任务）、pass/fail
 * 人工仲裁入口（evidence 必填 → POST /issues/{id}/acceptance/verdict，member-authed）。
 *
 * §7.5③：验收失败「转人工仲裁」；daemon 只走 runtime-token 路由、无法调 member 路由，
 * 故本面板的 pass/fail 按钮是合法的人工仲裁入口。裁决回调由挂载点（flow-section）注入。
 */
import { useState } from "react";
import type { AcceptanceVerdictResponse, Issue } from "@multica/core/types";
import { toast } from "sonner";
import { useT } from "../../i18n";

/** 验收轮次上限（design §9 / WS4 Task 4.4）：round>3 判验收失败终态。 */
const MAX_ACCEPTANCE_ROUND = 3;

interface RequirementAcceptancePanelProps {
  issue: Issue;
  /** 挂载点已查询的子任务列表：stage4=tester 报告，stage3=打回修复链。 */
  childIssues: Issue[];
  /** Calls POST /issues/{id}/acceptance/verdict. Injected so tests can capture the payload. */
  submitAcceptanceVerdict: (
    issueId: string,
    body: { verdict: "pass" | "fail"; evidence: string },
  ) => Promise<AcceptanceVerdictResponse>;
}

export function RequirementAcceptancePanel({
  issue,
  childIssues,
  submitAcceptanceVerdict,
}: RequirementAcceptancePanelProps) {
  const { t } = useT("issues");
  const [evidence, setEvidence] = useState("");
  const [submitting, setSubmitting] = useState<"pass" | "fail" | null>(null);
  const round = issue.acceptance_round ?? 0;
  const failed = round > MAX_ACCEPTANCE_ROUND;
  const testers = childIssues.filter((c) => c.stage === 4);
  const repairs = childIssues.filter((c) => c.stage === 3);

  const submit = async (verdict: "pass" | "fail") => {
    setSubmitting(verdict);
    try {
      await submitAcceptanceVerdict(issue.id, { verdict, evidence: evidence.trim() });
      toast.success(t(($) => $.acceptance_panel.verdict_ok));
      setEvidence("");
    } catch (e) {
      // 400（非法 verdict）/ 500；this.fetch 抛 ApiError(message=服务端 body)。
      toast.error(e instanceof Error ? e.message : t(($) => $.acceptance_panel.verdict_failed));
    } finally {
      setSubmitting(null);
    }
  };

  const canSubmit = evidence.trim().length > 0 && submitting == null;

  return (
    <section className="rounded-md border bg-card p-3" data-testid="acceptance-panel">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t(($) => $.acceptance_panel.title)}</h4>
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground"
          data-testid="acceptance-round"
        >
          {t(($) => $.acceptance_panel.round_label)} {round} / {MAX_ACCEPTANCE_ROUND}
        </span>
      </header>

      {/* 验收失败终态（round>3）：转人工仲裁 banner（§7.5③）。 */}
      {failed && (
        <p
          className="mb-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
          data-testid="acceptance-failed-banner"
        >
          {t(($) => $.acceptance_panel.failed_banner)}
        </p>
      )}

      {/* 验收报告：stage4 tester 子任务。 */}
      <div className="mb-2" data-testid="acceptance-report">
        <h5 className="text-2xs text-muted-foreground">{t(($) => $.acceptance_panel.report_title)}</h5>
        {testers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t(($) => $.acceptance_panel.no_report)}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {testers.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-1.5 text-xs"
                data-testid={`acceptance-tester-${c.id}`}
              >
                <span>{c.identifier}</span>
                <span className="text-muted-foreground">{c.title}</span>
                <span className="ml-auto rounded bg-muted px-1 text-2xs">{c.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 打回链：fail 分支新建的 stage3 修复子任务（WS4 Task 4.3）。 */}
      {repairs.length > 0 && (
        <div className="mb-2" data-testid="acceptance-repairs">
          <h5 className="text-2xs text-muted-foreground">{t(($) => $.acceptance_panel.repairs_title)}</h5>
          <ul className="mt-1 flex flex-col gap-0.5">
            {repairs.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-1.5 text-xs"
                data-testid={`acceptance-repair-${c.id}`}
              >
                <span>{c.identifier}</span>
                <span className="text-muted-foreground">{c.title}</span>
                <span className="ml-auto rounded bg-muted px-1 text-2xs">{c.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 人工仲裁：evidence 必填 + pass/fail（§7.5③）。 */}
      <div className="flex flex-col gap-1.5" data-testid="acceptance-arbitration">
        <textarea
          className="w-full rounded-md border bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          rows={2}
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder={t(($) => $.acceptance_panel.evidence_placeholder)}
          data-testid="acceptance-evidence"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="acceptance-pass"
            disabled={!canSubmit}
            onClick={() => void submit("pass")}
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            {submitting === "pass"
              ? t(($) => $.acceptance_panel.submitting)
              : t(($) => $.acceptance_panel.pass)}
          </button>
          <button
            type="button"
            data-testid="acceptance-fail"
            disabled={!canSubmit}
            onClick={() => void submit("fail")}
            className="rounded-md bg-destructive px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            {submitting === "fail"
              ? t(($) => $.acceptance_panel.submitting)
              : t(($) => $.acceptance_panel.fail)}
          </button>
          {evidence.trim().length === 0 && (
            <span className="text-2xs text-muted-foreground" data-testid="acceptance-evidence-hint">
              {t(($) => $.acceptance_panel.evidence_required)}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: 新增 `acceptance_panel` i18n 段（四语言同步）**

在四个 locale 的 `issues.json` 里、Task 6.3 新增的 `schedule_panel` 段**之后**、文件收尾 `}` 之前，各加一个 `acceptance_panel` 段（13 键，顺序一致）。

`packages/views/locales/en/issues.json`：

```json
  "acceptance_panel": {
    "title": "Acceptance",
    "round_label": "Round",
    "failed_banner": "Acceptance failed after 3 rounds — manual arbitration required",
    "report_title": "Acceptance report",
    "no_report": "No tester subtask yet",
    "repairs_title": "Repair chain",
    "evidence_placeholder": "Arbitration evidence (required)…",
    "evidence_required": "Evidence is required before submitting a verdict",
    "pass": "Pass",
    "fail": "Reject",
    "submitting": "Submitting…",
    "verdict_ok": "Verdict submitted",
    "verdict_failed": "Failed to submit verdict"
  }
```

`packages/views/locales/zh-Hans/issues.json`：

```json
  "acceptance_panel": {
    "title": "验收",
    "round_label": "轮次",
    "failed_banner": "已打回 3 轮仍未通过 —— 需人工仲裁",
    "report_title": "验收报告",
    "no_report": "暂无验收子任务",
    "repairs_title": "打回修复链",
    "evidence_placeholder": "仲裁依据（必填）…",
    "evidence_required": "提交裁决前必须填写仲裁依据",
    "pass": "通过",
    "fail": "打回",
    "submitting": "提交中…",
    "verdict_ok": "裁决已提交",
    "verdict_failed": "提交裁决失败"
  }
```

`packages/views/locales/ja/issues.json`：

```json
  "acceptance_panel": {
    "title": "受け入れ",
    "round_label": "ラウンド",
    "failed_banner": "3 回の差し戻し後も未通過 —— 手動仲裁が必要です",
    "report_title": "受け入れレポート",
    "no_report": "テスターサブタスクはまだありません",
    "repairs_title": "差し戻し修復チェーン",
    "evidence_placeholder": "仲裁の根拠（必須）…",
    "evidence_required": "判定を送信する前に根拠を入力してください",
    "pass": "合格",
    "fail": "差し戻し",
    "submitting": "送信中…",
    "verdict_ok": "判定を送信しました",
    "verdict_failed": "判定の送信に失敗しました"
  }
```

`packages/views/locales/ko/issues.json`：

```json
  "acceptance_panel": {
    "title": "검수",
    "round_label": "라운드",
    "failed_banner": "3회 반려 후에도 미통과 —— 수동 중재가 필요합니다",
    "report_title": "검수 보고서",
    "no_report": "테스터 하위 작업이 아직 없습니다",
    "repairs_title": "반려 수리 체인",
    "evidence_placeholder": "중재 근거(필수)…",
    "evidence_required": "판정을 제출하기 전에 근거를 입력해야 합니다",
    "pass": "통과",
    "fail": "반려",
    "submitting": "제출 중…",
    "verdict_ok": "판정이 제출되었습니다",
    "verdict_failed": "판정 제출에 실패했습니다"
  }
```

- [ ] **Step 5: 跑测试确认通过 + i18n 门禁 + 类型检查**

Run: `cd $ROOT && pnpm --filter @multica/views test -- requirement-acceptance-panel.test.tsx`
Expected: PASS（6 用例）。
Run: `cd $ROOT && pnpm --filter @multica/views test -- locales/parity.test.ts`
Expected: PASS（`acceptance_panel` 13 键四语言齐备，双向绿）。
Run: `cd $ROOT && pnpm --filter @multica/views typecheck`
Expected: 无类型错误（`issue.acceptance_round` 已由 Task 6.1 声明）。

- [ ] **Step 6: 提交**

```bash
cd $ROOT && git add packages/views/issues/components/requirement-acceptance-panel.tsx packages/views/issues/components/requirement-acceptance-panel.test.tsx packages/views/locales/en/issues.json packages/views/locales/zh-Hans/issues.json packages/views/locales/ja/issues.json packages/views/locales/ko/issues.json
git commit -m "feat(acceptance-panel): add RequirementAcceptancePanel (画面7) with round/report/repair-chain/manual arbitration"
```

---

### Task 6.5: `flow-section` 挂载 stage3→schedule、stage4→acceptance + trigger/verdict 回调

**背景（实证）**：`requirement-flow-section.tsx` 的 `deriveFlowStage`（`:53-70`）会返回 3/4，但 return 块（`:243-337`）**只有 stage1（原型面板）与 stage2（拆解面板/进行中/发起按钮）分支**，stage3/4 走到 `:337` 直接 `</section>`，无任何面板。本任务：① 加 `triggerRequirement`/`submitAcceptanceVerdict` 两个注入式回调（mirror `confirmDecomposition` 的 `:165-184` 模式：调 api → `invalidateQueries` children/detail → 返回响应）；② 在 stage2 分支（`:336` 的 `))}`）之后挂载 stage3→`RequirementSchedulePanel`、stage4→`RequirementAcceptancePanel`。

**Files:**
- Modify: `packages/views/issues/components/requirement-flow-section.tsx`（import + 2 回调 + return 块 2 分支）
- Modify: `packages/views/issues/components/requirement-flow-section.test.tsx`（mockApi 补 2 方法 + 2 个 `it`）

- [ ] **Step 1: 先写失败测试**

在 `requirement-flow-section.test.tsx` 的 `mockApi`（`vi.hoisted`，`:26-37`）里补两个方法（`confirmDecomposition` 之后）：

```tsx
  triggerRequirement: vi.fn(),
  submitAcceptanceVerdict: vi.fn(),
```

在 `beforeEach`（`:121-130` 区域，`mockApi.confirmDecomposition.mockResolvedValue(...)` 之后）补默认实现：

```tsx
  mockApi.triggerRequirement.mockResolvedValue({ triggered: true, enqueued: 0, issue_id: "req-1" });
  mockApi.submitAcceptanceVerdict.mockResolvedValue({ verdict: "pass", acceptance_round: 0, terminal: true });
```

在最后一个 `it` 之后、`describe` 收尾 `});` 之前，追加两个 `it`（stage3 = `decomposition_confirmed_at` 已落且无 stage4 子任务；stage4 = 存在 stage4 子任务，见 `deriveFlowStage:60-62`）：

```tsx
  it("stage3 渲染执行调度面板（画面6）", async () => {
    renderSection(
      <RequirementFlowSection
        issue={requirement({ decomposition_confirmed_at: "2026-09-05T00:00:00Z" })}
        childIssues={[
          { id: "c1", identifier: "REQ-2", title: "执行子任务", stage: 3, status: "todo" } as unknown as Issue,
        ]}
      />,
    );
    expect(await screen.findByTestId("schedule-panel")).toBeTruthy();
  });

  it("stage4 渲染验收面板（画面7）", async () => {
    renderSection(
      <RequirementFlowSection
        issue={requirement({ decomposition_confirmed_at: "2026-09-05T00:00:00Z" })}
        childIssues={[
          { id: "t1", identifier: "REQ-3", title: "整体验收", stage: 4, status: "todo" } as unknown as Issue,
        ]}
      />,
    );
    expect(await screen.findByTestId("acceptance-panel")).toBeTruthy();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT && pnpm --filter @multica/views test -- requirement-flow-section.test.tsx -t "画面"`
Expected: FAIL —— `Unable to find an element by: [data-testid="schedule-panel"]`（stage3/4 尚未挂面板）。

- [ ] **Step 3: 加 import**

在 `requirement-flow-section.tsx` 的 `import { RequirementDecomposePanel } from "./requirement-decompose-panel";`（`:32`）之后插入：

```tsx
import { RequirementSchedulePanel } from "./requirement-schedule-panel";
import { RequirementAcceptancePanel } from "./requirement-acceptance-panel";
```

- [ ] **Step 4: 加 trigger / verdict 回调**

在 `confirmDecomposition` 的 `useCallback`（`:165-184`）之后、`if (!isTopLevel) return null;`（`:186`）之前插入（mirror 同款 invalidate 模式；`api.triggerRequirement`/`api.submitAcceptanceVerdict` 由 Task 6.1 加到 client.ts）：

```tsx
  const triggerRequirement = useCallback(
    (issueId: string) =>
      api.triggerRequirement(issueId).then(async (r) => {
        // 触发后 stage3 子任务入队 → 刷新子任务列表与需求详情（triggered_at / 派生态）。
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: issueKeys.children(issue.workspace_id, issueId),
          }),
          queryClient.invalidateQueries({
            queryKey: issueKeys.detail(issue.workspace_id, issueId),
          }),
        ]);
        return r;
      }),
    [queryClient, issue.workspace_id],
  );
  const submitAcceptanceVerdict = useCallback(
    (issueId: string, body: { verdict: "pass" | "fail"; evidence: string }) =>
      api.submitAcceptanceVerdict(issueId, body).then(async (r) => {
        // pass → 需求 done（WS3 释放组锁）；fail → round+1 + 新 stage3 修复子任务入队。
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: issueKeys.children(issue.workspace_id, issueId),
          }),
          queryClient.invalidateQueries({
            queryKey: issueKeys.detail(issue.workspace_id, issueId),
          }),
        ]);
        return r;
      }),
    [queryClient, issue.workspace_id],
  );
```

- [ ] **Step 5: 在 return 块挂载 stage3/4 面板**

在 stage2 分支结束（`:336` 的 `))}`，即 `decompose-start` 按钮块的收尾）之后、`</section>`（`:337`）之前插入：

```tsx
      {stage === 3 && (
        <RequirementSchedulePanel
          issue={issue}
          childIssues={childIssues}
          triggerRequirement={triggerRequirement}
        />
      )}

      {stage === 4 && (
        <RequirementAcceptancePanel
          issue={issue}
          childIssues={childIssues}
          submitAcceptanceVerdict={submitAcceptanceVerdict}
        />
      )}
```

- [ ] **Step 6: 跑测试确认通过 + 类型检查**

Run: `cd $ROOT && pnpm --filter @multica/views test -- requirement-flow-section.test.tsx`
Expected: PASS（原用例 + 新 2 用例全过；stage3/4 面板出现）。
Run: `cd $ROOT && pnpm --filter @multica/views typecheck`
Expected: 无类型错误。

- [ ] **Step 7: 提交**

```bash
cd $ROOT && git add packages/views/issues/components/requirement-flow-section.tsx packages/views/issues/components/requirement-flow-section.test.tsx
git commit -m "feat(flow-section): mount schedule (stage3) + acceptance (stage4) panels with trigger/verdict callbacks"
```

---

### Task 6.6: `calendar-view` 补第 10 态「验收失败」色块映射（WS4→WS6 联动）

**背景（实证 + spec §6.1:272）**：WS4 Task 4.1 给 `issue.sql:18-33` 的派生投影增补了第 10 态「验收失败」（`acceptance_round > 3`）。§6.1:272 要求第 10 态落地时「同步更新前端色块映射」。`calendar-view.tsx` 的 `STATUS_ICON`（`:141-151`）/`STATUS_TONE`（`:153-159`）只有 9 态，`RESCHEDULE_LOCKED_STATUSES`（`:167-173`）也未含「验收失败」—— 缺映射时 `:489-490` 回落空字符串（无色块/无图标），且终态需求仍可被拖拽改期（错误）。「验收失败」是终态，须与「已完成/已取消」一样锁改期。**键为中文派生态字符串（server 投影原值），无需 i18n。**

**Files:**
- Modify: `packages/views/issues/components/calendar-view.tsx:141-173`（三个常量各补一项）
- Test: `packages/views/issues/components/calendar-view.test.tsx`（新增 1 个 `it`）

- [ ] **Step 1: 先写失败测试**

在 `calendar-view.test.tsx` 的 `running or finished requirements are not draggable…`（`:242-270`）之后、`describe` 收尾 `});`（`:271`）之前，追加一个 `it`（沿用该文件既有的 `requirement(...)` 工厂与 `renderCalendar([...])`，block testid 为 `req-block-{id}-{YYYY-MM-DD}`，locked 时 `title` = `calendar.reschedule_locked` 的 en 值）：

```tsx
  it("第10态「验收失败」渲染✗色块且锁改期（终态不可拖拽）", () => {
    renderCalendar([
      requirement({
        id: "req-fail",
        identifier: "REQ-9",
        start_at: "2026-09-15T09:00:00Z",
        due_date: "2026-09-16",
        requirement_status: "验收失败",
      }),
    ]);

    const block = screen.getByTestId("req-block-req-fail-2026-09-15");
    // 派生态文案 + ✗ 图标（STATUS_ICON["验收失败"]）都落在 start 段。
    expect(block.textContent).toContain("验收失败");
    expect(block.textContent).toContain("✗");
    // 终态锁改期：与「执行中/已完成」同款不可拖拽 + title 说明。
    expect(block.getAttribute("draggable")).toBe("false");
    expect(block.getAttribute("title")).toBe(
      "Already triggered — cancel the run before rescheduling",
    );
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT && pnpm --filter @multica/views test -- calendar-view.test.tsx -t "验收失败"`
Expected: FAIL —— `block.textContent` 不含 `✗`（STATUS_ICON 无「验收失败」→ 回落空串），且 `draggable` 为 `"true"`（未进 RESCHEDULE_LOCKED_STATUSES）。

- [ ] **Step 3: 三个常量各补一项**

`calendar-view.tsx` —— `STATUS_ICON`（`:150` 的 `已取消: "—",` 之后）补：

```tsx
  验收失败: "✗",
```

`STATUS_TONE`（`:158` 的 `已取消: "text-muted-foreground",` 之后）补：

```tsx
  验收失败: "text-destructive",
```

`RESCHEDULE_LOCKED_STATUSES`（`:172` 的 `"已取消",` 之后）补：

```tsx
  "验收失败",
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `cd $ROOT && pnpm --filter @multica/views test -- calendar-view.test.tsx`
Expected: PASS（原 5 用例 + 新 1 用例 = 6 全过）。
Run: `cd $ROOT && pnpm --filter @multica/views typecheck`
Expected: 无类型错误。

- [ ] **Step 5: 提交**

```bash
cd $ROOT && git add packages/views/issues/components/calendar-view.tsx packages/views/issues/components/calendar-view.test.tsx
git commit -m "feat(calendar): map 10th derived status 验收失败 (icon/tone/reschedule-lock)"
```

---

### Task 6.7: `create-issue` 补 `repo_resource_id` git 库选择器（画面 3 补全）

**背景（实证 + spec §10:378）**：`create-issue.tsx` 的 `showRequirementFields`（`:344` = `!parentIssueId && !!projectId`）块已含 goal/start_at/decompose_mode/auto_trigger/role-strip（`:1524-1611`），但 `grep repo_resource|project_resource|git` **零命中** → 无 git 库选择器，创建 payload（`:596-601`）也不带 `repo_resource_id`。§10:378 要求「git 库选择（project_resource）」位于**目标与分钟时间之间**。本任务复用 `projectResourcesOptions(wsId, projectId)`（`resource-queries.ts:16`，flow-section:135 已用同款；`select` 返回 `ProjectResource[]`），过滤 `resource_type === "github_repo"`，用 `label` 作选项文案。**i18n 键归 `modals.json` 的 `create_issue` 段**（`create-issue.tsx:138/226` 用 `useT("modals")`）。

**Files:**
- Modify: `packages/views/modals/create-issue.tsx`（import + state + query + UI select + payload）
- Modify: `packages/views/locales/{en,zh-Hans,ja,ko}/modals.json`（`create_issue` 段增 `repo_label`/`repo_none`，2 键 × 4 语言）
- Test: `packages/views/modals/create-issue.test.tsx`（mock `@multica/core/projects` + 新增 1 个 `it`）

- [ ] **Step 1: 先写失败测试**

在 `create-issue.test.tsx` 的 `vi.mock("@multica/core/issues/queries", …)`（`:211-228`）之后，新增一个对 `@multica/core/projects` 的 mock（用 `importOriginal` 展开保留其余导出，只覆写 `projectResourcesOptions`；queryFn 直接 resolve 数组，省去 `select`）：

```tsx
vi.mock("@multica/core/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/projects")>()),
  // git 库选择器的数据源：一个 github_repo + 一个 local_directory，验证只列前者。
  projectResourcesOptions: (wsId: string, projectId: string) => ({
    queryKey: ["project-resources", wsId, projectId],
    queryFn: () =>
      Promise.resolve([
        { id: "res-1", project_id: projectId, workspace_id: wsId, resource_type: "github_repo", resource_ref: {}, label: "multica/app", position: 0, created_at: "2026-09-01T00:00:00Z", created_by: null },
        { id: "res-2", project_id: projectId, workspace_id: wsId, resource_type: "local_directory", resource_ref: {}, label: "local-dir", position: 1, created_at: "2026-09-01T00:00:00Z", created_by: null },
      ]),
  }),
}));
```

在 `restores an unfinished project selection…`（`:1243-1256`）之后追加一个 `it`（沿用既有提交骨架：seed `mockDraftStore.draft.shared.projectId` → `renderModal(<CreateIssueModal …/>)` → 填标题 → 点 `Create Issue` → 断言 `mockCreateIssue` payload；`projectId` 由 `create-issue.tsx:289-293` 的 `useState(() => draft.shared.projectId)` 初值读取，故 seed 后首渲染即 `showRequirementFields=true`）：

```tsx
  it("顶层需求选项目后渲染 git 库选择器（仅 github_repo），创建带 repo_resource_id", async () => {
    const user = userEvent.setup();
    mockDraftStore.draft.shared.projectId = "proj-1";

    renderModal(<CreateIssueModal onClose={vi.fn()} />);

    // 选择器出现，只列 github_repo（multica/app），不列 local_directory（local-dir）。
    const repo = screen.getByTestId("create-issue-repo") as HTMLSelectElement;
    expect(repo.textContent).toContain("multica/app");
    expect(repo.textContent).not.toContain("local-dir");

    fireEvent.change(screen.getByPlaceholderText("Issue title"), {
      target: { value: "Refactor auth" },
    });
    fireEvent.change(repo, { target: { value: "res-1" } });
    await user.click(screen.getByRole("button", { name: "Create Issue" }));

    await waitFor(() => {
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Refactor auth",
          project_id: "proj-1",
          repo_resource_id: "res-1",
        }),
      );
    });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $ROOT && pnpm --filter @multica/views test -- create-issue.test.tsx -t "git 库选择器"`
Expected: FAIL —— `Unable to find an element by: [data-testid="create-issue-repo"]`（选择器尚未渲染）。

- [ ] **Step 3: 加 import + state + query**

`create-issue.tsx` —— 在 `import { projectRoleDefaultsOptions } from "@multica/core/issues/queries";`（`:86`）之后插入：

```tsx
import { projectResourcesOptions } from "@multica/core/projects";
```

在需求日历本地状态块（`:339-343`，`const [roleEntries, setRoleEntries] = useState<RoleAssignment[]>([]);` 之后）插入：

```tsx
  const [repoResourceId, setRepoResourceId] = useState("");
```

在 `projectRoleDefaultsOptions` 的 `useQuery`（`:364-367`）之后插入（`enabled` 同款 `showRequirementFields`；`wsId` 已在 `:347` 取得，`projectId` 是 `:289` 的 state）：

```tsx
  // git 库选择器数据源：项目资源里过滤出 github_repo（spec §10:378）。
  const { data: projectResources = [] } = useQuery({
    ...projectResourcesOptions(wsId, projectId ?? ""),
    enabled: showRequirementFields,
  });
  const repoResources = projectResources.filter((r) => r.resource_type === "github_repo");
```

- [ ] **Step 4: 在 Goal 与 Start time 之间插入 select**

在 Goal 块结束（`:1538` 的 `</div>`）之后、Start time 块（`:1540` 的 `{/* Start time — minute-precision */}`）之前插入（§10:378 顺序：目标 → git 库 → 分钟时间）：

```tsx
                {/* Git repo (project_resource) — spec §10:378, between goal and start time */}
                <div>
                  <label className="text-caption font-medium text-muted-foreground">
                    {t(($) => $.create_issue.repo_label)}
                  </label>
                  <select
                    data-testid="create-issue-repo"
                    className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 text-body focus:outline-none focus:ring-1 focus:ring-ring"
                    value={repoResourceId}
                    onChange={(e) => setRepoResourceId(e.target.value)}
                  >
                    <option value="">{t(($) => $.create_issue.repo_none)}</option>
                    {repoResources.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label ?? r.id}
                      </option>
                    ))}
                  </select>
                </div>
```

- [ ] **Step 5: payload 带上 repo_resource_id**

在创建 payload 的 `...(showRequirementFields ? { … } : {})` 块（`:596-601`）里，`auto_trigger: autoTrigger,`（`:600`）之后插入：

```tsx
            repo_resource_id: repoResourceId || undefined,
```

- [ ] **Step 6: 新增 `create_issue.repo_*` i18n 键（四语言同步，modals.json）**

四个 locale 的 `modals.json` 里，`create_issue` 段的最后一个键 `auto_trigger_hint` 之后补 `repo_label`/`repo_none`（给 `auto_trigger_hint` 行尾加逗号）。

`packages/views/locales/en/modals.json`（`auto_trigger_hint` 原值 `"Subtasks enter scheduling automatically at start time"`）：

```json
    "auto_trigger_hint": "Subtasks enter scheduling automatically at start time",
    "repo_label": "Git repository",
    "repo_none": "No repository"
```

`packages/views/locales/zh-Hans/modals.json`（原值 `"开始时间起子任务自动进入调度；关闭则需手动触发"`）：

```json
    "auto_trigger_hint": "开始时间起子任务自动进入调度；关闭则需手动触发",
    "repo_label": "Git 库",
    "repo_none": "不绑定 Git 库"
```

`packages/views/locales/ja/modals.json`（原值 `"開始時刻にサブタスクが自動でスケジュールに入る"`）：

```json
    "auto_trigger_hint": "開始時刻にサブタスクが自動でスケジュールに入る",
    "repo_label": "Git リポジトリ",
    "repo_none": "リポジトリなし"
```

`packages/views/locales/ko/modals.json`（原值 `"시작 시간에 하위 작업이 자동으로 스케줄링에 진입"`）：

```json
    "auto_trigger_hint": "시작 시간에 하위 작업이 자동으로 스케줄링에 진입",
    "repo_label": "Git 저장소",
    "repo_none": "저장소 없음"
```

- [ ] **Step 7: 跑测试确认通过 + i18n 门禁 + 类型检查**

Run: `cd $ROOT && pnpm --filter @multica/views test -- create-issue.test.tsx`
Expected: PASS（原用例 + 新 1 用例全过；payload 含 `repo_resource_id: "res-1"`）。
Run: `cd $ROOT && pnpm --filter @multica/views test -- locales/parity.test.ts`
Expected: PASS（`modals: zh-Hans/ja/ko covers every EN key` 与反向均绿 —— `create_issue.repo_label`/`repo_none` 四语言齐备）。
Run: `cd $ROOT && pnpm --filter @multica/views typecheck`
Expected: 无类型错误。

- [ ] **Step 8: 提交**

```bash
cd $ROOT && git add packages/views/modals/create-issue.tsx packages/views/modals/create-issue.test.tsx packages/views/locales/en/modals.json packages/views/locales/zh-Hans/modals.json packages/views/locales/ja/modals.json packages/views/locales/ko/modals.json
git commit -m "feat(create-issue): add repo_resource_id git-repo selector for top-level requirements"
```

---

### WS6 收尾验证

- [ ] `cd $ROOT && pnpm --filter @multica/core test -- client.test.ts` → trigger/verdict 端点用例全 PASS。
- [ ] `cd $ROOT && pnpm --filter @multica/views test -- requirement-decompose-panel.test.tsx requirement-schedule-panel.test.tsx requirement-acceptance-panel.test.tsx requirement-flow-section.test.tsx calendar-view.test.tsx create-issue.test.tsx` → 全 PASS。
- [ ] `cd $ROOT && pnpm --filter @multica/views test -- locales/parity.test.ts` → 全 PASS（`schedule_panel`/`acceptance_panel` 入 issues.json、`create_issue.repo_*` 入 modals.json，四语言键集双向相等）。
- [ ] `cd $ROOT && pnpm --filter @multica/core typecheck && pnpm --filter @multica/views typecheck` → 无类型错误。
- [ ] `cd $ROOT && pnpm --filter @multica/views lint` → 无新增 lint 错误。
- [ ] 人工核对动线：① 拆解面板 DraftCard 出现 graph/acceptance 摘要芯片（有数据才出框）；② 需求详情 stage3 出现调度面板（倒计时/进度/互斥 banner/触发按钮），点触发 → `POST /trigger` → toast；③ stage4 出现验收面板（轮次/报告/打回链），填 evidence 后 pass/fail → `POST /acceptance/verdict`；④ 日历「验收失败」块显示 ✗ 红色且不可拖拽；⑤ 创建顶层需求选项目后出现 git 库下拉（仅 github_repo），创建 payload 带 `repo_resource_id`。

---


## 验证与交付（全 plan 收尾，line 76 引用处）

> 本节是**全部 WS 完成后**的统一收口。每个 WS 各自已有「收尾验证」小节（WS2/WS3/WS4/WS5/WS6），本节做**跨 WS 的全量回归 + 端到端动线 + CodeReview + 清理 + 归档**，按顺序执行，全绿才算 Phase I 交付。

### V1. 全量构建与测试（每 WS 收尾命令汇总 + 全量门禁）

逐 WS 收尾命令（已在各 WS「收尾验证」列明，此处汇总为一张执行清单，串行跑）：

| WS | 构建 | 测试 |
| --- | --- | --- |
| WS2 | `cd $ROOT/server && go build ./...` | `go test ./internal/scheduler/ ./internal/handler/ -run 'Trigger\|Preflight\|ModuleBusy'` |
| WS3 | `cd $ROOT/server && go build ./...` | `go test ./internal/daemon/ -run 'ModuleLocker\|ReleaseGroup\|AcquireModuleLock'` |
| WS4 | `cd $ROOT/server && go build ./...` | `go test ./internal/handler/ -run 'AcceptanceVerdict\|Stage3Barrier\|RequirementStatusProjection'` |
| WS5 | `cd $ROOT/server && go build ./...` | `go test ./internal/handler/ ./internal/daemon/ -run 'AgentRun\|ProjectAgentRun\|ClassifyErrorEvent\|CallID'` |
| WS6 | `pnpm --filter @multica/core typecheck && pnpm --filter @multica/views typecheck` | `pnpm --filter @multica/core test -- client.test.ts` + `pnpm --filter @multica/views test -- requirement-*.test.tsx calendar-view.test.tsx create-issue.test.tsx locales/parity.test.ts` |

全量门禁（所有 WS 合并后跑一次，任一红即阻塞交付）：

- [ ] `cd $ROOT/server && go build ./... && go vet ./...` → 无输出。
- [ ] `cd $ROOT && make sqlc && git diff --exit-code -- server/pkg/db/generated` → 无 diff（生成物已随各 WS 提交；WS4 的 `IncrementAcceptanceRound` 与 CASE 增补已 `make sqlc` 落盘）。
- [ ] `cd $ROOT && make test`（后端全量）→ 全 PASS。
- [ ] `cd $ROOT && pnpm -r typecheck && pnpm -r lint` → 无错误。
- [ ] `cd $ROOT && pnpm --filter @multica/views test && pnpm --filter @multica/core test`（前端全量，含 `locales/parity.test.ts` 四语言双向门禁）→ 全 PASS。
- [ ] `cd $ROOT && pnpm --filter @multica/views test -- locales/parity.test.ts` 单独再跑一次 → 确认 `issues`（schedule_panel/acceptance_panel）与 `modals`（create_issue.repo_*）命名空间四语言键集完全相等。

### V2. 关键动线 Browser E2E（spec 六动线端到端）

用 `agent-browser` skill 驱动 web 客户端（或 desktop 预览），跑通**到点触发 → 组互斥 → 验收 pass/fail 打回 → agent_run 投影**的完整闭环。前置：WS2-WS6 全部合并、后端起服（`cd $ROOT/server && go run ./cmd/server` 或既有启动脚本）、前端起 dev（`pnpm --filter <web-app> dev`）、有一个绑定了 github_repo 资源与启用班底（pm/developer/tester/prototyper）的项目。

- [ ] **动线 1-3（日历浏览 / 拖拽改期 / 创建需求）**：
  - 创建顶层需求：打开创建弹窗 → 选项目 → 填目标 → **git 库下拉出现且仅列 github_repo**（Task 6.7）→ 选库 → 设 `start_at`（未来 2 分钟）→ `decompose_mode=confirm`、`auto_trigger=on` → 提交。断言：列表出现该需求，日历块按 `start_at~due_date` 铺展，派生态「未拆解/原型待确认」。
  - 拖拽改期：把一个「待触发」需求块拖到 +7 天单元格 → toast「Rescheduled — the auto-trigger time moved with it」→ `start_at/due_date` 平移 7 天（分钟保留）。把「执行中/已完成/验收失败」块尝试拖拽 → 不可拖（`draggable=false`，title 提示）。
- [ ] **动线 4-5（原型确认门 / PM plan + 拆解）**：
  - stage1：原型面板生成 → 打标（✗ 需填纠正说明）→ 全 ✓ 后确认门通过 → 流水线条推进 stage2。
  - stage2：发起拆解 → PM 产出草稿 → 拆解面板 DraftCard 显示 feature_points（new/modify）+ **graph/acceptance 摘要芯片**（Task 6.2）→ 微调执行人 → 确认生效 → 子任务物化（stage3 执行 + stage4 验收）。
- [ ] **动线 6（到点触发调度 + 组互斥）**：
  - 等待 `start_at` 到点（或点调度面板「立即触发」Task 6.3）→ 30s sweep 命中 `ListTriggerableRequirements`（`auto_trigger + triggered_at IS NULL + decomposition_confirmed_at + start_at<=now`）→ 触发预检（依赖无环 + 验收代码存在 + 模块窗口空闲）→ 幂等写 `triggered_at` → stage3 子任务入队 `agent_task_queue`。断言：调度面板翻「已触发」、倒计时变触发时刻、进度清单出现 stage3 子任务。
  - **组互斥**：在同模块再起一个需求组 → 其 stage3 因 ModuleLocker v2 组锁（`(moduleID, rootRequirementID)` 维度，WS3）被占而等待 → 调度面板显示「等待模块释放」互斥 banner（Task 6.3）→ 前一组 root 终态触发 `ReleaseGroup` → 后一组自动获锁开跑。
- [ ] **动线 7（验收 pass/fail 打回闭环）**：
  - stage3 全终态 → barrier 关闭 → **直接入队 stage4 tester**（WS4 Task 4.5 修正点，现状只唤醒 PM）→ 验收面板出现（Task 6.4）。
  - **fail 分支**：填 evidence → 点「打回」→ `POST /acceptance/verdict {verdict:"fail"}` → `acceptance_round + 1`（从 0 起）+ 新建 stage3 修复子任务入队 → 验收面板轮次 +1、打回链出现修复子任务。
  - **round>3 终态**：连续打回至 `acceptance_round=4` → 派生态翻「验收失败」→ 验收面板显示仲裁 banner、日历块显示 ✗ 红色（Task 6.6）+ system 仲裁评论。
  - **pass 分支**：填 evidence → 点「通过」→ `{verdict:"pass", terminal:true}` → 需求 root 落 `done` → WS3 `ReleaseGroup` 释放组锁。
- [ ] **agent_run 投影（WS5，贯穿动线 6-7）**：上述执行过程中，daemon 上报含 `call_id` 的 tool_use/tool_result → `agent_run` 表出现 running run（确定性 UUID v5、`root_issue_id` 正确、cli_kind=runtime provider）→ `agent_run_todo` 待办随 result 翻 done → `agent_run_event` 有 heartbeat/todo_change/错误分类事件 → task complete/fail/cancel → run status 翻终态且不被晚到回调覆盖 → usage 上报 → `token_used` 累加。断言：agent-run 视图（既有 `POST /api/agent-runs` 消费端）能看到该需求组的运行轨迹。
- [ ] **降级核对**：旧 daemon（不发 `call_id`）→ 仍建 run + heartbeat + error 事件，只是不建 tool 待办（无孤儿 in_progress）；agent 端图谱缺失 → 降级「档案未就绪」（开放问题 #11）。

### V3. 三维 CodeReview（合并前，用 `superpowers:requesting-code-review`）

对全部 WS 的 diff 做一次结构化 review，三个维度各自出结论（approve / request-changes），任一 request-changes 须修复后复审：

- [ ] **维度一 · 正确性（correctness）**：
  - WS2 触发谓词与 `ListTriggerableRequirements`（`requirement.sql:89-100`）完全一致，**无臆造 `trigger_status` 列**；`MarkRequirementTriggered` 幂等（`triggered_at IS NULL` 守卫）防并发重复触发。
  - WS3 组锁 key 升级为 `(moduleID, rootRequirementID)`，`ReleaseGroup` 仅在 root 终态调用；claim 闸门 root 维度不误伤异组。
  - WS4 `acceptance_round` **DEFAULT 0**、fail 时 `IncrementAcceptanceRound` +1、`round>3` 判验收失败终态；派生投影第 10 态 CASE 与规则 6 修正经 `requirement_status_projection_test.go` 覆盖；stage barrier 关闭确实入队 stage4 tester（非只唤醒 PM）。
  - WS5 投影是 task_message 的**单向确定性派生**（UUID v5），写库失败不阻断 `ReportTaskMessages` 200；终态收尾不被晚到回调覆盖。
  - WS6 client.ts 端点路径/请求体/响应体与 WS2（`/trigger` 空 body → `{triggered,enqueued,issue_id}`）、WS4（`/acceptance/verdict` `{verdict,evidence}` → `{verdict,acceptance_round,terminal,repair_issue_id?}`）**逐字对齐**；verdict 是 member-authed 人工仲裁入口（非 daemon 调用）。
- [ ] **维度二 · 测试覆盖（test coverage）**：
  - 每个新/改后端文件有对应 `_test.go`（预检纯函数、handler 端点、投影派生、barrier、组锁）；每个新/改前端组件有对应 `*.test.tsx`（注入式回调断言 payload）；i18n 四语言过 `parity.test.ts` 双向门禁。
  - 边界用例齐备：触发预检各阻断原因（409）、round=3 未越界 vs round=4 越界、旧 daemon 无 call_id 降级、空 graph/acceptance 不出框、evidence 空禁用仲裁按钮。
- [ ] **维度三 · 架构一致性（architecture / convention）**：
  - 后端遵循 chi router + sqlc + pgx 既有分层（handler → service → queries），无绕过 generated 层手写 SQL（WS5 handler 内原生 SQL 是既定例外，已注明不碰 `pkg/db/queries`）。
  - 前端遵循 pnpm workspace 边界（views 不 import next/*）、TanStack Query `xxxOptions + issueKeys` 模式、注入式回调约定、`useT` i18n、`cn` 类名合并、`data-testid` 可测性。
  - 派生态 `requirement_status` **始终作投影消费**，未 anywhere 落列或作 server 过滤维度（WS6 实证校正②）；module bar 维持模块单一职责。
  - DRY/YAGNI：无重复实现（触发逻辑 sweep 与 HTTP handler 共用 `RequirementTriggerService`）；无 Phase I 范围外的投机代码（过滤器/chip/角色头像已据实丢弃）。

### V4. 临时产物清理

- [ ] `cd $ROOT && git status --porcelain` → 工作区干净，无未跟踪的临时文件（调试脚本、`*.log`、`tmp_*`、截图等）。
- [ ] 删除 E2E 期间在本地库造的测试需求/项目/资源（或确认它们只在本地 dev 库、不进任何提交）。
- [ ] `cd $ROOT && git log --oneline -20` → 确认每个 Task 一个 commit、message 规范（`feat/fix(scope): …`），无 `WIP`/`fixup`/`squash!` 残留。
- [ ] 确认无 `console.log`/`fmt.Println` 调试输出残留（`git diff <base>..HEAD | grep -nE '^\+.*(console\.log|fmt\.Println)'` 为空）。

### V5. 变更日志归档

- [ ] 在 `/Users/eleme/Documents/workspace/change_logs/multica/daily_logs/` 新建 `20260906-需求日历PhaseI能力补全.md`（沿用该目录 `YYYYMMDD-<描述>.md` 命名约定），记录：
  - **范围**：WS2 到点触发 loop / WS3 ModuleLocker v2 组锁 / WS4 验收闭环 / WS5 agent_run 投影 / WS6 前端动线补全（画面 3/5/6/7 + 日历第 10 态）。
  - **关键决策**：① 触发态由 `auto_trigger + triggered_at + decomposition_confirmed_at` 派生，**无独立 trigger_status 列**；② migration 452 给 issue 新增 **12 列**（直读 `452_requirement_calendar.up.sql:7-19`）；③ `acceptance_round` **DEFAULT 0**、fail +1、>3 判验收失败终态；④ WS5 改为 server 侧 ingest 派生（daemon 无法调 member 路由）；⑤ WS6 据实丢弃伪 gap（拖拽已实现 / 派生态不可 server 过滤 / 角色头像非 spec）。
  - **数据模型变更**：`agent_run`/`agent_run_todo`/`agent_run_event`（migration 459，task_message 单向投影）；issue 派生投影第 10 态。
  - **验证结论**：V1 全量门禁、V2 六动线 E2E、V3 三维 CodeReview 均绿。
- [ ] 归档后把本 plan 文件（`docs/superpowers/plans/2026-09-06-requirement-calendar-phase1-completion.md`）随代码一并提交，作为执行蓝本留痕。

---

## Self-Review（writing-plans 规范收尾自检）

> 以「新鲜眼睛」对照 spec（`docs/superpowers/plans/2026-09-04-requirement-calendar-design.md` 与 Phase I 范围）逐项核查本 plan。三项检查：spec 覆盖 / 占位符扫描 / 类型一致性。

### SR1. Spec 覆盖（Phase I 每条范围能否指到某 Task）

| Phase I 范围（spec / 六动线 / 开放问题定稿） | 落地 Task | 覆盖 |
| --- | --- | --- |
| 动线 6：到点自动触发（sweep + 预检 + 幂等 triggered_at + stage3 入队） | WS2 Task 2.1（预检纯函数）/2.2（JobSpec+sweep）/2.4（注册） | ✅ |
| 触发前置预检：拆解已生效 + 依赖无环 + 验收代码存在 + 模块窗口空闲（开放问题 #10：v1 不做「执行人在线」预检） | WS2 Task 2.1（`triggerPreflight`+`dependencyGraphAcyclic`）/2.3（`ModuleBusyForOtherRoot`） | ✅ |
| 手动触发端点 `POST /issues/{id}/trigger`（与 sweep 共用服务） | WS2 Task 2.5 + Task 2.4 提炼 `RequirementTriggerService` | ✅ |
| 跨模块联动：ModuleLocker v2 组级互斥（`(moduleID, rootRequirementID)`） | WS3 Task 3.1（锁 key）/3.2（`ReleaseGroup`）/3.3-3.4（root 维度透传+闸门）/3.5（并发闸门决策）/3.6（组终态联动） | ✅ |
| 独立 issue root=自身（开放问题 #1） | WS3 Task 3.3（`root_requirement_id` 透传，顶层=自身 id） | ✅ |
| 动线 7：验收闭环（pass→done / fail→round+1+修复子任务 / round>3→验收失败终态+人工仲裁） | WS4 Task 4.2（pass）/4.3（fail+修复）/4.4（round>3 终态+仲裁） | ✅ |
| 验收 3 轮上限（开放问题 #9）+ `acceptance_round` DEFAULT 0 | WS4 Task 4.1（`IncrementAcceptanceRound` + 452:15 DEFAULT 0 实证）/4.4（>3 判定） | ✅ |
| stage barrier 修正：stage3 全终态直接入队 stage4 tester（现状只唤醒 PM） | WS4 Task 4.5 | ✅ |
| 派生投影第 10 态「验收失败」+ 规则 6 修正（开放问题 #4） | WS4 Task 4.1（CASE 增补 + `requirement_status_projection_test.go`） | ✅ |
| agent_run 单向投影（task_message 事实源 + 确定性 UUID v5） | WS5 Task 5.1（CallID 透传）/5.2（纯派生）/5.3（写入器+hook）/5.4（终态收尾+token） | ✅ |
| agent 端图谱缺失降级「档案未就绪」（开放问题 #11） | WS5 Task 5.2（`classifyErrorEvent` 降级分类）+ V2 降级核对 | ✅ |
| 画面 5 拆解面板补 graph/acceptance 摘要 | WS6 Task 6.2 | ✅ |
| 画面 6 执行调度面板（倒计时+进度+互斥等待+手动触发） | WS6 Task 6.3 | ✅ |
| 画面 7 验收报告面板（轮次+报告+打回链+pass/fail 人工仲裁） | WS6 Task 6.4 | ✅ |
| 流水线 stage3/4 挂载面板 + 回调 | WS6 Task 6.5 | ✅ |
| 日历第 10 态色块映射同步（§6.1:272） | WS6 Task 6.6 | ✅ |
| 画面 3 创建需求补 git 库选择器（§10:378，project_resource） | WS6 Task 6.7 | ✅ |
| client.ts trigger/verdict 端点 + `Issue.acceptance_round` 类型 | WS6 Task 6.1 | ✅ |
| 动线 1-2 日历浏览 + 拖拽改期 + 视觉反馈 | **已落地**（WS6 实证校正①：`calendar-view.tsx:309-343/418-432`），无需新 Task | ✅（既有） |
| 动线 4 原型确认门（严格 ✗ 门，开放问题 #5） | **已落地**（画面 4 原型面板，flow-section stage1 分支 `:290-298`），Phase I 仅引用 | ✅（既有） |
| due_date=date-only 日历日 / start_at=分钟 t0 | WS6 Task 6.3（`formatMinuteUTC`）+ 既有日历约定 | ✅ |
| 不建里程碑表（开放问题 #8）/ data 角色归 stage3（#7） | 全 plan 未引入里程碑表；WS4/WS6 角色处理沿用既有班底 | ✅（遵守约束） |

**结论**：Phase I 范围逐条可指到具体 Task（或标注为「已落地/既有」并给直读出处），**无遗漏**。范围外的伪 gap（过滤器维度 / 待确认 chip / 角色头像）已在 WS6 实证校正表据实丢弃并说明理由。

### SR2. 占位符扫描（No Placeholders 红线）

逐项自查本 plan（尤其 WS6 新增章节）是否含 writing-plans 禁止的占位符：

- **无** `TBD`/`TODO`/`implement later`/`fill in details`。
- **无** 「add appropriate error handling」/「handle edge cases」类空泛指令 —— 错误处理均给具体代码（如 Task 6.3/6.4 的 `catch (e) { toast.error(e instanceof Error ? e.message : …) }`、409/400 reason 透传）。
- **无** 「Write tests for the above」而无测试代码 —— 每个 Task 的 Step 1 都给了**完整可运行**的测试代码块。
- **无** 「Similar to Task N」式省略 —— Task 6.4 的 i18n 四语言、Task 6.5 的回调均**重复写出完整代码**（即便与 6.3/confirmDecomposition 同构）。
- **无** 描述「做什么」却不给「怎么做」的步骤 —— 所有改代码的步骤都附精确文件路径 + 行号锚点 + 完整代码块 + 确切命令 + 预期输出。
- **无** 引用未在任何 Task 定义的类型/函数 —— `TriggerRequirementResponse`/`AcceptanceVerdictResponse`/`Issue.acceptance_round` 均在 Task 6.1 定义后才被 6.3/6.4/6.5 消费；`RequirementSchedulePanel`/`RequirementAcceptancePanel` 在 6.3/6.4 定义后才被 6.5 挂载。
- 唯一一处**条件式表述**（原 Task 6.3 Step 4 关于 resources-types.ts 的「若…则…」）已据直读结果改写为**确定性结论**（`issues: typeof issues` 从 en JSON 推导，无需手改类型文件）。

**结论**：无占位符红线违规。

### SR3. 类型一致性（前后 Task 的签名 / 类型名 / 端点路径一致）

交叉核对本 plan 内跨 Task 引用的符号是否前后一致：

- **端点路径**：`/api/issues/{id}/trigger`（WS2 Task 2.5 handler ↔ WS6 契约表 ↔ Task 6.1 `client.triggerRequirement`）与 `/api/issues/{id}/acceptance/verdict`（WS4 Task 4.2/4.3 ↔ WS6 契约表 ↔ Task 6.1 `client.submitAcceptanceVerdict`）**三处逐字一致**。
- **请求/响应体**：trigger 空 body → `{triggered:boolean, enqueued:number, issue_id:string}`（WS2 Task 2.5 `writeJSON` ↔ Task 6.1 `TriggerRequirementResponse`）；verdict `{verdict:"pass"|"fail", evidence:string}` → `{verdict, acceptance_round:number, terminal:boolean, repair_issue_id?:string}`（WS4 handler ↔ Task 6.1 `AcceptanceVerdictResponse` ↔ Task 6.4 测试 mockResolvedValue）**字段名与类型一致**。
- **client 方法签名**：`triggerRequirement(issueId: string)` 与 `submitAcceptanceVerdict(issueId: string, body: { verdict; evidence })`（Task 6.1 定义）↔ Task 6.3 `triggerRequirement(issue.id)`、Task 6.4 `submitAcceptanceVerdict(issue.id, { verdict, evidence: evidence.trim() })`、Task 6.5 回调 `api.triggerRequirement(issueId)`/`api.submitAcceptanceVerdict(issueId, body)` **调用形参一致**。
- **面板 props 类型**：`RequirementSchedulePanelProps { issue; childIssues: Issue[]; triggerRequirement: (issueId: string) => Promise<TriggerRequirementResponse> }`（Task 6.3）↔ Task 6.5 挂载传参 `issue/childIssues/triggerRequirement` 一致；`RequirementAcceptancePanelProps { …; submitAcceptanceVerdict: (issueId, body) => Promise<AcceptanceVerdictResponse> }`（Task 6.4）↔ Task 6.5 传参一致。注意 Task 6.3/6.4 组件 prop 名是 `childIssues`（与 flow-section 的 `childIssues` prop 同名），测试与挂载均用 `childIssues=`，**未出现 `children` 误名**。
- **Issue 字段**：`acceptance_round?: number`（Task 6.1 加，对齐服务端 `issue.go:93` `AcceptanceRound int32`）↔ Task 6.4 `issue.acceptance_round ?? 0`；`requirement_status?`/`stage_progress?`/`start_at?`/`triggered_at?`（`issue.ts:229-244` 既有）↔ Task 6.3/6.6 消费，**字段名与可选性一致**。
- **i18n 键**：`decompose_panel.graph_title`/`acc_title`（既有，Task 6.2 复用）；`schedule_panel.*`（Task 6.3 定义 11 键 ↔ 组件 `t(($) => $.schedule_panel.*)` 逐键对应）；`acceptance_panel.*`（Task 6.4 定义 13 键 ↔ 组件逐键对应）；`create_issue.repo_label`/`repo_none`（Task 6.7 定义 ↔ select 消费）。所有组件引用的键都在同 Task 的 i18n 步骤里定义，**无悬空键**。
- **常量**：`MAX_ACCEPTANCE_ROUND = 3`（Task 6.4）与 WS4 Task 4.4 的 `round > 3` 判定、spec 开放问题 #9 的「3 轮上限」**数值一致**。
- **派生态字符串**：「验收失败」在 WS4 Task 4.1（SQL CASE）、Task 6.6（STATUS_ICON/STATUS_TONE/RESCHEDULE_LOCKED_STATUSES）、V2 E2E 断言中**字面一致**（中文原值，server 投影直出，不经 i18n）。

**结论**：跨 Task 的端点路径、请求/响应体、函数签名、props 类型、Issue 字段、i18n 键、常量、派生态字符串**全部前后一致**，未发现 `clearLayers()` vs `clearFullLayers()` 式的命名漂移。

---

> **Plan 完成。** 全 6 个 Workstream（WS1 文档引用 + WS2-WS6 实现）共 **27 个实现 Task**（WS2:5 / WS3:6 / WS4:5 / WS5:4 / WS6:7），每个 Task 均为 bite-sized TDD 步骤（失败测试 → 跑失败 → 最小实现 → 跑通过 → 提交），附精确文件路径 + 完整代码 + 确切命令 + 预期输出。三处 leader 要求的实证点（452=12 列 / 无 trigger_status / acceptance_round DEFAULT 0）已据实反映。建议执行方式：`superpowers:subagent-driven-development`（每 Task 派新 subagent + 两阶段 review）。
