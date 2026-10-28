import type { ChatMessageResource, ChatResourceRefInput, ProjectModule } from "@multica/core/types";

export const CHAT_RESOURCE_DRAFT_LIMIT = 3;

/**
 * 模块 → 输入区草稿。当前模块 API 不返规格/覆盖率，所以这几项留 0/null，
 * 由发出后的服务端快照（chat resource resolver）补齐真实值；不在这里猜。
 */
export function chatModuleResource(module: ProjectModule): ChatMessageResource {
  return {
    type: "module",
    id: module.id,
    kind: "module",
    project_id: module.project_id,
    access: "granted",
    title: module.name,
    module: {
      module_id: module.id,
      name: module.name,
      project_id: module.project_id,
      color: module.color,
      spec_version: 0,
      canonical_prototype_version: null,
      feature_point_count: 0,
    },
  };
}

/** Short type mark shared by the picker, the composer chip, and message cards. */
export function chatResourceMark(resource: Pick<ChatMessageResource, "type" | "kind" | "title" | "artifact" | "attachment">): string {
  if (resource.type === "module") return "MOD";
  if (resource.type === "module_prototype") return "PROTO";
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
  // Modules and prototype versions dedupe by (type, id, kind) only; unlike
  // documents they have no source variant to keep apart.
  const kind = "kind" in resource ? resource.kind ?? "" : "";
  const source = resource.type === "document" ? resource.source : "";
  const projectId = resource.type === "issue" ? "" : resource.project_id ?? "";
  return [resource.type, resource.id, kind, source, projectId].join(":");
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
  switch (resource.type) {
    case "issue":
      return { type: "issue", id: resource.id, kind: resource.kind === "requirement" ? "requirement" : "task" };
    case "module":
      return {
        type: "module",
        id: resource.id,
        kind: "module",
        ...(resource.project_id ? { project_id: resource.project_id } : {}),
      };
    case "module_prototype":
      return {
        type: "module_prototype",
        id: resource.id,
        kind: "prototype",
        ...(resource.project_id ? { project_id: resource.project_id } : {}),
      };
    default:
      return {
        type: "document",
        id: resource.id,
        source: resource.source ?? "artifact",
        ...(resource.project_id ? { project_id: resource.project_id } : {}),
      };
  }
}

export function canSubmitChatComposer(
  content: string,
  resources: ChatMessageResource[],
): boolean {
  return content.trim().length > 0 || resources.length > 0;
}
