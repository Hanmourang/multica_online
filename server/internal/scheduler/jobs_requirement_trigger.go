// 需求日历（spec: docs/superpowers/specs/2026-09-04-requirement-calendar-design.md
// §7.1 / §7.5①，plan: docs/superpowers/plans/2026-09-06-requirement-calendar-phase1-completion.md
// §WS2）：到点自动触发 loop 与手动触发端点共用的调度层。
//
// 单一入口是 triggerOneRequirement —— 30s sweep 与 POST /issues/{id}/trigger
// 都经它执行「预检 → 幂等标记 triggered_at → stage3 子任务入队」。这样两条
// 路径永远不会分叉：手动触发不会绕过预检，sweep 也不会漏掉手动模式已加的
// 幂等守卫。
//
// 幂等锚点是 MarkRequirementTriggered 的 execrows 守卫（triggered_at IS NULL
// 才写入）：sweep 并发与手动重试都由它挡下，返回 0 行 → 本 sweep 记入
// already_triggered 阻断原因，手动路径映射为 409。
package scheduler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// JobNameRequirementTrigger 是写入 sys_cron_executions 的稳定 job 名。
// 跨版本勿改：改名会让历史审计行成为孤儿（无法按 job 名回查）。
//
// 改名审计（M-9）：本 Phase I 内曾短暂用 requirement_trigger_sweep，随即在
// 同一未发布分支（feat/requirement-calendar）改为 requirement_trigger_dispatch。
// git 核实：旧名仅出现于本分支 commit（9fccf53 / 1e9bc9c），从未合入
// master/main/release，也无任何 migration 引用它——故旧名从未在生产库
// sys_cron_executions 留下审计行，无需补数据 migration，仅此处记录。
const JobNameRequirementTrigger = "requirement_trigger_dispatch"

// RequirementTriggerDispatcher 是本 job 对 service.TaskService 的窄契约。
// 签名与 (*service.TaskService).EnqueueTaskForIssue 完全一致（含可变参），
// 因此 *service.TaskService 直接满足；scheduler 包不直接依赖 service 包，
// 单测可用 stub 替换。
type RequirementTriggerDispatcher interface {
	EnqueueTaskForIssue(ctx context.Context, issue db.Issue, triggerCommentID ...pgtype.UUID) (db.AgentTaskQueue, error)
}

// TriggerResult 是一次触发尝试的结果。sweep 与手动路径共用同一结构，
// handler 据此填 sys_cron_executions.result / HTTP 响应体。
type TriggerResult struct {
	// Pass 表示预检通过并已入队（true）；false 时 Reason 非空。
	Pass bool
	// Reason 是阻断原因串，稳定枚举：
	//   decomposition_not_confirmed / dependency_cycle /
	//   acceptance_spec_missing    / module_window_busy /
	//   already_triggered
	Reason string
	// Enqueued 是本次新入队的 stage3 子任务数。
	Enqueued int
}

// RequirementTriggerService 封装「预检 → 幂等标记 → 入队 stage3」，供 30s
// sweep（RequirementTriggerJob）与手动 POST /issues/{id}/trigger（handler
// 层直接构造）共用。字段全部包内可见 —— 只有 triggerOneRequirement 与
// TriggerRequirementNow 需要访问，避免暴露 queries/dispatcher 给外部包。
type RequirementTriggerService struct {
	queries    *db.Queries
	dispatcher RequirementTriggerDispatcher
}

// NewRequirementTriggerService 构造共用触发服务。handler 层可用
// h.Queries + h.TaskService 就地构造，无需在 Handler struct 上另加字段。
func NewRequirementTriggerService(queries *db.Queries, dispatcher RequirementTriggerDispatcher) *RequirementTriggerService {
	return &RequirementTriggerService{queries: queries, dispatcher: dispatcher}
}

