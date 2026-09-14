package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

// taskCredentialKeys is the MULTICA_* set a task needs to read its issue and
// comment. seedCredentials writes exactly these, and every test clears exactly
// these first so bootstrapDaemonTaskCredentials' os.Setenv cannot leak into
// later tests (t.Setenv restores each to its pre-test value on cleanup).
var taskCredentialKeys = []string{
	"MULTICA_TOKEN",
	"MULTICA_SERVER_URL",
	"MULTICA_WORKSPACE_ID",
	"MULTICA_AGENT_ID",
	"MULTICA_TASK_ID",
	"MULTICA_DAEMON_PORT",
	cli.TaskConfigRootEnv,
}

// seedCredentials writes a daemon-owned credential sidecar into a fresh envRoot
// and chdirs into a nested workdir, so the CLI's upward walk has to find it the
// same way it would when a runtime lost the injected env.
func seedCredentials(t *testing.T, env map[string]string) string {
	t.Helper()
	envRoot := t.TempDir()
	if err := execenv.WriteTaskCredentials(envRoot, env); err != nil {
		t.Fatalf("WriteTaskCredentials: %v", err)
	}
	nested := filepath.Join(envRoot, "workdir", "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("create nested cwd: %v", err)
	}
	t.Chdir(nested)
	return envRoot
}

func fullTaskCredentialEnv(token string) map[string]string {
	return map[string]string{
		"MULTICA_TOKEN":        token,
		"MULTICA_SERVER_URL":   "http://127.0.0.1:18227",
		"MULTICA_WORKSPACE_ID": "ws-1",
		"MULTICA_AGENT_ID":     "agent-1",
		"MULTICA_TASK_ID":      "task-1",
		"MULTICA_DAEMON_PORT":  "18999",
		cli.TaskConfigRootEnv:  "/tmp/task-multica-config",
	}
}

// TestBootstrapDaemonTaskCredentialsRecoversStrippedEnv is the core regression:
// a runtime (Wukong print mode) hands tool execution to a service process that
// rebuilt its environment from the login shell, so every injected MULTICA_* var
// is gone. bootstrap must recover them from the sidecar so the task can build an
// API client instead of failing closed.
func TestBootstrapDaemonTaskCredentialsRecoversStrippedEnv(t *testing.T) {
	seedCredentials(t, fullTaskCredentialEnv("mat_recovered"))
	for _, k := range taskCredentialKeys {
		t.Setenv(k, "")
	}

	bootstrapDaemonTaskCredentials()

	if got := os.Getenv("MULTICA_TOKEN"); got != "mat_recovered" {
		t.Fatalf("MULTICA_TOKEN = %q, want %q", got, "mat_recovered")
	}
	if got := os.Getenv(cli.TaskConfigRootEnv); got != "/tmp/task-multica-config" {
		t.Fatalf("%s = %q, want the task config root", cli.TaskConfigRootEnv, got)
	}

	// End-to-end: with the credentials recovered, the API client builds and
	// attributes writes to the agent/task rather than refusing.
	client, err := newAPIClient(testCmd())
	if err != nil {
		t.Fatalf("newAPIClient after bootstrap: %v", err)
	}
	if client.AgentID != "agent-1" || client.TaskID != "task-1" {
		t.Fatalf("client actor = agent %q task %q, want agent-1/task-1", client.AgentID, client.TaskID)
	}
}

// TestBootstrapDaemonTaskCredentialsDoesNotOverwriteIntactEnv proves the recovery
// only fills gaps: when the injected token survived (a normal runtime), the
// sidecar is never even consulted and the live environment wins.
func TestBootstrapDaemonTaskCredentialsDoesNotOverwriteIntactEnv(t *testing.T) {
	seedCredentials(t, fullTaskCredentialEnv("mat_from_sidecar"))
	for _, k := range taskCredentialKeys {
		t.Setenv(k, "")
	}
	t.Setenv("MULTICA_TOKEN", "mat_from_env")

	bootstrapDaemonTaskCredentials()

	if got := os.Getenv("MULTICA_TOKEN"); got != "mat_from_env" {
		t.Fatalf("MULTICA_TOKEN = %q, want the intact env value %q", got, "mat_from_env")
	}
}

// TestBootstrapDaemonTaskCredentialsNoopWithoutSidecar proves an ordinary user
// shell (no sidecar above cwd) is untouched — bootstrap must not invent a token.
func TestBootstrapDaemonTaskCredentialsNoopWithoutSidecar(t *testing.T) {
	t.Chdir(t.TempDir())
	for _, k := range taskCredentialKeys {
		t.Setenv(k, "")
	}

	bootstrapDaemonTaskCredentials()

	if got := os.Getenv("MULTICA_TOKEN"); got != "" {
		t.Fatalf("MULTICA_TOKEN = %q, want empty with no sidecar present", got)
	}
}

// TestBootstrapDaemonTaskCredentialsIgnoresUntrustworthySidecar proves a planted
// or leftover file (foreign managed_by, or a non-task-scoped token) is never
// honoured, so the recovery channel cannot be turned into an escalation path.
func TestBootstrapDaemonTaskCredentialsIgnoresUntrustworthySidecar(t *testing.T) {
	for _, body := range []string{
		`{"managed_by":"someone-else","env":{"MULTICA_TOKEN":"mat_evil"}}`,
		`{"managed_by":"` + execenv.TaskCredentialsManagedBy + `","env":{"MULTICA_TOKEN":"pat_not_task_scoped"}}`,
	} {
		t.Run("", func(t *testing.T) {
			envRoot := t.TempDir()
			path := filepath.Join(envRoot, execenv.TaskCredentialsRelPath)
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatalf("seed untrustworthy sidecar: %v", err)
			}
			workDir := filepath.Join(envRoot, "workdir")
			if err := os.MkdirAll(workDir, 0o755); err != nil {
				t.Fatalf("create workdir: %v", err)
			}
			t.Chdir(workDir)
			for _, k := range taskCredentialKeys {
				t.Setenv(k, "")
			}

			bootstrapDaemonTaskCredentials()

			if got := os.Getenv("MULTICA_TOKEN"); got != "" {
				t.Fatalf("MULTICA_TOKEN = %q, want empty; untrustworthy sidecar must be ignored", got)
			}
		})
	}
}

// TestFailClosedPreservedWhenNoSidecar proves bootstrap does not weaken the
// existing guard: inside a daemon-managed task (marker present) with no token and
// no recoverable sidecar, the CLI still refuses rather than fall back to the
// user's own config PAT.
func TestFailClosedPreservedWhenNoSidecar(t *testing.T) {
	seedDaemonTaskMarker(t) // chdirs into a nested workdir under a marker
	for _, k := range taskCredentialKeys {
		t.Setenv(k, "")
	}
	// Set the non-credential context so the refusal we assert on is specifically
	// the missing mat_ token, not a missing server/config root.
	t.Setenv("MULTICA_SERVER_URL", "http://127.0.0.1:18227")
	t.Setenv(cli.TaskConfigRootEnv, "/tmp/task-multica-config")

	bootstrapDaemonTaskCredentials()

	if _, err := newAPIClient(testCmd()); err == nil {
		t.Fatal("newAPIClient succeeded with no token and no sidecar; want fail-closed refusal")
	} else if !strings.Contains(err.Error(), "mat_") {
		t.Fatalf("error should demand a task-scoped mat_ token; got %q", err.Error())
	}
}
