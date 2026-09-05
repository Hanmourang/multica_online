package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
)

// 运行追踪（migration 459）：会话流（task_message）是事实源，
// agent_run / agent_run_todo / agent_run_event 是单向投影。列名以 migration
// 为准。API 契约对齐 packages/core/types/agent-run.ts：
//   - run status:  DB running/completed/failed/cancelled/stalled = API 一致
//   - event payload: API `payload` ↔ DB 列 `detail`
//   - todo status: DB pending/in_progress/done/skipped/failed = API 一致
//   - started_at/finished_at: created_at/updated_at 投影（终态时）
// spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §5.5

// validRunStatus is the set of accepted agent_run.status values (DB = API).
var validRunStatus = map[string]bool{
	"running":   true,
	"completed": true,
	"failed":    true,
	"cancelled": true,
	"stalled":   true,
}

var validStallReasons = map[string]bool{
	"rate_limited":            true,
	"network_lost":            true,
	"crashed":                 true,
	"waiting_module_lock":     true,
	"waiting_local_directory": true,
}

// validTodoStatus is the set of accepted agent_run_todo.status values
// (mirrors the column CHECK in migration 459).
var validTodoStatus = map[string]bool{
	"pending":     true,
	"in_progress": true,
	"done":        true,
	"skipped":     true,
	"failed":      true,
}

// validTodoSource is the set of accepted agent_run_todo.source values.
var validTodoSource = map[string]bool{
	"tool_trace": true,
	"reply":      true,
	"manual":     true,
}

// validRunEventType is the set of accepted agent_run_event.event_type values.
var validRunEventType = map[string]bool{
	"heartbeat":   true,
	"todo_change": true,
	"rate_limit":  true,
	"net_err":     true,
	"crash":       true,
}

const (
	// maxAgentRunWriteBatch caps a single todo / event write so one projector
	// flush cannot turn into an unbounded statement loop.
	maxAgentRunWriteBatch = 500
	// maxAgentRunWriteBodyBytes caps the request body of the batch writes.
	maxAgentRunWriteBodyBytes = 1 << 20 // 1 MiB
	// maxAgentRunEventPayloadBytes caps one event's JSONB payload.
	maxAgentRunEventPayloadBytes = 32 << 10 // 32 KiB
)

// isForeignKeyViolation reports whether err is a PostgreSQL foreign-key
// violation (SQLSTATE 23503). Used to turn a dangling superseded_by reference
// into a 4xx instead of a generic 500.
func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

// parseIntInRange parses a query parameter as an int within [min, max].
func parseIntInRange(s string, min, max int) (int, error) {
	parsed, err := strconv.Atoi(s)
	if err != nil || parsed < min || parsed > max {
		return 0, strconv.ErrSyntax
	}
	return parsed, nil
}

// AgentRunResponse mirrors the TS `AgentRun`.
type AgentRunResponse struct {
	ID              string  `json:"id"`
	TaskQueueID     *string `json:"task_queue_id"`
	IssueID         *string `json:"issue_id"`
	RootIssueID     *string `json:"root_issue_id"`
	WorkspaceID     string  `json:"workspace_id"`
	AgentID         string  `json:"agent_id"`
	Model           *string `json:"model"`
	CliKind         string  `json:"cli_kind"`
	Status          string  `json:"status"`
	LastHeartbeatAt *string `json:"last_heartbeat_at"`
	StallReason     *string `json:"stall_reason"`
	TokenUsed       int64   `json:"token_used"`
	StartedAt       string  `json:"started_at"`
	FinishedAt      *string `json:"finished_at"`
}

// agentRunRow is the scan target for a full agent_run row.
type agentRunRow struct {
	ID              pgtype.UUID
	WorkspaceID     pgtype.UUID
	TaskQueueID     pgtype.UUID
	IssueID         pgtype.UUID
	RootIssueID     pgtype.UUID
	AgentID         string
	Model           pgtype.Text
	CliKind         string
	Status          string
	LastHeartbeatAt pgtype.Timestamptz
	StallReason     pgtype.Text
	TokenUsed       int64
	CreatedAt       pgtype.Timestamptz
	UpdatedAt       pgtype.Timestamptz
}

const agentRunColumns = `id, workspace_id, task_queue_id, issue_id, root_issue_id,
	agent_id, model, cli_kind, status, last_heartbeat_at, stall_reason, token_used,
	created_at, updated_at`

