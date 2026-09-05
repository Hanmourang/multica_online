package service

import (
	"context"
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// TestCountRunningTasksIncludesModuleLockWaiters 钉死 WS3 共存决策 C（plan
// Task 3.5）：waiting_module_lock 的任务仍计入 agent 容量闸 CountRunningTasks，
// 保证 resume 时不突破 MaxConcurrentTasks（agent.sql 该查询注释的 rationale：
// 移除会导致 waiter 恢复运行时容量超限）。ModuleLocker v2 的组级互斥由 daemon
// 内存锁的 (moduleID, rootRequirementID) 二维 key 强制，不改这条计数 SQL——
// 本测试即该决策的回归护栏：若有人把 waiting_module_lock 从计数中移除，
// 第二断言（容量已满拒绝再领）立即失败。
func TestCountRunningTasksIncludesModuleLockWaiters(t *testing.T) {
	ctx := context.Background()
	pool := newTaskClaimRacePool(t) // 复用同包 DB fixture helper（无库自动 Skip）
	queries := db.New(pool)

	// fixture：agent(max_concurrent_tasks=1) + 2 个 queued 任务。
	agentID := createClaimCapacityFixture(t, ctx, pool)
	agentUUID := util.MustParseUUID(agentID)

	// 初始容量占用 = 0。
	running, err := queries.CountRunningTasks(ctx, agentUUID)
	if err != nil {
		t.Fatalf("CountRunningTasks: %v", err)
	}
	if running != 0 {
		t.Fatalf("expected 0 running tasks initially, got %d", running)
	}

	// 模拟 daemon 泊入模块锁等待（MarkTaskWaitingModuleLock 的净效果）：
	// 最早入队的任务置为 waiting_module_lock。
	if _, err := pool.Exec(ctx, `
		UPDATE agent_task_queue SET status = 'waiting_module_lock'
		WHERE id = (
			SELECT id FROM agent_task_queue
			WHERE agent_id = $1 AND status = 'queued'
			ORDER BY created_at LIMIT 1
		)
	`, agentID); err != nil {
		t.Fatalf("set waiting_module_lock: %v", err)
	}

	// 核心断言①：waiter 计入容量闸 → CountRunningTasks = 1。
	running, err = queries.CountRunningTasks(ctx, agentUUID)
	if err != nil {
		t.Fatalf("CountRunningTasks after park: %v", err)
	}
	if running != 1 {
		t.Fatalf("CountRunningTasks must include waiting_module_lock: got %d, want 1", running)
	}

	// 核心断言②：容量已满（max=1，waiter 占 1），ClaimTask 拒绝再领——
	// 第二个 queued 任务留在队列而不是突破并发上限。
	task, err := NewTaskService(queries, pool, nil, events.New()).ClaimTask(ctx, agentUUID)
	if err != nil {
		t.Fatalf("ClaimTask: %v", err)
	}
	if task != nil {
		t.Fatalf("ClaimTask must refuse while the module-lock waiter holds the only capacity slot, got task %s", util.UUIDToString(task.ID))
	}
}
