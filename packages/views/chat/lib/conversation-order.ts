/**
 * Conversation order — a reply belongs under the message that asked for it,
 * not at the wall-clock position where the answer finished.
 *
 * A member who hands one question to two agents, or who asks a second agent
 * while the first is still working, produces persisted rows like
 *
 *   U1 (21:53 "ask OpenCode") · U2 (21:55 "ask OpenClaw")
 *   · A1 (21:56 OpenCode's answer) · A2 (21:57 OpenClaw's answer)
 *
 * because an assistant row is stamped when its task completes. Rendered in
 * `created_at` order the transcript claims the second question was asked
 * before the first answer existed — it reads as if the member answered
 * themselves. The trigger link does exist in that data:
 *
 * - a group send persists one `chat_group_task_input` row per task and the
 *   API surfaces them on the sending message as `dispatches[].task_id`;
 * - every assistant row carries the `task_id` it completes.
 *
 * So the ordering key for an assistant row is its trigger's position, with
 * its own clock only breaking ties between sibling agents. A row whose task
 * has no discoverable trigger (a one-to-one session predating the dispatch
 * table, a channel-ingested turn) keeps its own position: guessing would
 * move answers under questions they never answered.
 */

/** The subset of `ChatMessage` ordering needs — kept structural for tests. */
export interface ConversationAnchorMessage {
  id: string;
  role: string;
  task_id?: string | null;
  dispatches?: ReadonlyArray<{ task_id?: string | null }>;
}

export interface ConversationAnchors {
  /** Task id → id of the message that triggered it. */
  anchorByTaskId: Map<string, string>;
  /** Assistant message id → id of the message it answers. */
  anchorByMessageId: Map<string, string>;
}

/**
 * Resolve which message each reply answers.
 *
 * `liveTaskAnchors` carries in-flight tasks the caller already associated by
 * other means (a pending fan-out whose trigger is known from its @-mention
 * before the dispatch row is read back). Persisted dispatches win: they are
 * the authoritative link and survive a mention that has been edited away.
 */
export function resolveConversationAnchors(
  messages: readonly ConversationAnchorMessage[],
  liveTaskAnchors?: ReadonlyMap<string, string>,
): ConversationAnchors {
  const anchorByTaskId = new Map<string, string>();
  for (const message of messages) {
    for (const dispatch of message.dispatches ?? []) {
      const taskId = dispatch.task_id;
      if (!taskId || anchorByTaskId.has(taskId)) continue;
      anchorByTaskId.set(taskId, message.id);
    }
  }
  for (const [taskId, messageId] of liveTaskAnchors ?? []) {
    if (anchorByTaskId.has(taskId)) continue;
    anchorByTaskId.set(taskId, messageId);
  }

  const indexById = new Map<string, number>();
  messages.forEach((message, index) => indexById.set(message.id, index));

  const anchorByMessageId = new Map<string, string>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !message.task_id) return;
    const anchorId = anchorByTaskId.get(message.task_id);
    if (!anchorId || anchorId === message.id) return;
    const anchorIndex = indexById.get(anchorId);
    // Only a PRECEDING trigger can adopt the reply. A trigger that sorts
    // after the reply means the pair is already in the right order.
    if (anchorIndex === undefined || anchorIndex > index) return;
    anchorByMessageId.set(message.id, anchorId);
  });

  return { anchorByTaskId, anchorByMessageId };
}

/**
 * Reorder messages so each answer follows its question. Answers keep their
 * relative order (two agents answering one question stay in completion
 * order), and messages with no anchor hold their original position.
 */
export function orderMessagesForConversation<T extends ConversationAnchorMessage>(
  messages: readonly T[],
  anchors: ConversationAnchors,
): T[] {
  if (anchors.anchorByMessageId.size === 0) return [...messages];

  const followsByAnchor = new Map<string, T[]>();
  const primary: T[] = [];
  for (const message of messages) {
    const anchorId = anchors.anchorByMessageId.get(message.id);
    if (!anchorId) {
      primary.push(message);
      continue;
    }
    const list = followsByAnchor.get(anchorId);
    if (list) list.push(message);
    else followsByAnchor.set(anchorId, [message]);
  }

  const ordered: T[] = [];
  for (const message of primary) {
    ordered.push(message);
    const follows = followsByAnchor.get(message.id);
    if (follows) ordered.push(...follows);
  }
  // An anchor that did not survive into `primary` (caller filtered it out)
  // would silently drop its answers; keep them at the tail instead.
  const placed = new Set(ordered.map((message) => message.id));
  for (const message of messages) {
    if (!placed.has(message.id)) ordered.push(message);
  }
  return ordered;
}