func scanAgentRunRow(scan func(dest ...any) error) (agentRunRow, error) {
	var row agentRunRow
	err := scan(
		&row.ID, &row.WorkspaceID, &row.TaskQueueID, &row.IssueID, &row.RootIssueID,
		&row.AgentID, &row.Model, &row.CliKind, &row.Status, &row.LastHeartbeatAt,
		&row.StallReason, &row.TokenUsed, &row.CreatedAt, &row.UpdatedAt,
	)
	return row, err
}

func agentRunToResponse(row agentRunRow) AgentRunResponse {
	resp := AgentRunResponse{
		ID:              uuidToString(row.ID),
		TaskQueueID:     util.UUIDToPtr(row.TaskQueueID),
		IssueID:         util.UUIDToPtr(row.IssueID),
		RootIssueID:     util.UUIDToPtr(row.RootIssueID),
		WorkspaceID:     uuidToString(row.WorkspaceID),
		AgentID:         row.AgentID,
		Model:           textToPtr(row.Model),
		CliKind:         row.CliKind,
		Status:          row.Status,
		LastHeartbeatAt: timestampToPtr(row.LastHeartbeatAt),
		StallReason:     textToPtr(row.StallReason),
		TokenUsed:       row.TokenUsed,
		StartedAt:       timestampToString(row.CreatedAt),
	}
	// finished_at projection: a terminal run's last update approximates its
	// end time (the table has no dedicated column; §4.5).
	if row.Status == "completed" || row.Status == "failed" || row.Status == "stalled" || row.Status == "cancelled" {
		resp.FinishedAt = timestampToPtr(row.UpdatedAt)
	}
	return resp
}

// UpsertAgentRunRequest is the body for POST /api/agent-runs.
type UpsertAgentRunRequest struct {
	ID              *string `json:"id"`
	TaskQueueID     *string `json:"task_queue_id"`
	IssueID         *string `json:"issue_id"`
	RootIssueID     *string `json:"root_issue_id"`
	AgentID         string  `json:"agent_id"`
	Model           *string `json:"model"`
	CliKind         string  `json:"cli_kind"`
	Status          string  `json:"status"`
	LastHeartbeatAt *string `json:"last_heartbeat_at"`
	StallReason     *string `json:"stall_reason"`
	TokenUsed       int64   `json:"token_used"`
}

