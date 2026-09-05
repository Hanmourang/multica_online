package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	obsmetrics "github.com/multica-ai/multica/server/internal/metrics"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// WS5（需求日历 Phase I）：server 侧 ingest 投影。
//
// migration 459 头注明确 task_message 是事实源、agent_run/_todo/_event 是单向
// 投影；而 /api/agent-runs 三写端点挂在 RequireWorkspaceMember 组下
// （router.go:1859-1860 + agent_run.go:189/535/703 requireUserID），daemon 的
// runtime token 无法调用。故投影贴着事实源做：ReportTaskMessages 落 task_message
// 后，就地把同一批 messages 派生为 run/todo/event（见 applyAgentRunProjection）。
//
// 本文件只放**纯派生**逻辑（无 DB、无 IO），便于单测；写入器与终态收尾另见
// applyAgentRunProjection / finalizeAgentRunStatus。

// projectedTodo 是一条待办的派生结果，写入 agent_run_todo。
type projectedTodo struct {
	Key    string // todo_key：tool_use/tool_result 的 CallID（配对键）
	Title  string // 工具名
	Status string // in_progress（tool_use）/ done（tool_result）
	Seq    int    // 消息序号
	Source string // 恒为 tool_trace
}

// projectedEvent 是一条事件的派生结果，写入 agent_run_event。
type projectedEvent struct {
	Type    string          // heartbeat / todo_change / rate_limit / net_err / crash
	Payload json.RawMessage // 恒为 JSON 对象
}

// agentRunProjection 是一批 messages 的完整派生结果。
type agentRunProjection struct {
	Heartbeat   bool             // 非空批 → true
	StallReason string           // 该批最后一条 error 映射的 stall_reason，无则 ""
	Todos       []projectedTodo  // 按消息序，写入器按序 upsert
	Events      []projectedEvent // 含 1 条 heartbeat（若非空）+ todo_change + error 事件
}

// projectAgentRunFromMessages 从一批已解码的 task messages 派生 run 投影。纯函数。
func projectAgentRunFromMessages(msgs []TaskMessageRequest) agentRunProjection {
	var proj agentRunProjection
	if len(msgs) == 0 {
		return proj
	}
	proj.Heartbeat = true
	proj.Events = append(proj.Events, projectedEvent{
		Type:    "heartbeat",
		Payload: mustJSONObject(map[string]any{"messages": len(msgs)}),
	})

	for _, msg := range msgs {
		switch msg.Type {
		case "tool_use", "tool_result":
			if strings.TrimSpace(msg.CallID) == "" {
				// 旧 daemon 未透传 CallID：无法把 use/result 配对成一条待办，
				// 宁可不建（避免孤儿 in_progress），心跳已计。
				continue
			}
			status := "in_progress"
			if msg.Type == "tool_result" {
				status = "done"
			}
			title := strings.TrimSpace(msg.Tool)
			if title == "" {
				title = "tool"
			}
			proj.Todos = append(proj.Todos, projectedTodo{
				Key:    msg.CallID,
				Title:  title,
				Status: status,
				Seq:    msg.Seq,
				Source: "tool_trace",
			})
			proj.Events = append(proj.Events, projectedEvent{
				Type: "todo_change",
				Payload: mustJSONObject(map[string]any{
					"todo_key": msg.CallID,
					"status":   status,
					"tool":     title,
				}),
			})
		case "error":
			eventType := classifyErrorEvent(msg.Content)
			proj.Events = append(proj.Events, projectedEvent{
				Type:    eventType,
				Payload: mustJSONObject(map[string]any{"error": truncateRunError(msg.Content)}),
			})
			proj.StallReason = stallReasonForEvent(eventType)
		}
	}
	return proj
}

// classifyErrorEvent 把 error 文本归一到 agent_run_event.event_type 的三类
// （对齐 459:62-63 CHECK 与 agent_run.go:61 validRunEventType）。
func classifyErrorEvent(content string) string {
	lower := strings.ToLower(content)
	switch {
	case strings.Contains(lower, "rate limit"),
		strings.Contains(lower, "429"),
		strings.Contains(lower, "too many requests"),
		strings.Contains(lower, "quota"):
		return "rate_limit"
	case strings.Contains(lower, "connection"),
		strings.Contains(lower, "network"),
		strings.Contains(lower, "timeout"),
		strings.Contains(lower, "dial"),
		strings.Contains(lower, "tls"),
		strings.Contains(lower, "eof"):
		return "net_err"
	default:
		return "crash"
	}
}

