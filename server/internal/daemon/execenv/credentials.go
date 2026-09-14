package execenv

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// TaskCredentialsRelPath is a daemon-owned, per-task sidecar that carries the
// task-scoped MULTICA_* credentials. It exists because some agent runtimes —
// notably Wukong's print mode — hand tool execution to a separate long-lived
// service process whose environment is rebuilt from the user's login shell, not
// inherited from the daemon-spawned agent. Every MULTICA_* var the daemon
// injected (token, server URL, workspace/agent/task identity, task-local config
// root) is gone by the time the agent shells out to `multica`, and the CLI then
// — correctly — fails closed rather than fall back to the user's own PAT, which
// is how agent writes would otherwise land as the wrong actor.
//
// This file gives the CLI a second, daemon-owned channel to recover the exact
// per-task credentials from disk without weakening that guard: it is discovered
// by walking *up* from cwd (the same discovery the non-secret task marker uses),
// so a tool whose cwd is the task workdir finds it at the env root one level up.
//
// It is written under envRoot — never under a local_directory workdir — so a
// live task-scoped secret is never dropped into the user's own repository, and
// with mode 0600 so it is not readable by any other local user.
const TaskCredentialsRelPath = ".multica/task_credentials.json"

// TaskCredentialsManagedBy is the discriminator a reader checks before trusting
// TaskCredentialsRelPath. It is deliberately distinct from
// TaskContextMarkerManagedBy so a stale, non-secret task marker can never be
// mistaken for a credentials file, and vice versa.
const TaskCredentialsManagedBy = "multica-daemon-task-credentials"

// taskCredentialsFile is the on-disk shape of the sidecar. Env carries only
// MULTICA_* keys; see WriteTaskCredentials.
type taskCredentialsFile struct {
	ManagedBy string            `json:"managed_by"`
	Env       map[string]string `json:"env"`
}

// WriteTaskCredentials atomically persists the per-task MULTICA_* credential
// sidecar under envRoot. agentEnv is the fully-assembled agent environment; only
// keys prefixed with "MULTICA_" and carrying a non-empty value are stored, so
// PATH, TMPDIR, provider homes, and any user custom_env never leak into what is
// treated as recoverable task credentials.
//
// The write is refused unless a task-scoped mat_ token is present: a sidecar
// without one could only ever reproduce the very fail-closed error it exists to
// prevent, so writing it would be pointless at best. A parseable file owned by
// something else is never clobbered; our own torn write (the signature of a
// daemon killed mid-write) is reclaimed. Mirrors EnsureWorkspacesRootMarker's
// atomicity guarantees.
func WriteTaskCredentials(envRoot string, agentEnv map[string]string) error {
	if strings.TrimSpace(envRoot) == "" {
		return errors.New("execenv: env root is required")
	}
	creds := make(map[string]string, len(agentEnv))
	for k, v := range agentEnv {
		if strings.HasPrefix(k, "MULTICA_") && v != "" {
			creds[k] = v
		}
	}
	if !strings.HasPrefix(creds["MULTICA_TOKEN"], "mat_") {
		return errors.New("execenv: refusing to write task credentials without a task-scoped mat_ token")
	}

	path := filepath.Join(envRoot, TaskCredentialsRelPath)
	// Never overwrite a parseable file owned by something else. An unparseable
	// file is treated as our own torn write and reclaimed below.
	if existing, err := os.ReadFile(path); err == nil {
		var f taskCredentialsFile
		if json.Unmarshal(existing, &f) == nil && f.ManagedBy != "" && f.ManagedBy != TaskCredentialsManagedBy {
			return fmt.Errorf("foreign file at task credentials path %s; refusing to overwrite", path)
		}
	}

	payload := taskCredentialsFile{ManagedBy: TaskCredentialsManagedBy, Env: creds}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal task credentials: %w", err)
	}
	// 0700 on the directory: it lives under the daemon-owned env root and holds
	// a secret, so it must not be world-searchable.
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create task credentials dir: %w", err)
	}
	if err := writeTaskCredentialsAtomic(path, data); err != nil {
		return fmt.Errorf("write task credentials: %w", err)
	}
	return nil
}

// writeTaskCredentialsAtomic writes data to path via a same-directory temp file
// plus a rename, so a concurrent CLI walking up from the task workdir observes
// either no file or the complete new one — never a half-written sidecar it might
// misparse and treat as "no credentials here". The final mode is 0600 because
// the payload carries a live task-scoped token.
func writeTaskCredentialsAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".task_credentials-*.json.tmp")
	if err != nil {
		return fmt.Errorf("create temp task credentials: %w", err)
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write temp task credentials: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close temp task credentials: %w", err)
	}
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("chmod temp task credentials: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename task credentials: %w", err)
	}
	return nil
}

// ReadTaskCredentials walks up from startDir and returns the MULTICA_* env of the
// first trustworthy credentials sidecar, or (nil, false) when none is found. A
// file counts as trustworthy only when it is readable, parses, is owned by
// TaskCredentialsManagedBy, and carries a task-scoped mat_ token. Anything else
// — missing, unreadable, unparseable, foreign-owned, or a non-mat_ token — is
// skipped and the walk continues, so a leftover or planted file can never be
// trusted and can never abort the search for a legitimate one higher up.
func ReadTaskCredentials(startDir string) (map[string]string, bool) {
	dir := startDir
	if strings.TrimSpace(dir) == "" {
		return nil, false
	}
	for {
		path := filepath.Join(dir, TaskCredentialsRelPath)
		if data, err := os.ReadFile(path); err == nil {
			var f taskCredentialsFile
			if json.Unmarshal(data, &f) == nil &&
				f.ManagedBy == TaskCredentialsManagedBy &&
				strings.HasPrefix(f.Env["MULTICA_TOKEN"], "mat_") {
				return f.Env, true
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil, false
		}
		dir = parent
	}
}