// UpsertAgentRun implements POST /api/agent-runs: the projector's write
// endpoint. Passing `id` makes the call idempotent (ON CONFLICT (id) DO
// UPDATE); omitting it lets the server mint a fresh run.
func (h *Handler) UpsertAgentRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var req UpsertAgentRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.AgentID = strings.TrimSpace(req.AgentID)
	req.CliKind = strings.TrimSpace(req.CliKind)
	if req.AgentID == "" {
		writeError(w, http.StatusBadRequest, "agent_id is required")
		return
	}
	if req.CliKind == "" {
		writeError(w, http.StatusBadRequest, "cli_kind is required")
		return
	}
	if !validRunStatus[req.Status] {
		writeError(w, http.StatusBadRequest, "status must be one of running/completed/failed/cancelled/stalled")
		return
	}

	var runID pgtype.UUID
	if req.ID != nil && *req.ID != "" {
		parsed, err := util.ParseUUID(*req.ID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "id is not a valid UUID")
			return
		}
		runID = parsed
	}
	var taskQueueID, issueID, rootIssueID pgtype.UUID
	if req.TaskQueueID != nil && *req.TaskQueueID != "" {
		parsed, err := util.ParseUUID(*req.TaskQueueID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "task_queue_id is not a valid UUID")
			return
		}
		taskQueueID = parsed
	}
	if req.IssueID != nil && *req.IssueID != "" {
		parsed, err := util.ParseUUID(*req.IssueID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "issue_id is not a valid UUID")
			return
		}
		issueID = parsed
		// The FK only guarantees existence, not workspace affinity — pin the
		// run to the caller's workspace.
		var issueWorkspace pgtype.UUID
		if err := h.DB.QueryRow(r.Context(),
			`SELECT workspace_id FROM issue WHERE id = $1`, issueID,
		).Scan(&issueWorkspace); err != nil || issueWorkspace != wsUUID {
			writeError(w, http.StatusBadRequest, "issue_id does not belong to this workspace")
			return
		}
	}
	if req.RootIssueID != nil && *req.RootIssueID != "" {
		parsed, err := util.ParseUUID(*req.RootIssueID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "root_issue_id is not a valid UUID")
			return
		}
		rootIssueID = parsed
	}
	var stallReason pgtype.Text
	if req.StallReason != nil && *req.StallReason != "" {
		if !validStallReasons[*req.StallReason] {
			writeError(w, http.StatusBadRequest, "stall_reason must be one of rate_limited/network_lost/crashed/waiting_module_lock/waiting_local_directory")
			return
		}
		stallReason = pgtype.Text{String: *req.StallReason, Valid: true}
	}
	var lastHeartbeatAt pgtype.Timestamptz
	if req.LastHeartbeatAt != nil && *req.LastHeartbeatAt != "" {
		parsed, err := util.ParseTimestamp(*req.LastHeartbeatAt)
		if err != nil {
			writeError(w, http.StatusBadRequest, "last_heartbeat_at must be an RFC3339 timestamp")
			return
		}
		lastHeartbeatAt = parsed
	}

	row, err := scanAgentRunRow(func(dest ...any) error {
		return h.DB.QueryRow(r.Context(), `
			INSERT INTO agent_run (
				id, workspace_id, task_queue_id, issue_id, root_issue_id,
				agent_id, model, cli_kind, status, last_heartbeat_at, stall_reason, token_used
			) VALUES (
				$1, $2, $3, $4, $5,
				$6, $7, $8, $9, $10, $11, $12
			)
			ON CONFLICT (id) DO UPDATE SET
				task_queue_id = EXCLUDED.task_queue_id,
				issue_id = EXCLUDED.issue_id,
				root_issue_id = EXCLUDED.root_issue_id,
				agent_id = EXCLUDED.agent_id,
				model = EXCLUDED.model,
				cli_kind = EXCLUDED.cli_kind,
				status = EXCLUDED.status,
				last_heartbeat_at = EXCLUDED.last_heartbeat_at,
				stall_reason = EXCLUDED.stall_reason,
				token_used = EXCLUDED.token_used,
				updated_at = now()
			RETURNING `+agentRunColumns,
			runID, wsUUID, taskQueueID, issueID, rootIssueID,
			req.AgentID, util.PtrToText(req.Model), req.CliKind, req.Status,
			lastHeartbeatAt, stallReason, req.TokenUsed,
		).Scan(dest...)
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "agent run conflict")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to upsert agent run")
		return
	}
	// TODO(project-archive): publish EventAgentRunUpserted once the protocol
	// constant exists.
	writeJSON(w, http.StatusOK, agentRunToResponse(row))
}

// ListAgentRuns implements GET /api/issues/{id}/agent-runs: every run
// recorded under the requirement (child-task runs roll up via root_issue_id).
func (h *Handler) ListAgentRuns(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	runs, err := h.listAgentRunsForIssue(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list agent runs")
		return
	}
	resp := make([]AgentRunResponse, len(runs))
	for i, row := range runs {
		resp[i] = agentRunToResponse(row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": resp, "total": len(resp)})
}

// loadAgentRunForUser resolves a run by id and enforces that the caller is a
// member of the run's workspace.
func (h *Handler) loadAgentRunForUser(w http.ResponseWriter, r *http.Request) (agentRunRow, bool) {
	runUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "runId"), "run id")
	if !ok {
		return agentRunRow{}, false
	}
	row, err := scanAgentRunRow(func(dest ...any) error {
		return h.DB.QueryRow(r.Context(),
			`SELECT `+agentRunColumns+` FROM agent_run WHERE id = $1`, runUUID,
		).Scan(dest...)
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "agent run not found")
		return agentRunRow{}, false
	}
	if _, ok := h.workspaceMember(w, r, uuidToString(row.WorkspaceID)); !ok {
		return agentRunRow{}, false
	}
	return row, true
}

