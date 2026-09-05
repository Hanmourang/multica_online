package scheduler

import (
	"context"
	"fmt"
	"time"
)

// JobNameRequirementTriggerSweep 是写进 sys_cron_executions 审计行的作业名。
// 跨版本稳定——改名会让历史行成为孤儿。
const JobNameRequirementTriggerSweep = "requirement_trigger_sweep"

// RequirementTriggerSweeper 是本作业对 service 层的最小契约
// （service.IssueService.SweepRequirementTriggers 的实现），放在这里以便
// 本包单测与 cmd/server 集成测试可以 stub。
type RequirementTriggerSweeper interface {
	SweepRequirementTriggers(ctx context.Context) (int, error)
}

// RequirementTriggerSweepJob 返回驱动「需求到点触发」的 JobSpec
// （spec 2026-09-04-requirement-calendar-design.md §7.1）：每 30s 一轮，
// 扫 ListTriggerableRequirements 命中的需求并触发（写 triggered_at +
// stage 3 子任务入队）。
//
// 幂等与并发安全都在 service 层：MarkRequirementTriggered 的 execrows
// 守卫保证同一需求只触发一次；stale-lease 重入（AllowStaleReentry）
// 重跑一轮只会重扫到「未触发」集合，不会重复入队。
func RequirementTriggerSweepJob(sweeper RequirementTriggerSweeper) JobSpec {
	return JobSpec{
		Name:              JobNameRequirementTriggerSweep,
		Cadence:           30 * time.Second,
		ScheduleDelay:     0,
		CatchUpMode:       CatchUpLatestOnly,
		CatchUpWindow:     10 * time.Minute,
		RunTimeout:        2 * time.Minute,
		StaleTimeout:      5 * time.Minute,
		HeartbeatInterval: 10 * time.Second,
		AllowStaleReentry: true,
		MaxAttempts:       2,
		RetryBackoff: []time.Duration{
			1 * time.Minute,
		},
		Scopes:  StaticScopes(ScopeGlobal),
		Handler: makeRequirementTriggerSweepHandler(sweeper),
	}
}

func makeRequirementTriggerSweepHandler(sweeper RequirementTriggerSweeper) Handler {
	return func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
		triggered, err := sweeper.SweepRequirementTriggers(ctx)
		if err != nil {
			return HandlerResult{}, fmt.Errorf("requirement trigger sweep: %w", err)
		}
		return HandlerResult{RowsAffected: int64(triggered)}, nil
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
		// 保证只有出边没入边的节点也被外层循环枚举到（例如 b 只在 {a,b}
		// 里作为 to 出现时无需额外处理，但 {b,c} 单独存在时 b 需要在 adj 里）。
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
