package featureflags

import (
	"context"

	"github.com/multica-ai/multica/server/pkg/featureflag"
)

const (
	// BillingWorkspaceSubscriptions gates the workspace-scoped entitlement,
	// Stripe Checkout, seat reconcile, and Billing Portal proxy surface. It is
	// deliberately off by default so the main repository can ship before the
	// managed cloud enables its matching billing.subscriptions capability.
	BillingWorkspaceSubscriptions = "billing_workspace_subscriptions"
	// ComposioMCPApps gates the Composio app management UI and — together with
	// the MUL-3963 permission_mode / invocation_targets access model it depends
	// on — the aligned Private / Public-to picker in the agent create flow.
	// The access model exists to gate Composio sharing, so the two ship on the
	// same switch.
	ComposioMCPApps = "composio_mcp_apps"
	// PluginsV1 gates the user-facing Plugin catalog and lifecycle management
	// APIs while the first product slice is dogfooded. It deliberately does not
	// gate pinned Task/Run execution: disabling discovery and management must not
	// mutate an immutable execution manifest that is already in flight.
	PluginsV1 = "plugins_v1"
	// SprintModule gates the CoCo-对标 iteration (Sprint) surface (plan
	// 20261024 §02): sprint CRUD + CAS 启停 + issue 纳入/移出 HTTP routes and the
	// project sprints TAB. Default off for grayscale rollout; route registration
	// is gated too, so a disabled flag 404s cleanly.
	SprintModule = "sprint_module"
	// WorkflowModule gates the CoCo-对标 workflow engine (plan 20261024 §01): the
	// Template→Instance→StageRun→GateRun HTTP surface, the 30s waiting-instance
	// sweep, and the project TAB. Default off for grayscale rollout; route
	// registration is gated too, so a disabled flag 404s cleanly.
	WorkflowModule = "workflow_module"
	// AssetModule gates the CoCo-对标 asset management surface (plan 20261024 §03):
	// the project_asset_binding catalog layer over project_resource (065), its
	// bind/unbind/search-candidate HTTP routes, and the project TAB. Default off
	// for grayscale rollout; route registration is gated so a disabled flag 404s
	// cleanly and the front-end TAB stays hidden.
	AssetModule = "asset_module"
	// WorkflowAssetGate gates the CoCo-对标 asset admission enforcement (plan 101
	// C5/C7): dispatchStage refuses to start a stage whose required input assets
	// are not yet satisfied (upstream product or project binding), moving it to
	// 'blocked' instead, and the per-task overlay mounts the read-only
	// multica-assets MCP facade so agents pull context on demand. Default off so
	// existing workflows behave exactly as before until explicitly enabled.
	WorkflowAssetGate = "workflow_asset_gate"
	// WorkflowPullContext gates the push->pull context composer (plan 101 P3):
	// instead of stuffing large asset bodies into the stage prompt comment, a
	// dispatched auto stage emits a compact pointer block (issue/project/stage ids
	// + required-asset checklist + the multica-assets MCP pull hint). Default off
	// so prompt bytes stay exactly as before until explicitly enabled.
	WorkflowPullContext = "workflow_pull_context"
	// WorkflowStageSpec gates the stage-spec runtime consumption (plan 20261025 §B2):
	// a dispatched auto stage renders its snapshotted spec (goal / criteria /
	// inputTpl with ${workitem.*} ${inputs.*} ${project.assets} placeholders) into the
	// prompt instead of emitting the bare prompt only. Default off so prompt bytes
	// stay exactly as before until explicitly enabled.
	WorkflowStageSpec = "workflow_stage_spec"
	// ChatConversations gates the chat-module generalization (plan
	// 20261025-聊天模块-人与人群聊): the DM/Group conversation kinds, the
	// /api/chat/sessions/dm and /group routes, participant management routes, and
	// the unified conversation list. Default off so the existing single-agent
	// Chat behaves exactly as before; route registration is gated too, so a
	// disabled flag 404s the new endpoints cleanly and hides the front-end entry.
	ChatConversations = "chat_conversations"
	// ModulePrototypeChat gates the chat-side module attachment surface (plan
	// 20261026 §06): the composer「+」module group, the module tab in the
	// resource picker, and accepting module / module_prototype resource refs.
	// Default off so existing composers behave exactly as before; the frontend
	// hides the module affordances and the server rejects the two new ref
	// types while it is closed. Requires migration 489.
	ModulePrototypeChat = "module_prototype_chat"
	// ModuleSpecCenter gates the functional-module spec center (plan 20261026 §07):
	// the /modules/{moduleId}/spec, /prototype-versions, /prototype-reconcile,
	// /coverage and /prototype-plans HTTP surface backed by migrations 484–488.
	// Default off so existing module CRUD is unchanged; route registration is
	// gated too, so a disabled flag 404s cleanly and the front-end workbench stays
	// hidden. Requires migrations 484–488.
	ModuleSpecCenter = "module_spec_center"
	// agentBuilderCompat is no longer a release flag. Keep publishing the key
	// as enabled so installed desktop clients that still gate the AI creation
	// entry on this config decision receive the permanently enabled behavior.
	agentBuilderCompat = "agents_agent_builder"
	// agentSkillTogglesCompat is no longer a release flag. Keep publishing the
	// key as enabled so installed v0.4.0 desktop clients, which still gate the
	// switch on this config decision, receive the permanently enabled behavior.
	agentSkillTogglesCompat = "agents_skill_toggles"
	// resourceLabelsCompat is no longer a release flag. Keep publishing the key
	// as enabled for installed desktop clients from v0.4.0 through at least
	// v0.4.15, every release shipped before this change. Unlike the skill-toggle
	// gate above, which was removed client-side in v0.4.1, the resource-label
	// gate remained in every such client and fails closed (default false) if
	// the key stops being published.
	resourceLabelsCompat = "settings_resource_labels"
)