// AgentRunTodoResponse mirrors the TS `AgentRunTodo` (plus `title`, which the
// DB requires but the TS contract omits).
type AgentRunTodoResponse struct {
	ID           string  `json:"id"`
	RunID        string  `json:"run_id"`
	TodoKey      string  `json:"todo_key"`
	Phase        *string `json:"phase"`
	Title        string  `json:"title"`
	Status       string  `json:"status"`
	Seq          int32   `json:"seq"`
	Source       string  `json:"source"`
	SupersededBy *string `json:"superseded_by"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
}

// ListAgentRunTodos implements GET /api/agent-runs/{runId}/todos: the run's
// todo list ordered by seq.
func (h *Handler) ListAgentRunTodos(w http.ResponseWriter, r *http.Request) {
	run, ok := h.loadAgentRunForUser(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, run_id, todo_key, phase, title, status, seq, source, superseded_by, created_at, updated_at
		FROM agent_run_todo
		WHERE run_id = $1
		ORDER BY seq, created_at`,
		run.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list agent run todos")
		return
	}
	defer rows.Close()

	todos := []AgentRunTodoResponse{}
	for rows.Next() {
		var t AgentRunTodoResponse
		var id, runID, supersededBy pgtype.UUID
		var phase pgtype.Text
		var createdAt, updatedAt pgtype.Timestamptz
		if err := rows.Scan(&id, &runID, &t.TodoKey, &phase, &t.Title, &t.Status, &t.Seq, &t.Source, &supersededBy, &createdAt, &updatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan agent run todo")
			return
		}
		t.ID = uuidToString(id)
		t.RunID = uuidToString(runID)
		t.Phase = textToPtr(phase)
		t.SupersededBy = util.UUIDToPtr(supersededBy)
		t.CreatedAt = timestampToString(createdAt)
		t.UpdatedAt = timestampToString(updatedAt)
		todos = append(todos, t)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list agent run todos")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"todos": todos, "total": len(todos)})
}

// decodeAgentRunWriteBody decodes a size-capped batch-write body. The
// projector flushes in batches, so the read is bounded before parsing to keep
// one oversized payload from ballooning the handler's memory.
func decodeAgentRunWriteBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	body := http.MaxBytesReader(w, r.Body, maxAgentRunWriteBodyBytes)
	if err := json.NewDecoder(body).Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

// requireRunInRequestWorkspace pins a write to the workspace the request was
// authenticated against. The route middleware already guarantees membership,
// but a member of two workspaces must not be able to project todos / events
// into the other one by run id — so the run row has to belong to the same
// workspace. Reported as 404 (not 403) to avoid leaking cross-workspace
// existence.
func (h *Handler) requireRunInRequestWorkspace(w http.ResponseWriter, r *http.Request, run agentRunRow) bool {
	want := ctxWorkspaceID(r.Context())
	if want == "" {
		// Handlers invoked without the workspace middleware (e.g. direct unit
		// calls) resolve the identifier the same way the middleware does.
		want = h.resolveWorkspaceID(r)
	}
	if want == "" || want == uuidToString(run.WorkspaceID) {
		return true
	}
	writeError(w, http.StatusNotFound, "agent run not found")
	return false
}

// AgentRunTodoInput is one todo in a POST /api/agent-runs/{runId}/todos body.
// `todo_key` is the merge key (stable across runs); `status` / `source` fall
// back to the DB defaults when omitted.
type AgentRunTodoInput struct {
	TodoKey      string  `json:"todo_key"`
	Phase        *string `json:"phase"`
	Title        string  `json:"title"`
	Status       string  `json:"status"`
	Seq          int32   `json:"seq"`
	Source       string  `json:"source"`
	SupersededBy *string `json:"superseded_by"`
}

// UpsertAgentRunTodosRequest is the body for POST /api/agent-runs/{runId}/todos.
type UpsertAgentRunTodosRequest struct {
	Todos []AgentRunTodoInput `json:"todos"`
}

// agentRunTodoWrite is a validated, DB-ready todo row.
type agentRunTodoWrite struct {
	key          string
	phase        pgtype.Text
	title        string
	status       string
	seq          int32
	source       string
	supersededBy pgtype.UUID
}

