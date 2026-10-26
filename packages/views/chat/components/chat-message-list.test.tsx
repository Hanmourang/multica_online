import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { chatKeys } from "@multica/core/chat/queries";
import type { ChatMessage, ChatPendingTask, TaskMessagePayload } from "@multica/core/types";
import type { ReactElement } from "react";
import enChat from "../../locales/en/chat.json";

// The live timeline is a real list row rather than Virtuoso chrome (MUL-4922),
// so it shares one identity with the persisted assistant row and keeps its
// Mermaid/HTML blocks mounted across task completion. Real react-virtuoso
// renders its Footer but NO data rows under jsdom's zero-height viewport, so
// these tests must stub it to see rows at all. computeItemKey is still applied
// here — it is what expresses the live -> persisted identity.
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId, actorType }: { actorId: string; actorType: string }) => (
    <span data-testid="message-avatar" data-actor-id={actorId} data-actor-type={actorType} />
  ),
}));

vi.mock("../../navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../navigation")>();
  return {
    ...actual,
    AppLink: ({ href, children, ...props }: React.ComponentProps<"a">) => (
      <a href={href} {...props}>{children}</a>
    ),
  };
});

vi.mock("@multica/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/paths")>();
  return {
    ...actual,
    useWorkspacePaths: () => ({
      issueDetail: (id: string) => `/issues/${id}`,
      projectView: (id: string, view: string) => `/projects/${id}?view=${view}`,
      assets: () => "/assets",
    }),
  };
});

vi.mock("@multica/core/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/hooks")>();
  return { ...actual, useWorkspaceId: () => "ws-1" };
});

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    computeItemKey,
    components,
    context,
    followOutput,
  }: {
    data: unknown[];
    itemContent: (i: number, item: unknown) => ReactElement;
    computeItemKey: (i: number, item: unknown) => string;
    components?: { Footer?: (p: { context?: unknown }) => ReactElement | null };
    context?: unknown;
    followOutput?: (atBottom: boolean) => "smooth" | "auto" | false;
  }) => {
    const Footer = components?.Footer;
    return (
      <div
        data-follow-at-bottom={String(followOutput?.(true))}
        data-follow-away-from-bottom={String(followOutput?.(false))}
      >
        {data.map((item, i) => (
          <div key={computeItemKey(i, item)} data-row-key={computeItemKey(i, item)}>
            {itemContent(i, item)}
          </div>
        ))}
        {Footer ? <Footer context={context} /> : null}
      </div>
    );
  },
}));

import { ChatMessageList } from "./chat-message-list";

const TEST_RESOURCES = { en: { chat: enChat } };
const TASK_ID = "6af44cbe-80ab-4dfe-b07d-bd3cfd588f4d";

function taskMsg(
  seq: number,
  type: TaskMessagePayload["type"],
  extra: Partial<TaskMessagePayload> = {},
): TaskMessagePayload {
  return { task_id: TASK_ID, seq, type, ...extra } as TaskMessagePayload;
}

// A streaming timeline whose middle (tool steps) is non-empty, so the live
// footer renders the "N steps" outer fold.
const INITIAL_MESSAGES: TaskMessagePayload[] = [
  taskMsg(0, "text", { content: "Looking into it. " }),
  taskMsg(1, "tool_use", { tool: "Bash", input: { command: "go test ./..." } }),
  taskMsg(2, "tool_result", { tool: "Bash", output: "ok" }),
];

