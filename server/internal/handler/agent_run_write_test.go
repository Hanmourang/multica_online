package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// 运行投影写端点（migration 459；spec §5.5）：POST /api/agent-runs/{runId}/todos
// 以 (run_id, todo_key) 为合并键幂等 upsert，POST /api/agent-runs/{runId}/events
// 为 append-only。两者都必须把行钉在请求所属 workspace 上，并在任一行非法时
// 整批回滚（不留半批）。

// insertAgentRunFixture creates a run row in the test workspace and returns its
// id. agent_run_todo / agent_run_event cascade off it, so the fixture teardown
// removes everything a case wrote.
func insertAgentRunFixture(t *testing.T, workspaceID string) string {
	t.Helper()
	return dbfx.Insert(t, "agent_run", testutil.Cols{
		"workspace_id": workspaceID,
		"agent_id":     "agent-run-write-test",
		"cli_kind":     "claude",
		"status":       "running",
	})
}

func postAgentRunWrite(t *testing.T, path string, body any, runID string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := withURLParam(newRequest(http.MethodPost, path, body), "runId", runID)
	switch {
	case strings.HasSuffix(path, "/todos"):
		testHandler.UpsertAgentRunTodos(w, req)
	case strings.HasSuffix(path, "/events"):
		testHandler.AppendAgentRunEvents(w, req)
	default:
		t.Fatalf("unexpected path %q", path)
	}
	return w
}

func decodeCount(t *testing.T, w *httptest.ResponseRecorder, field string) int {
	t.Helper()
	var resp map[string]int
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response %q: %v", w.Body.String(), err)
	}
	return resp[field]
}

