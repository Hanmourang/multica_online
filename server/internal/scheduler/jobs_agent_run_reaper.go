// 需求日历 Phase I（WS5 agent_run 投影）收尾补丁 M-5：僵尸 running reaper。
//
// agent_run 的终态此前只由 daemon 的 complete/fail/cancel 回调驱动
// （handler.finalizeAgentRunStatus）。若 daemon 进程被 kill / 宕机 / 网络永久
// 断开，那条回调永远不会到达，投影出的 run 会永久停在 status='running'——
// 既误导前端「运行中」，也让 root 需求的派生态卡在阶段态。
//
// migration 459 的 agent_run_status_check 已允许 'stalled'，前端读取端
// （issue_archive.go）也已就绪，但全仓此前没有任何 'stalled' 的写入者。本 job
// 补上这个 reaper：周期性扫描心跳过期的 running run，据其 task 的权威终态收敛。
package scheduler

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// JobNameAgentRunReaper 是写入 sys_cron_executions 的稳定 job 名。
// 跨版本勿改：改名会让历史审计行成为孤儿（无法按 job 名回查）。
const JobNameAgentRunReaper = "agent_run_stalled_reaper"

// agentRunStallThreshold 是判定 running run「心跳过期」的阈值。run 的
// last_heartbeat_at 在每批 ReportTaskMessages（agent 活跃时约每 500ms）刷新，
// 故 10 分钟无任何消息批是 daemon 已死的强信号；取足够大以避免长工具调用
// （如一次数分钟的构建，其间无 message 批）被误判为 stalled。
const agentRunStallThreshold = 10 * time.Minute

// AgentRunReaperJob 返回周期性 reaper 的 JobSpec。全局单 scope、轻量集合式
// UPDATE，故 Cadence 2min / RunTimeout 1min 足够；镜像 TaskUsageHourlyJob 的
// 时间字段约束（StaleTimeout>RunTimeout、0<HeartbeatInterval<StaleTimeout）。
func AgentRunReaperJob(pool *pgxpool.Pool) JobSpec {
	return JobSpec{
		Name:              JobNameAgentRunReaper,
		Cadence:           2 * time.Minute,
		ScheduleDelay:     0,
		CatchUpMode:       CatchUpLatestOnly, // 停机后只补最近一次；本轮一次扫全所有过期 run
		CatchUpWindow:     1 * time.Hour,
		RunTimeout:        1 * time.Minute,
		StaleTimeout:      2 * time.Minute,
		HeartbeatInterval: 20 * time.Second,
		AllowStaleReentry: true, // 集合式 UPDATE 幂等 ⇒ 重入安全
		MaxAttempts:       3,
		RetryBackoff:      []time.Duration{30 * time.Second, 2 * time.Minute},
		MaxPlansPerTick:   1,
		Scopes:            StaticScopes(ScopeGlobal),
		Handler:           makeAgentRunReaperHandler(pool, agentRunStallThreshold),
	}
}

// makeAgentRunReaperHandler 用一条集合式 UPDATE 收敛所有心跳过期的 running run：
//
//   - task 已终态（completed/failed/cancelled）→ run 同步该终态（daemon 回调丢失，
//     但 task 侧权威事务已落定，据实收敛）；
//   - task 仍非终态、或 task_queue_id 为空 / task 行已被清理 → run 置 'stalled'
//     （daemon 失联且无权威终态可依，标记为停摆供人工/前端识别）。
//
// 相关子查询对「task 不存在」返回 NULL，与「task 非终态」的 ELSE NULL 一并被
// COALESCE 收敛到 'stalled'，无需 LEFT JOIN。UPDATE 只命中 status='running' 行，
// 天然幂等：已终态/已 stalled 的 run 不再被触碰。
func makeAgentRunReaperHandler(pool *pgxpool.Pool, threshold time.Duration) Handler {
	mins := int(threshold / time.Minute)
	if mins < 1 {
		mins = 1
	}
	return func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
		tag, err := pool.Exec(ctx, `
			UPDATE agent_run r
			SET status = COALESCE(
					(SELECT CASE q.status
						WHEN 'completed' THEN 'completed'
						WHEN 'failed'    THEN 'failed'
						WHEN 'cancelled' THEN 'cancelled'
						ELSE NULL
					 END
					 FROM agent_task_queue q WHERE q.id = r.task_queue_id),
					'stalled'),
				updated_at = now()
			WHERE r.status = 'running'
			  AND r.last_heartbeat_at IS NOT NULL
			  AND r.last_heartbeat_at < now() - make_interval(mins => $1)`,
			mins,
		)
		if err != nil {
			return HandlerResult{}, fmt.Errorf("reap stalled agent runs: %w", err)
		}

		// Light heartbeat at the end keeps stale_after fresh for a run much
		// shorter than HeartbeatInterval（对照 TaskUsageHourlyJob）。
		if in.Heartbeat != nil {
			_ = in.Heartbeat(ctx)
		}
		return HandlerResult{
			RowsAffected: tag.RowsAffected(),
			Result: map[string]any{
				"stall_threshold_minutes": mins,
			},
		}, nil
	}
}
