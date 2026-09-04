package agent

import (
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
)

// TestBuiltinRuntimeRegistryIsConsistent validates the descriptor registry's
// structural invariants — the contracts agents_probe.go, execenv, ListModels,
// and the frontend display maps all rely on when they derive behaviour from
// the registry without per-runtime code.
func TestBuiltinRuntimeRegistryIsConsistent(t *testing.T) {
	t.Parallel()
	seen := make(map[string]bool, len(BuiltinRuntimes))
	for _, desc := range BuiltinRuntimes {
		if desc.ID == "" {
			t.Error("descriptor with empty ID")
		}
		if seen[desc.ID] {
			t.Errorf("duplicate runtime identity %q", desc.ID)
		}
		seen[desc.ID] = true

		// An identity must not collide with a protocol family, and its
		// family must be real — NewRuntime dispatches through New(family).
		if IsSupportedType(desc.ID) {
			t.Errorf("%s: runtime identity must not be a protocol family (SupportedTypes)", desc.ID)
		}
		if !IsSupportedType(desc.ProtocolFamily) {
			t.Errorf("%s: ProtocolFamily %q is not in SupportedTypes", desc.ID, desc.ProtocolFamily)
		}

		if !strings.HasPrefix(desc.EnvPrefix, "MULTICA_") {
			t.Errorf("%s: EnvPrefix %q must start with MULTICA_", desc.ID, desc.EnvPrefix)
		}
		if desc.DisplayName == "" {
			t.Errorf("%s: DisplayName must not be empty (daemon/frontend display derives from it)", desc.ID)
		}
		if desc.SkillsDir == "" || desc.UserSkillsDir == "" {
			t.Errorf("%s: SkillsDir/UserSkillsDir must not be empty (execenv derives both)", desc.ID)
		}
		if desc.LaunchHeader == "" {
			t.Errorf("%s: LaunchHeader must not be empty", desc.ID)
		}

		// Bundle-pinned candidates are absolute by contract: the probe loop
		// hands them straight to resolveAgentExecutablePath and never
		// interprets them as PATH command names.
		for _, p := range desc.ProbePaths {
			if !filepath.IsAbs(p) {
				t.Errorf("%s: ProbePaths entry %q is not an absolute path", desc.ID, p)
			}
		}

		// Exactly one probe strategy per descriptor: a bare PATH command
		// (generic loop), absolute bundle candidates (bundle-pinned loop),
		// or neither (a daemon-managed dedicated probe, e.g. wukong).
		// DefaultCommand and ProbePaths together would be contradictory.
		if desc.DefaultCommand != "" && len(desc.ProbePaths) > 0 {
			t.Errorf("%s: DefaultCommand and ProbePaths are mutually exclusive probe strategies", desc.ID)
		}
	}
}

// TestBuiltinRuntimeCommandsSkipsDaemonManaged pins the contract that
// runtimes with no PATH-resolvable command of their own (wukong — its
// registered executable is a daemon-managed shim) contribute nothing to the
// login-shell resolution list.
func TestBuiltinRuntimeCommandsSkipsDaemonManaged(t *testing.T) {
	t.Parallel()
	cmds := BuiltinRuntimeCommands()
	for _, c := range cmds {
		if c == "" {
			t.Fatalf("BuiltinRuntimeCommands returned an empty command name: %v", cmds)
		}
		if c == "wukong" {
			t.Errorf("wukong must not appear in BuiltinRuntimeCommands (daemon-managed probe): %v", cmds)
		}
	}
	found := false
	for _, c := range cmds {
		if c == "omp" {
			found = true
		}
	}
	if !found {
		t.Errorf("BuiltinRuntimeCommands lost the omp command: %v", cmds)
	}
}