// TestUpsertAgentRunTodos_MergesOnTodoKey covers the projector's replay path:
// one batch inserts, the next batch with the same keys moves status/seq/phase
// forward in place instead of duplicating rows.
func TestUpsertAgentRunTodos_MergesOnTodoKey(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runID := insertAgentRunFixture(t, testWorkspaceID)
	path := "/api/agent-runs/" + runID + "/todos"

	w := postAgentRunWrite(t, path, map[string]any{
		"todos": []map[string]any{
			{
				"todo_key": "P1-T5",
				"phase":    "execution",
				"title":    "实现用户登录",
				"status":   "in_progress",
				"seq":      1,
				"source":   "tool_trace",
			},
			// status / source / phase omitted → DB defaults (pending /
			// tool_trace / NULL) must survive the projection.
			{"todo_key": "P1-T6", "title": "实现注册", "seq": 2},
		},
	}, runID)
	if w.Code != http.StatusOK {
		t.Fatalf("first batch: status = %d, body = %s", w.Code, w.Body.String())
	}
	if got := decodeCount(t, w, "upserted_count"); got != 2 {
		t.Fatalf("first batch: upserted_count = %d, want 2", got)
	}

	var status, source string
	var phase *string
	dbfx.QueryRow(t,
		`SELECT status, source, phase FROM agent_run_todo WHERE run_id = $1 AND todo_key = 'P1-T6'`,
		runID).Scan(&status, &source, &phase)
	if status != "pending" || source != "tool_trace" || phase != nil {
		t.Fatalf("defaults: status = %q, source = %q, phase = %v", status, source, phase)
	}

	// Replay the same keys with the todo finished: still two rows, and the
	// merged row carries the new state.
	w = postAgentRunWrite(t, path, map[string]any{
		"todos": []map[string]any{
			{"todo_key": "P1-T5", "phase": "验收", "title": "实现用户登录", "status": "done", "seq": 3, "source": "reply"},
			{"todo_key": "P1-T6", "title": "实现注册", "status": "in_progress", "seq": 2},
		},
	}, runID)
	if w.Code != http.StatusOK {
		t.Fatalf("replay: status = %d, body = %s", w.Code, w.Body.String())
	}
	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run_todo WHERE run_id = $1`, runID); got != 2 {
		t.Fatalf("replay: todo rows = %d, want 2 (todo_key is the merge key)", got)
	}
	var seq int32
	dbfx.QueryRow(t,
		`SELECT status, source, phase, seq FROM agent_run_todo WHERE run_id = $1 AND todo_key = 'P1-T5'`,
		runID).Scan(&status, &source, &phase, &seq)
	if status != "done" || source != "reply" || phase == nil || *phase != "验收" || seq != 3 {
		t.Fatalf("merged row: status = %q, source = %q, phase = %v, seq = %d", status, source, phase, seq)
	}

	// An empty batch is a no-op, not an error — projectors flush on a timer.
	w = postAgentRunWrite(t, path, map[string]any{"todos": []map[string]any{}}, runID)
	if w.Code != http.StatusOK || decodeCount(t, w, "upserted_count") != 0 {
		t.Fatalf("empty batch: status = %d, body = %s", w.Code, w.Body.String())
	}
}

// TestUpsertAgentRunTodos_RejectsInvalidBatch walks the validation surface. A
// rejected batch must leave nothing behind: every case runs against the same
// run and the row count is asserted at the end.
func TestUpsertAgentRunTodos_RejectsInvalidBatch(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runID := insertAgentRunFixture(t, testWorkspaceID)
	path := "/api/agent-runs/" + runID + "/todos"

	oversized := make([]map[string]any, 0, maxAgentRunWriteBatch+1)
	for i := 0; i <= maxAgentRunWriteBatch; i++ {
		oversized = append(oversized, map[string]any{
			"todo_key": fmt.Sprintf("K-%d", i), "title": "t",
		})
	}

	cases := []struct {
		name string
		body map[string]any
	}{
		{"missing todo_key", map[string]any{"todos": []map[string]any{{"title": "t"}}}},
		{"missing title", map[string]any{"todos": []map[string]any{{"todo_key": "K-1"}}}},
		{"unknown status", map[string]any{"todos": []map[string]any{{"todo_key": "K-1", "title": "t", "status": "wontfix"}}}},
		{"unknown source", map[string]any{"todos": []map[string]any{{"todo_key": "K-1", "title": "t", "source": "guess"}}}},
		{"negative seq", map[string]any{"todos": []map[string]any{{"todo_key": "K-1", "title": "t", "seq": -1}}}},
		{"superseded_by not a uuid", map[string]any{"todos": []map[string]any{{"todo_key": "K-1", "title": "t", "superseded_by": "P1-T9"}}}},
		{"duplicate key in batch", map[string]any{"todos": []map[string]any{
			{"todo_key": "K-1", "title": "a"},
			{"todo_key": "K-1", "title": "b"},
		}}},
		{"batch over cap", map[string]any{"todos": oversized}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := postAgentRunWrite(t, path, tc.body, runID)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body = %s)", w.Code, w.Body.String())
			}
		})
	}

	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run_todo WHERE run_id = $1`, runID); got != 0 {
		t.Fatalf("rejected batches wrote %d rows, want 0", got)
	}
}