// stallReasonForEvent 把事件类型映射到 agent_run.stall_reason
// （对齐 459:18-20 CHECK）；非 stall 类事件返回 ""。
func stallReasonForEvent(eventType string) string {
	switch eventType {
	case "rate_limit":
		return "rate_limited"
	case "net_err":
		return "network_lost"
	case "crash":
		return "crashed"
	default:
		return ""
	}
}

// truncateRunError 把错误文本截断到 512 字，避免 detail JSONB 膨胀。
func truncateRunError(s string) string {
	const max = 512
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// mustJSONObject 把 map 序列化为 JSON 对象；map 只含 string/int，序列化不会失败，
// 兜底返回 "{}"（与 agent_run.go:739 的默认 detail 一致）。
func mustJSONObject(m map[string]any) json.RawMessage {
	b, err := json.Marshal(m)
	if err != nil || len(b) == 0 {
		return json.RawMessage("{}")
	}
	return b
}

// ---------------------------------------------------------------------------
// 写入器 + 确定性 run id
// ---------------------------------------------------------------------------

// agentRunProjNamespace 是固定的 UUID v5 命名空间，使同一 agent_task_queue 行
// 恒定派生同一 agent_run.id —— 从而复用 run PK 的 ON CONFLICT(id)（与
// UpsertAgentRun 同构，agent_run.go:286），无需在 task_queue_id 上另建唯一索引。
var agentRunProjNamespace = uuid.MustParse("2f6d0a4e-7c31-4b9a-9e55-1a2b3c4d5e6f")

// agentRunIDForTask 从 task_queue_id 确定性派生 run id。
func agentRunIDForTask(taskID pgtype.UUID) pgtype.UUID {
	id := uuid.NewSHA1(agentRunProjNamespace, taskID.Bytes[:])
	return pgtype.UUID{Bytes: id, Valid: true}
}

// applyAgentRunProjection 把一批 messages 的派生结果写入 agent_run/_todo/_event。
// best-effort：任何错误只记日志、不返回 —— task_message 才是事实源且已提交，
// 投影失败绝不能 500 系统最热的写路径（MUL-6523）。
func (h *Handler) applyAgentRunProjection(ctx context.Context, task db.AgentTaskQueue, wsID string, proj agentRunProjection) {
	if !task.ID.Valid || !proj.Heartbeat {
		return
	}
	wsUUID := parseUUID(wsID)
	if !wsUUID.Valid {
		slog.Warn("agent run projection: invalid workspace id", "task_id", uuidToString(task.ID))
		return
	}

	agentID := uuidToString(task.AgentID)
	if agentID == "" {
		agentID = "unknown"
	}
	cliKind := h.resolveRunCliKind(ctx, task.RuntimeID)
	runID := agentRunIDForTask(task.ID)

	var stallReason pgtype.Text
	if proj.StallReason != "" {
		stallReason = pgtype.Text{String: proj.StallReason, Valid: true}
	}

	// run upsert：确定性 id → ON CONFLICT(id)。root_issue_id 由 issue 行的
	// root_requirement_id 子查询取得（独立需求 root=自身，452 回填；未回填时
	// COALESCE 降级为 issue 自身 id）。干净批用 COALESCE 保留既有 stall_reason，
	// 不因一次心跳清空。
	if _, err := h.DB.Exec(ctx, `
		INSERT INTO agent_run (
			id, workspace_id, task_queue_id, issue_id, root_issue_id,
			agent_id, cli_kind, status, stall_reason, last_heartbeat_at
		) VALUES (
			$1, $2, $3, $4, (SELECT COALESCE(root_requirement_id, id) FROM issue WHERE id = $4),
			$5, $6, 'running', $7, now()
		)
		ON CONFLICT (id) DO UPDATE SET
			last_heartbeat_at = now(),
			stall_reason = COALESCE(EXCLUDED.stall_reason, agent_run.stall_reason),
			updated_at = now()`,
		runID, wsUUID, task.ID, task.IssueID, agentID, cliKind, stallReason,
	); err != nil {
		slog.Warn("agent run projection: upsert run failed",
			"task_id", uuidToString(task.ID), "error", err)
		return
	}

	if len(proj.Todos) == 0 && len(proj.Events) == 0 {
		return
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		slog.Warn("agent run projection: begin tx failed", "task_id", uuidToString(task.ID), "error", err)
		return
	}
	defer tx.Rollback(ctx)

	for _, td := range proj.Todos {
		// 镜像 UpsertAgentRunTodos（agent_run.go:585-596），但 phase /
		// superseded_by 恒 NULL 且 DO UPDATE 不触碰二者（保留 reply/manual 源的值）。
		if _, err := tx.Exec(ctx, `
			INSERT INTO agent_run_todo (
				workspace_id, run_id, todo_key, phase, title, status, seq, source, superseded_by
			) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, NULL)
			ON CONFLICT (run_id, todo_key) DO UPDATE SET
				title = EXCLUDED.title,
				status = EXCLUDED.status,
				seq = EXCLUDED.seq,
				source = EXCLUDED.source,
				updated_at = now()`,
			wsUUID, runID, td.Key, td.Title, td.Status, td.Seq, td.Source,
		); err != nil {
			slog.Warn("agent run projection: upsert todo failed",
				"task_id", uuidToString(task.ID), "todo_key", td.Key, "error", err)
			return
		}
	}
	for _, ev := range proj.Events {
		// 镜像 AppendAgentRunEvents（agent_run.go:766-769）：append-only。
		if _, err := tx.Exec(ctx, `
			INSERT INTO agent_run_event (workspace_id, run_id, event_type, detail)
			VALUES ($1, $2, $3, $4::jsonb)`,
			wsUUID, runID, ev.Type, string(ev.Payload),
		); err != nil {
			slog.Warn("agent run projection: append event failed",
				"task_id", uuidToString(task.ID), "event_type", ev.Type, "error", err)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Warn("agent run projection: commit failed", "task_id", uuidToString(task.ID), "error", err)
		return
	}
}

// resolveRunCliKind 经 task.RuntimeID → agent_runtime.provider 解析 cli_kind，
// 失败回落 "unknown"（cli_kind TEXT NOT NULL，459:13）。server 侧唯一可得的
// agent 身份串就是 runtime.provider；若日后需要更细的 CLI 种类，由 daemon 的
// backend 名透传，届时替换此函数即可。
func (h *Handler) resolveRunCliKind(ctx context.Context, runtimeID pgtype.UUID) string {
	if !runtimeID.Valid {
		return "unknown"
	}
	rt, err := h.getAgentRuntime(ctx, obsmetrics.RuntimeLookupSourceTask, runtimeID)
	if err != nil || strings.TrimSpace(rt.Provider) == "" {
		return "unknown"
	}
	return rt.Provider
}

// ---------------------------------------------------------------------------
// 终态收尾
// ---------------------------------------------------------------------------

// finalizeAgentRunStatus 把 run 置为终态（completed/failed/cancelled）。
// WHERE status='running' 是幂等 + 防覆盖守卫：daemon 可能对同一 task 多次回调
// （如 cancel ack 与 fail 竞态），只有仍 running 的 run 才翻终态，已终态的不动。
// best-effort：错误只记日志，绝不阻断终态回调自身的权威事务。
func (h *Handler) finalizeAgentRunStatus(ctx context.Context, taskID pgtype.UUID, status string) {
	if !taskID.Valid {
		return
	}
	if _, err := h.DB.Exec(ctx, `
		UPDATE agent_run SET status = $2, updated_at = now()
		WHERE id = $1 AND status = 'running'`,
		agentRunIDForTask(taskID), status,
	); err != nil {
		slog.Warn("agent run finalize: update status failed",
			"task_id", uuidToString(taskID), "status", status, "error", err)
	}
}

// addAgentRunTokens 把一次 usage 上报的 token 数累加到 run.token_used。
// best-effort，同上。
func (h *Handler) addAgentRunTokens(ctx context.Context, taskID pgtype.UUID, tokens int64) {
	if !taskID.Valid || tokens <= 0 {
		return
	}
	if _, err := h.DB.Exec(ctx, `
		UPDATE agent_run SET token_used = token_used + $2, updated_at = now()
		WHERE id = $1`,
		agentRunIDForTask(taskID), tokens,
	); err != nil {
		slog.Warn("agent run tokens: accumulate failed",
			"task_id", uuidToString(taskID), "tokens", tokens, "error", err)
	}
}
