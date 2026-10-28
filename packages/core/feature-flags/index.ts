/**
 * Public surface for @multica/core/feature-flags.
 *
 * Keep this list minimal — every new export becomes a contract we have to
 * preserve across the monorepo. Add to it only when a real caller appears.
 */

export type {
  Decision,
  EvalContext,
  PercentRollout,
  Provider,
  Reason,
  Rule,
} from "./types";

export { FeatureFlagService } from "./service";
export { StaticProvider } from "./static-provider";
export { ChainProvider } from "./chain-provider";
export {
  BILLING_WORKSPACE_SUBSCRIPTIONS_FLAG,
  COMPOSIO_MCP_APPS_FLAG,
  PLUGINS_V1_FLAG,
  ASSET_MODULE_FLAG,
  WORKFLOW_MODULE_FLAG,
  SPRINT_MODULE_FLAG,
  CHAT_CONVERSATIONS_FLAG,
  MODULE_PROTOTYPE_CHAT_FLAG,
  MODULE_SPEC_CENTER_FLAG,
} from "./keys";
export {
  FeatureFlagsProvider,
  useFeatureFlagService,
  useFlag,
  useVariant,
} from "./context";

// Hash helpers are exported for tests and for callers that want to share
// the bucketing logic without going through a Provider (rare; usually a
// red flag that the caller should be using the Service instead).
export { bucketFor, inPercent } from "./hash";