function renderList(qc: QueryClient) {
  qc.setQueryData(chatKeys.taskMessages(TASK_ID), INITIAL_MESSAGES);
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={qc}>
        <ChatMessageList
          messages={[]}
          pendingTask={{ task_id: TASK_ID, status: "running" }}
          availability={undefined}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function pushTaskMessage(qc: QueryClient, msg: TaskMessagePayload) {
  // Mirrors useRealtimeSync's task:message handler: a new array lands in the
  // shared task-messages cache on every streamed message.
  act(() => {
    qc.setQueryData<TaskMessagePayload[]>(
      chatKeys.taskMessages(TASK_ID),
      (old = []) => [...old, msg],
    );
  });
}

describe("ChatMessageList live follow (#6697)", () => {
  it("follows appended output immediately only while Virtuoso is at the live end", () => {
    const { container } = render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            messages={[]}
            pendingTask={null}
            availability="online"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    const list = container.querySelector("[data-follow-at-bottom]");
    expect(list).toHaveAttribute("data-follow-at-bottom", "auto");
    expect(list).toHaveAttribute("data-follow-away-from-bottom", "false");
  });

  it("does not follow while older history is being prepended", () => {
    const { container } = render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            messages={[]}
            pendingTask={null}
            availability="online"
            isFetchingOlderMessages
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(container.querySelector("[data-follow-at-bottom]")).toHaveAttribute(
      "data-follow-at-bottom",
      "false",
    );
  });
});

describe("ChatMessageList live timeline (MUL-3960 regression)", () => {
  // The live footer is passed to Virtuoso through `components`. If that prop
  // is rebuilt inline on render, every streamed task:message unmounts and
  // remounts the whole footer subtree — re-parsing all Markdown and rebuilding
  // thousands of DOM rows, which froze the renderer during long agent runs.
  it("does not remount the live timeline when a streamed message arrives", async () => {
    const qc = new QueryClient();
    renderList(qc);

    const foldTrigger = await screen.findByText("2 steps");
    const footerBefore = foldTrigger.closest("div");

    pushTaskMessage(
      qc,
      taskMsg(3, "tool_use", { tool: "Read", input: { file_path: "/tmp/x" } }),
    );

    // The fold re-renders in place: same DOM node, updated count.
    const updatedTrigger = await screen.findByText("3 steps");
    expect(updatedTrigger.closest("div")).toBe(footerBefore);
    expect(document.contains(foldTrigger)).toBe(true);
  });

  it("keeps the process fold closed by the user across streamed messages", async () => {
    const qc = new QueryClient();
    renderList(qc);

    // Streaming defaults the fold open; the user closes it.
    const foldTrigger = await screen.findByText("2 steps");
    expect(screen.getByText("Bash")).toBeInTheDocument();
    act(() => {
      foldTrigger.click();
    });
    expect(screen.queryByText("Bash")).not.toBeInTheDocument();

    pushTaskMessage(
      qc,
      taskMsg(3, "tool_use", { tool: "Read", input: { file_path: "/tmp/x" } }),
    );

    // Before the fix the footer remounted, useState re-seeded defaultOpen and
    // the fold sprang back open on every streamed message.
    await screen.findByText("3 steps");
    expect(screen.queryByText("Bash")).not.toBeInTheDocument();
  });

  it("applies an embedded surface content transform to streamed text", async () => {
    const qc = new QueryClient();
    qc.setQueryData(chatKeys.taskMessages(TASK_ID), [
      taskMsg(0, "text", {
        content:
          "Draft ready.\n<agent_draft>{\"name\":\"Hidden protocol\"}</agent_draft>",
      }),
    ]);

    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={qc}>
          <ChatMessageList
            messages={[]}
            pendingTask={{ task_id: TASK_ID, status: "running" }}
            availability="online"
            transformContent={(content) =>
              content.replace(
                /<agent_draft>[\s\S]*?<\/agent_draft>/g,
                "",
              )
            }
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(await screen.findByText("Draft ready.")).toBeInTheDocument();
    expect(screen.queryByText(/Hidden protocol/)).not.toBeInTheDocument();
  });

  it("hides a partial quick-actions protocol footer while text streams", async () => {
    const qc = new QueryClient();
    qc.setQueryData(chatKeys.taskMessages(TASK_ID), [
      taskMsg(0, "text", {
        content:
          "Draft ready.\n```quick-actions\n[{\"label\":\"Hidden suggestion\"",
      }),
    ]);

    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={qc}>
          <ChatMessageList
            messages={[]}
            pendingTask={{ task_id: TASK_ID, status: "running" }}
            availability="online"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(await screen.findByText("Draft ready.")).toBeInTheDocument();
    expect(screen.queryByText(/Hidden suggestion/)).not.toBeInTheDocument();
  });
});

describe("ChatMessageList footer spacing", () => {
  it("keeps the bottom inset when no task is pending", () => {
    const { container } = render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            messages={[
              {
                id: "assistant-idle",
                chat_session_id: "session-idle",
                role: "assistant",
                content: "Idle reply",
                task_id: null,
                created_at: "2026-08-12T00:00:00Z",
              },
            ]}
            pendingTask={null}
            availability="online"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    const list = container.querySelector("[data-row-key]")?.parentElement;
    expect(list?.lastElementChild).toHaveClass("pb-4");
    expect(screen.queryByText(/working|queued/i)).not.toBeInTheDocument();
  });
});

describe("ChatMessageList quick actions", () => {
  it("renders up to three suggestions and sends the hidden prompt", async () => {
    const qc = new QueryClient();
    const onQuickAction = vi.fn();
    const quickActions = [
      { label: "Draft the brief", prompt: "Draft the complete launch brief", primary: true },
      { label: "Make a checklist", prompt: "Create a two-week launch checklist" },
      { label: "Define success", prompt: "Define the activation success metric" },
    ];

    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={qc}>
          <ChatMessageList
            messages={[{
              id: "assistant-1",
              chat_session_id: "session-1",
              role: "assistant",
              content: "The plan is ready.",
              task_id: null,
              created_at: "2026-07-22T00:00:00Z",
              quick_actions: quickActions,
            }]}
            pendingTask={null}
            availability="online"
            onQuickAction={onQuickAction}
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(await screen.findByRole("button", { name: "Draft the brief" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Make a checklist" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Define success" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Draft the brief" }));
    expect(onQuickAction).toHaveBeenCalledWith(quickActions[0]);
  });

  it("disables suggestions while another reply is running", async () => {
    const qc = new QueryClient();
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={qc}>
          <ChatMessageList
            messages={[{
              id: "assistant-1",
              chat_session_id: "session-1",
              role: "assistant",
              content: "Ready.",
              task_id: null,
              created_at: "2026-07-22T00:00:00Z",
              quick_actions: [{ label: "Continue", prompt: "Continue" }],
            }]}
            pendingTask={null}
            availability="online"
            onQuickAction={vi.fn()}
            quickActionsDisabled
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(await screen.findByRole("button", { name: "Continue" })).toBeDisabled();
  });
});

describe("ChatMessageList quick actions skeleton", () => {
  const assistantMessage = {
    id: "assistant-1",
    chat_session_id: "session-1",
    role: "assistant" as const,
    content: "The plan is ready.",
    task_id: null,
    created_at: "2026-07-22T00:00:00Z",
  };

  it("renders pill skeletons for the message awaiting its supplement", () => {
    const qc = new QueryClient();
    const { container } = render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={qc}>
          <ChatMessageList
            messages={[assistantMessage]}
            pendingTask={null}
            availability="online"
            onQuickAction={vi.fn()}
            quickActionsPendingMessageId="assistant-1"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );
    expect(container.querySelectorAll(".rounded-full[aria-hidden] , [aria-hidden] .rounded-full").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /suggested/i })).toBeNull();
  });

  it("shows no skeleton for other messages or without onQuickAction", () => {
    const qc = new QueryClient();
    const { container } = render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={qc}>
          <ChatMessageList
            messages={[assistantMessage]}
            pendingTask={null}
            availability="online"
            quickActionsPendingMessageId="assistant-1"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );
    expect(container.querySelector("[aria-hidden] .rounded-full")).toBeNull();
  });
});

