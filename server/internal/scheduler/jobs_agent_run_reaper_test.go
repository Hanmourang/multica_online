package scheduler

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestAgentRunReaper_ConvergesStaleRunningRuns 验证 M-5 reaper 的三条收敛路径：
//   - stale + task 已终态(completed) → run 同步 completed；
//   - stale + task 仍非终态(running)  → run 置 stalled；
//   - 心跳新鲜(fresh) 的 running run  → 不被触碰（仍 running）。
//
// 集合式 UPDATE 只命中 status='running' 且心跳过期者，天然幂等。
func TestAgentRunReaper_ConvergesStaleRunningRuns(t *testing.T) {
	pool := integrationPool(t)
	ctx := context.Background()
	suffix := "reaper-" + uniqueSuffix()

	var wsID, runtimeID, agentID string
	mustScan(t, pool.QueryRow(ctx, `
		INSERT INTO workspace (name, slug) VALUES ($1, $1) RETURNING id`, suffix), &wsID)
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, wsID) })
	mustScan(t, pool.QueryRow(ctx, `
		INSERT INTO agent_runtime (workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, metadata, last_seen_at)
		VALUES ($1, NULL, $2, 'cloud', 'p', 'online', '{}'::jsonb, '{}'::jsonb, now()) RETURNING id`, wsID, "rt-"+suffix), &runtimeID)
	mustScan(t, pool.QueryRow(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config, runtime_id, visibility, max_concurrent_tasks)
		VALUES ($1, $2, '', 'cloud', '{}'::jsonb, $3, 'workspace', 1) RETURNING id`, wsID, "ag-"+suffix, runtimeID), &agentID)

	// task A：已终态 completed；task B：仍非终态 running。
	taskA := seedReaperTask(t, pool, agentID, runtimeID, "completed")
	taskB := seedReaperTask(t, pool, agentID, runtimeID, "running")
	taskC := seedReaperTask(t, pool, agentID, runtimeID, "running")

	// run A/B：running + 心跳过期（远超 10min 阈值）；run C：running + 心跳新鲜。
	runA := seedReaperRun(t, pool, wsID, agentID, taskA, "running", "now() - interval '30 minutes'")
	runB := seedReaperRun(t, pool, wsID, agentID, taskB, "running", "now() - interval '30 minutes'")
	runC := seedReaperRun(t, pool, wsID, agentID, taskC, "running", "now()")

	res, err := makeAgentRunReaperHandler(pool, agentRunStallThreshold)(ctx, HandlerInput{})
	if err != nil {
		t.Fatalf("reaper handler: %v", err)
	}
	if res.RowsAffected != 2 {
		t.Errorf("RowsAffected = %d, want 2 (only the two stale running runs)", res.RowsAffected)
	}

	if got := runStatus(t, pool, runA); got != "completed" {
		t.Errorf("run A (task completed) status = %q, want completed", got)
	}
	if got := runStatus(t, pool, runB); got != "stalled" {
		t.Errorf("run B (task still running) status = %q, want stalled", got)
	}
	if got := runStatus(t, pool, runC); got != "running" {
		t.Errorf("run C (fresh heartbeat) status = %q, want running (untouched)", got)
	}

	// 幂等：再跑一次不触碰已收敛的终态/stalled 行，也不误伤 fresh running。
	res2, err := makeAgentRunReaperHandler(pool, agentRunStallThreshold)(ctx, HandlerInput{})
	if err != nil {
		t.Fatalf("reaper handler (2nd): %v", err)
	}
	if res2.RowsAffected != 0 {
		t.Errorf("2nd RowsAffected = %d, want 0 (idempotent)", res2.RowsAffected)
	}
}

func mustScan(t *testing.T, row interface{ Scan(...any) error }, dst ...any) {
	t.Helper()
	if err := row.Scan(dst...); err != nil {
		t.Fatalf("scan: %v", err)
	}
}

func seedReaperTask(t *testing.T, pool *pgxpool.Pool, agentID, runtimeID, status string) string {
	t.Helper()
	var id string
	mustScan(t, pool.QueryRow(context.Background(), `
		INSERT INTO agent_task_queue (agent_id, runtime_id, status)
		VALUES ($1, $2, $3) RETURNING id`, agentID, runtimeID, status), &id)
	return id
}

// seedReaperRun 建一条 agent_run。heartbeatExpr 是 last_heartbeat_at 的完整 SQL
// 表达式片段（如 "now()" 或 "now() - interval '30 minutes'"），不含占位参数。
func seedReaperRun(t *testing.T, pool *pgxpool.Pool, wsID, agentID, taskID, status, heartbeatExpr string) string {
	t.Helper()
	var id string
	q := `INSERT INTO agent_run (workspace_id, task_queue_id, agent_id, cli_kind, status, last_heartbeat_at)
	      VALUES ($1, $2, $3, 'test', $4, ` + heartbeatExpr + `) RETURNING id`
	mustScan(t, pool.QueryRow(context.Background(), q, wsID, taskID, agentID, status), &id)
	return id
}

func runStatus(t *testing.T, pool *pgxpool.Pool, runID string) string {
	t.Helper()
	var s string
	mustScan(t, pool.QueryRow(context.Background(), `SELECT status FROM agent_run WHERE id = $1`, runID), &s)
	return s
}
