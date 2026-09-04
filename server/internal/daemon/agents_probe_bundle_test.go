package daemon

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// bundlePinnedRuntimes are the built-in runtime identities discovered through
// descriptor ProbePaths (app-bundle CLIs) instead of a PATH command lookup.
// Their bundle binaries share a name with the public editions (`qodercli` /
// `qoderclicn`), so the probe contract is: env override, then the bundle
// candidates, and NEVER a PATH or login-shell lookup.
func bundlePinnedRuntimes() []struct {
	id        string
	envPath   string
	envModel  string
	colliding string
} {
	return []struct {
		id        string
		envPath   string
		envModel  string
		colliding string
	}{
		{id: "qoderwork", envPath: "MULTICA_QODERWORK_PATH", envModel: "MULTICA_QODERWORK_MODEL", colliding: "qodercli"},
		{id: "qwenwork", envPath: "MULTICA_QWENWORK_PATH", envModel: "MULTICA_QWENWORK_MODEL", colliding: "qoderclicn"},
	}
}

func stubEmptyLoginShell(t *testing.T) {
	t.Helper()
	orig := resolveAgentsViaLoginShell
	t.Cleanup(func() { resolveAgentsViaLoginShell = orig })
	resolveAgentsViaLoginShell = func([]string) map[string]string { return map[string]string{} }
	resetShellResolveCacheForTest(t)
}

// TestProbeAgentCLIs_BundlePinnedEnvOverrideWins: an explicit
// MULTICA_<ID>_PATH override resolves and wins over everything else —
// including the bundle candidates and a same-named binary on PATH.
func TestProbeAgentCLIs_BundlePinnedEnvOverrideWins(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}
	stubEmptyLoginShell(t)
	for _, tc := range bundlePinnedRuntimes() {
		t.Run(tc.id, func(t *testing.T) {
			fakeDir := t.TempDir()
			// A colliding public-edition binary on PATH must be ignored once
			// the override is set.
			writeDaemonTestExecutable(t, filepath.Join(fakeDir, tc.colliding), []byte("#!/bin/sh\nexit 0\n"))
			override := filepath.Join(fakeDir, tc.id+"-cli")
			writeDaemonTestExecutable(t, override, []byte("#!/bin/sh\nexit 0\n"))
			t.Setenv("PATH", fakeDir)
			t.Setenv(tc.envPath, override)
			t.Setenv(tc.envModel, "model-from-env")

			entry, ok := probeAgentCLIs()[tc.id]
			if !ok {
				t.Fatalf("%s was not discovered despite a valid %s override", tc.id, tc.envPath)
			}
			if entry.Path != override {
				t.Errorf("Path = %q, want the override %q", entry.Path, override)
			}
			if entry.Command != override {
				t.Errorf("Command = %q, want the override %q", entry.Command, override)
			}
			if entry.Model != "model-from-env" {
				t.Errorf("Model = %q, want %q", entry.Model, "model-from-env")
			}
		})
	}
}

// TestProbeAgentCLIs_BundlePinnedOverrideHardMiss: an explicit but invalid
// MULTICA_<ID>_PATH is a hard miss — the probe must NOT rescue it with a
// bundle candidate, a PATH hit, or a login-shell resolution. Silently
// substituting a different binary for an operator-pinned path is exactly how
// the public CLI would get registered under the bundle identity.
func TestProbeAgentCLIs_BundlePinnedOverrideHardMiss(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}
	stubEmptyLoginShell(t)
	for _, tc := range bundlePinnedRuntimes() {
		t.Run(tc.id, func(t *testing.T) {
			fakeDir := t.TempDir()
			writeDaemonTestExecutable(t, filepath.Join(fakeDir, tc.colliding), []byte("#!/bin/sh\nexit 0\n"))
			t.Setenv("PATH", fakeDir)
			t.Setenv(tc.envPath, filepath.Join(fakeDir, "nonexistent-pinned-binary"))
			t.Setenv(tc.envModel, "")

			if entry, ok := probeAgentCLIs()[tc.id]; ok {
				t.Errorf("pinned-but-missing %s resolved to %+v, want a hard miss "+
					"(no bundle/PATH/login-shell rescue)", tc.envPath, entry)
			}
		})
	}
}

// TestProbeAgentCLIs_BundlePinnedNeverUsesPATH: without an env override the
// probe may only resolve through the descriptor's absolute bundle candidates.
// A same-named binary on PATH (or via the login shell) must never be
// registered under the bundle identity. On a machine without the app
// installed the identity is simply absent — both outcomes satisfy the
// contract, so the test is hermetic.
func TestProbeAgentCLIs_BundlePinnedNeverUsesPATH(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}
	for _, tc := range bundlePinnedRuntimes() {
		t.Run(tc.id, func(t *testing.T) {
			fakeDir := t.TempDir()
			impostor := filepath.Join(fakeDir, tc.colliding)
			writeDaemonTestExecutable(t, impostor, []byte("#!/bin/sh\nexit 0\n"))

			orig := resolveAgentsViaLoginShell
			t.Cleanup(func() { resolveAgentsViaLoginShell = orig })
			resolveAgentsViaLoginShell = func([]string) map[string]string {
				// Even the login shell "finding" the public binary must not
				// rescue the bundle identity.
				return map[string]string{tc.colliding: impostor}
			}
			resetShellResolveCacheForTest(t)

			t.Setenv("PATH", fakeDir)
			t.Setenv(tc.envPath, "")
			t.Setenv(tc.envModel, "")

			entry, ok := probeAgentCLIs()[tc.id]
			if !ok {
				return // bundle not installed on this machine — correct outcome
			}
			if entry.Path == impostor || entry.Command == tc.colliding || entry.Command == impostor {
				t.Fatalf("%s registered the PATH/login-shell impostor %+v; bundle-pinned "+
					"probes must never use PATH", tc.id, entry)
			}
			desc, descOK := agent.BuiltinRuntimeByID(tc.id)
			if !descOK {
				t.Fatalf("descriptor for %s missing", tc.id)
			}
			fromBundle := false
			for _, candidate := range desc.ProbePaths {
				if entry.Command == candidate {
					fromBundle = true
					break
				}
			}
			if !fromBundle {
				t.Errorf("%s Command = %q, want one of the descriptor ProbePaths %v",
					tc.id, entry.Command, desc.ProbePaths)
			}
		})
	}
}
