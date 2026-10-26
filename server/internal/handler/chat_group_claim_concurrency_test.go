package handler

import (
	"context"
	"strings"
	"testing"
)

// 群派发不是续聊：每个任务 ForceFreshSession 且自带不可变输入快照
// （chat_group_task_input），claim 路径从不 resume 会话指针。所以同一 Agent 在
// 同一群里可以并行处理多条提问 —— claim 的 chat 串行只对真正共享续聊指针的
// 1:1/DM 会话成立。此前串行按 chat_session_id 一刀切，把不同提问当成同一轮
// 续聊挡住，第二条永远等第一条结束，与 agent.max_concurrent_tasks 无关。
func TestGroupClaimAllowsConcurrentTurnsForOneAgent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available")
	}
	fx := newGroupClaimFixture(t, "gpar")
	// 容量是另一道闸门（CountRunningTasks vs max_concurrent_tasks）：测试 fixture
	// 默认把 agent 建成单并发，先抬到 5 才能验证「额度足够时群内不等兄弟任务」。
	if _, err := testPool.Exec(context.Background(),
		`UPDATE agent SET max_concurrent_tasks = 5 WHERE id = $1`, fx.agentID); err != nil {
		t.Fatalf("raise agent capacity: %v", err)
	}

	firstTask := groupFanoutSend(t, fx, "first question")
	claimed1 := groupClaimOne(t, fx)
	if got := uuidToString(claimed1.ID); got != firstTask {
		t.Fatalf("first claim = %s, want %s", got, firstTask)
	}

	// 第一条仍在 in-flight（dispatched），第二条必须立刻可领。
	secondTask := groupFanoutSend(t, fx, "second question")
	claimed2 := groupClaimOne(t, fx)
	if got := uuidToString(claimed2.ID); got != secondTask {
		t.Fatalf("second claim = %s, want %s: a group turn must not wait for its sibling", got, secondTask)
	}

	// 并行不共享输入：第一条的快照不可变，不会被后发的问题污染。
	resp1, failure1 := groupBuildClaim(t, fx, claimed1)
	if failure1 != nil {
		t.Fatalf("claim build 1: %+v", failure1)
	}
	if !strings.Contains(resp1.ChatMessage, "first question") {
		t.Fatalf("task1 input missing its own trigger: %q", resp1.ChatMessage)
	}
	if strings.Contains(resp1.ChatMessage, "second question") {
		t.Fatalf("task1 snapshot absorbed a later turn: %q", resp1.ChatMessage)
	}
	resp2, failure2 := groupBuildClaim(t, fx, claimed2)
	if failure2 != nil {
		t.Fatalf("claim build 2: %+v", failure2)
	}
	if !strings.Contains(resp2.ChatMessage, "second question") {
		t.Fatalf("task2 input missing its trigger: %q", resp2.ChatMessage)
	}
}
