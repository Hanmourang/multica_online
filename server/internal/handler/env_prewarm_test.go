package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// ensureLocalEnvPrewarmTable applies the hint table the way handler_test.go
// applies the other late migrations: the shared test database does not always
// run every migration, and both statements are IF NOT EXISTS.
func ensureLocalEnvPrewarmTable(t *testing.T) {
	t.Helper()
	applyMigrationFile(t, "493_local_env_prewarm.up.sql")
	// The claim path promotes deferred tasks, which names this column. It is
	// missing on a stale shared database and would otherwise fail the claim
	// before the hints are read.
	applyMigrationFile(t, "492_agent_task_workflow_step.up.sql")
}

func applyMigrationFile(t *testing.T, name string) {
	t.Helper()
	for _, path := range []string{"../migrations/" + name, "../../migrations/" + name} {
		sqlBytes, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if _, err := testPool.Exec(context.Background(), string(sqlBytes)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
		return
	}
	t.Fatalf("migration %s not found", name)
}

// prewarmFixture resources a worktree-mode local_directory project pinned to
// its own daemon id, so rows from other tests can never be picked up here.
func prewarmFixture(t *testing.T) (daemonID, projectID string) {
	t.Helper()
	daemonID = fmt.Sprintf("daemon-prewarm-%d", time.Now().UnixNano())
	projectID = dbfx.Project(t, "prewarmed group")
	dbfx.Insert(t, "project_resource", testutil.Cols{
		"project_id":    projectID,
		"workspace_id":  testWorkspaceID,
		"resource_type": "local_directory",
		"resource_ref":  fmt.Sprintf(`{"execution_mode":"worktree","daemon_id":%q,"local_path":"/repos/app"}`, daemonID),
		"position":      0,
	})
	return daemonID, projectID
}

// TestGroupPrewarms_TravelFromCreateToClaim covers the whole first-turn path:
// creating the conversation queues one hint per (agent, machine), and the
// daemon that owns the machine picks it up on its next ordinary claim poll.
func TestGroupPrewarms_TravelFromCreateToClaim(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for checkout prewarm test")
	}
	ensureLocalEnvPrewarmTable(t)
	ctx := context.Background()
	daemonID, projectID := prewarmFixture(t)

	sessionID := dbfx.Insert(t, "chat_session", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"kind":         "group",
		"title":        "prewarmed group",
		"creator_id":   testUserID,
	})
	agentID := dbfx.Agent(t, "warm agent", handlerTestRuntimeID(t))
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM local_env_prewarm WHERE chat_session_id = $1`, sessionID)
	})

	testHandler.requestGroupPrewarms(ctx, testWorkspaceID, parseUUID(projectID), parseUUID(sessionID), []pgtype.UUID{parseUUID(agentID)})

	hints := testHandler.takePrewarms(ctx, daemonID, claimBatchMaxPrewarms)
	if len(hints) != 1 {
		t.Fatalf("picked up %d hints, want 1", len(hints))
	}
	got := hints[0]
	if got.WorkspaceID != testWorkspaceID || got.AgentID != agentID || got.ChatSessionID != sessionID {
		t.Errorf("hint = %+v, want workspace %s agent %s session %s", got, testWorkspaceID, agentID, sessionID)
	}
	if got.LocalPath != "/repos/app" {
		t.Errorf("hint local_path = %q, want the resource path", got.LocalPath)
	}
	if got.AgentName != "warm agent" {
		t.Errorf("hint agent_name = %q, want the agent's name", got.AgentName)
	}
}

// TestGroupPrewarms_OneHintPerEngineerAndPoll pins the delivery contract: a hint
// is offered once per retry window, to its own machine only, and only while no
// live task exists for the same (conversation, agent) — the turn that follows
// may not race a checkout into the same directory.
func TestGroupPrewarms_OneHintPerEngineerAndPoll(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for checkout prewarm test")
	}
	ensureLocalEnvPrewarmTable(t)
	ctx := context.Background()
	daemonID, projectID := prewarmFixture(t)

	sessionID := dbfx.Insert(t, "chat_session", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"kind":         "group",
		"title":        "prewarmed group",
		"creator_id":   testUserID,
	})
	agentID := dbfx.Agent(t, "warm agent", handlerTestRuntimeID(t))
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM local_env_prewarm WHERE chat_session_id = $1`, sessionID)
	})

	// Creating the group twice (or adding the same agent again) must not stack
	// work: the unique target index keeps one row.
	for i := 0; i < 2; i++ {
		testHandler.requestGroupPrewarms(ctx, testWorkspaceID, parseUUID(projectID), parseUUID(sessionID), []pgtype.UUID{parseUUID(agentID)})
	}
	var rows int
	dbfx.QueryRow(t, `SELECT count(*) FROM local_env_prewarm WHERE chat_session_id = $1 AND agent_id = $2`,
		sessionID, agentID).Scan(&rows)
	if rows != 1 {
		t.Fatalf("queued %d hints for one (agent, conversation), want 1", rows)
	}

	if hints := testHandler.takePrewarms(ctx, daemonID, claimBatchMaxPrewarms); len(hints) != 1 {
		t.Fatalf("first poll picked up %d hints, want 1", len(hints))
	}
	if hints := testHandler.takePrewarms(ctx, daemonID, claimBatchMaxPrewarms); len(hints) != 0 {
		t.Fatalf("second poll within the retry window picked up %d hints, want 0", len(hints))
	}
	if hints := testHandler.takePrewarms(ctx, daemonID+"-other", claimBatchMaxPrewarms); len(hints) != 0 {
		t.Fatalf("another machine picked up %d hints, want 0", len(hints))
	}

	// A hint whose daemon crashed is offered again after the retry window.
	dbfx.Exec(t, `UPDATE local_env_prewarm SET claimed_at = now() - $2::interval WHERE chat_session_id = $1`,
		sessionID, "10 minutes")
	if hints := testHandler.takePrewarms(ctx, daemonID, claimBatchMaxPrewarms); len(hints) != 1 {
		t.Fatalf("poll after the retry window picked up %d hints, want 1", len(hints))
	}

	// A live task for the same (conversation, agent) means the checkout is
	// happening for real; the hint must stand down.
	dbfx.Exec(t, `UPDATE local_env_prewarm SET claimed_at = now() - $2::interval WHERE chat_session_id = $1`,
		sessionID, "10 minutes")
	dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id":      handlerTestRuntimeID(t),
		"chat_session_id": sessionID,
		"status":          "queued",
	})
	if hints := testHandler.takePrewarms(ctx, daemonID, claimBatchMaxPrewarms); len(hints) != 0 {
		t.Fatalf("hint raced a queued task: picked up %d hints, want 0", len(hints))
	}
}

