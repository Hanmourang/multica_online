import type { ChatMention } from "@multica/core/types";

/**
 * Extract the structured @-mention payload from composed message content
 * (plan 20261025 §6.2 / SEC-07 client half).
 *
 * The group send contract requires every structured mention to ALSO appear as
 * a `mention://{type}/{id}` markdown link in the content — the server rejects
 * (400, zero persist) anything hidden. The editor serializes picked mentions
 * exactly that way (`[@Name](mention://agent/<uuid>)`), so the client derives
 * the structured list FROM the rendered content: by construction every
 * extracted entry is visible, a pasted/typed link the picker never resolved
 * still matches what the server will see, and the two can never drift.
 * Dedup keeps first-occurrence order; only member/agent targets are sent (the
 * server's mention vocabulary), issue/project links are input chrome, not
 * notification targets.
 */
const MENTION_LINK_RE = /mention:\/\/(member|agent)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

export function extractMentionsFromContent(content: string): ChatMention[] {
  if (!content.includes("mention://")) return [];
  const seen = new Set<string>();
  const mentions: ChatMention[] = [];
  for (const match of content.matchAll(MENTION_LINK_RE)) {
    const type = match[1];
    const id = match[2];
    if (type !== "member" && type !== "agent") continue;
    if (!id) continue;
    const key = `${type}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push({ type, id });
  }
  return mentions;
}
