package daemon

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// stubWukongProbeEnv isolates probeWukongRuntime from the machine: HOME moved
// to a temp dir (the shim materializes under ~/.multica/shims), the env
// overrides cleared, and the app-bundle candidate list replaced.
func stubWukongProbeEnv(t *testing.T, candidates []string) (home string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX-only: shim materialization uses 0755 permissions")
	}
	home = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("MULTICA_WUKONG_PATH", "")
	t.Setenv("MULTICA_WUKONG_MODEL", "")
	orig := wukongCLIProbePaths
	t.Cleanup(func() { wukongCLIProbePaths = orig })
	wukongCLIProbePaths = candidates
	return home
}

func readShim(t *testing.T, home string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, ".multica", "shims", "wukong-qwen-bridge"))
	if err != nil {
		t.Fatalf("read shim: %v", err)
	}
	return string(data)
}

// TestEnsureWukongBridgeShimMaterializesIdempotently covers the publish
// contract: the embedded source lands at the well-known shim path with the
// CLI placeholder replaced, executable bits set, repeat calls are content-
// compared no-ops, and a corrupted on-disk shim is repaired on the next pass.
func TestEnsureWukongBridgeShimMaterializesIdempotently(t *testing.T) {
	home := stubWukongProbeEnv(t, nil)

	// The replacement below is a silent no-op if the embedded source ever
	// loses the placeholder (e.g. an edit to wukong_qwen_bridge.py) — fail
	// here instead of publishing a shim pointing at a literal placeholder.
	if !strings.Contains(wukongBridgeSource, wukongBridgeCLIDefaultPlaceholder) {
		t.Fatal("embedded bridge source lost the CLI-path placeholder")
	}

	shim, err := ensureWukongBridgeShim("/fake/wukong-cli")
	if err != nil {
		t.Fatalf("ensureWukongBridgeShim: %v", err)
	}
	wantShim := filepath.Join(home, ".multica", "shims", "wukong-qwen-bridge")
	if shim != wantShim {
		t.Errorf("shim path = %q, want %q", shim, wantShim)
	}

	content := readShim(t, home)
	if strings.Contains(content, wukongBridgeCLIDefaultPlaceholder) {
		t.Error("shim still contains the __WUKONG_CLI_DEFAULT__ placeholder")
	}
	if !strings.Contains(content, `"/fake/wukong-cli"`) {
		t.Error("shim does not embed the detected wukong-cli path")
	}
	info, err := os.Stat(shim)
	if err != nil {
		t.Fatalf("stat shim: %v", err)
	}
	if info.Mode()&0o111 == 0 {
		t.Errorf("shim mode %v is not executable", info.Mode())
	}

	// Repeat call with the same CLI path: same path, content untouched.
	again, err := ensureWukongBridgeShim("/fake/wukong-cli")
	if err != nil || again != shim {
		t.Fatalf("idempotent re-publish = (%q, %v), want (%q, nil)", again, err, shim)
	}
	if got := readShim(t, home); got != content {
		t.Error("idempotent re-publish rewrote the shim content")
	}

	// A corrupted shim is repaired by the next probe round.
	if err := os.WriteFile(shim, []byte("corrupted"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := ensureWukongBridgeShim("/fake/wukong-cli"); err != nil {
		t.Fatalf("repair publish: %v", err)
	}
	if got := readShim(t, home); got != content {
		t.Error("corrupted shim was not repaired to the expected content")
	}

	// A different detected CLI path rewrites the shim to match.
	if _, err := ensureWukongBridgeShim("/elsewhere/wukong-cli"); err != nil {
		t.Fatalf("re-publish for moved CLI: %v", err)
	}
	if got := readShim(t, home); !strings.Contains(got, `"/elsewhere/wukong-cli"`) {
		t.Error("shim was not re-published for the moved CLI path")
	}
}

// TestEnsureWukongBridgeShimRejectsUnsafeCLIPath: the CLI path is baked into
// a Python string literal, so characters that could break out of the literal
// must be rejected rather than publish a corrupted (or hostile) shim.
func TestEnsureWukongBridgeShimRejectsUnsafeCLIPath(t *testing.T) {
	home := stubWukongProbeEnv(t, nil)
	for _, bad := range []string{
		`/tmp/evil";import os;#`,
		"/tmp/evil'path",
		"/tmp/evil\\path",
		"/tmp/evil\npath",
	} {
		if _, err := ensureWukongBridgeShim(bad); err == nil {
			t.Errorf("ensureWukongBridgeShim(%q) succeeded, want a rejection", bad)
		}
	}
	shim := filepath.Join(home, ".multica", "shims", "wukong-qwen-bridge")
	if _, err := os.Stat(shim); !os.IsNotExist(err) {
		t.Errorf("shim must not be materialized for a rejected path, stat err=%v", err)
	}
}

// TestProbeWukongRuntimeRegistersShim covers the happy path: a wukong-cli
// found among the bundle candidates yields a runtime entry pointing at the
// materialized SHIM (never the raw CLI), with the model env passed through.
func TestProbeWukongRuntimeRegistersShim(t *testing.T) {
	fakeCLI := filepath.Join(t.TempDir(), "wukong-cli")
	writeDaemonTestExecutable(t, fakeCLI, []byte("#!/bin/sh\nexit 0\n"))
	home := stubWukongProbeEnv(t, []string{"/nonexistent/first-candidate", fakeCLI})
	t.Setenv("MULTICA_WUKONG_MODEL", "wk-model-1")

	entry, ok := probeWukongRuntime()
	if !ok {
		t.Fatal("probeWukongRuntime missed with a present CLI candidate")
	}
	wantShim := filepath.Join(home, ".multica", "shims", "wukong-qwen-bridge")
	if entry.Path != wantShim {
		t.Errorf("entry.Path = %q, want the materialized shim %q (never the raw CLI)", entry.Path, wantShim)
	}
	if entry.Path == fakeCLI {
		t.Error("entry.Path is the raw wukong-cli — the daemon must register the bridge shim")
	}
	// Command stays empty: the shim is a daemon-managed artifact, not a PATH
	// command the self-heal resolver could re-resolve.
	if entry.Command != "" {
		t.Errorf("entry.Command = %q, want empty", entry.Command)
	}
	if entry.Model != "wk-model-1" {
		t.Errorf("entry.Model = %q, want %q", entry.Model, "wk-model-1")
	}
	if got := readShim(t, home); !strings.Contains(got, `"`+fakeCLI+`"`) {
		t.Errorf("shim does not embed the probed CLI path %q", fakeCLI)
	}
}

// TestProbeWukongRuntimeMissesWithoutCLI covers the absent-CLI branch: no env
// override and no executable candidate means the runtime stays unregistered
// (fail-closed) and no shim is published.
func TestProbeWukongRuntimeMissesWithoutCLI(t *testing.T) {
	home := stubWukongProbeEnv(t, []string{"/nonexistent/wukong-cli"})
	// A non-executable file at a candidate path does not count either.
	deadDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(deadDir, "wukong-cli"), []byte("not executable"), 0o644); err != nil {
		t.Fatal(err)
	}
	wukongCLIProbePaths = append(wukongCLIProbePaths, filepath.Join(deadDir, "wukong-cli"))

	if entry, ok := probeWukongRuntime(); ok {
		t.Errorf("probeWukongRuntime = %+v, want a miss with no CLI present", entry)
	}
	if _, err := os.Stat(filepath.Join(home, ".multica", "shims", "wukong-qwen-bridge")); !os.IsNotExist(err) {
		t.Error("shim must not be published when no CLI was found")
	}
}

// TestProbeWukongRuntimeEnvOverride covers both override branches: a valid
// MULTICA_WUKONG_PATH wins over the bundle candidates, and an invalid one is
// a hard miss that never falls back to them (same contract as probe()).
func TestProbeWukongRuntimeEnvOverride(t *testing.T) {
	t.Run("valid override wins", func(t *testing.T) {
		overrideCLI := filepath.Join(t.TempDir(), "wukong-cli")
		writeDaemonTestExecutable(t, overrideCLI, []byte("#!/bin/sh\nexit 0\n"))
		bundleCLI := filepath.Join(t.TempDir(), "wukong-cli")
		writeDaemonTestExecutable(t, bundleCLI, []byte("#!/bin/sh\nexit 0\n"))
		home := stubWukongProbeEnv(t, []string{bundleCLI})
		t.Setenv("MULTICA_WUKONG_PATH", overrideCLI)

		entry, ok := probeWukongRuntime()
		if !ok {
			t.Fatal("probeWukongRuntime missed despite a valid override")
		}
		got := readShim(t, home)
		if !strings.Contains(got, `"`+overrideCLI+`"`) {
			t.Errorf("shim does not embed the override path %q", overrideCLI)
		}
		if strings.Contains(got, bundleCLI) {
			t.Errorf("shim embeds the bundle candidate %q despite the override", bundleCLI)
		}
		_ = entry
	})

	t.Run("invalid override is a hard miss", func(t *testing.T) {
		bundleCLI := filepath.Join(t.TempDir(), "wukong-cli")
		writeDaemonTestExecutable(t, bundleCLI, []byte("#!/bin/sh\nexit 0\n"))
		stubWukongProbeEnv(t, []string{bundleCLI})
		t.Setenv("MULTICA_WUKONG_PATH", "/nonexistent/pinned-wukong-cli")

		if entry, ok := probeWukongRuntime(); ok {
			t.Errorf("pinned-but-missing override resolved to %+v, want a hard miss "+
				"(no bundle-candidate rescue)", entry)
		}
	})
}

// TestProbeAgentCLIs_WukongGoesThroughDedicatedProbe is the end-to-end guard
// for the descriptor loop contract: the wukong descriptor has no
// DefaultCommand, so the generic probe loop must skip it and the dedicated
// block must register the shim entry — and must leave the runtime absent
// when no CLI exists.
func TestProbeAgentCLIs_WukongGoesThroughDedicatedProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}
	stubEmptyLoginShell(t)

	t.Run("cli present", func(t *testing.T) {
		fakeCLI := filepath.Join(t.TempDir(), "wukong-cli")
		writeDaemonTestExecutable(t, fakeCLI, []byte("#!/bin/sh\nexit 0\n"))
		home := stubWukongProbeEnv(t, []string{fakeCLI})
		t.Setenv("PATH", t.TempDir())

		entry, ok := probeAgentCLIs()["wukong"]
		if !ok {
			t.Fatal("wukong was not registered by the dedicated probe block")
		}
		if entry.Path != filepath.Join(home, ".multica", "shims", "wukong-qwen-bridge") {
			t.Errorf("wukong Path = %q, want the daemon-managed shim", entry.Path)
		}
	})

	t.Run("cli absent", func(t *testing.T) {
		stubWukongProbeEnv(t, []string{"/nonexistent/wukong-cli"})
		t.Setenv("PATH", t.TempDir())

		if entry, ok := probeAgentCLIs()["wukong"]; ok {
			t.Errorf("wukong registered %+v with no CLI present", entry)
		}
	})
}