// TriggerRequirementNow 对单个需求立即执行触发（手动入口 + sweep 内层）。
// 与 sweep 路径的唯一差别：sweep 由 SQL 过滤 start_at <= now()，手动路径
// 忽略 start_at（用户显式触发即视为「到点」）；两者的预检 / 幂等 / 入队
// 完全一致。
func (s *RequirementTriggerService) TriggerRequirementNow(ctx context.Context, req db.Issue) (TriggerResult, error) {
	pass, reason, enq, err := triggerOneRequirement(ctx, s.queries, s.dispatcher, req)
	if err != nil {
		return TriggerResult{}, err
	}
	return TriggerResult{Pass: pass, Reason: reason, Enqueued: enq}, nil
}

// RequirementTriggerJob 返回 30s 全局 sweep 的 JobSpec。
// 镜像 AutopilotScheduleDispatchJob 结构，但用 StaticScopes(ScopeGlobal) +
// Cadence（不用 PlansForScope）——触发时机由 start_at <= now() 的 SQL 过滤
// 决定，sweep 只是周期性重扫，无需 cron 表达式枚举。
//
// pool 参数保留：未来若要把「ListTriggerableRequirements + 每个 trigger 的
// 预检读取 + MarkRequirementTriggered」包进单个 tx（消除 TOCTOU 窗口），
// 从这里拿连接最方便。当前实现按需求逐个处理，各查询独立 autocommit。
func RequirementTriggerJob(
	pool *pgxpool.Pool,
	queries *db.Queries,
	dispatcher RequirementTriggerDispatcher,
) JobSpec {
	_ = pool // 预留：见上方注释
	svc := NewRequirementTriggerService(queries, dispatcher)
	return JobSpec{
		Name:              JobNameRequirementTrigger,
		Cadence:           30 * time.Second,
		ScheduleDelay:     0,
		CatchUpMode:       CatchUpLatestOnly, // 停机后只补最近一次 sweep；历史到点需求本轮一次扫全
		CatchUpWindow:     1 * time.Hour,
		RunTimeout:        2 * time.Minute,
		StaleTimeout:      3 * time.Minute,
		HeartbeatInterval: 10 * time.Second,
		AllowStaleReentry: true, // MarkRequirementTriggered 幂等 ⇒ 重入安全
		MaxAttempts:       3,
		RetryBackoff:      []time.Duration{30 * time.Second, 2 * time.Minute},
		MaxPlansPerTick:   1,
		Scopes:            StaticScopes(ScopeGlobal),
		Handler:           requirementTriggerHandler(svc),
	}
}

// SweepSummary 是一轮 sweep 的审计汇总。导出为结构体（而非直接返回
// map[string]any）是为了让测试能强类型断言各字段，也方便未来加新维度
//（例如按 stage 拆分入队数）而不破坏 handler 层契约。
type SweepSummary struct {
	// Scanned 是 ListTriggerableRequirements 返回的行数（本轮扫到的到点需求）。
	Scanned int
	// Triggered 是本轮新写入 triggered_at 的需求数（不含 already_triggered）。
	Triggered int
	// Enqueued 是本轮新入队的 stage3 子任务总数（跨所有 Triggered 需求）。
	Enqueued int
	// Blocked 按原因串汇总被预检 / 已触发 / 错误挡下的需求数。原因串稳定枚举：
	//   decomposition_not_confirmed / dependency_cycle / acceptance_spec_missing /
	//   module_window_busy / already_triggered / error
	Blocked map[string]int
}

// ResultMap 把汇总转成 sys_cron_executions.result 可写的 map[string]any。
// 单独抽方法是为了让 handler 与测试共享同一份序列化形态。
func (s SweepSummary) ResultMap() map[string]any {
	result := map[string]any{
		"scanned":   s.Scanned,
		"triggered": s.Triggered,
		"enqueued":  s.Enqueued,
	}
	if len(s.Blocked) > 0 {
		result["blocked"] = s.Blocked
	}
	return result
}