describe("ChatMessageList onboarding kickoff", () => {
  it("hides the product-authored kickoff while rendering Mika's reply", async () => {
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            messages={[
              {
                id: "kickoff",
                chat_session_id: "s1",
                role: "user",
                content: "INTERNAL ONBOARDING PROMPT",
                task_id: TASK_ID,
                created_at: new Date(0).toISOString(),
                message_kind: "onboarding_kickoff",
              },
              {
                id: "reply",
                chat_session_id: "s1",
                role: "assistant",
                content: "Hi, I'm Mika.",
                task_id: TASK_ID,
                created_at: new Date(1).toISOString(),
              },
            ]}
            pendingTask={undefined}
            availability="online"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(await screen.findByText("Hi, I'm Mika.")).toBeInTheDocument();
    expect(
      screen.queryByText("INTERNAL ONBOARDING PROMPT"),
    ).not.toBeInTheDocument();
  });
});

describe("ChatMessageList DM author attribution (plan 20261025)", () => {
  // Both participants are humans, so the server persists every message with
  // role: "user". The old role-based logic would put BOTH on the right as
  // "self". For a dm session the side is decided by author_id === currentUserId,
  // so the peer's bubble must align left (justify-start) and the viewer's right
  // (justify-end).
  function bubbleAlign(text: string): string | undefined {
    let node: HTMLElement | null = screen.getByText(text);
    while (node) {
      if (node.className.includes("justify-")) return node.className;
      node = node.parentElement;
    }
    return undefined;
  }

  it("renders a peer's message on the left and the viewer's on the right", async () => {
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            messages={[
              {
                id: "m1",
                chat_session_id: "s1",
                role: "user",
                content: "from peer",
                task_id: null,
                created_at: new Date(0).toISOString(),
                author_type: "member",
                author_id: "user-b",
              },
              {
                id: "m2",
                chat_session_id: "s1",
                role: "user",
                content: "from me",
                task_id: null,
                created_at: new Date(1).toISOString(),
                author_type: "member",
                author_id: "user-a",
              },
            ]}
            pendingTask={undefined}
            availability="online"
            conversationKind="dm"
            currentUserId="user-a"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    await screen.findByText("from peer");
    expect(bubbleAlign("from peer")).toContain("justify-start");
    expect(bubbleAlign("from me")).toContain("justify-end");
    const avatars = screen.getAllByTestId("message-avatar");
    expect(avatars.map((node) => node.getAttribute("data-actor-id"))).toEqual(["user-b", "user-a"]);
    const selfBubble = screen.getByText("from me").parentElement?.parentElement;
    expect(selfBubble?.className).toContain("bg-card");
  });

  it("keeps every role=user message on the right for an agent session (no regression)", async () => {
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            messages={[
              {
                id: "m1",
                chat_session_id: "s1",
                role: "user",
                content: "agent-mode message",
                task_id: null,
                created_at: new Date(0).toISOString(),
              },
            ]}
            pendingTask={undefined}
            availability="online"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    await screen.findByText("agent-mode message");
    expect(bubbleAlign("agent-mode message")).toContain("justify-end");
  });

  it("renders structured resources outside the message content bubble", async () => {
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            messages={[
              {
                id: "resource-message",
                chat_session_id: "s1",
                role: "user",
                content: "shared doc",
                task_id: null,
                created_at: new Date(0).toISOString(),
                author_type: "member",
                author_id: "user-a",
                resources: [{
                  type: "document",
                  id: "artifact-1",
                  source: "artifact",
                  project_id: "project-1",
                  access: "granted",
                  artifact: {
                    id: "artifact-1",
                    project_id: "project-1",
                    rel_path: "docs/prd.md",
                  } as never,
                }],
              },
            ]}
            pendingTask={undefined}
            availability="online"
            conversationKind="dm"
            currentUserId="user-a"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    const content = await screen.findByText("shared doc");
    const resource = screen.getByRole("button", { name: "Preview document" });
    const bubble = content.closest("div.rounded-2xl");
    expect(bubble).not.toBeNull();
    expect(bubble).not.toContainElement(resource);
  });

  it("does not render an empty content bubble for a resource-only message", async () => {
    const { container } = render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            messages={[{
              id: "resource-only-message",
              chat_session_id: "s1",
              role: "user",
              content: "",
              task_id: null,
              created_at: new Date(0).toISOString(),
              author_type: "member",
              author_id: "user-a",
              resources: [{
                type: "document",
                id: "artifact-1",
                source: "artifact",
                project_id: "project-1",
                access: "granted",
                artifact: {
                  id: "artifact-1",
                  project_id: "project-1",
                  rel_path: "docs/prd.md",
                } as never,
              }],
            }]}
            pendingTask={undefined}
            availability="online"
            conversationKind="dm"
            currentUserId="user-a"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(await screen.findByRole("button", { name: "Preview document" })).toBeInTheDocument();
    expect(container.querySelector("div.rounded-2xl")).toBeNull();
  });

  it("keeps the viewer's own DM bubble on a light tint so the text stays readable", async () => {
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            messages={[{
              id: "own-message",
              chat_session_id: "s1",
              role: "user",
              content: "from me",
              task_id: null,
              created_at: new Date(0).toISOString(),
              author_type: "member",
              author_id: "user-a",
            }]}
            pendingTask={undefined}
            availability="online"
            conversationKind="dm"
            currentUserId="user-a"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    const bubble = (await screen.findByText("from me")).closest("div.rounded-2xl");
    expect(bubble).toHaveClass("bg-card", "text-foreground");
  });
});

