package execenv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func requirePluginsDisabled(t *testing.T, parsed map[string]any) {
	t.Helper()
	features, ok := parsed["features"].(map[string]any)
	if !ok {
		t.Fatalf("expected `features` table in parsed config, got: %#v", parsed["features"])
	}
	v, ok := features["plugins"].(bool)
	if !ok {
		t.Fatalf("expected features.plugins to be a bool, got: %#v", features["plugins"])
	}
	if v {
		t.Errorf("expected features.plugins = false, got true")
	}
}

func TestEnsureCodexPluginsConfigEmptyFile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.toml")

	if err := ensureCodexPluginsConfig(configPath, nil); err != nil {
		t.Fatalf("ensureCodexPluginsConfig failed: %v", err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read result: %v", err)
	}
	got := string(data)
	if !strings.Contains(got, "features.plugins = false") {
		t.Errorf("expected managed block to set features.plugins = false at root, got:\n%s", got)
	}
	if !strings.Contains(got, multicaPluginsBeginMarker) {
		t.Errorf("expected begin marker, got:\n%s", got)
	}
	requirePluginsDisabled(t, parseTOML(t, got))
}

func TestEnsureCodexPluginsConfigDottedKey(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.toml")
	original := `model = "o3"
features.plugins = true

[profiles.default]
model = "o3"
`
	if err := os.WriteFile(configPath, []byte(original), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	if err := ensureCodexPluginsConfig(configPath, nil); err != nil {
		t.Fatalf("ensureCodexPluginsConfig failed: %v", err)
	}

	data, _ := os.ReadFile(configPath)
	got := string(data)
	if strings.Contains(got, "features.plugins = true") {
		t.Errorf("expected user features.plugins = true to be stripped, got:\n%s", got)
	}
	if !strings.Contains(got, "features.plugins = false") {
		t.Errorf("expected managed features.plugins = false at root, got:\n%s", got)
	}
	if !strings.Contains(got, `[profiles.default]`) || !strings.Contains(got, `model = "o3"`) {
		t.Errorf("expected unrelated content preserved, got:\n%s", got)
	}
	requirePluginsDisabled(t, parseTOML(t, got))
}

func TestEnsureCodexPluginsConfigFeaturesTable(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.toml")
	original := `[features]
experimental_foo = true
plugins = true
`
	if err := os.WriteFile(configPath, []byte(original), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	if err := ensureCodexPluginsConfig(configPath, nil); err != nil {
		t.Fatalf("ensureCodexPluginsConfig failed: %v", err)
	}

	data, _ := os.ReadFile(configPath)
	got := string(data)
	if strings.Contains(got, "plugins = true") {
		t.Errorf("expected user plugins = true stripped, got:\n%s", got)
	}
	if !strings.Contains(got, "plugins = false") {
		t.Errorf("expected in-table plugins = false, got:\n%s", got)
	}
	// Root dotted form would redefine `[features]` and Codex's toml-rs
	// would refuse to load the file.
	if strings.Contains(got, "features.plugins = false") {
		t.Errorf("must not write dotted-key form next to [features], got:\n%s", got)
	}
	parsed := parseTOML(t, got)
	requirePluginsDisabled(t, parsed)
	features := parsed["features"].(map[string]any)
	if features["experimental_foo"] != true {
		t.Errorf("expected experimental_foo preserved, got: %#v", features["experimental_foo"])
	}
}

func TestEnsureCodexPluginsConfigOptIn(t *testing.T) {
	t.Setenv(MulticaCodexPluginsEnv, "1")

	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.toml")
	original := "model = \"o3\"\n"
	if err := os.WriteFile(configPath, []byte(original), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	if err := ensureCodexPluginsConfig(configPath, nil); err != nil {
		t.Fatalf("ensureCodexPluginsConfig failed: %v", err)
	}

	data, _ := os.ReadFile(configPath)
	got := string(data)
	if got != original {
		t.Errorf("opt-in must leave config untouched, got:\n%s", got)
	}
}

func TestEnsureCodexPluginsConfigIdempotent(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.toml")
	if err := ensureCodexPluginsConfig(configPath, nil); err != nil {
		t.Fatalf("first write: %v", err)
	}
	first, _ := os.ReadFile(configPath)
	if err := ensureCodexPluginsConfig(configPath, nil); err != nil {
		t.Fatalf("second write: %v", err)
	}
	second, _ := os.ReadFile(configPath)
	if string(first) != string(second) {
		t.Errorf("expected idempotent rewrite\n--- first ---\n%s\n--- second ---\n%s", first, second)
	}
}

func TestEnsureCodexPluginsConfigCoexistsWithMultiAgent(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.toml")
	original := `model = "o3"
features.plugins = true
features.multi_agent = true
`
	if err := os.WriteFile(configPath, []byte(original), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	if err := ensureCodexMultiAgentConfig(configPath, nil); err != nil {
		t.Fatalf("ensureCodexMultiAgentConfig failed: %v", err)
	}
	if err := ensureCodexPluginsConfig(configPath, nil); err != nil {
		t.Fatalf("ensureCodexPluginsConfig failed: %v", err)
	}

	data, _ := os.ReadFile(configPath)
	got := string(data)
	parsed := parseTOML(t, got)
	requireMultiAgentDisabled(t, parsed)
	requirePluginsDisabled(t, parsed)

	if err := ensureCodexMultiAgentConfig(configPath, nil); err != nil {
		t.Fatalf("multi-agent rerun: %v", err)
	}
	if err := ensureCodexPluginsConfig(configPath, nil); err != nil {
		t.Fatalf("plugins rerun: %v", err)
	}
	dataAfter, _ := os.ReadFile(configPath)
	if string(dataAfter) != got {
		t.Errorf("expected idempotent combined rewrite\n--- first ---\n%s\n--- second ---\n%s", got, dataAfter)
	}
}
