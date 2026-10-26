import type { ChatMessageResource, ChatResourceRefInput } from "@multica/core/types";

export const CHAT_RESOURCE_DRAFT_LIMIT = 3;

/** Short type mark shared by the picker, the composer chip, and message cards. */
export function chatResourceMark(resource: Pick<ChatMessageResource, "type" | "kind" | "title" | "artifact" | "attachment">): string {
  if (resource.type === "document") {
    const name = resource.title
      ?? resource.artifact?.rel_path
      ?? resource.attachment?.filename
      ?? "";
    const ext = name.includes(".") ? name.split(".").pop()?.toUpperCase() ?? "" : "";
    return ext.length > 0 && ext.length <= 4 ? ext : "DOC";
  }
  return resource.kind === "requirement" ? "REQ" : "TASK";
}

export function chatResourceDraftKey(resource: ChatMessageResource | ChatResourceRefInput): string {
  return [
    resource.type,
    resource.id,
    resource.type === "issue" ? resource.kind : "",
    resource.type === "document" ? resource.source : "",
    resource.type === "document" ? resource.project_id ?? "" : "",
  ].join(":");
}

export function addChatResourceDraft(
  drafts: ChatMessageResource[],
  resource: ChatMessageResource,
): ChatMessageResource[] {
  const key = chatResourceDraftKey(resource);
  if (drafts.length >= CHAT_RESOURCE_DRAFT_LIMIT || drafts.some((item) => chatResourceDraftKey(item) === key)) {
    return drafts;
  }
  return [...drafts, resource];
}

export function chatResourceRef(resource: ChatMessageResource): ChatResourceRefInput {
  return resource.type === "issue"
    ? { type: "issue", id: resource.id, kind: resource.kind ?? "task" }
    : {
        type: "document",
        id: resource.id,
        source: resource.source ?? "artifact",
        ...(resource.project_id ? { project_id: resource.project_id } : {}),
      };
}

export function canSubmitChatComposer(
  content: string,
  resources: ChatMessageResource[],
): boolean {
  return content.trim().length > 0 || resources.length > 0;
}
