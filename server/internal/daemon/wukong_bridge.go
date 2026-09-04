package daemon

import (
	_ "embed"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// Wukong （悟空） bundles a `wukong-cli` inside its desktop app whose print mode
// speaks AG-UI stream-json — not a protocol family the daemon drives natively.
// Instead of teaching pkg/agent a new wire format, the daemon materializes a
// small Python bridge (wukong_qwen_bridge.py, embedded below) into
// ~/.multica/shims/wukong-qwen-bridge and registers THAT as the wukong
// runtime's executable. The bridge translates AG-UI into the qwen family's
// JSONL contract, so task execution, usage accounting, and resume-rejection
// handling all reuse the existing qwen backend unchanged.
//
// Why a managed shim instead of probing the raw CLI: registering
// wukong-cli directly would advertise a runtime whose event stream no backend
// can parse; every task would fail after being claimed. The shim is also what
// makes `--resume` fail closed — wukong print mode has no session resume, and
// a silent fresh run would lose continuity without telling anyone.
//
// The shim depends on python3 at launch time (macOS ships /usr/bin/python3 via
// the Command Line Tools). If python3 is missing the registration-time version
// probe (`shim --version`) fails and the runtime simply stays unregistered —
// the same fail-closed outcome as any unrunnable CLI.

//go:embed wukong_qwen_bridge.py
var wukongBridgeSource string

// wukongBridgeCLIDefaultPlaceholder in the embedded source is replaced with
// the wukong-cli path detected on this machine, so the shim finds the CLI even
// when it lives outside the default app-bundle location (e.g. a
// MULTICA_WUKONG_PATH override).
const wukongBridgeCLIDefaultPlaceholder = "__WUKONG_CLI_DEFAULT__"

// wukongCLIProbePaths are the app-bundle candidates for the real wukong-cli,
// in preference order. macOS-only today; other platforms can point
// MULTICA_WUKONG_PATH at their install.
var wukongCLIProbePaths = []string{
	"/Applications/Wukong.app/Contents/MacOS/wukong-cli",
}

// wukongBridgeShimPath is where the daemon-managed bridge is materialized.
// Shared across daemon profiles: the shim content is profile-independent.
func wukongBridgeShimPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".multica", "shims", "wukong-qwen-bridge"), nil
}

// ensureWukongBridgeShim publishes the bridge shim for the given real
// wukong-cli path and returns the shim path. Writes are content-compared and
// atomic (temp file + rename), so the periodic re-probe is a no-op when the
// shim is already current and a reader never observes a half-written file.
func ensureWukongBridgeShim(realCLIPath string) (string, error) {
	shimPath, err := wukongBridgeShimPath()
	if err != nil {
		return "", err
	}
	// The path is baked into a Python string literal in the shim. It comes
	// from the daemon's own probe list or a local operator's env override —
	// never from the network — but reject anything that could break out of
	// the literal rather than publish a corrupted (or hostile) shim.
	if strings.ContainsAny(realCLIPath, "\"'\\\r\n") {
		return "", fmt.Errorf("wukong-cli path %q contains characters unsafe to embed in the bridge shim", realCLIPath)
	}
	content := strings.ReplaceAll(wukongBridgeSource, wukongBridgeCLIDefaultPlaceholder, realCLIPath)
	if existing, err := os.ReadFile(shimPath); err == nil && string(existing) == content {
		return shimPath, nil
	}
	if err := os.MkdirAll(filepath.Dir(shimPath), 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(filepath.Dir(shimPath), ".wukong-qwen-bridge-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return "", err
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		os.Remove(tmpName)
		return "", err
	}
	if err := os.Rename(tmpName, shimPath); err != nil {
		os.Remove(tmpName)
		return "", err
	}
	return shimPath, nil
}

// probeWukongRuntime resolves the real wukong-cli (MULTICA_WUKONG_PATH
// override first, then the app-bundle candidates), materializes the bridge
// shim against it, and returns the runtime entry pointing at the SHIM. An
// explicit but invalid MULTICA_WUKONG_PATH is a hard miss — it never falls
// back to a bundle candidate, matching the probe() override contract.
func probeWukongRuntime() (AgentEntry, bool) {
	model := strings.TrimSpace(os.Getenv("MULTICA_WUKONG_MODEL"))
	realCLI := strings.TrimSpace(os.Getenv("MULTICA_WUKONG_PATH"))
	if realCLI != "" {
		resolved, err := resolveAgentExecutablePath(realCLI)
		if err != nil {
			slog.Debug("wukong: MULTICA_WUKONG_PATH does not resolve; skipping runtime", "path", realCLI, "error", err)
			return AgentEntry{}, false
		}
		realCLI = resolved
	} else {
		for _, candidate := range wukongCLIProbePaths {
			if isExecutableFile(candidate) {
				realCLI = candidate
				break
			}
		}
		if realCLI == "" {
			return AgentEntry{}, false
		}
	}
	shim, err := ensureWukongBridgeShim(realCLI)
	if err != nil {
		slog.Warn("wukong: failed to materialize qwen bridge shim; skipping runtime", "error", err)
		return AgentEntry{}, false
	}
	// Command stays empty: Path is a daemon-managed absolute artifact, not a
	// PATH command the self-heal resolver could meaningfully re-resolve. If the
	// shim vanishes, the next probe round re-materializes it.
	return AgentEntry{Path: shim, Model: model}, true
}