var frontendPublicFlags = []string{
	BillingWorkspaceSubscriptions,
	ComposioMCPApps,
	PluginsV1,
	SprintModule,
	WorkflowModule,
	AssetModule,
	WorkflowAssetGate,
	WorkflowPullContext,
	WorkflowStageSpec,
	ChatConversations,
	ModulePrototypeChat,
	ModuleSpecCenter,
}

func BillingWorkspaceSubscriptionsEnabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, BillingWorkspaceSubscriptions, false)
}

func ComposioMCPAppsEnabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, ComposioMCPApps, false)
}

func PluginsV1Enabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, PluginsV1, false)
}

func SprintModuleEnabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, SprintModule, false)
}

func WorkflowModuleEnabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, WorkflowModule, false)
}

func AssetModuleEnabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, AssetModule, false)
}

func WorkflowAssetGateEnabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, WorkflowAssetGate, false)
}

func WorkflowPullContextEnabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, WorkflowPullContext, false)
}

// WorkflowStageSpecEnabled reports whether stage spec (goal/criteria/inputTpl) is
// consumed at dispatch time. nil flags → off (zero regression).
func WorkflowStageSpecEnabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, WorkflowStageSpec, false)
}

// ChatConversationsEnabled reports whether DM/Group conversation routes and
// the unified conversation list are on. nil flags → off (zero regression).
func ChatConversationsEnabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, ChatConversations, false)
}

// ModulePrototypeChatEnabled reports whether a chat message may reference a
// project module or one of its prototype versions. nil flags → off (zero
// regression).
func ModulePrototypeChatEnabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, ModulePrototypeChat, false)
}

// ModuleSpecCenterEnabled reports whether the module spec center / prototype
// workbench HTTP surface is registered. nil flags → off (zero regression).
func ModuleSpecCenterEnabled(ctx context.Context, flags *featureflag.Service) bool {
	return flags.IsEnabled(ctx, ModuleSpecCenter, false)
}

func EvaluateFrontendPublicFlags(ctx context.Context, flags *featureflag.Service) map[string]bool {
	out := make(map[string]bool, len(frontendPublicFlags)+3)
	for _, key := range frontendPublicFlags {
		out[key] = flags.IsEnabled(ctx, key, false)
	}
	out[agentBuilderCompat] = true
	out[agentSkillTogglesCompat] = true
	out[resourceLabelsCompat] = true
	return out
}