// prepareAgentRunTodoWrite validates one input row and projects it onto the
// migration-459 columns. Every row is validated before anything is written so
// a bad row cannot leave a half-applied batch behind.
func prepareAgentRunTodoWrite(in AgentRunTodoInput, index int) (agentRunTodoWrite, string) {
	var out agentRunTodoWrite

	out.key = strings.TrimSpace(in.TodoKey)
	if out.key == "" {
		return agentRunTodoWrite{}, fmt.Sprintf("todos[%d].todo_key is required", index)
	}
	out.title = strings.TrimSpace(in.Title)
	if out.title == "" {
		return agentRunTodoWrite{}, fmt.Sprintf("todos[%d].title is required", index)
	}
	if in.Seq < 0 {
		return agentRunTodoWrite{}, fmt.Sprintf("todos[%d].seq must be >= 0", index)
	}
	out.seq = in.Seq

	out.status = strings.TrimSpace(in.Status)
	if out.status == "" {
		out.status = "pending"
	}
	if !validTodoStatus[out.status] {
		return agentRunTodoWrite{}, fmt.Sprintf("todos[%d].status must be one of pending/in_progress/done/skipped/failed", index)
	}
	out.source = strings.TrimSpace(in.Source)
	if out.source == "" {
		out.source = "tool_trace"
	}
	if !validTodoSource[out.source] {
		return agentRunTodoWrite{}, fmt.Sprintf("todos[%d].source must be one of tool_trace/reply/manual", index)
	}
	if in.Phase != nil {
		// phase is an open string (CLI-defined, e.g. P0 / 设计 / 验收); blank
		// collapses to NULL so the projection stays honest.
		if phase := strings.TrimSpace(*in.Phase); phase != "" {
			out.phase = pgtype.Text{String: phase, Valid: true}
		}
	}
	if in.SupersededBy != nil && strings.TrimSpace(*in.SupersededBy) != "" {
		// superseded_by references agent_run_todo.id (a row id, not a todo_key).
		parsed, err := util.ParseUUID(strings.TrimSpace(*in.SupersededBy))
		if err != nil {
			return agentRunTodoWrite{}, fmt.Sprintf("todos[%d].superseded_by is not a valid UUID", index)
		}
		out.supersededBy = parsed
	}
	return out, ""
}

