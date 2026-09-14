import type { RuntimeProtocolFamily } from "@multica/core/types";

function docsLocaleSegment(language?: string): string {
  if (language?.startsWith("zh")) return "/zh";
  if (language?.startsWith("ja")) return "/ja";
  if (language?.startsWith("ko")) return "/ko";
  return "";
}

export function daemonRuntimesDocsHref(language?: string): string {
  return `https://multica.ai/docs${docsLocaleSegment(language)}/daemon-runtimes`;
}

export function customRuntimeDocsHref(language?: string): string {
  const base = daemonRuntimesDocsHref(language);
  if (language?.startsWith("zh")) {
    return `${base}#${encodeURIComponent("自定义运行时配置")}`;
  }
  if (language?.startsWith("ja")) {
    return `${base}#${encodeURIComponent("カスタムランタイムプロファイル")}`;
  }
  if (language?.startsWith("ko")) {
    return `${base}#${encodeURIComponent("사용자-지정-런타임-프로필")}`;
  }
  return `${base}#custom-runtime-profiles`;
}

// Official install/setup guides per protocol family. Keep in sync with
// apps/docs/content/docs/install-agent-runtime.mdx ("Official install guide").
const PROTOCOL_FAMILY_DOCS: Partial<Record<RuntimeProtocolFamily, string>> = {
  antigravity: "https://antigravity.google/docs/cli-install",
  claude: "https://code.claude.com/docs/en/quickstart",
  codebuddy: "https://www.codebuddy.ai/docs/cli/quickstart",
  codearts:
    "https://support.huaweicloud.com/qs-codeartssnap/codeartsagent_qs_0004.html",
  codex: "https://developers.openai.com/codex/cli/",
  copilot:
    "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
  cursor: "https://docs.cursor.com/en/cli/installation",
  dsh: "https://github.com/deepseek-ai/deepseek-harness",
  deveco: "https://gitcode.com/openharmony-sig/deveco-code",
  grok: "https://docs.x.ai/build/overview",
  hermes: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart/",
  kimi: "https://github.com/MoonshotAI/kimi-cli",
  kiro: "https://kiro.dev/docs/cli/installation/",
  mcode: "https://www.npmjs.com/package/@minimax-ai/code",
  openclaw: "https://docs.openclaw.ai/install",
  opencode: "https://opencode.ai/en/docs",
  pi: "https://github.com/earendil-works/pi",
  qoder: "https://docs.qoder.com/en/cli/quick-start",
  qoderclicn:
    "https://help.aliyun.com/en/lingma/qodercli-cn/user-guide/qoder-cli-cn-get-started-quickly",
  qwen: "https://github.com/QwenLM/qwen-code",
  qwenpaw: "https://github.com/agentscope-ai/QwenPaw",
  reasonix: "https://github.com/esengine/DeepSeek-Reasonix",
  traecli: "https://www.trae.cn/",
  dim: "https://dimagent.cn/en/docs/cli",
};

export function protocolFamilyDocsHref(
  family: string,
): string | undefined {
  return PROTOCOL_FAMILY_DOCS[family as RuntimeProtocolFamily];
}