// TestGroupPrewarms_RideTheClaimResponse pins the wire contract: the hints
// travel in the same answer as the tasks, on the poll every idle daemon already
// makes, so they need no endpoint of their own.
func TestGroupPrewarms_RideTheClaimResponse(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for checkout prewarm test")
	}
	ensureLocalEnvPrewarmTable(t)
	ctx := context.Background()
	daemonID, projectID := prewarmFixture(t)

	sessionID := dbfx.Insert(t, "chat_session", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"kind":         "group",
		"title":        "prewarmed group",
		"creator_id":   testUserID,
	})
	agentID := dbfx.Agent(t, "warm agent", handlerTestRuntimeID(t))
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM local_env_prewarm WHERE chat_session_id = $1`, sessionID)
	})

	testHandler.requestGroupPrewarms(ctx, testWorkspaceID, parseUUID(projectID), parseUUID(sessionID), []pgtype.UUID{parseUUID(agentID)})

	w := httptest.NewRecorder()
	req := newDaemonTokenRequest("POST", "/api/daemon/tasks/claim", map[string]any{
		"daemon_id":   daemonID,
		"runtime_ids": []string{handlerTestRuntimeID(t)},
		"max_tasks":   1,
	}, testWorkspaceID, daemonID)
	testHandler.ClaimTasksByRuntime(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		Prewarms []localEnvPrewarmTarget `json:"prewarms"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Prewarms) != 1 || resp.Prewarms[0].ChatSessionID != sessionID {
		t.Fatalf("prewarms = %#v, want the hint for %s: %s", resp.Prewarms, sessionID, w.Body.String())
	}
}

// TestGroupPrewarms_SkipIneligibleResources keeps the queue quiet where a
// checkout cannot help: in-place resources run in the user's own directory, and
// a resource with no machine cannot be prepared anywhere.
func TestGroupPrewarms_SkipIneligibleResources(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for checkout prewarm test")
	}
	ensureLocalEnvPrewarmTable(t)
	ctx := context.Background()

	daemonID := fmt.Sprintf("daemon-prewarm-%d", time.Now().UnixNano())
	projectID := dbfx.Project(t, "in-place project")
	dbfx.Insert(t, "project_resource", testutil.Cols{
		"project_id":    projectID,
		"workspace_id":  testWorkspaceID,
		"resource_type": "local_directory",
		"resource_ref":  `{"execution_mode":"in_place","daemon_id":"` + daemonID + `","local_path":"/repos/app"}`,
		"position":      0,
	})
	dbfx.Insert(t, "project_resource", testutil.Cols{
		"project_id":    projectID,
		"workspace_id":  testWorkspaceID,
		"resource_type": "local_directory",
		"resource_ref":  `{"execution_mode":"worktree","local_path":"/repos/unpinned"}`,
		"position":      1,
	})

	sessionID := dbfx.Insert(t, "chat_session", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"kind":         "group",
		"title":        "in-place group",
		"creator_id":   testUserID,
	})
	agentID := dbfx.Agent(t, "in-place agent", handlerTestRuntimeID(t))
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM local_env_prewarm WHERE chat_session_id = $1`, sessionID)
	})

	testHandler.requestGroupPrewarms(ctx, testWorkspaceID, parseUUID(projectID), parseUUID(sessionID), []pgtype.UUID{parseUUID(agentID)})

	if hints := testHandler.takePrewarms(ctx, daemonID, claimBatchMaxPrewarms); len(hints) != 0 {
		t.Fatalf("queued %d hints for resources that need no checkout, want 0", len(hints))
	}
}