describe("ChatMessageList group dispatch history", () => {
  function renderDispatch(
    dispatches: Array<{ agent_id: string; task_id?: string; status: string; reason?: string }>,
    agentTasks?: Array<{ agent_id: string; task_id: string; status: string; created_at: string }>,
  ) {
    return render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            conversationKind="group"
            currentUserId="member-1"
            groupAgentNames={new Map([["agent-release", "Release Bot"]])}
            messages={[{
              id: "message-dispatch",
              chat_session_id: "group-1",
              role: "user",
              author_type: "member",
              author_id: "member-1",
              content: "Please review the release",
              task_id: null,
              created_at: new Date(0).toISOString(),
              dispatches,
            }]}
            pendingTask={agentTasks ? { agent_tasks: agentTasks } : null}
            availability="online"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );
  }

  it("renders persisted dispatch outcomes without matching agent ids in the message body", async () => {
    renderDispatch([
      { agent_id: "agent-release", task_id: "task-1", status: "completed" },
      { agent_id: "agent-qa", task_id: "task-2", status: "failed" },
      { agent_id: "agent-private", status: "blocked", reason: "invocation_not_allowed" },
    ]);

    expect(await screen.findByText("Release Bot · Completed")).toBeInTheDocument();
    expect(screen.getByText("Agent · Failed")).toBeInTheDocument();
    expect(screen.getByText("Agent · Blocked")).toBeInTheDocument();
  });

  it("uses the current pending status for the same dispatched task", async () => {
    renderDispatch(
      [{ agent_id: "agent-release", task_id: "task-1", status: "queued" }],
      [{ agent_id: "agent-release", task_id: "task-1", status: "running", created_at: new Date(0).toISOString() }],
    );

    expect(await screen.findByText("Release Bot · Working")).toBeInTheDocument();
    expect(screen.queryByText("Release Bot · Queued")).not.toBeInTheDocument();
  });

  it("hides the working pill after the assistant reply for that task is on screen", async () => {
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            conversationKind="group"
            currentUserId="member-1"
            groupAgentNames={new Map([["agent-release", "Release Bot"]])}
            messages={[
              {
                id: "message-ask",
                chat_session_id: "group-1",
                role: "user",
                author_type: "member",
                author_id: "member-1",
                content: "Please review agent-release",
                task_id: null,
                created_at: new Date(0).toISOString(),
                mentions: [{ type: "agent", id: "agent-release" }],
              },
              {
                id: "message-answer",
                chat_session_id: "group-1",
                role: "assistant",
                author_type: "agent",
                author_id: "agent-release",
                content: "Done",
                task_id: "task-1",
                created_at: new Date(1).toISOString(),
              },
            ]}
            pendingTask={{
              agent_tasks: [{
                agent_id: "agent-release",
                task_id: "task-1",
                status: "running",
                created_at: new Date(0).toISOString(),
              }],
            }}
            availability="online"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(await screen.findByText("Done")).toBeInTheDocument();
    expect(screen.queryByText("Release Bot · Working")).not.toBeInTheDocument();
  });
});

