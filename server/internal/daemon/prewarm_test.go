package daemon

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

// reuseProbeFile is the record execenv.Finalize leaves beside a kept checkout.
// Spelled out here rather than imported: the extension point under test is the
// path composition in prewarmedWorkdir, and a rename on the execenv side is
// supposed to fail this test instead of silently making it vacuous.
const reuseProbeFile = ".multica_reuse_probe.json"

const (
	prewarmTaskWorkspace = "0192f0aa-1111-7c3b-8d4e-00000000aa11"
	prewarmTaskAgent     = "0192f0aa-2222-7c3b-8d4e-00000000bb22"
	prewarmTaskSession   = "0192f0aa-4444-7c3b-8d4e-00000000dd44"
)

// prewarmFixture builds the on-disk half of a prewarm: the env root with its
// reuse record, and the user's repository the record points at.
func prewarmFixture(t *testing.T, resourceRel string) (workspacesRoot, agentRoot string) {
	t.Helper()
	workspacesRoot = t.TempDir()
	agentRoot = t.TempDir()
	resource := filepath.Join(agentRoot, resourceRel)
	if err := os.MkdirAll(resource, 0o755); err != nil {
		t.Fatalf("mkdir resource: %v", err)
	}

	envRoot := execenv.PrewarmEnvRoot(workspacesRoot, prewarmTaskWorkspace, prewarmTaskAgent, prewarmTaskSession)
	if envRoot == "" {
		t.Fatal("PrewarmEnvRoot returned \"\" for well-formed ids")
	}
	if err := os.MkdirAll(envRoot, 0o755); err != nil {
		t.Fatalf("mkdir env root: %v", err)
	}
	probe := `{"git_root":"` + agentRoot + `","branch":"chat-abcd","head":"deadbeef","user_branch":"main","status":"","dirty":false}`
	if err := os.WriteFile(filepath.Join(envRoot, reuseProbeFile), []byte(probe), 0o644); err != nil {
		t.Fatalf("write reuse record: %v", err)
	}
	return workspacesRoot, agentRoot
}

func worktreeTask() Task {
	return Task{
		WorkspaceID:     prewarmTaskWorkspace,
		AgentID:         prewarmTaskAgent,
		ChatSessionID:   prewarmTaskSession,
		ChatSessionKind: "group",
	}
}

func worktreeAssignment(path string) *localDirectoryAssignment {
	return &localDirectoryAssignment{
		Ref:     localDirectoryRef{ExecutionMode: localDirectoryModeWorktree},
		AbsPath: path,
	}
}

// TestStartPrewarmsNeverBlocksThePoll pins the one property the poll loop
// depends on: handing hints over is a queue write, never a wait. A group with
// several agents delivers its hints across several polls, and the poll that
// carries the second batch must not stall behind the first one's build.
func TestStartPrewarmsNeverBlocksThePoll(t *testing.T) {
	d := New(Config{MaxConcurrentTasks: 2}, slog.New(slog.NewTextHandler(noopWriter{}, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		// More batches than the queue can hold at once, each a no-op build (no
		// local path), so the worker drains them as fast as it can and the
		// writer still must not block.
		for i := 0; i < prewarmQueueDepth*2; i++ {
			d.startPrewarms(ctx, []PrewarmTarget{{ID: "hint", ChatSessionID: "session"}})
		}
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("startPrewarms blocked the poll loop")
	}
}

// TestPrewarmedWorkdir_MatchesResourceDepth pins the one thing the adopting turn
// cannot guess: a prewarmed checkout hands the turn the directory at the same
// depth inside the tree as the project resource sits inside the user's repo.
func TestPrewarmedWorkdir_MatchesResourceDepth(t *testing.T) {
	cases := []struct {
		name        string
		resourceRel string
	}{
		{"repository root", "."},
		{"one level in", "apps"},
		{"two levels in", filepath.Join("apps", "web")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			workspacesRoot, agentRoot := prewarmFixture(t, c.resourceRel)
			resource := filepath.Clean(filepath.Join(agentRoot, c.resourceRel))
			task := worktreeTask()

			got := prewarmedWorkdir(task, worktreeAssignment(resource), workspacesRoot)
			envRoot := execenv.PrewarmEnvRoot(workspacesRoot, task.WorkspaceID, task.AgentID, task.ChatSessionID)
			want := filepath.Join(envRoot, execenv.LocalWorktreeDirName, c.resourceRel)
			if filepath.Clean(want) != filepath.Clean(got) {
				t.Fatalf("prewarmedWorkdir = %q, want %q", got, want)
			}
		})
	}
}

// TestPrewarmedWorkdir_DeclinesWithoutAPrewarm keeps the fallback conservative:
// when anything the composition needs is missing, it must answer "" so the turn
// falls back to an ordinary full checkout.
func TestPrewarmedWorkdir_DeclinesWithoutAPrewarm(t *testing.T) {
	t.Run("p2p conversation", func(t *testing.T) {
		workspacesRoot, agentRoot := prewarmFixture(t, ".")
		task := worktreeTask()
		task.ChatSessionKind = "p2p"
		if got := prewarmedWorkdir(task, worktreeAssignment(agentRoot), workspacesRoot); got != "" {
			t.Fatalf("prewarmedWorkdir = %q, want \"\"", got)
		}
	})
	t.Run("shared directory mode", func(t *testing.T) {
		workspacesRoot, agentRoot := prewarmFixture(t, ".")
		assignment := &localDirectoryAssignment{AbsPath: agentRoot}
		if got := prewarmedWorkdir(worktreeTask(), assignment, workspacesRoot); got != "" {
			t.Fatalf("prewarmedWorkdir = %q, want \"\"", got)
		}
	})
	t.Run("no assignment", func(t *testing.T) {
		workspacesRoot, _ := prewarmFixture(t, ".")
		if got := prewarmedWorkdir(worktreeTask(), nil, workspacesRoot); got != "" {
			t.Fatalf("prewarmedWorkdir = %q, want \"\"", got)
		}
	})
	t.Run("no reuse record", func(t *testing.T) {
		workspacesRoot, agentRoot := prewarmFixture(t, ".")
		envRoot := execenv.PrewarmEnvRoot(workspacesRoot, prewarmTaskWorkspace, prewarmTaskAgent, prewarmTaskSession)
		if err := os.Remove(filepath.Join(envRoot, reuseProbeFile)); err != nil {
			t.Fatalf("remove reuse record: %v", err)
		}
		if got := prewarmedWorkdir(worktreeTask(), worktreeAssignment(agentRoot), workspacesRoot); got != "" {
			t.Fatalf("prewarmedWorkdir = %q, want \"\"", got)
		}
	})
	t.Run("resource outside the repository", func(t *testing.T) {
		// The record claims one repository while the assignment points at another
		// checkout: composing a path from that pair would name a directory in the
		// wrong tree, so the fallback has to decline.
		workspacesRoot, _ := prewarmFixture(t, ".")
		elsewhere := t.TempDir()
		if got := prewarmedWorkdir(worktreeTask(), worktreeAssignment(elsewhere), workspacesRoot); got != "" {
			t.Fatalf("prewarmedWorkdir = %q, want \"\"", got)
		}
	})
}
