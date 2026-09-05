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
)

// JobNameRequirementTrigger 是写入 sys_cron_executions 的稳定 job 名。
// 跨版本勿改：改名会让历史审计行成为孤儿（无法按 job 名回查）。
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
		RunTimeout:        1 * time.Minute,
		StaleTimeout:      3 * time.Minute,
		HeartbeatInterval: 20 * time.Second,
		AllowStaleReentry: true, // MarkRequirementTriggered 幂等 ⇒ 重入安全
		MaxAttempts:       3,
		RetryBackoff:      []time.Duration{30 * time.Second, 2 * time.Minute},
		MaxPlansPerTick:   1,
		Scopes:            StaticScopes(ScopeGlobal),
		Handler:           requirementTriggerHandler(svc),
	}
}

// requirementTriggerHandler 单次 sweep：扫全量到点需求，逐个跑 triggerOneRequirement，
// 汇总审计结果（scanned / triggered / enqueued / blocked[reason]）。单个需求失败
// 不阻断本轮其余需求 —— 下一 tick 会重扫（triggered_at 守卫保证幂等）。
func requirementTriggerHandler(svc *RequirementTriggerService) Handler {
	return func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
		reqs, err := svc.queries.ListTriggerableRequirements(ctx)
		if err != nil {
			return HandlerResult{}, fmt.Errorf("requirement trigger: list triggerable: %w", err)
		}
		triggered := 0
		enqueued := 0
		blocked := map[string]int{}
		for _, req := range reqs {
			res, err := svc.TriggerRequirementNow(ctx, req)
			if err != nil {
				// 单需求失败：记入审计，下一 tick 重试。不 return err
				// 是为了让本轮其余需求继续被扫。
				blocked["error"]++
				slog.Warn("requirement trigger sweep: trigger failed",
					"requirement_id", util.UUIDToString(req.ID), "error", err)
				continue
			}
			if !res.Pass {
				blocked[res.Reason]++
				continue
			}
			triggered++
			enqueued += res.Enqueued
		}
		result := map[string]any{
			"scanned":   len(reqs),
			"triggered": triggered,
			"enqueued":  enqueued,
		}
		if len(blocked) > 0 {
			result["blocked"] = blocked
		}
		return HandlerResult{RowsAffected: int64(triggered), Result: result}, nil
	}
}

// triggerOneRequirement 处理单个到点需求：预检 → 幂等标记 → 入队 stage3。
// 返回 (是否放行, 阻断原因, 入队任务数, error)。
//
// 阻断原因枚举（稳定串，前端/E2E 依赖）：
//   - decomposition_not_confirmed：issue.decomposition_confirmed_at IS NULL
//   - dependency_cycle：组内 stage3 子任务的 blocked_by 边成环
//   - acceptance_spec_missing：无任何 stage3 子任务写了非空 acceptance_spec
//   - module_window_busy：同模块上有其它 root 组的活动任务（v1 桩恒 false，
//     待 WS3 ModuleLocker v2 落地后接入实查询）
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
	// 互斥窗口：同模块无其它 root 组活动任务。
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
	enqueued := 0
	for _, c := range stage3 {
		if c.AssigneeType.String != "agent" || !c.AssigneeID.Valid {
			continue
		}
		if _, err := dispatcher.EnqueueTaskForIssue(ctx, c); err != nil {
			// 已标记 triggered_at，本轮部分入队失败不会自动重试；返回 err
			// 让 sweep 把这次记入 blocked["error"]，运维从审计里定位。
			return true, "", enqueued, fmt.Errorf("enqueue stage3 %s: %w", util.UUIDToString(c.ID), err)
		}
		enqueued++
	}
	return true, "", enqueued, nil
}

// moduleWindowFree 报告该需求所在模块是否对其 root 组空闲（无其它组活动任务）。
//
// v1 桩：始终返回 true —— 组级互斥窗口是 WS3 ModuleLocker v2 的产出，本轮
// WS2 不改 .sql、不引新查询，先让触发链路跑通；等 WS3 落地后把这里换成
// ModuleBusyForOtherRoot（或 WS3 定稿的等价查询）即可，其余触发逻辑无需改。
//
// 无模块需求（module_id 为 NULL）恒返回 true —— 不参与互斥。
func moduleWindowFree(_ context.Context, _ *db.Queries, req db.Issue) (bool, error) {
	if !req.ModuleID.Valid {
		return true, nil
	}
	// TODO(WS3): replace with real ModuleBusyForOtherRoot query once
	// ModuleLocker v2 lands group-level mutex (root_requirement_id keyed).
	return true, nil
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
