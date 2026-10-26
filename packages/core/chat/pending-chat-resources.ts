import { replaceEqualDeep } from "@tanstack/react-query";
import type { ChatMessage, ChatMessageResource } from "../types";

/**
 * The send response and the chat:message echo do not both carry the resource
 * card. The echo only says that resources exist. The composer already has the
 * issue or document the sender picked, so keep that snapshot until the echo
 * (or the send response) writes the user row.
 */
type PendingChatResources = {
  content: string;
  resources: ChatMessageResource[];
};

const pending = new Map<string, PendingChatResources[]>();

/**
 * Cards the client has already rendered, keyed by message id.
 *
 * A refetch replaces the transcript with the server page. structuralSharing
 * only helps while the previous query cache still holds the snapshot. This
 * map survives that replacement for the life of the page, including a
 * re-entry that mounts a fresh query.
 */
const rendered = new Map<string, ChatMessageResource[]>();

export function rememberPendingChatResources(
  sessionId: string,
  content: string,
  resources: ChatMessageResource[],
): void {
  if (resources.length === 0) return;
  const queue = pending.get(sessionId) ?? [];
  queue.push({ content, resources });
  pending.set(sessionId, queue);
}

export function takePendingChatResources(
  sessionId: string,
  content: string,
): ChatMessageResource[] | undefined {
  const queue = pending.get(sessionId);
  if (!queue?.length) return undefined;
  const index = queue.findIndex((item) => item.content === content);
  if (index < 0) return undefined;
  const [item] = queue.splice(index, 1);
  if (queue.length === 0) pending.delete(sessionId);
  return item?.resources;
}

export function rememberRenderedChatResources(messages: ChatMessage[]): void {
  for (const message of messages) {
    if (!message.id || !message.resources?.length) continue;
    const merged = mergeChatResourceSnapshots(message.resources, rendered.get(message.id));
    if (merged?.length) rendered.set(message.id, merged);
  }
}

/** Fill a freshly fetched page with cards this client already rendered. */
export function applyRenderedChatResources(messages: ChatMessage[]): ChatMessage[] {
  const previous = messages.map((message) => {
    const local = rendered.get(message.id);
    return local?.length ? { ...message, resources: local, has_resources: true as const } : message;
  });
  return retainChatResourceSnapshots(previous, messages);
}

export function mergeChatResourceSnapshots(
  server: ChatMessageResource[] | undefined,
  local: ChatMessageResource[] | undefined,
): ChatMessageResource[] | undefined {
  if (!local?.length) return server;
  if (!server?.length) return local;
  return server.map((resource) => {
    const match = local.find((item) => item.type === resource.type && item.id === resource.id);
    if (!match) return resource;
    return {
      ...match,
      ...resource,
      issue: resource.issue ?? match.issue,
      artifact: resource.artifact ?? match.artifact,
      attachment: resource.attachment ?? match.attachment,
      title: resource.title ?? match.title,
    };
  });
}

/**
 * A messages refetch replaces the cache outright. The echo and the send
 * response may have already attached the picker snapshot, and an older server
 * (or a list that omits the issue body) would wipe that card. Keep the local
 * snapshot wherever the incoming row does not already carry the same one.
 */
export function retainChatResourceSnapshots(
  previous: ChatMessage[] | undefined,
  next: ChatMessage[],
): ChatMessage[] {
  if (!previous?.length) return next;
  const byId = new Map(previous.map((message) => [message.id, message]));
  let changed = false;
  const merged = next.map((message) => {
    const local = byId.get(message.id)?.resources;
    if (!local?.length) return message;
    const resources = mergeChatResourceSnapshots(message.resources, local);
    if (!resources?.length) return message;
    const same = !!message.resources
      && resources.length === message.resources.length
      && resources.every((resource, index) => {
        const current = message.resources?.[index];
        return !!current
          && current.id === resource.id
          && current.type === resource.type
          && current.issue === resource.issue
          && current.artifact === resource.artifact
          && current.attachment === resource.attachment;
      });
    if (same) return message;
    changed = true;
    return { ...message, resources, has_resources: true as const };
  });
  const result = changed ? merged : next;
  rememberRenderedChatResources(result);
  return result;
}

type PagedMessages = { pages: Array<{ messages: ChatMessage[] } & Record<string, unknown>> };

function isPagedMessages(value: unknown): value is PagedMessages {
  return !!value && typeof value === "object" && Array.isArray((value as PagedMessages).pages);
}

/** structuralSharing for the flat message list. */
export function shareChatMessages(oldData: unknown, newData: unknown): unknown {
  const shared = replaceEqualDeep(oldData, newData);
  if (!Array.isArray(oldData) || !Array.isArray(shared)) return shared;
  return retainChatResourceSnapshots(oldData as ChatMessage[], shared as ChatMessage[]);
}

/** structuralSharing for the paged transcript the chat window actually renders. */
export function shareChatMessagesPage(oldData: unknown, newData: unknown): unknown {
  const shared = replaceEqualDeep(oldData, newData);
  if (!isPagedMessages(oldData) || !isPagedMessages(shared)) return shared;
  const previous = oldData.pages.flatMap((page) => page.messages);
  let changed = false;
  const pages = shared.pages.map((page) => {
    const messages = retainChatResourceSnapshots(previous, page.messages);
    if (messages === page.messages) return page;
    changed = true;
    return { ...page, messages };
  });
  return changed ? { ...shared, pages } : shared;
}
