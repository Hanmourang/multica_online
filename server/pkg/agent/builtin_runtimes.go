package agent

import (
	"context"
	"fmt"
)

// BuiltinRuntime describes a built-in runtime identity that the daemon probes
// and registers automatically — independent of the custom runtime profile
// protocol_family whitelist. Multiple runtime identities can share one
// protocol family (e.g. both "pi" and "omp" use the "pi" protocol backend).
//
// The descriptor is the single declaration site for a runtime identity:
// agents_probe.go, config.go, daemon.go display-name overrides, execenv
// skill/config paths, local_skills.go, ListModels, and the frontend display
// maps all derive from this. Adding a new compatible fork of an existing
// runtime is a descriptor entry, not a cross-stack change.
type BuiltinRuntime struct {
	// ID is the provider key the daemon registers under (e.g. "omp").
	// It is NOT a protocol_family — it does not appear in SupportedTypes or
	// the runtime_profile.protocol_family CHECK constraint.
	ID string

	// ProtocolFamily is the execution backend this runtime dispatches to.
	// It MUST be in SupportedTypes. NewRuntime builds that family's backend
	// via New(), then applies this descriptor's ID-specific defaults
	// (executable, label) to it.
	ProtocolFamily string

	// DefaultCommand is the bare CLI name the probe looks up on PATH
	// when MULTICA_<ID>_PATH is not set (e.g. "omp"). Empty means the
	// runtime has no PATH-resolvable command of its own: the generic probe
	// loop skips it and a daemon-side dedicated probe registers it instead
	// (wukong, whose registered executable is a daemon-managed bridge shim).
	DefaultCommand string

	// ProbePaths, when non-empty, pins discovery to these absolute candidate
	// paths, checked in order after the MULTICA_<ID>_PATH env override. PATH
	// and login-shell lookups are SKIPPED entirely. This is the mechanism for
	// app-bundle CLIs whose binary name collides with a different product's
	// public CLI: QoderWork ships a `qodercli`, so a PATH lookup for
	// "qodercli" would silently register the public Qoder install under the
	// qoderwork identity — same argv contract, different account and quota.
	ProbePaths []string

	// EnvPrefix is the MULTICA_ prefix for *_PATH and *_MODEL env overrides
	// (e.g. "MULTICA_OMP" → MULTICA_OMP_PATH / MULTICA_OMP_MODEL).
	EnvPrefix string

	// DisplayName is the human-facing runtime name. The daemon and frontend
	// both use this so they never drift apart.
	DisplayName string

	// SkillsDir is the project-level skills directory relative to the
	// workdir (e.g. ".omp/skills").
	SkillsDir string

	// UserSkillsDir is the user-level skills directory relative to $HOME
	// (e.g. ".omp/agent/skills").
	UserSkillsDir string

	// LaunchHeader is the user-visible launch skeleton shown in the UI
	// (e.g. "omp (json mode)").
	LaunchHeader string

	// DefaultExecutable is the binary name the backend falls back to when
	// cfg.ExecutablePath is empty (passed to piBackend.defaultExecutable).
	DefaultExecutable string

	// ProviderLabel is the label used in log/error messages (passed to
	// piBackend.providerLabel).
	ProviderLabel string

	// ModelDiscovery is the strategy for discovering available models.
	// When set, it replaces the protocol family's discovery entirely — omp
	// uses `omp models --json`, a different command and output shape from
	// pi's `--list-models`. When nil, ListModels returns an empty catalog
	// rather than falling back to the family's command: running a
	// semantically incompatible one (omp exits non-zero on `--list-models`)
	// is worse than degrading to manual entry.
	ModelDiscovery ModelDiscoveryFunc
}

// ModelDiscoveryFunc discovers available models for a runtime identity.
// It receives the context and the resolved command — executable plus the
// runtime's launch prefix — and returns a model catalog. When the binary is
// missing or too old, it returns an empty slice (ListModels swallows the
// error and degrades to manual entry).
type ModelDiscoveryFunc func(ctx context.Context, runtimeCmd Command) ([]Model, error)

