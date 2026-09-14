package daemon

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestProbeAgentCLIsDiscoversNvmCodex(t *testing.T) {
	home := t.TempDir()
	nvmDir := filepath.Join(home, ".nvm")
	binDir := filepath.Join(nvmDir, "versions", "node", "v24.11.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(nvmDir, "alias"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nvmDir, "alias", "default"), []byte("v24.11.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	name := "codex"
	content := []byte("#!/bin/sh\nexit 0\n")
	if runtime.GOOS == "windows" {
		name = "codex.cmd"
		content = []byte("@echo off\r\nexit /b 0\r\n")
	}
	executable := filepath.Join(binDir, name)
	if err := os.WriteFile(executable, content, 0o755); err != nil {
		t.Fatal(err)
	}

	origResolve := resolveAgentsViaLoginShell
	t.Cleanup(func() { resolveAgentsViaLoginShell = origResolve })
	resolveAgentsViaLoginShell = func([]string) map[string]string { return map[string]string{} }
	resetShellResolveCacheForTest(t)

	oldBundlePaths := codexDesktopAppBundlePaths
	codexDesktopAppBundlePaths = func() []string { return nil }
	t.Cleanup(func() { codexDesktopAppBundlePaths = oldBundlePaths })

	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("NVM_DIR", nvmDir)
	t.Setenv("NVM_BIN", "")
	t.Setenv("PATH", t.TempDir())
	t.Setenv("MULTICA_CODEX_PATH", "")
	t.Setenv("MULTICA_CODEX_MODEL", "gpt-5")

	entry, ok := probeAgentCLIs()["codex"]
	if !ok {
		t.Fatal("Codex was not discovered from its nvm install path")
	}
	if filepath.Clean(entry.Path) != filepath.Clean(executable) {
		t.Fatalf("Codex path = %q, want %q", entry.Path, executable)
	}
	if entry.Command != "codex" || entry.Model != "gpt-5" {
		t.Fatalf("unexpected Codex entry: %+v", entry)
	}
}

func TestProbeAgentCLIs_CodexPinnedPathStaysHardMiss(t *testing.T) {
	home := t.TempDir()
	nvmDir := filepath.Join(home, ".nvm")
	binDir := filepath.Join(nvmDir, "versions", "node", "v24.11.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "codex"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	origResolve := resolveAgentsViaLoginShell
	t.Cleanup(func() { resolveAgentsViaLoginShell = origResolve })
	resolveAgentsViaLoginShell = func([]string) map[string]string { return map[string]string{} }
	resetShellResolveCacheForTest(t)

	oldBundlePaths := codexDesktopAppBundlePaths
	codexDesktopAppBundlePaths = func() []string { return nil }
	t.Cleanup(func() { codexDesktopAppBundlePaths = oldBundlePaths })

	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("NVM_DIR", nvmDir)
	t.Setenv("NVM_BIN", "")
	t.Setenv("PATH", t.TempDir())
	t.Setenv("MULTICA_CODEX_PATH", "/nonexistent/pinned/codex")

	if entry, ok := probeAgentCLIs()["codex"]; ok {
		t.Errorf("pinned-but-missing MULTICA_CODEX_PATH resolved to %q, want a hard miss", entry.Path)
	}
}

func TestNvmUserCodexPathsPrefersDefaultAlias(t *testing.T) {
	home := t.TempDir()
	nvmDir := filepath.Join(home, ".nvm")
	for _, version := range []string{"v18.20.0", "v24.11.0"} {
		if err := os.MkdirAll(filepath.Join(nvmDir, "versions", "node", version, "bin"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(nvmDir, "alias"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nvmDir, "alias", "default"), []byte("v18.20.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("NVM_DIR", nvmDir)
	t.Setenv("NVM_BIN", "")

	paths := nvmUserCodexPaths()
	want := filepath.Join(nvmDir, "versions", "node", "v18.20.0", "bin", "codex")
	if len(paths) == 0 || paths[0] != want {
		t.Fatalf("nvmUserCodexPaths()[0] = %v, want default-alias %q first", paths, want)
	}
}
