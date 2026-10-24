// 工作流 30s sweep（CoCo 对标 plan 20261024 §01 C5，Agent-W）。
//
// 镜像 RequirementTriggerJob 结构：单一入口 svc.SweepWaiting —— 「扫 waiting
// 实例 → 逐个幂等启动」。幂等锚点是 MarkWorkflowStarted 的 CAS（仅 waiting→
// running），sweep 并发 / 多副本重入 / 手动启动三通道共用同一守卫，因此
// AllowStaleReentry=true 是安全的。workflow_module flag 关闭时 SweepWaiting
// 空转返回零汇总 —— job 注册与否不影响回滚语义。
package scheduler

import (
	"context"
	"fmt"
	"time"

	"github.com/multica-ai/multica/server/internal/service"
)

// JobNameWorkflowTrigger 是写入 sys_cron_executions 的稳定 job 名，跨版本勿改。
const JobNameWorkflowTrigger = "workflow_waiting_dispatch"

// workflowSweeper 是本 job 对 *service.WorkflowService 的窄契约（单测可 stub）。
type workflowSweeper interface {
	SweepWaiting(ctx context.Context) (service.WorkflowSweepSummary, error)
}

// WorkflowTriggerJob 返回 30s 全局 sweep 的 JobSpec（参数逐值对照
// RequirementTriggerJob：同节奏、同补跑策略、同重入安全性论证）。
func WorkflowTriggerJob(svc *service.WorkflowService) JobSpec {
	return workflowTriggerJobWith(svc)
}

func workflowTriggerJobWith(sweeper workflowSweeper) JobSpec {
	return JobSpec{
		Name:              JobNameWorkflowTrigger,
		Cadence:           30 * time.Second,
		ScheduleDelay:     0,
		CatchUpMode:       CatchUpLatestOnly, // 停机后只补最近一次 sweep；waiting 实例一轮全扫
		CatchUpWindow:     1 * time.Hour,
		RunTimeout:        2 * time.Minute,
		StaleTimeout:      3 * time.Minute,
		HeartbeatInterval: 10 * time.Second,
		AllowStaleReentry: true, // MarkWorkflowStarted CAS ⇒ 重入安全
		MaxAttempts:       3,
		RetryBackoff:      []time.Duration{30 * time.Second, 2 * time.Minute},
		MaxPlansPerTick:   1,
		Scopes:            StaticScopes(ScopeGlobal),
		Handler:           workflowTriggerHandler(sweeper),
	}
}

// workflowTriggerHandler 单次 sweep：RowsAffected = 本轮新启动实例数，
// Result = {scanned, started, errors} 审计汇总（sys_cron_executions.result）。
func workflowTriggerHandler(sweeper workflowSweeper) Handler {
	return func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
		summary, err := sweeper.SweepWaiting(ctx)
		if err != nil {
			return HandlerResult{}, fmt.Errorf("workflow sweep: %w", err)
		}
		return HandlerResult{RowsAffected: int64(summary.Started), Result: summary.ResultMap()}, nil
	}
}