// TestNewRuntimeAppBundleOverrides verifies that the QoderWork and QwenWork CN
// identities dispatch to the qoder-family backend with their own executable
// name and user-facing label applied — the fail-closed override contract that
// keeps a bundle identity from launching (or erroring as) the public CLI.
func TestNewRuntimeAppBundleOverrides(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		id             string
		wantExecutable string
		wantLabel      string
	}{
		{"qoderwork", "qodercli", "QoderWork"},
		{"qwenwork", "qoderclicn", "QwenWork CN"},
	} {
		t.Run(tc.id, func(t *testing.T) {
			t.Parallel()
			b, err := NewRuntime(tc.id, Config{Logger: slog.Default()})
			if err != nil {
				t.Fatalf("NewRuntime(%s): %v", tc.id, err)
			}
			qb, ok := b.(*qoderBackend)
			if !ok {
				t.Fatalf("NewRuntime(%s) = %T, want *qoderBackend", tc.id, b)
			}
			if qb.defaultExecutable != tc.wantExecutable {
				t.Errorf("defaultExecutable = %q, want %q", qb.defaultExecutable, tc.wantExecutable)
			}
			if qb.providerLabel != tc.wantLabel {
				t.Errorf("providerLabel = %q, want %q", qb.providerLabel, tc.wantLabel)
			}
		})
	}
}

// TestNewRuntimeWukongOverrides verifies the wukong identity lands on the
// qwen backend (the protocol family its bridge shim speaks) with the
// fail-closed fallback executable and its own label.
func TestNewRuntimeWukongOverrides(t *testing.T) {
	t.Parallel()
	b, err := NewRuntime("wukong", Config{Logger: slog.Default()})
	if err != nil {
		t.Fatalf("NewRuntime(wukong): %v", err)
	}
	qb, ok := b.(*qwenBackend)
	if !ok {
		t.Fatalf("NewRuntime(wukong) = %T, want *qwenBackend", b)
	}
	if qb.executable() != "wukong-cli" {
		t.Errorf("executable() = %q, want %q", qb.executable(), "wukong-cli")
	}
	if qb.label() != "wukong" {
		t.Errorf("label() = %q, want %q", qb.label(), "wukong")
	}
}

// TestWukongHasNoModelDiscovery pins the deliberate absence of a model
// catalog command: ListModels must degrade to an empty catalog (manual entry
// in the UI) rather than run a family discovery command wukong-cli does not
// have.
func TestWukongHasNoModelDiscovery(t *testing.T) {
	t.Parallel()
	desc, ok := BuiltinRuntimeByID("wukong")
	if !ok {
		t.Fatal("wukong descriptor missing")
	}
	if desc.ModelDiscovery != nil {
		t.Error("wukong ModelDiscovery must be nil — wukong-cli has no catalog command")
	}
}

// TestQwenBackendLabelFallbacks locks the qwen family's own defaults: with no
// descriptor overrides the backend keeps resolving and reporting as "qwen",
// so hosting the wukong identity cannot change plain qwen behaviour.
func TestQwenBackendLabelFallbacks(t *testing.T) {
	t.Parallel()
	b, err := New("qwen", Config{Logger: slog.Default()})
	if err != nil {
		t.Fatalf("New(qwen): %v", err)
	}
	qb, ok := b.(*qwenBackend)
	if !ok {
		t.Fatalf("New(qwen) = %T, want *qwenBackend", b)
	}
	if qb.executable() != "qwen" {
		t.Errorf("executable() = %q, want %q", qb.executable(), "qwen")
	}
	if qb.label() != "qwen" {
		t.Errorf("label() = %q, want %q", qb.label(), "qwen")
	}
}

// TestRuntimeIdentityLabelsNotFoundErrors verifies that a missing executable
// is reported under the runtime identity's label, not the hosting protocol
// family's name — a wukong failure must say "wukong", a QoderWork failure
// must say "QoderWork".
func TestRuntimeIdentityLabelsNotFoundErrors(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		id        string
		wantLabel string
	}{
		{"wukong", "wukong"},
		{"qoderwork", "QoderWork"},
		{"qwenwork", "QwenWork CN"},
	} {
		t.Run(tc.id, func(t *testing.T) {
			t.Parallel()
			backend, err := NewRuntime(tc.id, Config{ExecutablePath: "/nonexistent/" + tc.id + "-binary", Logger: slog.Default()})
			if err != nil {
				t.Fatalf("NewRuntime(%s): %v", tc.id, err)
			}
			_, err = backend.Execute(t.Context(), "prompt", ExecOptions{})
			if err == nil {
				t.Fatal("expected error for nonexistent binary")
			}
			if !strings.Contains(err.Error(), tc.wantLabel+" executable not found") {
				t.Fatalf("error = %q, want it to contain %q", err.Error(), tc.wantLabel+" executable not found")
			}
		})
	}
}
