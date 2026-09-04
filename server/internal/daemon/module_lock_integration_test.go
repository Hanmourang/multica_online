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

// moduleLockTestServer stubs the two server endpoints the module-lock wait
// path touches: the waiting_module_lock report and the cancellation poller's
// status read. prepare-lease extension rides a 15s ticker, so it never fires
// inside a test.
type moduleLockTestServer struct {
	srv *httptest.Server

	waitCalls atomic.Int32
	// lastReason holds the most recent wait-module-lock reason body.
	lastReason atomic.Value
	// status, when non-empty, is what the /status endpoint reports; empty
	// means "running".
	status atomic.Value
}

func newModuleLockTestServer(t *testing.T) *moduleLockTestServer {
	t.Helper()
	s := &moduleLockTestServer{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/wait-module-lock"):
			s.waitCalls.Add(1)
			var body struct {
				Reason string `json:"reason"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.lastReason.Store(body.Reason)
			w.WriteHeader(http.StatusOK)
		case strings.HasSuffix(r.URL.Path, "/fail"):
			w.WriteHeader(http.StatusOK)
		case strings.HasSuffix(r.URL.Path, "/status"):
			w.Header().Set("Content-Type", "application/json")
			status, _ := s.status.Load().(string)
			if status == "" {
				status = "running"
			}
			_, _ = w.Write([]byte(`{"status":"` + status + `"}`))
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *moduleLockTestServer) reason() string {
	v, _ := s.lastReason.Load().(string)
	return v
}

// TestTaskWaitsOnModuleLock is the spec §5 acceptance test: a task whose issue
// carries a module participates in cross-module conflict avoidance — it parks
// behind an exclusive holder from another module, reports
// waiting_module_lock naming the module, and proceeds once the holder
// releases. A task without a module never waits.
func TestTaskWaitsOnModuleLock(t *testing.T) {
	t.Parallel()

	fake := newModuleLockTestServer(t)
	d := &Daemon{
		client:             NewClient(fake.srv.URL),
		logger:             slog.Default(),
		moduleLocks:        NewModuleLocker(),
		localPathLocks:     NewLocalPathLocker(),
		cancelPollInterval: time.Hour, // never poll; the test drives the lifecycle
		cfg:                Config{DaemonID: "d-test"},
	}

	// A: module m1 with avoid_conflict — takes the lock immediately.
	taskA := Task{ID: "task-a", IssueID: "issue-a", ModuleID: "m1", ModuleName: "内核", AvoidConflict: true}
	releaseA, abort := d.acquireModuleLockIfNeeded(context.Background(), taskA, nil, slog.Default())
	if abort {
		t.Fatal("task A: acquisition aborted")
	}
	if releaseA == nil {
		t.Fatal("task A: expected a release callback for a module task")
	}

	// B: module m2, not exclusive — A's exclusive hold blocks it.
	taskB := Task{ID: "task-b", IssueID: "issue-b", ModuleID: "m2", ModuleName: "Flow 编排"}
	type acqResult struct {
		release func()
		abort   bool
	}
	doneB := make(chan acqResult, 1)
	go func() {
		rel, abort := d.acquireModuleLockIfNeeded(context.Background(), taskB, nil, slog.Default())
		doneB <- acqResult{release: rel, abort: abort}
	}()

	// B must park and report waiting_module_lock. The reason names B's own
	// module and the holder's module.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && fake.waitCalls.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if got := fake.waitCalls.Load(); got != 1 {
		t.Fatalf("wait-module-lock calls = %d, want 1", got)
	}
	if reason := fake.reason(); !strings.Contains(reason, "Flow 编排") || !strings.Contains(reason, "内核") {
		t.Errorf("wait reason = %q, want it to name both modules", reason)
	}

	// While B is parked: C (no module) walks straight through without any
	// release callback and without reporting a wait.
	releaseC, abort := d.acquireModuleLockIfNeeded(context.Background(),
		Task{ID: "task-c", IssueID: "issue-c"}, nil, slog.Default())
	if abort {
		t.Fatal("task C: acquisition aborted")
	}
	if releaseC != nil {
		t.Fatal("task C: a module-less task must not take the module lock")
	}
	if got := fake.waitCalls.Load(); got != 1 {
		t.Fatalf("wait-module-lock calls after task C = %d, want still 1", got)
	}

	// B is still parked.
	select {
	case got := <-doneB:
		t.Fatalf("task B returned (abort=%v) while A's exclusive lock was held", got.abort)
	case <-time.After(100 * time.Millisecond):
	}

	// Release A → B proceeds.
	releaseA()
	select {
	case got := <-doneB:
		if got.abort {
			t.Fatal("task B: acquisition aborted after A released")
		}
		if got.release == nil {
			t.Fatal("task B: expected a release callback once the lock was won")
		}
		got.release()
	case <-time.After(2 * time.Second):
		t.Fatal("task B never acquired the module lock after A released")
	}

	if got := d.resourceWaitTasks.Load(); got != 0 {
		t.Fatalf("resource wait count after everything settled = %d, want 0", got)
	}
}

// TestModuleLockSameModuleNeverBlocks pins the DAG complement: two tasks in
// the SAME module never mutex each other, even when one is exclusive — their
// ordering is expressed by the dependency graph, not by a lock.
func TestModuleLockSameModuleNeverBlocks(t *testing.T) {
	t.Parallel()

	fake := newModuleLockTestServer(t)
	d := &Daemon{
		client:             NewClient(fake.srv.URL),
		logger:             slog.Default(),
		moduleLocks:        NewModuleLocker(),
		localPathLocks:     NewLocalPathLocker(),
		cancelPollInterval: time.Hour,
		cfg:                Config{DaemonID: "d-test"},
	}

	first := Task{ID: "task-1", IssueID: "issue-1", ModuleID: "m1", ModuleName: "内核", AvoidConflict: true}
	release1, abort := d.acquireModuleLockIfNeeded(context.Background(), first, nil, slog.Default())
	if abort || release1 == nil {
		t.Fatalf("first task failed to take the module lock (abort=%v)", abort)
	}
	defer release1()

	second := Task{ID: "task-2", IssueID: "issue-2", ModuleID: "m1", ModuleName: "内核"}
	done := make(chan acqOutcome, 1)
	go func() {
		rel, abort := d.acquireModuleLockIfNeeded(context.Background(), second, nil, slog.Default())
		done <- acqOutcome{release: rel, abort: abort}
	}()
	select {
	case got := <-done:
		if got.abort {
			t.Fatal("second same-module task aborted")
		}
		if got.release == nil {
			t.Fatal("second same-module task: expected a release callback")
		}
		got.release()
	case <-time.After(2 * time.Second):
		t.Fatal("second same-module task blocked on the module lock")
	}
	if got := fake.waitCalls.Load(); got != 0 {
		t.Fatalf("wait-module-lock calls = %d, want 0 for same-module tasks", got)
	}
}

type acqOutcome struct {
	release func()
	abort   bool
}

// TestModuleLockChatTaskExempt: a chat turn never queues behind a module lock
// (the #7344 carve-out carried over), even when its issue carries a module
// and another module's exclusive task is running.
func TestModuleLockChatTaskExempt(t *testing.T) {
	t.Parallel()

	fake := newModuleLockTestServer(t)
	d := &Daemon{
		client:             NewClient(fake.srv.URL),
		logger:             slog.Default(),
		moduleLocks:        NewModuleLocker(),
		localPathLocks:     NewLocalPathLocker(),
		cancelPollInterval: time.Hour,
		cfg:                Config{DaemonID: "d-test"},
	}

	holder := Task{ID: "task-holder", IssueID: "issue-h", ModuleID: "m1", ModuleName: "内核", AvoidConflict: true}
	releaseHolder, abort := d.acquireModuleLockIfNeeded(context.Background(), holder, nil, slog.Default())
	if abort || releaseHolder == nil {
		t.Fatalf("holder failed to take the module lock (abort=%v)", abort)
	}
	defer releaseHolder()

	chat := Task{ID: "task-chat", ChatSessionID: "sess-1", ModuleID: "m2", ModuleName: "Flow 编排"}
	done := make(chan acqOutcome, 1)
	go func() {
		rel, abort := d.acquireModuleLockIfNeeded(context.Background(), chat, nil, slog.Default())
		done <- acqOutcome{release: rel, abort: abort}
	}()
	select {
	case got := <-done:
		if got.abort {
			t.Fatal("chat task aborted")
		}
		if got.release != nil {
			t.Fatal("chat task took the module lock")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("chat task blocked on the module lock")
	}
	if got := fake.waitCalls.Load(); got != 0 {
		t.Fatalf("wait-module-lock calls = %d, want 0 for the exempt chat task", got)
	}
}

// TestModuleLockWorktreeExempt: a worktree-mode task is physically isolated
// from the user's directory, so it stays out of the module lock even when its
// issue carries a module.
func TestModuleLockWorktreeExempt(t *testing.T) {
	t.Parallel()

	fake := newModuleLockTestServer(t)
	d := &Daemon{
		client:             NewClient(fake.srv.URL),
		logger:             slog.Default(),
		moduleLocks:        NewModuleLocker(),
		localPathLocks:     NewLocalPathLocker(),
		cancelPollInterval: time.Hour,
		cfg:                Config{DaemonID: "d-test"},
	}

	holder := Task{ID: "task-holder", IssueID: "issue-h", ModuleID: "m1", ModuleName: "内核", AvoidConflict: true}
	releaseHolder, abort := d.acquireModuleLockIfNeeded(context.Background(), holder, nil, slog.Default())
	if abort || releaseHolder == nil {
		t.Fatalf("holder failed to take the module lock (abort=%v)", abort)
	}
	defer releaseHolder()

	worktreeAssignment := &localDirectoryAssignment{
		Ref:      localDirectoryRef{ExecutionMode: localDirectoryModeWorktree},
		AbsPath:  "/tmp/whatever",
		RealPath: "/tmp/whatever",
	}
	worktreeTask := Task{ID: "task-wt", IssueID: "issue-w", ModuleID: "m2", ModuleName: "Flow 编排"}
	release, abort := d.acquireModuleLockIfNeeded(context.Background(), worktreeTask, worktreeAssignment, slog.Default())
	if abort {
		t.Fatal("worktree task aborted")
	}
	if release != nil {
		t.Fatal("worktree task took the module lock")
	}
}

// TestAcquireModuleLock_CancelDuringWait: if the issue is cancelled (or the
// task row disappears) while a task is parked on the module lock, the daemon
// must notice promptly and bail silently — the row is already terminal, so
// failing it again would be noise. Mirrors the old path-mutex contract.
func TestAcquireModuleLock_CancelDuringWait(t *testing.T) {
	t.Parallel()

	fake := newModuleLockTestServer(t)
	d := &Daemon{
		client:             NewClient(fake.srv.URL),
		logger:             slog.Default(),
		moduleLocks:        NewModuleLocker(),
		localPathLocks:     NewLocalPathLocker(),
		cancelPollInterval: 10 * time.Millisecond,
		cfg:                Config{DaemonID: "d-test"},
	}

	holder := Task{ID: "task-holder", IssueID: "issue-h", ModuleID: "m1", ModuleName: "内核", AvoidConflict: true}
	releaseHolder, abort := d.acquireModuleLockIfNeeded(context.Background(), holder, nil, slog.Default())
	if abort || releaseHolder == nil {
		t.Fatalf("holder failed to take the module lock (abort=%v)", abort)
	}
	t.Cleanup(releaseHolder)

	waiter := Task{ID: "task-waiter", IssueID: "issue-w", ModuleID: "m2", ModuleName: "Flow 编排"}
	done := make(chan acqOutcome, 1)
	go func() {
		rel, abort := d.acquireModuleLockIfNeeded(context.Background(), waiter, nil, slog.Default())
		done <- acqOutcome{release: rel, abort: abort}
	}()

	// Park first, then flip the server-side status to cancelled.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && fake.waitCalls.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if fake.waitCalls.Load() == 0 {
		t.Fatal("waiter never reported waiting_module_lock")
	}
	fake.status.Store("cancelled")

	select {
	case got := <-done:
		if !got.abort {
			t.Fatal("expected abort=true after server-side cancel, got abort=false")
		}
		if got.release != nil {
			t.Fatal("expected nil release on cancel, got a non-nil callback")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("module lock wait was not interrupted by the server-side cancel")
	}

	if got := d.resourceWaitTasks.Load(); got != 0 {
		t.Fatalf("resource wait count after cancellation = %d, want 0", got)
	}
}

// TestAcquireModuleLock_ParentCancellationReportsFailure: when the daemon's
// own context dies under a parked module-lock wait (shutdown), the task is
// failed with the module_lock_cancelled reason so it doesn't sit queued
// forever.
func TestAcquireModuleLock_ParentCancellationReportsFailure(t *testing.T) {
	t.Parallel()

	fake := newModuleLockTestServer(t)
	var failCalls atomic.Int32
	var lastFailReason atomic.Value
	failSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/wait-module-lock"):
			fake.waitCalls.Add(1)
			w.WriteHeader(http.StatusOK)
		case strings.HasSuffix(r.URL.Path, "/fail"):
			failCalls.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if reason, ok := body["failure_reason"].(string); ok {
				lastFailReason.Store(reason)
			}
			w.WriteHeader(http.StatusOK)
		case strings.HasSuffix(r.URL.Path, "/status"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"running"}`))
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(failSrv.Close)

	d := &Daemon{
		client:             NewClient(failSrv.URL),
		logger:             slog.Default(),
		moduleLocks:        NewModuleLocker(),
		localPathLocks:     NewLocalPathLocker(),
		cancelPollInterval: time.Hour, // the server keeps saying "running"; the parent ctx is what dies
		cfg:                Config{DaemonID: "d-test"},
	}

	holder := Task{ID: "task-holder", IssueID: "issue-h", ModuleID: "m1", ModuleName: "内核", AvoidConflict: true}
	releaseHolder, abort := d.acquireModuleLockIfNeeded(context.Background(), holder, nil, slog.Default())
	if abort || releaseHolder == nil {
		t.Fatalf("holder failed to take the module lock (abort=%v)", abort)
	}
	t.Cleanup(releaseHolder)

	ctx, cancel := context.WithCancel(context.Background())
	waiter := Task{ID: "task-waiter", IssueID: "issue-w", ModuleID: "m2", ModuleName: "Flow 编排"}
	done := make(chan acqOutcome, 1)
	go func() {
		rel, abort := d.acquireModuleLockIfNeeded(ctx, waiter, nil, slog.Default())
		done <- acqOutcome{release: rel, abort: abort}
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && fake.waitCalls.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if fake.waitCalls.Load() == 0 {
		t.Fatal("waiter never parked on the module lock")
	}
	cancel()

	select {
	case got := <-done:
		if !got.abort {
			t.Fatal("expected abort=true after parent cancellation")
		}
		if got.release != nil {
			t.Fatal("expected nil release after parent cancellation")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("module lock wait did not return after parent cancellation")
	}

	if got := failCalls.Load(); got != 1 {
		t.Fatalf("fail calls = %d, want 1", got)
	}
	if reason, _ := lastFailReason.Load().(string); reason != "module_lock_cancelled" {
		t.Errorf("failure_reason = %q, want module_lock_cancelled", reason)
	}
	if got := d.resourceWaitTasks.Load(); got != 0 {
		t.Fatalf("resource wait count after cancellation = %d, want 0", got)
	}
}
