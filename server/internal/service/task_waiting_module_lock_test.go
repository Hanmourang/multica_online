package service

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// waiting_module_lock 上报管道（spec §5/§6）：daemon 等待跨模块「避免冲突」
// 锁期间，任务行从 dispatched 停进 waiting_module_lock，wait_reason 落库并随
// 事件广播；拿到锁后 StartAgentTask 能把它转回 running（与
// waiting_local_directory 同一套转换契约）。
func TestMarkTaskWaitingModuleLock(t *testing.T) {
	pool := newResolveOriginatorPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, agentID, issueID := seedAttributionFixture(t, pool)

	var runtimeID string
	if err := pool.QueryRow(ctx, `SELECT runtime_id::text FROM agent WHERE id = $1`, agentID).Scan(&runtimeID); err != nil {
		t.Fatalf("load agent runtime: %v", err)
	}
	var taskID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, dispatched_at)
		VALUES ($1, $2, $3, 'dispatched', 0, now())
		RETURNING id
	`, agentID, runtimeID, issueID).Scan(&taskID); err != nil {
		t.Fatalf("seed dispatched task: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, taskID)
	})

	bus := events.New()
	var got events.Event
	bus.Subscribe(protocol.EventTaskWaitingModuleLock, func(e events.Event) { got = e })
	svc := &TaskService{Queries: q, TxStarter: pool, Bus: bus}

	reason := "模块「内核与配置」"
	task, err := svc.MarkTaskWaitingModuleLock(ctx, util.MustParseUUID(taskID), reason)
	if err != nil {
		t.Fatalf("MarkTaskWaitingModuleLock: %v", err)
	}
	if task.Status != "waiting_module_lock" {
		t.Fatalf("status = %q, want waiting_module_lock", task.Status)
	}
	if !task.WaitReason.Valid || task.WaitReason.String != reason {
		t.Fatalf("wait_reason = %+v, want %q", task.WaitReason, reason)
	}

	// 行状态复核（不走返回值的缓存）
	var persistedStatus, persistedReason string
	if err := pool.QueryRow(ctx, `SELECT status, wait_reason FROM agent_task_queue WHERE id = $1`, taskID).
		Scan(&persistedStatus, &persistedReason); err != nil {
		t.Fatalf("reload task: %v", err)
	}
	if persistedStatus != "waiting_module_lock" || persistedReason != reason {
		t.Fatalf("persisted = (%q, %q), want (waiting_module_lock, %q)", persistedStatus, persistedReason, reason)
	}

	if got.Type != protocol.EventTaskWaitingModuleLock {
		t.Fatalf("event type = %q, want %q", got.Type, protocol.EventTaskWaitingModuleLock)
	}
	if got.TaskID != taskID {
		t.Fatalf("event TaskID = %q, want %q", got.TaskID, taskID)
	}
	payload, ok := got.Payload.(map[string]any)
	if !ok {
		t.Fatalf("payload type = %T, want map[string]any", got.Payload)
	}
	if payload["wait_reason"] != reason {
		t.Fatalf("payload wait_reason = %v, want %q", payload["wait_reason"], reason)
	}

	// 拿到锁后的恢复路径：waiting_module_lock → running
	started, err := q.StartAgentTask(ctx, util.MustParseUUID(taskID))
	if err != nil {
		t.Fatalf("StartAgentTask from waiting_module_lock: %v", err)
	}
	if started.Status != "running" {
		t.Fatalf("status after start = %q, want running", started.Status)
	}
	if started.WaitReason.Valid {
		t.Fatalf("wait_reason after start = %+v, want cleared", started.WaitReason)
	}
}

// 契约与 waiting_local_directory 一致：只有 dispatched 能停进 waiting_module_lock，
// 已是 running/终态的行不受影响（query 的 WHERE 兜底，service 透传 no-rows 错误）。
func TestMarkTaskWaitingModuleLockRequiresDispatched(t *testing.T) {
	pool := newResolveOriginatorPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, agentID, issueID := seedAttributionFixture(t, pool)

	var runtimeID string
	if err := pool.QueryRow(ctx, `SELECT runtime_id::text FROM agent WHERE id = $1`, agentID).Scan(&runtimeID); err != nil {
		t.Fatalf("load agent runtime: %v", err)
	}
	var taskID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, started_at)
		VALUES ($1, $2, $3, 'running', 0, now())
		RETURNING id
	`, agentID, runtimeID, issueID).Scan(&taskID); err != nil {
		t.Fatalf("seed running task: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, taskID)
	})

	svc := &TaskService{Queries: q, TxStarter: pool, Bus: events.New()}
	if _, err := svc.MarkTaskWaitingModuleLock(ctx, util.MustParseUUID(taskID), "模块「内核与配置」"); err == nil {
		t.Fatal("expected error marking a running task waiting_module_lock")
	}

	var persistedStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM agent_task_queue WHERE id = $1`, taskID).Scan(&persistedStatus); err != nil {
		t.Fatalf("reload task: %v", err)
	}
	if persistedStatus != "running" {
		t.Fatalf("status = %q, want running (untouched)", persistedStatus)
	}
}

// 防止回归 pgtype 细节：空 reason 落 NULL 而不是空串，UI 靠 Valid 区分
// 「在等锁但没说等谁」与「等某个具体模块」。
func TestMarkTaskWaitingModuleLockBlankReasonStoresNull(t *testing.T) {
	pool := newResolveOriginatorPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, agentID, issueID := seedAttributionFixture(t, pool)

	var runtimeID string
	if err := pool.QueryRow(ctx, `SELECT runtime_id::text FROM agent WHERE id = $1`, agentID).Scan(&runtimeID); err != nil {
		t.Fatalf("load agent runtime: %v", err)
	}
	var taskID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, dispatched_at)
		VALUES ($1, $2, $3, 'dispatched', 0, now())
		RETURNING id
	`, agentID, runtimeID, issueID).Scan(&taskID); err != nil {
		t.Fatalf("seed dispatched task: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, taskID)
	})

	svc := &TaskService{Queries: q, TxStarter: pool, Bus: events.New()}
	task, err := svc.MarkTaskWaitingModuleLock(ctx, util.MustParseUUID(taskID), "")
	if err != nil {
		t.Fatalf("MarkTaskWaitingModuleLock: %v", err)
	}
	if task.WaitReason != (pgtype.Text{}) {
		t.Fatalf("wait_reason = %+v, want NULL", task.WaitReason)
	}
}
