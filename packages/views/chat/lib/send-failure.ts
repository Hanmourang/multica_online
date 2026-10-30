import { clientErrorMessage, dispatchReasonCode } from "@multica/core/api";

/**
 * Why the server refused a chat message, from the client's point of view.
 *
 * `blocked` / `runtime_required` come from the structured MUL-4525
 * `reason_code`. The mention kinds come from a plain 400 body instead: the
 * group handler rejects a mention whose target is not a current participant
 * with `{"error": "mention is not a group agent participant"}` and no
 * `reason_code`. Branching only on `dispatchReasonCode` sends that case to the
 * generic "failed to send" toast, and the user has no way to learn that the `@`
 * is the problem — it reads like an outage.
 */
export type ChatSendFailureKind =
  | "blocked"
  | "runtime_required"
  | "mention_agent_not_in_group"
  | "mention_not_in_group"
  | "generic";

const MENTION_FAILURE_KINDS = new Map<string, ChatSendFailureKind>([
  ["mention is not a group agent participant", "mention_agent_not_in_group"],
  ["mention is not a participant", "mention_not_in_group"],
]);

export function chatSendFailureKind(err: unknown): ChatSendFailureKind {
  switch (dispatchReasonCode(err)) {
    case "invocation_not_allowed":
      return "blocked";
    case "agent_runtime_required":
      return "runtime_required";
  }
  const serverMessage = clientErrorMessage(err);
  if (serverMessage) {
    const kind = MENTION_FAILURE_KINDS.get(serverMessage);
    if (kind) return kind;
  }
  return "generic";
}
