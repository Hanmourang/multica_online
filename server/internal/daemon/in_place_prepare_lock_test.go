package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// prepareLockTestServer stubs the two server endpoints the in-place prepare
// wait touches: the waiting_local_directory report and the cancellation
// poller's status read. The poll interval is set to an hour in these tests, so
// /status is never actually reached.
type prepareLockTestServer struct {
	srv       *httptest.Server
	waitCalls atomic.Int32
	lastPath  atomic.Value
}

func newPrepareLockTestServer(t *testing.T) *prepareLockTestServer {
	t.Helper()
	s := &prepareLockTestServer{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/wait-local-directory"):
			s.waitCalls.Add(1)
			s.lastPath.Store(r.URL.Path)
			var body struct {
				Reason string `json:"reason"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			w.WriteHeader(http.StatusOK)
		case strings.HasSuffix(r.URL.Path, "/status"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"running"}`))
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func newPrepareLockTestDaemon(t *testing.T, fake *prepareLockTestServer) *Daemon {
	t.Helper()
	return &Daemon{
		client:             NewClient(fake.srv.URL),
		logger:             slog.Default(),
		localPathLocks:     NewLocalPathLocker(),
		moduleLocks:        NewModuleLocker(),
		cancelPollInterval: time.Hour,
		cfg:                Config{DaemonID: "d-test"},
	}
}

func inPlaceAssignment(path string) *localDirectoryAssignment {
	return &localDirectoryAssignment{
		Ref:      localDirectoryRef{LocalPath: path, DaemonID: "d-test"},
		AbsPath:  path,
		RealPath: path,
	}
}

// TestInPlacePrepareLockChatTurnExempt pins the group-parallel dispatch
// invariant: every runtime of one desktop daemon shares one LocalPathLocker,
// so a second agent @-mentioned in the same group send must not queue behind
// the first agent's prepare. Before this exemption the sibling parked in
// waiting_local_directory for the whole of the first turn's prepare, which the
// group status line rendered as "B · waiting" next to "A · processing".
func TestInPlacePrepareLockChatTurnExempt(t *testing.T) {
	t.Parallel()

	fake := newPrepareLockTestServer(t)
	d := newPrepareLockTestDaemon(t, fake)
	path := t.TempDir()
	assignment := inPlaceAssignment(path)

	// A coding task holds the user's directory for its staging window.
	releaseHolder, err := d.localPathLocks.Acquire(context.Background(), path, "task-coding", nil)
	if err != nil {
		t.Fatalf("hold the path mutex: %v", err)
	}

	// The group's second chat turn walks straight through.
	chatDone := make(chan error, 1)
	go func() {
		release, lockErr := d.acquireInPlacePrepareLock(context.Background(),
			Task{ID: "task-chat", ChatSessionID: "session-group"}, assignment, slog.Default())
		if release != nil {
			release()
		}
		chatDone <- lockErr
	}()
	select {
	case err := <-chatDone:
		if err != nil {
			t.Fatalf("chat turn prepare lock: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a chat turn queued behind the in-place prepare lock")
	}
	if got := fake.waitCalls.Load(); got != 0 {
		t.Fatalf("wait-local-directory calls for the chat turn = %d, want 0", got)
	}

	// An issue task still serialises on the same directory, and reports the
	// hold so the UI can explain it.
	issueDone := make(chan struct{})
	go func() {
		release, lockErr := d.acquireInPlacePrepareLock(context.Background(),
			Task{ID: "task-issue", IssueID: "issue-1"}, assignment, slog.Default())
		if lockErr == nil && release != nil {
			release()
		}
		close(issueDone)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && fake.waitCalls.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if got := fake.waitCalls.Load(); got != 1 {
		t.Fatalf("wait-local-directory calls for the issue task = %d, want 1", got)
	}
	select {
	case <-issueDone:
		t.Fatal("an issue task must keep waiting for the in-place prepare lock")
	case <-time.After(100 * time.Millisecond):
	}

	// Freeing the directory lets the issue task through.
	releaseHolder()
	select {
	case <-issueDone:
	case <-time.After(2 * time.Second):
		t.Fatal("the issue task never got the prepare lock after the holder released")
	}
}