describe("ChatMessageList conversation order", () => {
  // An assistant row is stamped when its task COMPLETES, so a member who asks a
  // second agent while the first is still working persisted the second question
  // BEFORE the first answer — read in created_at order the transcript claimed
  // the member had answered themselves. A reply now renders under the message
  // whose dispatch started its task (see conversation-order.ts).
  function rowKeys(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("[data-row-key]")).map(
      (row) => row.getAttribute("data-row-key") ?? "",
    );
  }

  function renderOrdered(messages: ChatMessage[], pendingTask?: ChatPendingTask | null) {
    return render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            conversationKind="group"
            currentUserId="member-1"
            groupAgentNames={new Map([["agent-a", "Bot A"], ["agent-b", "Bot B"]])}
            messages={messages}
            pendingTask={pendingTask}
            availability="online"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );
  }

  function ask(
    id: string,
    at: number,
    agentId: string,
    taskId: string,
    dispatches?: ChatMessage["dispatches"],
  ): ChatMessage {
    return {
      id,
      chat_session_id: "group-1",
      role: "user",
      author_type: "member",
      author_id: "member-1",
      content: `Please run ${agentId}`,
      task_id: null,
      created_at: new Date(at).toISOString(),
      mentions: [{ type: "agent", id: agentId }],
      ...(dispatches ? { dispatches } : {}),
    };
  }

  function answer(id: string, at: number, agentId: string, taskId: string): ChatMessage {
    return {
      id,
      chat_session_id: "group-1",
      role: "assistant",
      author_type: "agent",
      author_id: agentId,
      content: `${agentId} done`,
      task_id: taskId,
      created_at: new Date(at).toISOString(),
    };
  }

  it("puts each reply under the question it answers, not after the next question", async () => {
    const { container } = renderOrdered([
      ask("ask-a", 0, "agent-a", "task-a", [
        { agent_id: "agent-a", task_id: "task-a", status: "completed" },
      ]),
      ask("ask-b", 2, "agent-b", "task-b", [
        { agent_id: "agent-b", task_id: "task-b", status: "completed" },
      ]),
      answer("reply-a", 3, "agent-a", "task-a"),
      answer("reply-b", 4, "agent-b", "task-b"),
    ]);

    expect(await screen.findByText("agent-a done")).toBeInTheDocument();
    expect(rowKeys(container)).toEqual(["ask-a", "task:task-a", "ask-b", "task:task-b"]);
  });

  it("slots a still-running reply where its persisted message will land", async () => {
    const { container } = renderOrdered(
      [ask("ask-a", 0, "agent-a", "task-a"), ask("ask-b", 2, "agent-b", "task-b")],
      {
        agent_tasks: [
          {
            agent_id: "agent-a",
            task_id: "task-a",
            status: "running",
            created_at: new Date(0).toISOString(),
          },
        ],
      },
    );

    expect(await screen.findByText("Please run agent-a")).toBeInTheDocument();
    expect(rowKeys(container)).toEqual(["ask-a", "task:task-a", "ask-b"]);
  });

  it("holds the original order when no reply has a discoverable trigger", async () => {
    const { container } = renderOrdered([
      ask("ask-a", 0, "agent-a", "task-a"),
      answer("reply-a", 1, "agent-a", "task-a"),
      ask("ask-b", 2, "agent-b", "task-b"),
      answer("reply-b", 3, "agent-b", "task-b"),
    ]);

    expect(await screen.findByText("agent-a done")).toBeInTheDocument();
    expect(rowKeys(container)).toEqual(["ask-a", "task:task-a", "ask-b", "task:task-b"]);
  });
});