// BuiltinRuntimes is the registry of built-in runtime identities that are
// NOT in SupportedTypes (they are protocol-family derivatives, not families
// themselves). The daemon probes each one independently and dispatches it
// to its protocol family's backend.
//
// A runtime identity appears here when it needs its own probe/display/skills
// but reuses an existing backend's protocol. The first entry is omp (oh-my-pi):
// a separate CLI that speaks the pi JSON event protocol. qoderwork and qwenwork
// are the app-bundle editions of the Qoder CLI family; wukong rides the qwen
// protocol family through a daemon-managed bridge shim (its CLI speaks AG-UI).
var BuiltinRuntimes = []BuiltinRuntime{
	{
		ID:                "omp",
		ProtocolFamily:    "pi",
		DefaultCommand:    "omp",
		EnvPrefix:         "MULTICA_OMP",
		DisplayName:       "Oh-My-Pi",
		SkillsDir:         ".omp/skills",
		UserSkillsDir:     ".omp/agent/skills",
		LaunchHeader:      "omp (json mode)",
		DefaultExecutable: "omp",
		ProviderLabel:     "omp",
		ModelDiscovery:    discoverOmpModels,
	},
	{
		// QoderWork （企业版） bundles its own qodercli inside the desktop app
		// instead of installing onto PATH. ProbePaths pins detection to the
		// bundle: the binary is named `qodercli`, so a PATH lookup would
		// register the public Qoder install under this identity and route
		// enterprise tasks to the wrong account and quota.
		ID:             "qoderwork",
		ProtocolFamily: "qoder",
		EnvPrefix:      "MULTICA_QODERWORK",
		DisplayName:    "QoderWork",
		SkillsDir:      ".qoder/skills",
		// QoderWork keeps its own user-level config root (~/.qoderwork),
		// separate from the public CLI's ~/.qoder.
		UserSkillsDir:     ".qoderwork/skills",
		LaunchHeader:      "qodercli --acp",
		DefaultExecutable: "qodercli",
		ProviderLabel:     "QoderWork",
		ProbePaths:        []string{"/Applications/QoderWork.app/Contents/Resources/bin/qodercli"},
		ModelDiscovery: func(ctx context.Context, runtimeCmd Command) ([]Model, error) {
			return discoverQoderModels(ctx, runtimeCmd, "qodercli")
		},
	},
	{
		// QwenWork CN （千问办公） bundles its own qoderclicn inside the desktop
		// app. Bundle-pinned for the same reason as qoderwork: the binary is
		// named `qoderclicn`, identical to the public CN edition on PATH.
		ID:             "qwenwork",
		ProtocolFamily: "qoderclicn",
		EnvPrefix:      "MULTICA_QWENWORK",
		DisplayName:    "QwenWork CN",
		SkillsDir:      ".qoder/skills",
		// The bundled binary identifies as "Qoder CLI CN" and shares the CN
		// edition's ~/.qoder-cn config root convention.
		UserSkillsDir:     ".qoder-cn/skills",
		LaunchHeader:      "qoderclicn --acp",
		DefaultExecutable: "qoderclicn",
		ProviderLabel:     "QwenWork CN",
		ProbePaths:        []string{"/Applications/QwenWorkCN.app/Contents/Resources/bin/qoderclicn"},
		ModelDiscovery: func(ctx context.Context, runtimeCmd Command) ([]Model, error) {
			return discoverQoderModels(ctx, runtimeCmd, "qoderclicn")
		},
	},
	{
		// Wukong （悟空） speaks AG-UI stream-json, not any protocol family the
		// daemon drives natively. The daemon bridges it into the qwen family
		// through a managed shim (server/internal/daemon/wukong_bridge.go) and
		// registers the SHIM's path — so probing is daemon-managed and this
		// descriptor deliberately has no DefaultCommand/ProbePaths. The shim
		// drops --resume (wukong print mode cannot resume) with an explicit
		// rejection error so the daemon retries fresh instead of silently
		// losing continuity, and drops --mcp-config (no MCP injection).
		ID:             "wukong",
		ProtocolFamily: "qwen",
		EnvPrefix:      "MULTICA_WUKONG",
		DisplayName:    "Wukong （悟空）",
		// Wukong has no documented on-disk skills convention (its skills live
		// behind the gateway). Skill content reaches the agent inline via the
		// runtime brief (providerNeedsInlineSystemPrompt); the isolated dir
		// keeps the execenv sidecar layout uniform and cleanable.
		SkillsDir:     ".wukong/skills",
		UserSkillsDir: ".wukong/skills",
		LaunchHeader:  "wukong-cli -p (stream-json bridge)",
		// The registered executable is always the daemon-managed shim; this
		// fallback only fires when cfg.ExecutablePath is empty and exists so a
		// misconfigured launch fails closed ("not found") instead of execing
		// a bare `qwen` under the wukong identity.
		DefaultExecutable: "wukong-cli",
		ProviderLabel:     "wukong",
		// No model discovery: wukong has no catalog command, so the UI falls
		// back to manual model entry (forwarded to wukong-cli via --model).
	},
}

