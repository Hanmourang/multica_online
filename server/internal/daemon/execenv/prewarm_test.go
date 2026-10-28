package execenv

import (
	"path/filepath"
	"strings"
	"testing"
)

const (
	prewarmTestWorkspace = "0192f0aa-1111-7c3b-8d4e-00000000aa11"
	prewarmTestAgent     = "0192f0aa-2222-7c3b-8d4e-00000000bb22"
	prewarmTestOther     = "0192f0aa-3333-7c3b-8d4e-00000000cc33"
	prewarmTestSession   = "0192f0aa-4444-7c3b-8d4e-00000000dd44"
)

// TestPrewarmEnvRoot_IsDeterministicAndNamespaced pins the protocol the prewarm
// depends on: the daemon builds the tree before a task exists, and the turn that
// follows derives the same path from its own fields alone.
func TestPrewarmEnvRoot_IsDeterministicAndNamespaced(t *testing.T) {
	root := t.TempDir()

	first := PrewarmEnvRoot(root, prewarmTestWorkspace, prewarmTestAgent, prewarmTestSession)
	if first == "" {
		t.Fatal("PrewarmEnvRoot returned \"\" for well-formed ids")
	}
	if again := PrewarmEnvRoot(root, prewarmTestWorkspace, prewarmTestAgent, prewarmTestSession); again != first {
		t.Fatalf("not deterministic: %q then %q", first, again)
	}
	if other := PrewarmEnvRoot(root, prewarmTestWorkspace, prewarmTestOther, prewarmTestSession); other == first {
		t.Fatalf("two agents of one conversation share the env root %q", first)
	}
	if other := PrewarmEnvRoot(root, prewarmTestWorkspace, prewarmTestAgent, prewarmTestOther); other == first {
		t.Fatalf("two conversations of one agent share the env root %q", first)
	}

	rel, err := filepath.Rel(root, first)
	if err != nil {
		t.Fatalf("rel: %v", err)
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) != 2 {
		t.Fatalf("env root sits %d levels under the workspaces root (%q), want 2", len(parts), rel)
	}
	if !strings.HasPrefix(parts[0], "workspace-") {
		t.Errorf("workspace segment = %q, want a workspace-<id> directory", parts[0])
	}
	if !strings.HasPrefix(parts[1], prewarmDirPrefix) {
		t.Errorf("env root segment = %q, want the %q prefix the GC classifies on", parts[1], prewarmDirPrefix)
	}
}

// TestPrewarmEnvRoot_HasTheShapeReuseValidates keeps the prewarm and the code
// that adopts it in agreement: shouldReusePriorWorkdir accepts
// <workspaces>/<workspace>/worktree[/<resource depth>], so a prewarmed root must
// produce exactly that once the worktree dir is appended.
func TestPrewarmEnvRoot_HasTheShapeReuseValidates(t *testing.T) {
	root := t.TempDir()
	envRoot := PrewarmEnvRoot(root, prewarmTestWorkspace, prewarmTestAgent, prewarmTestSession)
	if envRoot == "" {
		t.Fatal("PrewarmEnvRoot returned \"\" for well-formed ids")
	}

	worktree := filepath.Join(envRoot, LocalWorktreeDirName)
	rel, err := filepath.Rel(root, worktree)
	if err != nil {
		t.Fatalf("rel: %v", err)
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] != LocalWorktreeDirName {
		t.Fatalf("worktree path %q does not match <workspace>/<env root>/<worktree>", rel)
	}
	if filepath.Dir(worktree) != envRoot {
		t.Fatalf("worktree dir %q is not directly under the env root %q", worktree, envRoot)
	}
}

// TestPrewarmEnvRoot_RejectsUnsafeIDs covers the ids arriving from the server:
// every segment has to be drawn from a uuid-shaped id, so anything else must
// yield "" rather than a composed path.
func TestPrewarmEnvRoot_RejectsUnsafeIDs(t *testing.T) {
	root := t.TempDir()
	cases := []struct {
		name                                      string
		workspacesRoot, workspace, agent, session string
	}{
		{"empty workspaces root", "", prewarmTestWorkspace, prewarmTestAgent, prewarmTestSession},
		{"empty workspace", root, "", prewarmTestAgent, prewarmTestSession},
		{"empty agent", root, prewarmTestWorkspace, "", prewarmTestSession},
		{"empty session", root, prewarmTestWorkspace, prewarmTestAgent, ""},
		{"path separator", root, "../" + prewarmTestWorkspace, prewarmTestAgent, prewarmTestSession},
		{"dot dot", root, prewarmTestWorkspace, "..", prewarmTestSession},
		{"non-hex id", root, prewarmTestWorkspace, "agent-not-a-uuid", prewarmTestSession},
		{"absolute path", root, prewarmTestWorkspace, prewarmTestAgent, "/etc"},
	}
	for _, c := range cases {
		if got := PrewarmEnvRoot(c.workspacesRoot, c.workspace, c.agent, c.session); got != "" {
			t.Errorf("%s: PrewarmEnvRoot = %q, want \"\"", c.name, got)
		}
	}
}

// TestChatWorktreeConversationKey pins the branch key both sides derive: the
// prewarm creates the branch under it and the adopting turn continues it.
func TestChatWorktreeConversationKey(t *testing.T) {
	if got := ChatWorktreeConversationKey("  "); got != "" {
		t.Errorf("blank session key = %q, want \"\"", got)
	}
	key := ChatWorktreeConversationKey(prewarmTestSession)
	if !strings.HasPrefix(key, "chat-") {
		t.Errorf("key = %q, want a chat- prefix", key)
	}
	if key == ChatWorktreeConversationKey(prewarmTestOther) {
		t.Errorf("two conversations share the branch key %q", key)
	}
	if want := "chat-" + taskKey(prewarmTestSession); key != want {
		t.Errorf("key = %q, want %q", key, want)
	}
}