describe("ChatMessageList failure copy (MUL-5370 regression)", () => {
  // The backend moved to the refined taxonomy (agent_error.*) in MUL-2946 but
  // the copy map stayed on the six coarse values, so an exact-key lookup
  // missed every refined reason and fell through to the generic fallback.
  // A user whose skill bundle download stalled was told only "Something went
  // wrong", and the maintainer debugging it had nothing better to go on.
  function renderFailure(reason: string) {
    return render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            messages={[
              {
                id: "m1",
                chat_session_id: "s1",
                role: "assistant",
                content: "skill bundle unavailable: skill \"x\"",
                task_id: null,
                created_at: new Date(0).toISOString(),
                failure_reason: reason,
              },
            ]}
            pendingTask={undefined}
            availability="online"
          />
        </QueryClientProvider>
      </I18nProvider>,
    );
  }

  const FALLBACK = enChat.message_list.failure.fallback;

  it("renders dedicated copy for a stalled skill bundle download", async () => {
    renderFailure("skill_bundle_unavailable");
    expect(
      await screen.findByText(enChat.message_list.failure.skill_bundle_unavailable),
    ).toBeInTheDocument();
    expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
  });

  it("renders dedicated copy for a failed environment preparation", async () => {
    // #7913. Without an entry of its own this reason has no agent_error
    // family to degrade into, so it would land on the generic fallback —
    // and the one thing the reader needs to know is that the problem is on
    // the machine running the agent, which the fallback cannot say.
    renderFailure("environment_prepare_failed");
    expect(
      await screen.findByText(
        enChat.message_list.failure.environment_prepare_failed,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
  });

  it("renders dedicated copy for a refined reason the map names", async () => {
    renderFailure("agent_error.provider_network");
    expect(
      await screen.findByText(enChat.message_list.failure.provider_network),
    ).toBeInTheDocument();
  });

  it("degrades an unnamed refined reason to its agent_error family", async () => {
    renderFailure("agent_error.unknown");
    expect(
      await screen.findByText(enChat.message_list.failure.agent_error),
    ).toBeInTheDocument();
    expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
  });

  it("degrades a reason newer than this build to its agent_error family", async () => {
    renderFailure("agent_error.some_future_bucket");
    expect(
      await screen.findByText(enChat.message_list.failure.agent_error),
    ).toBeInTheDocument();
  });

  it("still falls back when neither the reason nor its family is known", async () => {
    renderFailure("something_entirely_new");
    expect(await screen.findByText(FALLBACK)).toBeInTheDocument();
  });
});

describe("ChatMessageList onboarding starter cards", () => {
  // The opening self-describes: the completion path stamps Mika's reply to the
  // hidden kickoff with message_kind "onboarding_opening" (the kickoff row
  // itself never reaches clients).
  const opening = {
    id: "opening",
    chat_session_id: "s1",
    role: "assistant" as const,
    content: "Hi, I'm Mika.",
    task_id: null,
    created_at: new Date(1).toISOString(),
    message_kind: "onboarding_opening" as const,
    quick_actions: [{ label: "LLM chip", prompt: "llm prompt" }],
  };

  function renderCards(overrides: Partial<Parameters<typeof ChatMessageList>[0]> = {}) {
    return render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatMessageList
            messages={[opening]}
            pendingTask={null}
            availability="online"
            onQuickAction={vi.fn()}
            {...overrides}
          />
        </QueryClientProvider>
      </I18nProvider>,
    );
  }

  it("renders the three cards under the opening and hides that turn's chips", async () => {
    renderCards();
    expect(
      await screen.findByRole("button", { name: "Get a board up in minutes" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Hand me one thing first" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Let the daily digest write itself" }),
    ).toBeEnabled();
    // The cards own the opening's suggestion strip — no chip row beside them.
    expect(screen.queryByRole("button", { name: "LLM chip" })).toBeNull();
    expect(screen.queryByText("Follow-up questions")).toBeNull();
  });

  it("sends the card's fixed prompt through the quick-action path", async () => {
    const onQuickAction = vi.fn();
    renderCards({ onQuickAction });
    fireEvent.click(
      await screen.findByRole("button", { name: "Get a board up in minutes" }),
    );
    expect(onQuickAction).toHaveBeenCalledWith({
      label: "Get a board up in minutes",
      prompt: "Turn our current goals into a project board",
    });
  });

  it("follows the chips' disabled rule while a task runs", async () => {
    renderCards({ quickActionsDisabled: true });
    expect(
      await screen.findByRole("button", { name: "Get a board up in minutes" }),
    ).toBeDisabled();
  });

  it("renders ordinary chips, not cards, for an unstamped assistant turn", async () => {
    renderCards({ messages: [{ ...opening, message_kind: "message" as const }] });
    expect(await screen.findByRole("button", { name: "LLM chip" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Get a board up in minutes" }),
    ).toBeNull();
  });

  it("attaches cards only to the stamped opening; later turns keep chips", async () => {
    const followUp = {
      id: "follow-up",
      chat_session_id: "s1",
      role: "assistant" as const,
      content: "Anything else?",
      task_id: null,
      created_at: new Date(2).toISOString(),
      quick_actions: [{ label: "Later chip", prompt: "later" }],
    };
    renderCards({ messages: [opening, followUp] });
    expect(
      await screen.findByRole("button", { name: "Get a board up in minutes" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Later chip" })).toBeEnabled();
  });
});
