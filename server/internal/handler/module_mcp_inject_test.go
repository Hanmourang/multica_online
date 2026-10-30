package handler

import (
	"encoding/json"
	"strings"
	"testing"
)

// 注入单测：锁死四条不变式——① 默认注入并指向 /api/mcp/modules；② Bearer 用的是
// 本次 claim 的 mat_ token；③ agent 自己声明的同名 server 不被覆盖；④ 旧 mcp 容器
// 被折进 mcpServers（否则 daemon 只读 mcpServers 会静默丢掉 legacy 条目）。

func injectTestHandler(publicURL string) *Handler {
	return &Handler{cfg: Config{PublicURL: publicURL}}
}

func serversOf(t *testing.T, resp *AgentTaskResponse) map[string]map[string]any {
	t.Helper()
	if resp.Agent == nil || len(resp.Agent.McpConfig) == 0 {
		t.Fatalf("expected an injected mcp_config, got none")
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(resp.Agent.McpConfig, &doc); err != nil {
		t.Fatalf("decode mcp_config: %v (%s)", err, resp.Agent.McpConfig)
	}
	raw, ok := doc["mcpServers"]
	if !ok {
		t.Fatalf("mcp_config has no mcpServers: %s", resp.Agent.McpConfig)
	}
	var servers map[string]map[string]any
	if err := json.Unmarshal(raw, &servers); err != nil {
		t.Fatalf("decode mcpServers: %v (%s)", err, raw)
	}
	return servers
}

func TestInjectModuleMCPServerDefaultsOn(t *testing.T) {
	resp := &AgentTaskResponse{Agent: &TaskAgentData{}}
	injectTestHandler("https://multica.example/").injectModuleMCPServer(resp, "mat_task_token")

	servers := serversOf(t, resp)
	entry, ok := servers[moduleMCPServerName]
	if !ok {
		t.Fatalf("missing %s in %v", moduleMCPServerName, servers)
	}
	if got := entry["url"]; got != "https://multica.example/api/mcp/modules" {
		t.Fatalf("url = %v, want the facade endpoint on the trimmed public URL", got)
	}
	if got := entry["type"]; got != "http" {
		t.Fatalf("type = %v, want http", got)
	}
	headers, _ := entry["headers"].(map[string]any)
	if got := headers["Authorization"]; got != "Bearer mat_task_token" {
		t.Fatalf("Authorization = %v, want the task-scoped token", got)
	}
}

func TestInjectModuleMCPServerKeepsAgentEntry(t *testing.T) {
	resp := &AgentTaskResponse{Agent: &TaskAgentData{
		McpConfig: json.RawMessage(`{"mcpServers":{"multica-modules":{"url":"https://mine.example/mcp"}}}`),
	}}
	injectTestHandler("https://multica.example").injectModuleMCPServer(resp, "mat_task_token")

	entry := serversOf(t, resp)[moduleMCPServerName]
	if got := entry["url"]; got != "https://mine.example/mcp" {
		t.Fatalf("agent's own entry must win, url = %v", got)
	}
	if _, injected := entry["headers"]; injected {
		t.Fatalf("must not graft headers onto the agent's own entry: %v", entry)
	}
}

func TestInjectModuleMCPServerFoldsLegacyContainer(t *testing.T) {
	resp := &AgentTaskResponse{Agent: &TaskAgentData{
		McpConfig: json.RawMessage(`{"mcp":{"legacy":{"url":"https://legacy.example/mcp"}}}`),
	}}
	injectTestHandler("https://multica.example").injectModuleMCPServer(resp, "mat_task_token")

	servers := serversOf(t, resp)
	if _, ok := servers[moduleMCPServerName]; !ok {
		t.Fatalf("facade missing after fold: %v", servers)
	}
	if _, ok := servers["legacy"]; !ok {
		t.Fatalf("legacy container entry was dropped: %v", servers)
	}
	var doc map[string]json.RawMessage
	_ = json.Unmarshal(resp.Agent.McpConfig, &doc)
	if _, ok := doc["mcp"]; ok {
		t.Fatalf("legacy container must not survive beside mcpServers: %s", resp.Agent.McpConfig)
	}
}

func TestInjectModuleMCPServerSkipsWithoutPublicURL(t *testing.T) {
	resp := &AgentTaskResponse{Agent: &TaskAgentData{}}
	injectTestHandler("   ").injectModuleMCPServer(resp, "mat_task_token")
	if len(resp.Agent.McpConfig) != 0 {
		t.Fatalf("must not inject without a public URL, got %s", resp.Agent.McpConfig)
	}
}

func TestInjectModuleMCPServerSkipsNonTaskToken(t *testing.T) {
	resp := &AgentTaskResponse{Agent: &TaskAgentData{}}
	injectTestHandler("https://multica.example").injectModuleMCPServer(resp, "pat_human_token")
	if len(resp.Agent.McpConfig) != 0 {
		t.Fatalf("a non-task token must never be copied into mcp_config, got %s", resp.Agent.McpConfig)
	}
}

func TestInjectModuleMCPServerKillSwitch(t *testing.T) {
	t.Setenv("MULTICA_MODULE_MCP_AUTOINJECT", "off")
	resp := &AgentTaskResponse{Agent: &TaskAgentData{}}
	injectTestHandler("https://multica.example").injectModuleMCPServer(resp, "mat_task_token")
	if len(resp.Agent.McpConfig) != 0 {
		t.Fatalf("kill switch must disable injection, got %s", resp.Agent.McpConfig)
	}
}

// 注入的条目不能把 agent 原有的其它 server 挤掉。
func TestInjectModuleMCPServerPreservesOtherServers(t *testing.T) {
	resp := &AgentTaskResponse{Agent: &TaskAgentData{
		McpConfig: json.RawMessage(`{"mcpServers":{"github":{"url":"https://gh.example/mcp"}}}`),
	}}
	injectTestHandler("https://multica.example").injectModuleMCPServer(resp, "mat_task_token")

	servers := serversOf(t, resp)
	if len(servers) != 2 {
		t.Fatalf("want both servers, got %v", servers)
	}
	if _, ok := servers["github"]; !ok {
		t.Fatalf("agent's github server was dropped: %v", servers)
	}
	if !strings.Contains(string(resp.Agent.McpConfig), moduleMCPServerName) {
		t.Fatalf("facade not present: %s", resp.Agent.McpConfig)
	}
}
