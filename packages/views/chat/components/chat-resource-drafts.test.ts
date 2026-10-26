import { describe, expect, it } from "vitest";
import type { ChatMessageResource } from "@multica/core/types";
import {
  addChatResourceDraft,
  canSubmitChatComposer,
  chatResourceDraftKey,
} from "./chat-resource-drafts";

function resource(id: string): ChatMessageResource {
  return { type: "issue", id, kind: "task", access: "granted" };
}

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
});
