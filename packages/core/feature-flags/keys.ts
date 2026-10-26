export const COMPOSIO_MCP_APPS_FLAG = "composio_mcp_apps";
export const PLUGINS_V1_FLAG = "plugins_v1";
export const BILLING_WORKSPACE_SUBSCRIPTIONS_FLAG =
  "billing_workspace_subscriptions";
// 资产管理模块（对标 CoCo /projects/:id/assets，migration 471）。默认 false，
// server 门控路由注册 + 前端资产 TAB 显隐；关闭时前端 TAB 隐藏、后端整块 404。
export const ASSET_MODULE_FLAG = "asset_module";
// 工作流模块（对标 CoCo /projects/:id/workflows，plan 20261024 §01，
// migration 468/469）。默认 false，server 门控路由注册 + 前端工作流 TAB 显隐；
// 关闭时 TAB 隐藏、后端整块 404，与 Go internal/featureflags/keys.go 同形。
export const WORKFLOW_MODULE_FLAG = "workflow_module";
// 迭代（Sprint）模块（对标 CoCo 工作流迭代资产，plan 20261024 §02，
// migration 470）。默认 false，server 门控路由注册 + 前端迭代 TAB 显隐；
// 关闭时 TAB 隐藏、后端整块 404，与 Go internal/featureflags/keys.go 同形。
export const SPRINT_MODULE_FLAG = "sprint_module";
// 聊天模块泛化（DM/Group 统一会话模型，plan 20261025，migration 478）。默认
// false，server 门控 /dm、/group、participants 路由注册 + 前端 DM/Group 入口显隐；
// 关闭时新路由 404、旧单 Agent 聊天行为不变，与 Go internal/featureflags ChatConversations 同形。
export const CHAT_CONVERSATIONS_FLAG = "chat_conversations";
