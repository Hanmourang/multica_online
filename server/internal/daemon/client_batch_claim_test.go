package daemon

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestClient_ClaimTasks_PostsRuntimeSetAndParsesTasks verifies the machine-level
// batch claim (MUL-4257): the client POSTs to /api/daemon/tasks/claim with the full
// runtime_id set + max_tasks, and parses the {"tasks":[...],"prewarms":[...]}
// envelope, keeping each task's runtime_id so the daemon can route it locally and
// each prewarm's target so it can be built ahead of the first turn.
func TestClient_ClaimTasks_PostsRuntimeSetAndParsesTasks(t *testing.T) {
	var gotPath string
	var gotBody struct {
		DaemonID   string   `json:"daemon_id"`
		RuntimeIDs []string `json:"runtime_ids"`
		MaxTasks   int      `json:"max_tasks"`
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tasks":[
			{"id":"t1","runtime_id":"rt-a","agent":{"name":"a"}},
			{"id":"t2","runtime_id":"rt-b","agent":{"name":"b"}}
		],"prewarms":[
			{"id":"p1","workspace_id":"ws-1","agent_id":"ag-1","agent_name":"a",
			 "chat_session_id":"cs-1","local_path":"/repos/app"}
		]}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetToken("tok")

	batch, err := c.ClaimTasks(context.Background(), "daemon-x", []string{"rt-a", "rt-b", "rt-c"}, 3)
	if err != nil {
		t.Fatalf("ClaimTasks: %v", err)
	}

	if gotPath != "/api/daemon/tasks/claim" {
		t.Errorf("path = %q, want /api/daemon/tasks/claim", gotPath)
	}
	if gotBody.DaemonID != "daemon-x" {
		t.Errorf("posted daemon_id = %q, want daemon-x", gotBody.DaemonID)
	}
	if len(gotBody.RuntimeIDs) != 3 || gotBody.RuntimeIDs[0] != "rt-a" || gotBody.MaxTasks != 3 {
		t.Errorf("posted body = %+v, want runtime_ids=[rt-a rt-b rt-c] max_tasks=3", gotBody)
	}
	if batch == nil {
		t.Fatal("ClaimTasks returned a nil batch for a successful answer")
	}
	if len(batch.Tasks) != 2 {
		t.Fatalf("got %d tasks, want 2", len(batch.Tasks))
	}
	if batch.Tasks[0].ID != "t1" || batch.Tasks[0].RuntimeID != "rt-a" {
		t.Errorf("task[0] = %+v, want id=t1 runtime_id=rt-a", batch.Tasks[0])
	}
	if batch.Tasks[1].ID != "t2" || batch.Tasks[1].RuntimeID != "rt-b" {
		t.Errorf("task[1] = %+v, want id=t2 runtime_id=rt-b", batch.Tasks[1])
	}
	if len(batch.Prewarms) != 1 {
		t.Fatalf("got %d prewarms, want 1", len(batch.Prewarms))
	}
	want := PrewarmTarget{
		ID:            "p1",
		WorkspaceID:   "ws-1",
		AgentID:       "ag-1",
		AgentName:     "a",
		ChatSessionID: "cs-1",
		LocalPath:     "/repos/app",
	}
	if batch.Prewarms[0] != want {
		t.Errorf("prewarm[0] = %+v, want %+v", batch.Prewarms[0], want)
	}
}

// TestClient_ClaimTasks_EmptyResult confirms an empty batch (idle daemon) is
// returned as a nil/empty slice, not an error.
func TestClient_ClaimTasks_EmptyResult(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tasks":[]}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetToken("tok")

	batch, err := c.ClaimTasks(context.Background(), "daemon-x", []string{"rt-a"}, 1)
	if err != nil {
		t.Fatalf("ClaimTasks: %v", err)
	}
	if batch == nil {
		t.Fatal("ClaimTasks returned a nil batch for a successful answer")
	}
	if len(batch.Tasks) != 0 {
		t.Fatalf("got %d tasks, want 0", len(batch.Tasks))
	}
	if len(batch.Prewarms) != 0 {
		t.Fatalf("got %d prewarms, want 0", len(batch.Prewarms))
	}
}
