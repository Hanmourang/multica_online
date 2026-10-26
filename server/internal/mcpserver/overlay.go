// 资产 MCP 门面的 per-task overlay 构建器（plan 101 P2）。
//
// 实现 service.ComposioOverlayBuilder 同形接缝（BuildTaskOverlay），供 TaskService.AssetMCP
// 在入队时把 multica-assets MCP server 注入 mcpServers。**只有配置了服务 URL 才注入**；
// 未配置即返回零 overlay，行为与未接入前逐字一致（默认关，零回归）。
package mcpserver

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/runtimeapps"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// OverlayBuilder 产出注入 agent 执行环境的 multica-assets MCP server 配置。
type OverlayBuilder struct {
	serverURL string // Streamable-HTTP MCP 端点；空 = 不注入
}

// NewOverlayBuilder 用运维配置的门面 URL 构造构建器。
func NewOverlayBuilder(serverURL string) *OverlayBuilder {
	return &OverlayBuilder{serverURL: serverURL}
}

// BuildTaskOverlay 实现 service.ComposioOverlayBuilder 接缝。URL 未配置时返回零结果。
func (o *OverlayBuilder) BuildTaskOverlay(_ context.Context, _ pgtype.UUID, _ db.Agent) (runtimeapps.MCPOverlayResult, error) {
	if o == nil || o.serverURL == "" {
		return runtimeapps.MCPOverlayResult{}, nil
	}
	payload := map[string]any{
		"mcpServers": map[string]any{
			"multica-assets": map[string]any{
				"type": "http",
				"url":  o.serverURL,
			},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return runtimeapps.MCPOverlayResult{}, err
	}
	return runtimeapps.MCPOverlayResult{MCPOverlay: raw}, nil
}