// TestUpsertAgentRunTodos_DanglingSupersededByRollsBack asserts both halves of
// the lineage guard: a superseded_by that points at a row outside the run is a
// 400 (FK violation translated, not a 500), and the valid row that preceded it
// in the same batch is rolled back with it.
func TestUpsertAgentRunTodos_DanglingSupersededByRollsBack(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runID := insertAgentRunFixture(t, testWorkspaceID)
	otherRunID := insertAgentRunFixture(t, testWorkspaceID)
	// A real todo row, but under a different run — the FK is satisfied while the
	// lineage is not what the projector meant, so the write still lands.
	otherTodoID := dbfx.Insert(t, "agent_run_todo", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"run_id":       otherRunID,
		"todo_key":     "P1-T1",
		"title":        "别的 run 的待办",
		"status":       "done",
	})

	path := "/api/agent-runs/" + runID + "/todos"
	w := postAgentRunWrite(t, path, map[string]any{
		"todos": []map[string]any{
			{"todo_key": "K-ok", "title": "先写的合法行"},
			{"todo_key": "K-bad", "title": "指向不存在的行", "superseded_by": "00000000-0000-4000-8000-000000000000"},
		},
	}, runID)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("dangling superseded_by: status = %d, want 400 (body = %s)", w.Code, w.Body.String())
	}
	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run_todo WHERE run_id = $1`, runID); got != 0 {
		t.Fatalf("rolled-back batch left %d rows, want 0", got)
	}

	// The same batch with a live reference succeeds and stores the lineage.
	w = postAgentRunWrite(t, path, map[string]any{
		"todos": []map[string]any{
			{"todo_key": "K-ok", "title": "先写的合法行", "superseded_by": otherTodoID},
		},
	}, runID)
	if w.Code != http.StatusOK {
		t.Fatalf("live superseded_by: status = %d, body = %s", w.Code, w.Body.String())
	}
	var supersededBy string
	dbfx.QueryRow(t,
		`SELECT superseded_by FROM agent_run_todo WHERE run_id = $1 AND todo_key = 'K-ok'`,
		runID).Scan(&supersededBy)
	if supersededBy != otherTodoID {
		t.Fatalf("superseded_by = %q, want %q", supersededBy, otherTodoID)
	}
}

// TestUpsertAgentRunTodos_ForeignWorkspaceRunIsNotFound pins the write to the
// workspace the request was authenticated against: a run that lives in another
// workspace (even one the caller belongs to) reads as 404, so a projector can
// never cross workspaces by run id.
func TestUpsertAgentRunTodos_ForeignWorkspaceRunIsNotFound(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	otherWorkspaceID := dbfx.Workspace(t, "Run Write Other", "run-write-other")
	dbfx.Member(t, otherWorkspaceID, testUserID, "owner")
	foreignRunID := insertAgentRunFixture(t, otherWorkspaceID)

	// newRequest stamps X-Workspace-ID = testWorkspaceID, so the caller asks to
	// write into their primary workspace while naming a foreign run.
	w := postAgentRunWrite(t, "/api/agent-runs/"+foreignRunID+"/todos", map[string]any{
		"todos": []map[string]any{{"todo_key": "K-1", "title": "t"}},
	}, foreignRunID)
	if w.Code != http.StatusNotFound {
		t.Fatalf("foreign workspace run: status = %d, want 404 (body = %s)", w.Code, w.Body.String())
	}
	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run_todo WHERE run_id = $1`, foreignRunID); got != 0 {
		t.Fatalf("foreign workspace write stored %d rows, want 0", got)
	}
}

// TestUpsertAgentRunTodos_UnknownRunIsNotFound covers the existence guard.
func TestUpsertAgentRunTodos_UnknownRunIsNotFound(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	missing := "00000000-0000-4000-8000-0000000000ff"
	w := postAgentRunWrite(t, "/api/agent-runs/"+missing+"/todos", map[string]any{
		"todos": []map[string]any{{"todo_key": "K-1", "title": "t"}},
	}, missing)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown run: status = %d, want 404 (body = %s)", w.Code, w.Body.String())
	}
}

