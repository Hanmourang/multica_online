package execenv

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestWriteTaskCredentials covers the daemon-owned credential sidecar that lets
// the CLI recover its task-scoped MULTICA_* env when a runtime (Wukong print
// mode) executes tools in a separate service process that lost the injected env.
func TestWriteTaskCredentials(t *testing.T) {
	t.Run("writes only MULTICA_* keys with a valid mat_ token", func(t *testing.T) {
		root := t.TempDir()
		agentEnv := map[string]string{
			"MULTICA_TOKEN":           "mat_task_scoped_secret",
			"MULTICA_SERVER_URL":      "http://localhost:18227",
			"MULTICA_WORKSPACE_ID":    "ws-1",
			"MULTICA_AGENT_ID":        "agent-1",
			"MULTICA_TASK_ID":         "task-1",
			"MULTICA_DAEMON_PORT":     "18999",
			"MULTICA_TASK_CONFIG_ROOT": filepath.Join(root, "multica-config"),
			// Non-MULTICA keys and empty values must never be persisted.
			"PATH":     "/usr/bin:/bin",
			"TMPDIR":   "/tmp/whatever",
			"EMPTY_MC": "",
		}
		if err := WriteTaskCredentials(root, agentEnv); err != nil {
			t.Fatalf("WriteTaskCredentials: %v", err)
		}
		data, err := os.ReadFile(filepath.Join(root, TaskCredentialsRelPath))
		if err != nil {
			t.Fatalf("read sidecar: %v", err)
		}
		var f taskCredentialsFile
		if err := json.Unmarshal(data, &f); err != nil {
			t.Fatalf("unmarshal sidecar: %v\n%s", err, string(data))
		}
		if f.ManagedBy != TaskCredentialsManagedBy {
			t.Fatalf("managed_by = %q, want %q", f.ManagedBy, TaskCredentialsManagedBy)
		}
		if f.Env["MULTICA_TOKEN"] != "mat_task_scoped_secret" {
			t.Fatalf("token = %q, want the mat_ token", f.Env["MULTICA_TOKEN"])
		}
		for _, leaked := range []string{"PATH", "TMPDIR", "EMPTY_MC"} {
			if _, ok := f.Env[leaked]; ok {
				t.Fatalf("non-credential key %q leaked into sidecar", leaked)
			}
		}
	})

	t.Run("file mode is 0600", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("POSIX permission bits are not meaningful on Windows")
		}
		root := t.TempDir()
		if err := WriteTaskCredentials(root, map[string]string{"MULTICA_TOKEN": "mat_x"}); err != nil {
			t.Fatalf("WriteTaskCredentials: %v", err)
		}
		info, err := os.Stat(filepath.Join(root, TaskCredentialsRelPath))
		if err != nil {
			t.Fatalf("stat sidecar: %v", err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("sidecar perm = %#o, want 0600", perm)
		}
	})

	t.Run("refuses to write without a mat_ token", func(t *testing.T) {
		for _, env := range []map[string]string{
			{},
			{"MULTICA_TOKEN": ""},
			{"MULTICA_TOKEN": "pat_not_task_scoped"},
			{"MULTICA_SERVER_URL": "http://x"},
		} {
			root := t.TempDir()
			if err := WriteTaskCredentials(root, env); err == nil {
				t.Fatalf("expected error for env %v, got nil", env)
			}
			if _, err := os.Stat(filepath.Join(root, TaskCredentialsRelPath)); !os.IsNotExist(err) {
				t.Fatalf("sidecar written despite missing mat_ token (stat err=%v)", err)
			}
		}
	})

	t.Run("refuses to overwrite a foreign file", func(t *testing.T) {
		root := t.TempDir()
		path := filepath.Join(root, TaskCredentialsRelPath)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		foreign := []byte(`{"managed_by":"someone-else","env":{"MULTICA_TOKEN":"mat_evil"}}`)
		if err := os.WriteFile(path, foreign, 0o600); err != nil {
			t.Fatalf("write foreign file: %v", err)
		}
		if err := WriteTaskCredentials(root, map[string]string{"MULTICA_TOKEN": "mat_good"}); err == nil {
			t.Fatal("expected error for foreign file at credentials path, got nil")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("re-read foreign file: %v", err)
		}
		if string(data) != string(foreign) {
			t.Fatalf("foreign file was clobbered: %s", string(data))
		}
	})

	t.Run("self-heals a corrupt sidecar from a torn write", func(t *testing.T) {
		for _, corrupt := range []string{"", "{", "not-json", `{"managed_by":`} {
			root := t.TempDir()
			path := filepath.Join(root, TaskCredentialsRelPath)
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			if err := os.WriteFile(path, []byte(corrupt), 0o600); err != nil {
				t.Fatalf("seed corrupt sidecar %q: %v", corrupt, err)
			}
			if err := WriteTaskCredentials(root, map[string]string{"MULTICA_TOKEN": "mat_reclaimed"}); err != nil {
				t.Fatalf("reclaim corrupt sidecar %q: unexpected error %v", corrupt, err)
			}
			creds, ok := ReadTaskCredentials(root)
			if !ok || creds["MULTICA_TOKEN"] != "mat_reclaimed" {
				t.Fatalf("reclaimed sidecar not readable for input %q (ok=%v creds=%v)", corrupt, ok, creds)
			}
		}
	})

	t.Run("rejects empty env root", func(t *testing.T) {
		if err := WriteTaskCredentials("", map[string]string{"MULTICA_TOKEN": "mat_x"}); err == nil {
			t.Fatal("expected error for empty env root, got nil")
		}
	})
}

