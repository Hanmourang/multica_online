import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, ChatMessage, ChatResourceRefInput, ChatSession } from "@multica/core/types";

const h = vi.hoisted(() => ({
  activeSessionId: "dm-1",
  sessions: [] as ChatSession[],
  agents: [] as Agent[],
  onSend: null as null | ((
    content: string,
    attachmentIds?: string[],
    commitInput?: () => void,
    draftAttachments?: [],
    resourceRefs?: ChatResourceRefInput[],
  ) => Promise<boolean>),
  sendChatMessage: vi.fn(),
  upsert: vi.fn(),
  seedPending: vi.fn(),
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
  getQueryData: vi.fn(),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  agentListOptions: () => ({ queryKey: ["agents"] }),
  memberListOptions: () => ({ queryKey: ["members"] }),
}));
vi.mock("@multica/core/projects/queries", () => ({
  projectListOptions: () => ({ queryKey: ["projects"] }),
}));
vi.mock("@multica/core/chat/queries", () => ({
  chatSessionsOptions: () => ({ queryKey: ["sessions"] }),
  chatMessagesPageOptions: () => ({ queryKey: ["messages-page"] }),
  pendingChatTaskOptions: () => ({ queryKey: ["pending-task"] }),
  pendingChatTasksOptions: () => ({ queryKey: ["pending-tasks"] }),
  chatQuickActionsPendingOptions: () => ({ queryKey: ["quick-actions"] }),
  chatKeys: {
    messages: (id: string) => ["messages", id],
    messagesPage: (id: string) => ["messages-page", id],
    sessions: (id: string) => ["sessions", id],
    pendingTask: (id: string) => ["pending-task", id],
    pendingTasks: (id: string) => ["pending-tasks", id],
  },
  isTaskMessageTaskId: () => false,
}));
vi.mock("@multica/core/chat/mutations", () => ({
  useCreateChatSession: () => ({ mutateAsync: vi.fn() }),
  useMarkChatSessionRead: () => ({ mutate: vi.fn() }),
  useRegenerateChatQuickActions: () => ({ mutateAsync: vi.fn() }),
  useSetChatSessionArchived: () => ({ mutate: vi.fn() }),
  useSetChatSessionProject: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateChatSession: () => ({ mutate: vi.fn() }),
}));
vi.mock("@multica/core/chat", () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      isOpen: true,
      isExpanded: false,
      activeSessionId: h.activeSessionId,
      selectedAgentId: null,
      selectedProjectId: null,
      setOpen: vi.fn(),
      setActiveSession: vi.fn(),
      setSelectedAgentId: vi.fn(),
      setSelectedProjectId: vi.fn(),
    }),
    { getState: () => ({ activeSessionId: h.activeSessionId }) },
  ),
}));
vi.mock("@multica/core/chat/message-cache", () => ({
  upsertChatMessageToCaches: h.upsert,
  rememberPendingChatResources: () => undefined,
  mergeChatResourceSnapshots: (server: unknown, local: unknown) => server ?? local,
}));
vi.mock("@multica/core/chat/pending", () => ({
  hideQueuedChatMessages: (messages: ChatMessage[]) => messages,
}));
vi.mock("@multica/core/chat/use-quick-actions-pending-timeout", () => ({
  useQuickActionsPendingTimeout: () => undefined,
}));
vi.mock("@multica/core/realtime", () => ({ removeChatMessageFromCaches: vi.fn() }));
vi.mock("@multica/core/agents", () => ({
  isAgentRuntimeBound: () => true,
  useAgentPresenceDetail: () => ({ availability: "online" }),
  useCustomizeConversationStartersHref: () => null,
  useWorkspaceAgentAvailability: () => "available",
}));
vi.mock("@multica/core/api", () => ({
  api: { sendChatMessage: h.sendChatMessage, cancelTaskById: vi.fn() },
  dispatchReasonCode: () => undefined,
}));
vi.mock("@multica/core/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@multica/views/issues/components", () => ({ canAssignAgent: () => true }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: h.invalidateQueries,
    setQueryData: h.setQueryData,
    getQueryData: h.getQueryData,
  }),
  useInfiniteQuery: () => ({
    data: undefined,
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = options.queryKey[0];
    if (key === "sessions") return { data: h.sessions, isSuccess: true };
    if (key === "agents") return { data: h.agents };
    if (key === "members") return { data: [{ user_id: "user-1", role: "admin" }] };
    if (key === "projects") return { data: [], isSuccess: true };
    return { data: null, isLoading: false };
  },
}));
vi.mock("motion/react", async () => {
  const React = await import("react");
  return {
    motion: {
      div: React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<"div">>(
        function MotionDiv({ children, ...props }, ref) {
          const safeProps = Object.fromEntries(
            Object.entries(props).filter(([key]) => !["initial", "animate", "transition"].includes(key)),
          );
          return <div ref={ref} {...safeProps}>{children}</div>;
        },
      ),
    },
  };
});
vi.mock("./chat-input", () => ({
  ChatInput: (props: { onSend: NonNullable<typeof h.onSend> }) => {
    h.onSend = props.onSend;
    return <button type="button">send</button>;
  },
}));
vi.mock("./use-chat-controller", () => ({
  hasInFlightPendingTask: () => false,
  isStillOnComposeTarget: (live: string | null, target: string | null) => live === target,
  planProjectContextChange: vi.fn(),
  seedAcceptedPendingTask: h.seedPending,
}));
vi.mock("../lib/page-surface-context", () => ({
  preparePageSurfaceSend: async (_api: unknown, content: string) => ({
    content,
    attachmentIds: [],
    attachments: [],
  }),
  usePageSurfaceContext: (selector: (state: { context: null }) => unknown) =>
    selector({ context: null }),
}));
vi.mock("../lib/fanout-agents", () => ({
  fanOutChatMessage: vi.fn(),
  useChatFanout: { getState: () => ({ extraAgentIds: [] }) },
}));
vi.mock("./use-chat-draft-restore", () => ({
  useChatDraftRestore: () => ({
    restoreDraftRequest: null,
    enqueueLocalRestore: vi.fn(),
    handleRestoreDraftApplied: vi.fn(),
  }),
}));
vi.mock("./use-chat-task-actions", () => ({
  useChatTaskActions: () => ({
    cancelChatTask: vi.fn(),
    handleEditQueuedTask: vi.fn(),
    handleRemoveQueuedTask: vi.fn(),
    handleClearQueuedTasks: vi.fn(),
    handleSendQueuedTaskNow: vi.fn(),
  }),
}));
vi.mock("./use-chat-input-focus", () => ({
  useChatInputFocus: () => ({ focusRequest: 0, requestInputFocus: vi.fn() }),
}));
vi.mock("./use-quick-actions-failure-toast", () => ({ useQuickActionsFailureToast: () => undefined }));
vi.mock("./use-chat-resize", () => ({
  useChatResize: () => ({
    renderWidth: 420,
    renderHeight: 640,
    isAtMax: false,
    boundsReady: true,
    isDragging: false,
    toggleExpand: vi.fn(),
    startDrag: vi.fn(),
  }),
}));
vi.mock("./use-chat-context-items", () => ({ useChatContextItems: () => [] }));
vi.mock("./use-chat-project-context-support", () => ({ useChatProjectContextSupport: () => true }));
vi.mock("./use-visual-viewport-keyboard", () => ({ useVisualViewportKeyboard: () => null }));
vi.mock("../../common/use-app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("../../i18n", () => ({ useT: () => ({ t: () => "x" }), useLocale: () => "en" }));
vi.mock("@multica/ui/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("./chat-message-list", () => ({ ChatMessageList: () => null, ChatMessageSkeleton: () => null }));
vi.mock("./chat-empty-state", () => ({ ConversationEmpty: () => null, EmptyState: () => null }));
vi.mock("./chat-resize-handles", () => ({ ChatResizeHandles: () => null }));
vi.mock("./chat-queue", () => ({ ChatQueue: () => null }));
vi.mock("./session-rename-input", () => ({ SessionRenameInput: () => null }));

import { ChatWindow } from "./chat-window";
import { api } from "@multica/core/api";

function session(overrides: Partial<ChatSession>): ChatSession {
  return {
    id: "session-1",
    workspace_id: "ws-1",
    agent_id: null,
    creator_id: "user-1",
    title: "Chat",
    status: "active",
    has_unread: false,
    unread_count: 0,
    last_message: null,
    pinned: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const refs: ChatResourceRefInput[] = [
  { type: "issue", id: "issue-1", kind: "task" },
  { type: "document", id: "artifact-1", source: "artifact", project_id: "project-1" },
];
const snapshots = [{ type: "issue" as const, id: "issue-1", kind: "task" as const, access: "granted" as const }];

beforeEach(() => {
  vi.clearAllMocks();
  h.onSend = null;
  h.activeSessionId = "dm-1";
  h.sessions = [session({ id: "dm-1", kind: "dm" })];
  h.agents = [];
  h.sendChatMessage.mockResolvedValue({
    message_id: "message-1",
    created_at: "2026-01-01T00:00:00Z",
    resources: snapshots,
  });
});

describe("ChatWindow resource sends", () => {
  it("forwards resource refs and sender snapshots through a DM send", async () => {
    render(<ChatWindow />);
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    await waitFor(() => expect(h.onSend).not.toBeNull());

    await h.onSend!("share", undefined, undefined, [], refs);

    expect(vi.mocked(api.sendChatMessage)).toHaveBeenCalledWith(
      "dm-1",
      "share",
      undefined,
      { resource_refs: refs },
    );
    expect(h.upsert).toHaveBeenCalledWith(
      expect.anything(),
      "dm-1",
      expect.objectContaining({ resources: snapshots, has_resources: true }),
      { seedIfMissing: true },
    );
  });

  it("forwards resource refs and sender snapshots through an Agent send", async () => {
    h.activeSessionId = "agent-session";
    h.sessions = [session({ id: "agent-session", agent_id: "agent-1", kind: "agent" })];
    h.agents = [{ id: "agent-1", name: "Agent", runtime_id: "runtime-1" } as Agent];
    h.sendChatMessage.mockResolvedValue({
      message_id: "message-1",
      task_id: "task-1",
      created_at: "2026-01-01T00:00:00Z",
      resources: snapshots,
    });
    render(<ChatWindow />);
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    await waitFor(() => expect(h.onSend).not.toBeNull());

    await h.onSend!("", undefined, undefined, [], refs);

    expect(vi.mocked(api.sendChatMessage)).toHaveBeenCalledWith(
      "agent-session",
      "",
      undefined,
      { resource_refs: refs },
    );
    expect(h.upsert).toHaveBeenCalledWith(
      expect.anything(),
      "agent-session",
      expect.objectContaining({ resources: snapshots, has_resources: true }),
      { seedIfMissing: true },
    );
  });
});
