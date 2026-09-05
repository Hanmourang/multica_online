package handler

import (
	"context"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// TestProjectAgentRunFromMessages_PairsToolCallByCallID 验证：一次工具调用的
// tool_use（in_progress）与 tool_result（done）按 CallID 合并成同一条待办，
// 且各产生一条 todo_change 事件；非空批产生一条 heartbeat。
func TestProjectAgentRunFromMessages_PairsToolCallByCallID(t *testing.T) {
	msgs := []TaskMessageRequest{
		{Seq: 1, Type: "tool_use", Tool: "bash", CallID: "call_1"},
		{Seq: 2, Type: "tool_result", Tool: "bash", CallID: "call_1", Output: "ok"},
	}
	proj := projectAgentRunFromMessages(msgs)

	if !proj.Heartbeat {
		t.Fatalf("Heartbeat = false, want true (non-empty batch)")
	}
	if len(proj.Todos) != 2 {
		t.Fatalf("Todos len = %d, want 2 (use + result, merged by writer)", len(proj.Todos))
	}
	if proj.Todos[0].Key != "call_1" || proj.Todos[0].Status != "in_progress" || proj.Todos[0].Title != "bash" || proj.Todos[0].Source != "tool_trace" {
		t.Fatalf("Todos[0] = %+v, want key=call_1 status=in_progress title=bash source=tool_trace", proj.Todos[0])
	}
	if proj.Todos[1].Key != "call_1" || proj.Todos[1].Status != "done" {
		t.Fatalf("Todos[1] = %+v, want key=call_1 status=done", proj.Todos[1])
	}
	// heartbeat(1) + todo_change(2)
	var hb, tc int
	for _, ev := range proj.Events {
		switch ev.Type {
		case "heartbeat":
			hb++
		case "todo_change":
			tc++
		}
	}
	if hb != 1 || tc != 2 {
		t.Fatalf("events: heartbeat=%d todo_change=%d, want 1 and 2", hb, tc)
	}
}

// TestProjectAgentRunFromMessages_SkipsTodosWithoutCallID 验证旧 daemon 降级：
// 无 CallID 的 tool 消息不建待办（不留孤儿），但仍计心跳。
func TestProjectAgentRunFromMessages_SkipsTodosWithoutCallID(t *testing.T) {
	proj := projectAgentRunFromMessages([]TaskMessageRequest{
		{Seq: 1, Type: "tool_use", Tool: "bash"},
		{Seq: 2, Type: "thinking", Content: "..."},
	})
	if !proj.Heartbeat {
		t.Fatalf("Heartbeat = false, want true")
	}
	if len(proj.Todos) != 0 {
		t.Fatalf("Todos len = %d, want 0 (no CallID → no orphan todo)", len(proj.Todos))
	}
}

// TestProjectAgentRunFromMessages_ClassifiesErrorAndSetsStall 验证 error 消息
// 归类为事件并带出 stall_reason；空批不产生心跳。
func TestProjectAgentRunFromMessages_ClassifiesErrorAndSetsStall(t *testing.T) {
	proj := projectAgentRunFromMessages([]TaskMessageRequest{
		{Seq: 1, Type: "error", Content: "HTTP 429 Too Many Requests: rate limit exceeded"},
	})
	if len(proj.Events) != 2 { // heartbeat + rate_limit
		t.Fatalf("Events len = %d, want 2 (heartbeat + rate_limit)", len(proj.Events))
	}
	var sawRateLimit bool
	for _, ev := range proj.Events {
		if ev.Type == "rate_limit" {
			sawRateLimit = true
		}
	}
	if !sawRateLimit {
		t.Fatalf("no rate_limit event derived from a 429 error")
	}
	if proj.StallReason != "rate_limited" {
		t.Fatalf("StallReason = %q, want rate_limited", proj.StallReason)
	}

	if empty := projectAgentRunFromMessages(nil); empty.Heartbeat || len(empty.Todos) != 0 || len(empty.Events) != 0 {
		t.Fatalf("empty batch projection = %+v, want zero value", empty)
	}
}

// TestClassifyErrorEvent 覆盖三类归一。
func TestClassifyErrorEvent(t *testing.T) {
	cases := map[string]string{
		"rate limit exceeded":       "rate_limit",
		"429 too many requests":     "rate_limit",
		"quota exceeded for key":    "rate_limit",
		"connection reset by peer":  "net_err",
		"dial tcp: i/o timeout":     "net_err",
		"unexpected EOF":            "net_err",
		"segmentation fault (core)": "crash",
		"something went very wrong": "crash",
	}
	for content, want := range cases {
		if got := classifyErrorEvent(content); got != want {
			t.Errorf("classifyErrorEvent(%q) = %q, want %q", content, got, want)
		}
	}
}

// TestApplyAgentRunProjection_UpsertsRunTodosEvents 验证写入器：确定性 run id
// upsert、todo ON CONFLICT merge、event append、stall_reason COALESCE 保留。
func TestApplyAgentRunProjection_UpsertsRunTodosEvents(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID := dbfx.Runtime(t, "proj-rt", testutil.Cols{"provider": "anthropic"})
	agentID := dbfx.Agent(t, "proj-agent", runtimeID)
	issueID := dbfx.Issue(t, "投影需求")
	taskID := dbfx.Task(t, agentID, testutil.Cols{
		"issue_id":   issueID,
		"runtime_id": runtimeID,
		"status":     "running",
	})
	task := db.AgentTaskQueue{
		ID:        parseUUID(taskID),
		AgentID:   parseUUID(agentID),
		IssueID:   parseUUID(issueID),
		RuntimeID: parseUUID(runtimeID),
	}

	// 第一批：一次工具调用开始 + 一次限流错误。
	testHandler.applyAgentRunProjection(context.Background(), task, testWorkspaceID,
		projectAgentRunFromMessages([]TaskMessageRequest{
			{Seq: 1, Type: "tool_use", Tool: "bash", CallID: "call_1"},
			{Seq: 2, Type: "error", Content: "429 rate limit exceeded"},
		}))

	var runID, cliKind, status, stallReason string
	var tokenUsed int64
	dbfx.QueryRow(t,
		`SELECT id::text, cli_kind, status, COALESCE(stall_reason,''), token_used
		   FROM agent_run WHERE task_queue_id = $1`, taskID).
		Scan(&runID, &cliKind, &status, &stallReason, &tokenUsed)
	if cliKind != "anthropic" {
		t.Fatalf("cli_kind = %q, want anthropic (from runtime provider)", cliKind)
	}
	if status != "running" {
		t.Fatalf("status = %q, want running", status)
	}
	if stallReason != "rate_limited" {
		t.Fatalf("stall_reason = %q, want rate_limited", stallReason)
	}
	// issue_id / root_issue_id 落到 run 上（独立需求 root=自身，见 452）。
	var issueCol, rootCol string
	dbfx.QueryRow(t,
		`SELECT COALESCE(issue_id::text,''), COALESCE(root_issue_id::text,'') FROM agent_run WHERE id = $1`, runID).
		Scan(&issueCol, &rootCol)
	if issueCol != issueID {
		t.Fatalf("issue_id = %q, want %q", issueCol, issueID)
	}
	if rootCol != issueID {
		t.Fatalf("root_issue_id = %q, want %q (independent issue root = self)", rootCol, issueID)
	}
	// 待办 call_1 = in_progress；事件含 heartbeat + todo_change + rate_limit。
	var todoStatus string
	dbfx.QueryRow(t, `SELECT status FROM agent_run_todo WHERE run_id = $1 AND todo_key = 'call_1'`, runID).Scan(&todoStatus)
	if todoStatus != "in_progress" {
		t.Fatalf("todo status = %q, want in_progress", todoStatus)
	}
	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run_event WHERE run_id = $1 AND event_type = 'rate_limit'`, runID); got != 1 {
		t.Fatalf("rate_limit events = %d, want 1", got)
	}

	// 第二批（同 task）：工具调用结束。**同一 run**（确定性 id），待办翻 done，
	// stall_reason 不被干净批清空（COALESCE 保留）。
	testHandler.applyAgentRunProjection(context.Background(), task, testWorkspaceID,
		projectAgentRunFromMessages([]TaskMessageRequest{
			{Seq: 3, Type: "tool_result", Tool: "bash", CallID: "call_1", Output: "ok"},
		}))
	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run WHERE task_queue_id = $1`, taskID); got != 1 {
		t.Fatalf("run rows = %d, want 1 (deterministic id upsert)", got)
	}
	dbfx.QueryRow(t, `SELECT status FROM agent_run_todo WHERE run_id = $1 AND todo_key = 'call_1'`, runID).Scan(&todoStatus)
	if todoStatus != "done" {
		t.Fatalf("todo status after result = %q, want done", todoStatus)
	}
	dbfx.QueryRow(t, `SELECT COALESCE(stall_reason,'') FROM agent_run WHERE id = $1`, runID).Scan(&stallReason)
	if stallReason != "rate_limited" {
		t.Fatalf("stall_reason after clean batch = %q, want rate_limited (preserved)", stallReason)
	}
}