// Sweep 扫一轮 ListTriggerableRequirements，逐个跑 TriggerRequirementNow，汇总审计
// 结果。单个需求失败不阻断本轮其余需求 —— 错误计入 Blocked["error"] 并打 warn 日志，
// 下一 tick 重扫（MarkRequirementTriggered 的 execrows 守卫保证已触发的行不会
// 被重复入队）。
//
// 导出为方法（而非只在 handler 闭包里）有两个理由：
//  1. 集成测试可直接调 svc.Sweep(ctx) 断言汇总，无需通过 HandlerInput 绕一圈；
//  2. 未来若要把 sweep 拆成多 tx（例如按 workspace 分片），这里是唯一切入点。
func (s *RequirementTriggerService) Sweep(ctx context.Context) (SweepSummary, error) {
	reqs, err := s.queries.ListTriggerableRequirements(ctx)
	if err != nil {
		return SweepSummary{}, fmt.Errorf("list triggerable: %w", err)
	}
	summary := SweepSummary{Scanned: len(reqs), Blocked: map[string]int{}}
	for _, req := range reqs {
		res, err := s.TriggerRequirementNow(ctx, req)
		if err != nil {
			// 单需求失败：记入审计，下一 tick 重试。不 return err
			// 是为了让本轮其余需求继续被扫。
			summary.Blocked["error"]++
			slog.Warn("requirement trigger sweep: trigger failed",
				"requirement_id", util.UUIDToString(req.ID), "error", err)
			continue
		}
		if !res.Pass {
			summary.Blocked[res.Reason]++
			continue
		}
		summary.Triggered++
		summary.Enqueued += res.Enqueued
	}
	return summary, nil
}

// requirementSweeper 是 sweep 汇总的窄契约，*RequirementTriggerService 满足之。
// 抽接口（而非直接收 *RequirementTriggerService）是为了让 handler 的
// RowsAffected 映射与 error 穿透可用 stub 覆盖（M-8：重建被删的
// TestRequirementTriggerSweepHandler 等价覆盖）。
type requirementSweeper interface {
	Sweep(ctx context.Context) (SweepSummary, error)
}

// requirementTriggerHandler 单次 sweep：调 svc.Sweep 拿汇总，映射到 HandlerResult
//（RowsAffected = triggered 数，Result = 审计 map）。
func requirementTriggerHandler(svc requirementSweeper) Handler {
	return func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
		summary, err := svc.Sweep(ctx)
		if err != nil {
			return HandlerResult{}, fmt.Errorf("requirement trigger: %w", err)
		}
		return HandlerResult{RowsAffected: int64(summary.Triggered), Result: summary.ResultMap()}, nil
	}
}

