package execenv

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPromoteHermesProviderSecretsOverridesInheritedOpenAIKey(t *testing.T) {
	t.Parallel()

	home := t.TempDir()
	mustWrite(t, filepath.Join(home, ".env"), "DOGFOODING_API_KEY=cli-login-key\n")
	mustWrite(t, filepath.Join(home, "config.yaml"), `
model:
  provider: dogfooding
providers:
  dogfooding:
    name: dogfooding
    api: https://idealab.example.test/v1
    key_env: DOGFOODING_API_KEY
`)

	agentEnv := map[string]string{}
	PromoteHermesProviderSecrets(agentEnv, nil, home, nil)

	if got := agentEnv["DOGFOODING_API_KEY"]; got != "cli-login-key" {
		t.Errorf("DOGFOODING_API_KEY = %q, want CLI login key", got)
	}
	if got := agentEnv["OPENAI_API_KEY"]; got != "cli-login-key" {
		t.Errorf("OPENAI_API_KEY = %q, want CLI login key so provider=custom does not send a shell/Codex key", got)
	}
	if got := agentEnv["OPENAI_BASE_URL"]; got != "https://idealab.example.test/v1" {
		t.Errorf("OPENAI_BASE_URL = %q, want the named provider api", got)
	}
}

func TestPromoteHermesProviderSecretsPreservesCustomEnv(t *testing.T) {
	t.Parallel()

	home := t.TempDir()
	mustWrite(t, filepath.Join(home, ".env"), "DOGFOODING_API_KEY=cli-login-key\n")
	mustWrite(t, filepath.Join(home, "config.yaml"), `
model:
  provider: dogfooding
providers:
  dogfooding:
    api: https://idealab.example.test/v1
    key_env: DOGFOODING_API_KEY
`)

	agentEnv := map[string]string{
		"OPENAI_API_KEY":  "from-ui",
		"OPENAI_BASE_URL": "https://ui.example.test/v1",
	}
	customEnv := map[string]string{
		"OPENAI_API_KEY":  "from-ui",
		"OPENAI_BASE_URL": "https://ui.example.test/v1",
	}
	PromoteHermesProviderSecrets(agentEnv, customEnv, home, nil)

	if agentEnv["OPENAI_API_KEY"] != "from-ui" {
		t.Errorf("custom_env OPENAI_API_KEY was overwritten: %q", agentEnv["OPENAI_API_KEY"])
	}
	if agentEnv["OPENAI_BASE_URL"] != "https://ui.example.test/v1" {
		t.Errorf("custom_env OPENAI_BASE_URL was overwritten: %q", agentEnv["OPENAI_BASE_URL"])
	}
	if agentEnv["DOGFOODING_API_KEY"] != "cli-login-key" {
		t.Errorf("key_env should still be injected: %q", agentEnv["DOGFOODING_API_KEY"])
	}
}

func TestPromoteHermesProviderSecretsNoopWithoutHome(t *testing.T) {
	t.Parallel()
	agentEnv := map[string]string{"KEEP": "1"}
	PromoteHermesProviderSecrets(agentEnv, nil, "", nil)
	if len(agentEnv) != 1 || agentEnv["KEEP"] != "1" {
		t.Errorf("empty home must be a no-op, got %#v", agentEnv)
	}
}

func TestDotenvLineValue(t *testing.T) {
	t.Parallel()
	tests := []struct {
		in, want string
	}{
		{`DOGFOODING_API_KEY=abc`, "abc"},
		{`export DOGFOODING_API_KEY='abc'`, "abc"},
		{`DOGFOODING_API_KEY="abc"`, "abc"},
		{`  FOO = bar  `, "bar"},
	}
	for _, tc := range tests {
		if got := dotenvLineValue(tc.in); got != tc.want {
			t.Errorf("dotenvLineValue(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestPromoteHermesProviderSecretsMissingFiles(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	agentEnv := map[string]string{}
	PromoteHermesProviderSecrets(agentEnv, nil, home, nil)
	if len(agentEnv) != 0 {
		t.Errorf("missing .env must be a no-op, got %#v", agentEnv)
	}
	if err := os.WriteFile(filepath.Join(home, ".env"), []byte("FOO=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	PromoteHermesProviderSecrets(agentEnv, nil, home, nil)
	if len(agentEnv) != 0 {
		t.Errorf("missing config.yaml must not invent keys, got %#v", agentEnv)
	}
}
