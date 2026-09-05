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