// triggerOneRequirement 处理单个到点需求：预检 → 幂等标记 → 入队 stage3。
// 返回 (是否放行, 阻断原因, 入队任务数, error)。
//
// 阻断原因枚举（稳定串，前端/E2E 依赖）：
//   - decomposition_not_confirmed：issue.decomposition_confirmed_at IS NULL
//   - dependency_cycle：组内 stage3 子任务的 blocked_by 边成环
//   - acceptance_spec_missing：无任何 stage3 子任务写了非空 acceptance_spec
//   - module_window_busy：同模块上有其它 root 组的活动任务（ModuleBusyForOtherRoot
//     查询命中；WS3 ModuleLocker v2 组级互斥语义，见 moduleWindowFree 注释）
//   - already_triggered：MarkRequirementTriggered 返回 0 行（并发竞争输给
//     另一 sweep 实例或手动触发）
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
	// 验收代码存在：至少一个 stage3 子任务 acceptance_spec 非空 JSON。
	// 列默认值 '{}' 视为「未填写」——只有真的写了 criteria/checks 才算数。
	acceptancePresent := false
	var stage3 []db.Issue
	for _, c := range children {
		if !c.Stage.Valid || c.Stage.Int32 != 3 {
			continue
		}
		stage3 = append(stage3, c)
		if !acceptancePresent && acceptanceSpecNonEmpty(c.AcceptanceSpec) {
			acceptancePresent = true
		}
	}
	// 依赖无环：取项目内全部 blocked_by 边，裁剪到组内子任务后判环。
	// 只判组内是因为跨组边由 451 claim 闸门在领取时把关，不影响本组触发决策。
	groupIDs := make(map[string]bool, len(children))
	for _, c := range children {
		groupIDs[util.UUIDToString(c.ID)] = true
	}
	var groupEdges [][2]string
	if req.ProjectID.Valid {
		edges, err := queries.ListDependencyEdgesForProject(ctx, req.ProjectID)
		if err != nil {
			return false, "", 0, fmt.Errorf("list dependency edges: %w", err)
		}
		for _, e := range edges {
			from := util.UUIDToString(e.IssueID)
			to := util.UUIDToString(e.DependsOnIssueID)
			if groupIDs[from] && groupIDs[to] {
				groupEdges = append(groupEdges, [2]string{from, to})
			}
		}
	}
	// 互斥窗口：需求自身模块 + 每个 stage3 子任务各自模块都无其它 root 组活动任务。
	windowFree, err := moduleWindowFree(ctx, queries, req, stage3)
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
		// H-3：acceptance_spec_missing 是永久阻断，且此前只落 sys_cron_executions
		// 计数、零用户可见信号。补一条去重护栏下的 system 评论（对照 handler 层
		// postAcceptanceFailedComment），让用户在需求详情看到卡点原因。已核实：
		// migration 452 同时新增 auto_trigger/decomposition_confirmed_at/triggered_at/
		// start_at，存量行 decomposition_confirmed_at 与 start_at 均为 NULL，永远进不了
		// ListTriggerableRequirements → 本闸门对存量行不可达；仅对「拆解草稿未填
		// acceptance_spec」的新需求生效，故无需存量豁免，只补可见信号。
		if reason == "acceptance_spec_missing" {
			postAcceptanceSpecMissingNotice(ctx, queries, req)
		}
		return false, reason, 0, nil
	}

	// 幂等标记；0 行 = 已被并发 sweep / 手动触发抢先，本轮跳过（不重复入队）。
	rows, err := queries.MarkRequirementTriggered(ctx, req.ID)
	if err != nil {
		return false, "", 0, fmt.Errorf("mark triggered: %w", err)
	}
	if rows == 0 {
		return false, "already_triggered", 0, nil
	}

	// 入队全部 stage3 子任务：依赖闸门由 ClaimAgentTask 在领取时把关
	// （451 的 NOT EXISTS 前置未 done 判定），未满足依赖的会停在 queued。
	// 非 agent 执行人的子任务跳过 —— 人自己领活，不进 agent 队列。
	//
	// 写序修复（C-1）：triggered_at 已在上面 CAS 落库。若某个入队失败就 return
	// 中断，需求会永久卡「已触发/零任务」——sweep（谓词含 triggered_at IS NULL）
	// /手动（CAS 0 行→already_triggered）/重试（重跑 CAS 仍 0 行）三通道全关闭。
	// 因此单个子任务入队失败改为 slog.Warn + continue 处理完剩余；仅当「已 CAS
	// 但零入队且确有失败」时调用 ResetRequirementTrigger 回退 triggered_at，让下轮
	// sweep 重扫重试。部分成功（enqueued>0）不回退 —— 否则会重复入队已成功者。
	enqueued := 0
	enqueueFailures := 0
	for _, c := range stage3 {
		if c.AssigneeType.String != "agent" || !c.AssigneeID.Valid {
			continue
		}
		if _, err := dispatcher.EnqueueTaskForIssue(ctx, c); err != nil {
			enqueueFailures++
			slog.Warn("requirement trigger: enqueue stage3 child failed",
				"requirement_id", util.UUIDToString(req.ID),
				"child_id", util.UUIDToString(c.ID), "error", err)
			continue
		}
		enqueued++
	}
	// 「已 CAS 但零入队且全部失败」→ 回退 triggered_at，返回 error 让 sweep 记入
	// blocked["error"] 并下一 tick 重扫（此时 triggered_at 已 NULL，可再次触发）。
	// enqueued==0 && enqueueFailures==0 是合法态（stage3 全为 member/squad 指派，
	// 无 agent 可入队）——不回退，需求确已触发，人自己领活。
	if enqueued == 0 && enqueueFailures > 0 {
		if _, rerr := queries.ResetRequirementTrigger(ctx, req.ID); rerr != nil {
			slog.Error("requirement trigger: reset triggered_at after all-failed enqueue failed",
				"requirement_id", util.UUIDToString(req.ID), "error", rerr)
			return false, "", 0, fmt.Errorf("all %d stage3 enqueues failed and triggered_at rollback failed: %w", enqueueFailures, rerr)
		}
		return false, "", 0, fmt.Errorf("all %d stage3 enqueues failed; triggered_at rolled back for retry", enqueueFailures)
	}
	return true, "", enqueued, nil
}

