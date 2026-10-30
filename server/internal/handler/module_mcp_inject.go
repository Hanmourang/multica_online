package handler

import (
	"encoding/json"
	"log/slog"
	"os"
	"strings"
)

// moduleMCPServerName is the runtime name the 「项目 → 功能模块」facade is
// mounted under inside every agent's mcp_config. It is deliberately NOT
// "multica-assets": that one is the read-only asset facade, this one carries
// the module CRUD / spec / prototype / release tools. Two names, two
// capabilities, so an agent (or a person reading its config) can tell them
// apart and disable either one on its own.
const moduleMCPServerName = "multica-modules"

// moduleMCPAutoInjectDisabled reads the operator kill switch. Injection is ON
// by default because MCP is how an agent discovers the modules_* tools without
// a workspace admin binding the server agent by agent; set
// MULTICA_MODULE_MCP_AUTOINJECT=off on a deployment whose edge does not expose
// /api/mcp/modules (otherwise every agent would carry a server it can never
// reach).
func moduleMCPAutoInjectDisabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("MULTICA_MODULE_MCP_AUTOINJECT"))) {
	case "off", "0", "false", "disabled", "no":
		return true
	default:
		return false
	}
}

// injectModuleMCPServer attaches the module facade to the mcp_config of the
// task being claimed, so EVERY agent gets modules_* on EVERY run with nothing
// to bind, restart or opt into. Three rules keep it honest:
//
//   - The URL is the configured MULTICA_PUBLIC_URL, the same base the facade
//     uses to call its own REST. Unset means no injection: an entry the agent
//     cannot reach is worse than no entry, because the runtime would list
//     tools that fail on every call.
//   - Authorization carries the task-scoped `mat_` token minted for THIS claim.
//     It is the same credential already injected into the process environment
//     as MULTICA_TOKEN, so the exposure surface does not grow, and it dies
//     with the task (24h ceiling).
//   - An agent that already declares a server under this name keeps its own
//     entry. ResolveAgentMcpConfig enforces that precedence AND folds a legacy
//     top-level `mcp` container into `mcpServers` — without that fold the
//     daemon would read the canonical container alone and silently drop the
//     agent's legacy entries.
//
// Failures are logged and swallowed: a broken injection must never stop a
// task from running with the MCP config it already had.
func (h *Handler) injectModuleMCPServer(resp *AgentTaskResponse, taskToken string) {
	if resp == nil || resp.Agent == nil {
		return
	}
	if moduleMCPAutoInjectDisabled() {
		return
	}
	base := strings.TrimRight(strings.TrimSpace(h.cfg.PublicURL), "/")
	if base == "" {
		return
	}
	token := strings.TrimSpace(taskToken)
	if !strings.HasPrefix(token, "mat_") {
		// Claim mints mat_ tokens only; anything else means this is not the
		// task-scoped credential and must not be copied into a config file.
		return
	}
	entry, err := json.Marshal(map[string]any{
		"type":    "http",
		"url":     base + "/api/mcp/modules",
		"headers": map[string]string{"Authorization": "Bearer " + token},
	})
	if err != nil {
		return
	}
	resolved, err := ResolveAgentMcpConfig(
		[]WorkspaceMcpBinding{{Name: moduleMCPServerName, Config: entry}},
		json.RawMessage(resp.Agent.McpConfig),
	)
	if err != nil {
		slog.Warn("daemon claim: inject multica-modules MCP server failed; keeping agent mcp_config",
			"agent_id", resp.Agent.ID,
			"error", err,
		)
		return
	}
	resp.Agent.McpConfig = resolved
}
