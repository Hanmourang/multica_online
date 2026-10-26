import { describe, expect, it } from "vitest";
import {
  orderMessagesForConversation,
  resolveConversationAnchors,
  type ConversationAnchorMessage,
} from "./conversation-order";

interface Row extends ConversationAnchorMessage {
  created_at: string;
}

const row = (
  id: string,
  role: "user" | "assistant",
  created_at: string,
  extra: Partial<Row> = {},
): Row => ({ id, role, created_at, ...extra });

const ids = (rows: Row[]) => rows.map((entry) => entry.id);

describe("resolveConversationAnchors", () => {
  it("links an answer to the dispatch that started its task", () => {
    const messages = [
      row("u1", "user", "21:53", { dispatches: [{ task_id: "t1" }] }),
      row("u2", "user", "21:55", { dispatches: [{ task_id: "t2" }] }),
      row("a1", "assistant", "21:56", { task_id: "t1" }),
      row("a2", "assistant", "21:57", { task_id: "t2" }),
    ];

    const anchors = resolveConversationAnchors(messages);

    expect(anchors.anchorByMessageId.get("a1")).toBe("u1");
    expect(anchors.anchorByMessageId.get("a2")).toBe("u2");
  });

  it("prefers the persisted dispatch over a caller-supplied live anchor", () => {
    const messages = [
      row("u1", "user", "21:53", { dispatches: [{ task_id: "t1" }] }),
      row("u2", "user", "21:55"),
    ];

    const anchors = resolveConversationAnchors(
      messages,
      new Map([["t1", "u2"]]),
    );

    expect(anchors.anchorByTaskId.get("t1")).toBe("u1");
  });

  it("takes the live anchor when the dispatch row is not readable yet", () => {
    const messages = [row("u1", "user", "21:53"), row("u2", "user", "21:55")];

    const anchors = resolveConversationAnchors(messages, new Map([["t1", "u2"]]));

    expect(anchors.anchorByTaskId.get("t1")).toBe("u2");
  });

  it("leaves a reply alone when its trigger is not in the loaded window", () => {
    const messages = [
      row("a1", "assistant", "21:56", { task_id: "t-unknown" }),
      row("u2", "user", "21:57"),
    ];

    const anchors = resolveConversationAnchors(messages);

    expect(anchors.anchorByMessageId.size).toBe(0);
  });

  it("leaves a reply alone when its trigger sorts after it", () => {
    const messages = [
      row("a1", "assistant", "21:50", { task_id: "t1" }),
      row("u1", "user", "21:53", { dispatches: [{ task_id: "t1" }] }),
    ];

    const anchors = resolveConversationAnchors(messages);

    expect(anchors.anchorByMessageId.size).toBe(0);
  });
});

describe("orderMessagesForConversation", () => {
  it("moves each answer under the question it answers", () => {
    const messages = [
      row("u1", "user", "21:53", { dispatches: [{ task_id: "t1" }] }),
      row("u2", "user", "21:55", { dispatches: [{ task_id: "t2" }] }),
      row("a1", "assistant", "21:56", { task_id: "t1" }),
      row("a2", "assistant", "21:57", { task_id: "t2" }),
    ];

    const ordered = orderMessagesForConversation(
      messages,
      resolveConversationAnchors(messages),
    );

    expect(ids(ordered)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("keeps two agents that answered one question in completion order", () => {
    const messages = [
      row("u1", "user", "21:53", {
        dispatches: [{ task_id: "t1" }, { task_id: "t2" }],
      }),
      row("u2", "user", "21:55", { dispatches: [{ task_id: "t3" }] }),
      row("a1", "assistant", "21:56", { task_id: "t1" }),
      row("a2", "assistant", "21:57", { task_id: "t2" }),
      row("a3", "assistant", "21:58", { task_id: "t3" }),
    ];

    const ordered = orderMessagesForConversation(
      messages,
      resolveConversationAnchors(messages),
    );

    expect(ids(ordered)).toEqual(["u1", "a1", "a2", "u2", "a3"]);
  });

  it("holds the position of replies whose trigger is unknown", () => {
    const messages = [
      row("u1", "user", "21:53", { dispatches: [{ task_id: "t1" }] }),
      row("u2", "user", "21:55"),
      row("a0", "assistant", "21:54", { task_id: "legacy" }),
      row("a1", "assistant", "21:56", { task_id: "t1" }),
    ];

    const ordered = orderMessagesForConversation(
      messages,
      resolveConversationAnchors(messages),
    );

    expect(ids(ordered)).toEqual(["u1", "a1", "u2", "a0"]);
  });

  it("keeps answers whose trigger was filtered out of the window", () => {
    const all = [
      row("u1", "user", "21:53", { dispatches: [{ task_id: "t1" }] }),
      row("a1", "assistant", "21:56", { task_id: "t1" }),
    ];
    const anchors = resolveConversationAnchors(all);
    const visibleOnly = all.filter((entry) => entry.id !== "u1");

    const ordered = orderMessagesForConversation(visibleOnly, anchors);

    expect(ids(ordered)).toEqual(["a1"]);
  });

  it("is a no-op when nothing can be anchored", () => {
    const messages = [
      row("u1", "user", "21:53"),
      row("a1", "assistant", "21:54", { task_id: "t1" }),
    ];

    const ordered = orderMessagesForConversation(
      messages,
      resolveConversationAnchors(messages),
    );

    expect(ids(ordered)).toEqual(["u1", "a1"]);
  });
});