// moduleWindowFree 报告该需求组涉及的模块是否对其 root 组空闲（无其它组活动任务）。
//
// 对齐 WS3 ModuleLocker v2（daemon/module_locker.go blockerLocked）：同模块跨组
// 无条件互斥，同组内部并行不阻。触发前置只在「有 root」时才检查 —— root 缺失
// 即退化为 451 语义（不互斥），避免把回填前的存量行卡死。
//
// L-1：daemon ModuleLocker 用每个子任务自己的 task.ModuleID（daemon.go:5817）
// 逐任务判定，子任务拆解到不同模块时只看 req.ModuleID 会漏判。故这里收集
// 「需求自身 + 全部 stage3 子任务」的 distinct module_id，逐个执行
// ModuleBusyForOtherRoot；任一模块被其它组占用即判窗口忙。
//
// 活动任务口径 = CountRunningTasks（agent.sql:1749）：dispatched / running /
// waiting_local_directory / waiting_module_lock —— waiting_* 也算占用（daemon
// 已在等锁，触发新组只会加剧排队）；queued 不算（尚未占用互斥窗口）。
func moduleWindowFree(ctx context.Context, queries *db.Queries, req db.Issue, stage3 []db.Issue) (bool, error) {
	if !req.RootRequirementID.Valid {
		return true, nil // 组未知 → 退化为 451（不互斥）
	}
	// distinct module_id：需求自身 + 每个 stage3 子任务（按 UUID 串去重）。
	modules := make(map[string]pgtype.UUID)
	collect := func(id pgtype.UUID) {
		if id.Valid {
			modules[util.UUIDToString(id)] = id
		}
	}
	collect(req.ModuleID)
	for _, c := range stage3 {
		collect(c.ModuleID)
	}
	for _, moduleID := range modules {
		busy, err := queries.ModuleBusyForOtherRoot(ctx, db.ModuleBusyForOtherRootParams{
			ModuleID:          moduleID,
			RootRequirementID: req.RootRequirementID,
		})
		if err != nil {
			return false, err
		}
		if busy {
			return false, nil
		}
	}
	return true, nil
}