// TestAppendAgentRunEvents_AppendsInOrder asserts the append-only contract:
// every call adds rows (no merge key), the API `type` / `payload` fields land
// in the DB `event_type` / `detail` columns, and an omitted payload stores {}.
func TestAppendAgentRunEvents_AppendsInOrder(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runID := insertAgentRunFixture(t, testWorkspaceID)
	path := "/api/agent-runs/" + runID + "/events"

	w := postAgentRunWrite(t, path, map[string]any{
		"events": []map[string]any{
			{"type": "heartbeat", "payload": map[string]any{"heartbeat_age_seconds": 3}},
			{"type": "todo_change", "payload": map[string]any{"todo_key": "P1-T5", "status": "done"}},
			{"type": "rate_limit"},
		},
	}, runID)
	if w.Code != http.StatusOK {
		t.Fatalf("append: status = %d, body = %s", w.Code, w.Body.String())
	}
	if got := decodeCount(t, w, "appended_count"); got != 3 {
		t.Fatalf("appended_count = %d, want 3", got)
	}

	// Appending again adds rows rather than merging — the timeline is a log.
	w = postAgentRunWrite(t, path, map[string]any{
		"events": []map[string]any{{"type": "heartbeat", "payload": map[string]any{"heartbeat_age_seconds": 9}}},
	}, runID)
	if w.Code != http.StatusOK {
		t.Fatalf("second append: status = %d, body = %s", w.Code, w.Body.String())
	}
	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run_event WHERE run_id = $1`, runID); got != 4 {
		t.Fatalf("event rows = %d, want 4 (append-only)", got)
	}

	var payload string
	dbfx.QueryRow(t,
		`SELECT detail::text FROM agent_run_event WHERE run_id = $1 AND event_type = 'rate_limit'`,
		runID).Scan(&payload)
	if payload != "{}" {
		t.Fatalf("omitted payload stored %s, want {}", payload)
	}
	var heartbeatCount int
	dbfx.QueryRow(t,
		`SELECT count(*) FROM agent_run_event WHERE run_id = $1 AND detail ? 'heartbeat_age_seconds'`,
		runID).Scan(&heartbeatCount)
	if heartbeatCount != 2 {
		t.Fatalf("payload rows = %d, want 2", heartbeatCount)
	}

	w = postAgentRunWrite(t, path, map[string]any{"events": []map[string]any{}}, runID)
	if w.Code != http.StatusOK || decodeCount(t, w, "appended_count") != 0 {
		t.Fatalf("empty batch: status = %d, body = %s", w.Code, w.Body.String())
	}
}

// TestAppendAgentRunEvents_RejectsInvalidBatch walks the event validation
// surface; nothing may be written by a rejected batch.
func TestAppendAgentRunEvents_RejectsInvalidBatch(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runID := insertAgentRunFixture(t, testWorkspaceID)
	path := "/api/agent-runs/" + runID + "/events"

	oversized := make([]map[string]any, 0, maxAgentRunWriteBatch+1)
	for i := 0; i <= maxAgentRunWriteBatch; i++ {
		oversized = append(oversized, map[string]any{"type": "heartbeat"})
	}

	cases := []struct {
		name string
		body map[string]any
	}{
		{"missing type", map[string]any{"events": []map[string]any{{"payload": map[string]any{"a": 1}}}}},
		{"unknown type", map[string]any{"events": []map[string]any{{"type": "compiles"}}}},
		{"payload not an object", map[string]any{"events": []map[string]any{{"type": "heartbeat", "payload": []any{1, 2}}}}},
		{"payload over cap", map[string]any{"events": []map[string]any{{
			"type":    "heartbeat",
			"payload": map[string]any{"blob": strings.Repeat("x", maxAgentRunEventPayloadBytes+1)},
		}}}},
		{"batch over cap", map[string]any{"events": oversized}},
		// The good event precedes the bad one: the whole batch must roll back.
		{"valid row before invalid row", map[string]any{"events": []map[string]any{
			{"type": "heartbeat"},
			{"type": "not-an-event-type"},
		}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := postAgentRunWrite(t, path, tc.body, runID)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body = %s)", w.Code, w.Body.String())
			}
		})
	}

	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run_event WHERE run_id = $1`, runID); got != 0 {
		t.Fatalf("rejected batches wrote %d events, want 0", got)
	}
}

// TestAppendAgentRunEvents_ForeignWorkspaceRunIsNotFound mirrors the todo
// guard on the event path.
func TestAppendAgentRunEvents_ForeignWorkspaceRunIsNotFound(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	otherWorkspaceID := dbfx.Workspace(t, "Run Event Other", "run-event-other")
	dbfx.Member(t, otherWorkspaceID, testUserID, "owner")
	foreignRunID := insertAgentRunFixture(t, otherWorkspaceID)

	w := postAgentRunWrite(t, "/api/agent-runs/"+foreignRunID+"/events", map[string]any{
		"events": []map[string]any{{"type": "heartbeat"}},
	}, foreignRunID)
	if w.Code != http.StatusNotFound {
		t.Fatalf("foreign workspace run: status = %d, want 404 (body = %s)", w.Code, w.Body.String())
	}
	if got := dbfx.Count(t, `SELECT count(*) FROM agent_run_event WHERE run_id = $1`, foreignRunID); got != 0 {
		t.Fatalf("foreign workspace write stored %d events, want 0", got)
	}
}
