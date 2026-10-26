import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatMessageResource } from "../types";
import {
  applyRenderedChatResources,
  rememberPendingChatResources,
  rememberRenderedChatResources,
  retainChatResourceSnapshots,
  shareChatMessagesPage,
  takePendingChatResources,
} from "./pending-chat-resources";

const snapshot: ChatMessageResource = {
  type: "issue",
  id: "issue-1",
  kind: "task",
  access: "granted",
  title: "旅游攻略",
  issue: { id: "issue-1", title: "旅游攻略" } as ChatMessageResource["issue"],
};

function row(partial: Partial<ChatMessage> & Pick<ChatMessage, "id">): ChatMessage {
  return {
    chat_session_id: "session-1",
    role: "user",
    content: "请分析进度",
    task_id: null,
    created_at: "2026-10-26T01:44:00Z",
    ...partial,
  };
}

describe("pending chat resources", () => {
  it("returns the snapshot only for the matching message text", () => {
    rememberPendingChatResources("session-a", "请分析进度", [snapshot]);
    expect(takePendingChatResources("session-a", "别的内容")).toBeUndefined();
    expect(takePendingChatResources("session-a", "请分析进度")).toEqual([snapshot]);
    expect(takePendingChatResources("session-a", "请分析进度")).toBeUndefined();
  });

  it("restores a rendered card on a later fetch that has no previous cache", () => {
    rememberRenderedChatResources([row({ id: "msg-kept", resources: [snapshot], has_resources: true })]);
    const fetched = applyRenderedChatResources([row({ id: "msg-kept" })]);
    expect(fetched[0]?.resources?.[0]?.issue).toEqual(snapshot.issue);
  });

  it("keeps the picker card when a refetch omits the issue snapshot", () => {
    const previous = [row({ id: "msg-1", resources: [snapshot], has_resources: true })];
    const next = [row({ id: "msg-1", has_resources: true })];
    expect(retainChatResourceSnapshots(previous, next)[0]?.resources?.[0]).toMatchObject({
      id: "issue-1",
      title: "旅游攻略",
    });
  });

  it("keeps the card across a paged transcript replace", () => {
    const oldData = {
      pages: [{ messages: [row({ id: "msg-1", resources: [snapshot] })], limit: 50, has_more: false }],
      pageParams: [null],
    };
    const newData = {
      pages: [{ messages: [row({ id: "msg-1" })], limit: 50, has_more: false }],
      pageParams: [null],
    };
    const shared = shareChatMessagesPage(oldData, newData) as typeof newData;
    expect(shared.pages[0]?.messages[0]?.resources?.[0]?.issue).toMatchObject({ title: "旅游攻略" });
  });
});