// postAcceptanceSpecMissingNotice 在需求因 acceptance_spec_missing 被永久阻断时，
// 于需求上补一条 system 评论作为用户可见信号（对照 handler.postAcceptanceFailedComment）。
// 去重护栏：已有带 [acceptance_spec_missing] 标记前缀的系统评论则跳过 —— sweep 每
// 30s 重扫同一被阻断需求，无护栏会刷屏。best-effort：任何错误只记日志，不影响阻断返回。
func postAcceptanceSpecMissingNotice(ctx context.Context, queries *db.Queries, req db.Issue) {
	noticed, err := queries.HasAcceptanceSpecMissingNotice(ctx, req.ID)
	if err != nil {
		slog.Warn("requirement trigger: acceptance_spec_missing notice dedup check failed",
			"requirement_id", util.UUIDToString(req.ID), "error", err)
		return
	}
	if noticed {
		return
	}
	content := "[acceptance_spec_missing] 自动触发被阻断：本需求的 stage3 子任务均未填写非空验收代码"
	_, err = queries.CreateComment(ctx, db.CreateCommentParams{
		ID:          dbid.NewV7(),
		IssueID:     req.ID,
		WorkspaceID: req.WorkspaceID,
		AuthorType:  "system",
		AuthorID:    pgtype.UUID{Valid: true},
		Content:     content,
		Type:        "system",
		ParentID:    pgtype.UUID{Valid: false},
	})
	if err != nil {
		slog.Warn("requirement trigger: post acceptance_spec_missing notice failed",
			"requirement_id", util.UUIDToString(req.ID), "error", err)
	}
}

// acceptanceSpecNonEmpty 判断 JSONB 列是否填了实际内容。列默认值 '{}' /
// 'null' 都算「未填写」；只要 unmarshal 出非空 map / 非空 array / 非 nil
// 标量就算数。空字节串（未初始化）也算未填写。
func acceptanceSpecNonEmpty(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	var v any
	if err := json.Unmarshal(trimmed, &v); err != nil {
		// 非法 JSON 保守视为「未填写」，让预检拒触发而不是把坏数据带下游。
		return false
	}
	switch val := v.(type) {
	case nil:
		return false
	case map[string]any:
		return len(val) > 0
	case []any:
		return len(val) > 0
	default:
		// 标量（string/number/bool）—— 有值即算填写。
		return true
	}
}

// triggerPreflightInput 是触发前置判定的纯输入，由 handler 从 DB 读齐后填入。
// 对应开放问题 #10（plan 2026-09-06 §WS2）：v1 触发前置 = 拆解已生效 +
// 依赖无环 + 验收代码存在 + ModuleLocker 互斥窗口可用；不做「执行人在线」
// 预检——daemon 心跳与 claim 闸门已覆盖该维度。
type triggerPreflightInput struct {
	DecompositionConfirmed bool // issue.decomposition_confirmed_at IS NOT NULL
	DependencyAcyclic      bool // 组内子任务 blocked_by DAG 无环
	AcceptanceSpecPresent  bool // 至少一个 stage3 子任务 acceptance_spec 非空
	ModuleWindowFree       bool // 同模块无「其它 root 需求组」的活动任务
}

// triggerPreflight 返回是否放行 + 阻断原因（写入 sys_cron_executions.result
// 供审计，并作为 POST /issues/{id}/trigger 409 的 body 串）。
//
// 判定顺序固定 → 原因串稳定，便于前端 / E2E 断言：拆解 → 依赖 → 验收 →
// 互斥窗口。任一前置失败即短路返回，不会执行下游更贵的检查。
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
// 白 = 未访问、灰 = 在当前 DFS 栈上、黑 = 已完成；遇到灰色后继 ⇒ 后向边 ⇒ 有环。
// 空边集平凡无环；自环 (a→a) 视为环；断开分量分别 DFS，任一分量有环即整体有环。
func dependencyGraphAcyclic(edges [][2]string) bool {
	adj := make(map[string][]string, len(edges))
	for _, e := range edges {
		adj[e[0]] = append(adj[e[0]], e[1])
		if _, ok := adj[e[1]]; !ok {
			adj[e[1]] = nil
		}
	}
	const (
		white = 0 // 未访问
		gray  = 1 // 访问中（在当前 DFS 栈上）
		black = 2 // 已完成
	)
	color := make(map[string]int, len(adj))
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