// UpsertAgentRunTodos implements POST /api/agent-runs/{runId}/todos: the
// projector's batch todo write. (run_id, todo_key) is the merge key, so the
// call is idempotent — replaying a flush updates status/seq/phase in place
// rather than duplicating rows. The whole batch commits or rolls back.
func (h *Handler) UpsertAgentRunTodos(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	// loadAgentRunForUser resolves the run and enforces membership in the run's
	// workspace (same guard as the todo / event reads); the second check pins the
	// write to the workspace this request was authenticated against.
	run, ok := h.loadAgentRunForUser(w, r)
	if !ok {
		return
	}
	if !h.requireRunInRequestWorkspace(w, r, run) {
		return
	}
	var req UpsertAgentRunTodosRequest
	if !decodeAgentRunWriteBody(w, r, &req) {
		return
	}
	if len(req.Todos) > maxAgentRunWriteBatch {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("at most %d todos per request", maxAgentRunWriteBatch))
		return
	}
	if len(req.Todos) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"upserted_count": 0})
		return
	}

	prepared := make([]agentRunTodoWrite, 0, len(req.Todos))
	seen := make(map[string]int, len(req.Todos))
	for i, in := range req.Todos {
		row, errMsg := prepareAgentRunTodoWrite(in, i)
		if errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
		if first, dup := seen[row.key]; dup {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("todos[%d].todo_key %q duplicates todos[%d] in the same batch", i, row.key, first))
			return
		}
		seen[row.key] = i
		prepared = append(prepared, row)
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(r.Context())

	for _, row := range prepared {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO agent_run_todo (
				workspace_id, run_id, todo_key, phase, title, status, seq, source, superseded_by
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (run_id, todo_key) DO UPDATE SET
				phase = EXCLUDED.phase,
				title = EXCLUDED.title,
				status = EXCLUDED.status,
				seq = EXCLUDED.seq,
				source = EXCLUDED.source,
				superseded_by = EXCLUDED.superseded_by,
				updated_at = now()`,
			run.WorkspaceID, run.ID, row.key, row.phase, row.title, row.status,
			row.seq, row.source, row.supersededBy,
		); err != nil {
			if isForeignKeyViolation(err) {
				writeError(w, http.StatusBadRequest, "superseded_by does not reference an existing agent run todo")
				return
			}
			if isCheckViolation(err) {
				writeError(w, http.StatusBadRequest, "todo field violates a column constraint")
				return
			}
			writeError(w, http.StatusInternalServerError, "failed to upsert agent run todo")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit agent run todos")
		return
	}
	// TODO(project-archive): publish EventAgentRunTodosUpserted once the
	// protocol constant exists.
	writeJSON(w, http.StatusOK, map[string]any{"upserted_count": len(prepared)})
}

// AgentRunEventResponse mirrors the TS `AgentRunEvent` (DB column `detail`
// projects to API field `payload`).
type AgentRunEventResponse struct {
	ID        string          `json:"id"`
	RunID     string          `json:"run_id"`
	EventType string          `json:"event_type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt string          `json:"created_at"`
}

// ListAgentRunEvents implements GET /api/agent-runs/{runId}/events: the run's
// event stream (heartbeats / todo changes / rate limits / net errors /
// crashes), newest first, capped by the `limit` query parameter.
func (h *Handler) ListAgentRunEvents(w http.ResponseWriter, r *http.Request) {
	run, ok := h.loadAgentRunForUser(w, r)
	if !ok {
		return
	}
	limit := 50
	if limitStr := strings.TrimSpace(r.URL.Query().Get("limit")); limitStr != "" {
		parsed, err := parseIntInRange(limitStr, 1, 500)
		if err != nil {
			writeError(w, http.StatusBadRequest, "limit must be an integer within 1..500")
			return
		}
		limit = parsed
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, run_id, event_type, detail, created_at
		FROM agent_run_event
		WHERE run_id = $1
		ORDER BY created_at DESC
		LIMIT $2`,
		run.ID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list agent run events")
		return
	}
	defer rows.Close()

	events := []AgentRunEventResponse{}
	for rows.Next() {
		var e AgentRunEventResponse
		var id, runID pgtype.UUID
		var payload []byte
		var createdAt pgtype.Timestamptz
		if err := rows.Scan(&id, &runID, &e.EventType, &payload, &createdAt); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan agent run event")
			return
		}
		e.ID = uuidToString(id)
		e.RunID = uuidToString(runID)
		e.Payload = payload
		e.CreatedAt = timestampToString(createdAt)
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list agent run events")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events, "total": len(events)})
}

// AgentRunEventInput is one event in a POST /api/agent-runs/{runId}/events
// body. API field `type` maps to DB column `event_type`, API field `payload`
// maps to DB column `detail` (the same projection the read side applies).
type AgentRunEventInput struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// AppendAgentRunEventsRequest is the body for POST /api/agent-runs/{runId}/events.
type AppendAgentRunEventsRequest struct {
	Events []AgentRunEventInput `json:"events"`
}

// AppendAgentRunEvents implements POST /api/agent-runs/{runId}/events: the
// projector's append-only event write (heartbeats / todo changes / rate limits
// / net errors / crashes). There is no merge key — every call appends, so the
// batch commits atomically to keep the timeline gap-free.
func (h *Handler) AppendAgentRunEvents(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	run, ok := h.loadAgentRunForUser(w, r)
	if !ok {
		return
	}
	if !h.requireRunInRequestWorkspace(w, r, run) {
		return
	}
	var req AppendAgentRunEventsRequest
	if !decodeAgentRunWriteBody(w, r, &req) {
		return
	}
	if len(req.Events) > maxAgentRunWriteBatch {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("at most %d events per request", maxAgentRunWriteBatch))
		return
	}
	if len(req.Events) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"appended_count": 0})
		return
	}

	// Validate first, write second: a malformed row must not leave the earlier
	// rows of the same flush committed.
	type eventWrite struct {
		eventType string
		detail    string
	}
	prepared := make([]eventWrite, 0, len(req.Events))
	for i, in := range req.Events {
		eventType := strings.TrimSpace(in.Type)
		if !validRunEventType[eventType] {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("events[%d].type must be one of heartbeat/todo_change/rate_limit/net_err/crash", i))
			return
		}
		detail := "{}"
		if raw := strings.TrimSpace(string(in.Payload)); raw != "" && raw != "null" {
			if len(raw) > maxAgentRunEventPayloadBytes {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("events[%d].payload exceeds %d bytes", i, maxAgentRunEventPayloadBytes))
				return
			}
			if !json.Valid([]byte(raw)) {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("events[%d].payload must be valid JSON", i))
				return
			}
			if !strings.HasPrefix(raw, "{") {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("events[%d].payload must be a JSON object", i))
				return
			}
			detail = raw
		}
		prepared = append(prepared, eventWrite{eventType: eventType, detail: detail})
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(r.Context())

	for _, ev := range prepared {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO agent_run_event (workspace_id, run_id, event_type, detail)
			VALUES ($1, $2, $3, $4::jsonb)`,
			run.WorkspaceID, run.ID, ev.eventType, ev.detail,
		); err != nil {
			if isCheckViolation(err) {
				writeError(w, http.StatusBadRequest, "event field violates a column constraint")
				return
			}
			writeError(w, http.StatusInternalServerError, "failed to append agent run event")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit agent run events")
		return
	}
	// TODO(project-archive): publish EventAgentRunEventsAppended once the
	// protocol constant exists.
	writeJSON(w, http.StatusOK, map[string]any{"appended_count": len(prepared)})
}