// TestFinalizeAgentRunStatus_IdempotentAndPreInsert 验证终态收尾：
// (a) completed/failed/cancelled 幂等守卫——已终态的 run 不被后续回调覆盖；
// (b) M-4：finalize 先于首次心跳（run 行尚不存在）时，upsert 直接落终态占位行，
//     且随后迟到的心跳 INSERT 不会把它复活成 running（也不再新建第二行）。
func TestFinalizeAgentRunStatus_IdempotentAndPreInsert(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID := dbfx.Runtime(t, "fin-rt", testutil.Cols{"provider": "openai"})
	agentID := dbfx.Agent(t, "fin-agent", runtimeID)
	ctx := context.Background()

	// (a) 常规：投影建 running → finalize completed → 再 finalize failed 不覆盖。
	taskIDA := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "status": "running"})
	taskA := db.AgentTaskQueue{ID: parseUUID(taskIDA), AgentID: parseUUID(agentID), RuntimeID: parseUUID(runtimeID)}
	testHandler.applyAgentRunProjection(ctx, taskA, testWorkspaceID,
		projectAgentRunFromMessages([]TaskMessageRequest{{Seq: 1, Type: "tool_use", Tool: "bash", CallID: "c1"}}))
	testHandler.finalizeAgentRunStatus(ctx, taskA, testWorkspaceID, "completed")
	var status string
	dbfx.QueryRow(t, `SELECT status FROM agent_run WHERE task_queue_id = $1`, taskIDA).Scan(&status)
	if status != "completed" {
		t.Fatalf("status = %q, want completed", status)
	}
	testHandler.finalizeAgentRunStatus(ctx, taskA, testWorkspaceID, "failed")
	dbfx.QueryRow(t, `SELECT status FROM agent_run WHERE task_queue_id = $1`, taskIDA).Scan(&status)
	if status != "completed" {
		t.Fatalf("terminal run clobbered: status = %q, want completed", status)
	}

	// (b) M-4 竞态：finalize 先于任何心跳（run 行不存在）→ 落 cancelled 占位行；
	//     随后迟到心跳不得复活为 running。
	taskIDB := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "status": "running"})
	taskB := db.AgentTaskQueue{ID: parseUUID(taskIDB), AgentID: parseUUID(agentID), RuntimeID: parseUUID(runtimeID)}
	testHandler.finalizeAgentRunStatus(ctx, taskB, testWorkspaceID, "cancelled")
	dbfx.QueryRow(t, `SELECT status FROM agent_run WHERE task_queue_id = $1`, taskIDB).Scan(&status)
	if status != "cancelled" {
		t.Fatalf("pre-insert finalize status = %q, want cancelled", status)
	}
	testHandler.applyAgentRunProjection(ctx, taskB, testWorkspaceID,
		projectAgentRunFromMessages([]TaskMessageRequest{{Seq: 1, Type: "tool_use", Tool: "bash", CallID: "c2"}}))
	dbfx.QueryRow(t, `SELECT status FROM agent_run WHERE task_queue_id = $1`, taskIDB).Scan(&status)
	if status != "cancelled" {
		t.Fatalf("late heartbeat resurrected terminal run: status = %q, want cancelled", status)
	}
	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run WHERE task_queue_id = $1`, taskIDB); got != 1 {
		t.Fatalf("run rows = %d, want 1 (deterministic id upsert, no duplicate)", got)
	}
}

// TestRecomputeAgentRunTokens_FromSource 验证 M-3：token_used 按事实源 task_usage
// 重算覆盖，重复上报（Reclaim/Requeue 语义）不单调膨胀，天然幂等。
func TestRecomputeAgentRunTokens_FromSource(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID := dbfx.Runtime(t, "tok-rt", testutil.Cols{"provider": "openai"})
	agentID := dbfx.Agent(t, "tok-agent", runtimeID)
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "status": "running"})
	task := db.AgentTaskQueue{ID: parseUUID(taskID), AgentID: parseUUID(agentID), RuntimeID: parseUUID(runtimeID)}
	ctx := context.Background()

	testHandler.applyAgentRunProjection(ctx, task, testWorkspaceID,
		projectAgentRunFromMessages([]TaskMessageRequest{{Seq: 1, Type: "tool_use", Tool: "bash", CallID: "c1"}}))

	// 事实源：两条 (provider,model) usage 行，合计 (60+40)+(30+20)=150。
	dbfx.Exec(t, `INSERT INTO task_usage (task_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
	              VALUES ($1, 'openai', 'gpt-4o', 60, 40, 0, 0)`, taskID)
	dbfx.Exec(t, `INSERT INTO task_usage (task_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
	              VALUES ($1, 'openai', 'gpt-4o-mini', 30, 20, 0, 0)`, taskID)

	testHandler.recomputeAgentRunTokens(ctx, parseUUID(taskID))
	// 重复重算：仍等于事实源之和，不膨胀（幂等）。
	testHandler.recomputeAgentRunTokens(ctx, parseUUID(taskID))
	var tokens int64
	dbfx.QueryRow(t, `SELECT token_used FROM agent_run WHERE task_queue_id = $1`, taskID).Scan(&tokens)
	if tokens != 150 {
		t.Fatalf("token_used = %d, want 150 (recomputed from task_usage, idempotent)", tokens)
	}

	// UpsertTaskUsage replace 语义：同 (task,provider,model) 再次上报累计快照 90，
	// 重算后应为 90+50=140，而非 150+90=240（这正是 M-3 修正的双计）。
	dbfx.Exec(t, `INSERT INTO task_usage (task_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
	              VALUES ($1, 'openai', 'gpt-4o', 90, 0, 0, 0)
	              ON CONFLICT (task_id, provider, model) DO UPDATE SET input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens`, taskID)
	testHandler.recomputeAgentRunTokens(ctx, parseUUID(taskID))
	dbfx.QueryRow(t, `SELECT token_used FROM agent_run WHERE task_queue_id = $1`, taskID).Scan(&tokens)
	if tokens != 140 {
		t.Fatalf("token_used after replace = %d, want 140 (not accumulated)", tokens)
	}
}