// BuiltinRuntimeByID returns the descriptor for the given runtime identity,
// or false if no such built-in runtime exists.
func BuiltinRuntimeByID(id string) (BuiltinRuntime, bool) {
	for _, r := range BuiltinRuntimes {
		if r.ID == id {
			return r, true
		}
	}
	return BuiltinRuntime{}, false
}

// IsBuiltinRuntime reports whether id is a registered built-in runtime
// identity (as opposed to a protocol family in SupportedTypes).
func IsBuiltinRuntime(id string) bool {
	_, ok := BuiltinRuntimeByID(id)
	return ok
}

// BuiltinRuntimeCommands returns the default CLI command names for all
// built-in runtimes, for the daemon's defaultAgentCommandNames list.
// Runtimes with a daemon-managed probe (empty DefaultCommand, e.g. wukong)
// contribute nothing — there is no bare command name to resolve.
func BuiltinRuntimeCommands() []string {
	cmds := make([]string, 0, len(BuiltinRuntimes))
	for _, r := range BuiltinRuntimes {
		if r.DefaultCommand == "" {
			continue
		}
		cmds = append(cmds, r.DefaultCommand)
	}
	return cmds
}

// backendOverrideApplicator is the interface that lets a descriptor apply
// per-runtime overrides (executable, label) to the backend its protocol family
// returned. A family whose backend does not implement it cannot host a runtime
// identity at all: NewRuntime fails closed rather than handing back a backend
// with the overrides silently dropped.
type backendOverrideApplicator interface {
	applyBuiltinRuntimeOverrides(desc BuiltinRuntime)
}

// piBackend already implements this via its defaultExecutable and
// providerLabel fields. The method is defined here (not in pi.go) to keep
// the descriptor→backend contract in one file.
func (b *piBackend) applyBuiltinRuntimeOverrides(desc BuiltinRuntime) {
	b.defaultExecutable = desc.DefaultExecutable
	b.providerLabel = desc.ProviderLabel
}

// qoderBackend hosts the qoderwork and qwenwork identities (app-bundle
// editions of the two Qoder CLI binaries).
func (b *qoderBackend) applyBuiltinRuntimeOverrides(desc BuiltinRuntime) {
	if desc.DefaultExecutable != "" {
		b.defaultExecutable = desc.DefaultExecutable
	}
	if desc.ProviderLabel != "" {
		b.providerLabel = desc.ProviderLabel
	}
}

// qwenBackend hosts the wukong identity (bridged through the daemon-managed
// AG-UI → qwen stream-json shim).
func (b *qwenBackend) applyBuiltinRuntimeOverrides(desc BuiltinRuntime) {
	if desc.DefaultExecutable != "" {
		b.defaultExecutable = desc.DefaultExecutable
	}
	if desc.ProviderLabel != "" {
		b.providerLabel = desc.ProviderLabel
	}
}

// ResolveBackend is the single production entry point the daemon uses to
// construct a backend from a provider key. It routes built-in runtime
// identities (e.g. "omp") through NewRuntime, and protocol families (e.g.
// "pi", "claude") through New. This keeps both factories meaning exactly one
// thing: New() is family-only, NewRuntime() is runtime-identity-only, and
// the daemon never has to know which is which.
func ResolveBackend(provider string, cfg Config) (Backend, error) {
	if IsBuiltinRuntime(provider) {
		return NewRuntime(provider, cfg)
	}
	return New(provider, cfg)
}

// NewRuntime creates a Backend for a built-in runtime identity (e.g. "omp").
// It builds the descriptor's protocol family backend via New(), then applies
// the per-runtime overrides through the backendOverrideApplicator interface.
// This is the production entry point for runtime identities; New() is
// family-only and rejects runtime ids.
//
// Fails closed: if the protocol family backend does not implement
// backendOverrideApplicator, the descriptor's overrides cannot be applied and
// the runtime would launch under the wrong executable and label — so
// NewRuntime returns an error rather than returning an unmodified backend.
func NewRuntime(runtimeID string, cfg Config) (Backend, error) {
	desc, ok := BuiltinRuntimeByID(runtimeID)
	if !ok {
		return nil, fmt.Errorf("unknown runtime identity: %q", runtimeID)
	}
	cfg.provider = runtimeID
	backend, err := New(desc.ProtocolFamily, cfg)
	if err != nil {
		return nil, fmt.Errorf("runtime %q (family %q): %w", runtimeID, desc.ProtocolFamily, err)
	}
	applicator, ok := backend.(backendOverrideApplicator)
	if !ok {
		return nil, fmt.Errorf("runtime %q: protocol family %q backend %T does not support runtime overrides", runtimeID, desc.ProtocolFamily, backend)
	}
	applicator.applyBuiltinRuntimeOverrides(desc)
	return backend, nil
}
