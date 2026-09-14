package execenv

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// PromoteHermesProviderSecrets copies CLI-login credentials from the
// Hermes home `.env` into the child environment, and points the
// OpenAI-compatible fallback (`provider=custom`) at the same key.
//
// Hermes config for a custom gateway typically looks like:
//
//	model.provider: dogfooding
//	providers.dogfooding.key_env: DOGFOODING_API_KEY
//
// Interactive `hermes` loads `<HERMES_HOME>/.env` and that works. Under
// Multica the child still inherits the daemon process environment, which
// on a developer machine often already has `OPENAI_API_KEY` (zshrc /
// Codex / DashScope). Hermes then remaps the named custom provider to
// `provider=custom` and sends that inherited key to the gateway. IdeaLab
// answers `无效的api key` even though the CLI login key in `.env` is
// valid. This function makes the child see the CLI key first.
//
// Keys the user set on the agent custom_env are left untouched — those
// are an explicit Multica override. The user's global `~/.hermes/.env`
// is only read, never written.
func PromoteHermesProviderSecrets(agentEnv, customEnv map[string]string, hermesHome string, logger *slog.Logger) {
	if agentEnv == nil || strings.TrimSpace(hermesHome) == "" {
		return
	}

	dotenv, err := readHermesDotenv(filepath.Join(hermesHome, ".env"))
	if err != nil {
		if logger != nil && !os.IsNotExist(err) {
			logger.Warn("execenv: hermes .env unreadable; CLI provider keys not promoted", "error", err)
		}
		return
	}
	if len(dotenv) == 0 {
		return
	}

	cfg, err := readHermesProviderFile(filepath.Join(hermesHome, "config.yaml"))
	if err != nil {
		if logger != nil && !os.IsNotExist(err) {
			logger.Warn("execenv: hermes config.yaml unreadable; CLI provider keys not promoted", "error", err)
		}
		return
	}

	protected := make(map[string]struct{}, len(customEnv))
	for k := range customEnv {
		if strings.TrimSpace(k) == "" {
			continue
		}
		protected[k] = struct{}{}
	}

	setUnlessCustom := func(key, value string) {
		if value == "" {
			return
		}
		if _, skip := protected[key]; skip {
			return
		}
		agentEnv[key] = value
	}

	var defaultKey, defaultAPI string
	for name, provider := range cfg.Providers {
		if provider.KeyEnv != "" {
			if v := dotenv[provider.KeyEnv]; v != "" {
				setUnlessCustom(provider.KeyEnv, v)
				if name == cfg.Model.Provider || provider.Name == cfg.Model.Provider {
					defaultKey = v
					defaultAPI = provider.API
				}
			}
		}
		if defaultKey == "" && provider.APIKey != "" && (name == cfg.Model.Provider || provider.Name == cfg.Model.Provider) {
			defaultKey = provider.APIKey
			defaultAPI = provider.API
		}
	}

	if defaultKey != "" {
		setUnlessCustom("OPENAI_API_KEY", defaultKey)
	}
	if defaultAPI != "" {
		setUnlessCustom("OPENAI_BASE_URL", defaultAPI)
	}
}

type hermesProviderFile struct {
	Model struct {
		Provider string `yaml:"provider"`
	} `yaml:"model"`
	Providers map[string]hermesProviderEntry `yaml:"providers"`
}

type hermesProviderEntry struct {
	Name   string `yaml:"name"`
	API    string `yaml:"api"`
	KeyEnv string `yaml:"key_env"`
	APIKey string `yaml:"api_key"`
}

func readHermesProviderFile(path string) (hermesProviderFile, error) {
	var cfg hermesProviderFile
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func readHermesDotenv(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string)
	for _, line := range strings.Split(string(data), "\n") {
		key := dotenvLineKey(line)
		if key == "" {
			continue
		}
		out[key] = dotenvLineValue(line)
	}
	return out, nil
}

// dotenvLineValue returns the assignment value for a .env line, stripping
// a leading `export` and surrounding single/double quotes the way
// python-dotenv does for simple values.
func dotenvLineValue(line string) string {
	s := strings.TrimSpace(line)
	if rest := strings.TrimPrefix(s, "export"); rest != s && rest != "" &&
		(rest[0] == ' ' || rest[0] == '\t') {
		s = strings.TrimSpace(rest)
	}
	eq := strings.IndexByte(s, '=')
	if eq < 0 {
		return ""
	}
	v := strings.TrimSpace(s[eq+1:])
	if len(v) >= 2 {
		if (v[0] == '\'' && v[len(v)-1] == '\'') || (v[0] == '"' && v[len(v)-1] == '"') {
			return v[1 : len(v)-1]
		}
	}
	return v
}