// TestReadTaskCredentials covers the CLI-side discovery: walk up from the task
// workdir, trust only a correctly-owned file carrying a mat_ token, and never
// let a planted/leftover file be honoured or abort the search.
func TestReadTaskCredentials(t *testing.T) {
	t.Run("finds the sidecar by walking up from a child workdir", func(t *testing.T) {
		root := t.TempDir()
		if err := WriteTaskCredentials(root, map[string]string{
			"MULTICA_TOKEN":        "mat_walkup",
			"MULTICA_WORKSPACE_ID": "ws-walk",
		}); err != nil {
			t.Fatalf("WriteTaskCredentials: %v", err)
		}
		workDir := filepath.Join(root, "workdir", "nested")
		if err := os.MkdirAll(workDir, 0o755); err != nil {
			t.Fatalf("mkdir workdir: %v", err)
		}
		creds, ok := ReadTaskCredentials(workDir)
		if !ok {
			t.Fatal("walk-up from workdir did not find the sidecar")
		}
		if creds["MULTICA_TOKEN"] != "mat_walkup" || creds["MULTICA_WORKSPACE_ID"] != "ws-walk" {
			t.Fatalf("unexpected creds: %v", creds)
		}
	})

	t.Run("returns false when no sidecar exists", func(t *testing.T) {
		if _, ok := ReadTaskCredentials(t.TempDir()); ok {
			t.Fatal("expected no credentials in an empty temp tree")
		}
	})

	t.Run("skips untrustworthy files and keeps walking", func(t *testing.T) {
		root := t.TempDir()
		// A legitimate sidecar at the top.
		if err := WriteTaskCredentials(root, map[string]string{"MULTICA_TOKEN": "mat_legit"}); err != nil {
			t.Fatalf("WriteTaskCredentials: %v", err)
		}
		// A poisoned sidecar one level down that must be ignored in favour of
		// the legitimate one higher up.
		child := filepath.Join(root, "workdir")
		childPath := filepath.Join(child, TaskCredentialsRelPath)
		for _, bad := range []string{
			`{"managed_by":"someone-else","env":{"MULTICA_TOKEN":"mat_evil"}}`,
			`{"managed_by":"` + TaskCredentialsManagedBy + `","env":{"MULTICA_TOKEN":"pat_not_task"}}`,
			`not-json`,
		} {
			if err := os.MkdirAll(filepath.Dir(childPath), 0o700); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			if err := os.WriteFile(childPath, []byte(bad), 0o600); err != nil {
				t.Fatalf("seed bad sidecar: %v", err)
			}
			creds, ok := ReadTaskCredentials(child)
			if !ok {
				t.Fatalf("bad child file %q aborted the walk; want fallthrough to the legit parent", bad)
			}
			if creds["MULTICA_TOKEN"] != "mat_legit" {
				t.Fatalf("trusted a bad child file %q: got token %q", bad, creds["MULTICA_TOKEN"])
			}
		}
	})

	t.Run("empty start dir yields no credentials", func(t *testing.T) {
		if _, ok := ReadTaskCredentials(""); ok {
			t.Fatal("expected no credentials for an empty start dir")
		}
	})
}
