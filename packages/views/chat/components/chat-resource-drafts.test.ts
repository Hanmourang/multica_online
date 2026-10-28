import { describe, expect, it } from "vitest";
import type { ChatMessageResource, ProjectModule } from "@multica/core/types";
import {
  addChatResourceDraft,
  canSubmitChatComposer,
  chatModuleResource,
  chatResourceDraftKey,
  chatResourceMark,
  chatResourceRef,
} from "./chat-resource-drafts";

function resource(id: string): ChatMessageResource {
  return { type: "issue", id, kind: "task", access: "granted" };
}

const MODULE: ProjectModule = {
  id: "module-1",
  project_id: "project-1",
  workspace_id: "ws-1",
  name: "线索分配",
  color: "#10b981",
  created_at: "2026-10-26T00:00:00Z",
};

describe("chat resource drafts", () => {
  it("keeps stable identity across issue and document references", () => {
    expect(chatResourceDraftKey(resource("issue-1"))).toBe("issue:issue-1:task::");
    expect(chatResourceDraftKey({
      type: "document",
      id: "doc-1",
      source: "artifact",
      project_id: "project-1",
      access: "granted",
    })).toBe("document:doc-1::artifact:project-1");
  });

  it("deduplicates without moving the existing selection and caps drafts at three", () => {
    const first = addChatResourceDraft([], resource("one"));
    const duplicate = addChatResourceDraft(first, resource("one"));
    const full = ["one", "two", "three"].reduce(
      (drafts, id) => addChatResourceDraft(drafts, resource(id)),
      [] as ChatMessageResource[],
    );

    expect(duplicate).toEqual(first);
    expect(addChatResourceDraft(full, resource("four"))).toEqual(full);
    expect(full.map((item) => item.id)).toEqual(["one", "two", "three"]);
  });

  it("allows a resource-only message but not an entirely empty composer", () => {
    expect(canSubmitChatComposer("", [resource("one")])).toBe(true);
    expect(canSubmitChatComposer("  \n", [])).toBe(false);
    expect(canSubmitChatComposer("hello", [])).toBe(true);
  });

  it("turns a project module into a draft card and back into a ref", () => {
    const draft = chatModuleResource(MODULE);
    expect(draft.type).toBe("module");
    expect(draft.title).toBe("线索分配");
    // The draft carries no spec data: the server snapshot fills it in on send.
    expect(draft.module?.spec_version).toBe(0);
    expect(draft.module?.canonical_prototype_version).toBeNull();
    expect(chatResourceMark(draft)).toBe("MOD");
    expect(chatResourceDraftKey(draft)).toBe("module:module-1:module::project-1");
    expect(chatResourceRef(draft)).toEqual({
      type: "module",
      id: "module-1",
      kind: "module",
      project_id: "project-1",
    });
  });

  it("keeps a prototype version distinct from its module", () => {
    const prototype: ChatMessageResource = {
      type: "module_prototype",
      id: "version-2",
      kind: "prototype",
      project_id: "project-1",
      access: "granted",
      prototype: { version_id: "version-2", module_id: "module-1", version: 2 },
    };
    expect(chatResourceMark(prototype)).toBe("PROTO");
    expect(chatResourceDraftKey(prototype)).not.toBe(chatResourceDraftKey(chatModuleResource(MODULE)));
    expect(chatResourceRef(prototype)).toEqual({
      type: "module_prototype",
      id: "version-2",
      kind: "prototype",
      project_id: "project-1",
    });
    // 模块 + 原型共存于同一个草稿上限之内。
    expect(addChatResourceDraft([chatModuleResource(MODULE)], prototype)).toHaveLength(2);
  });
});
