"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useAuthStore } from "@multica/core/auth";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import { projectListOptions } from "@multica/core/projects/queries";
import { canAssignAgent } from "@multica/views/issues/components";
import { api, dispatchReasonCode } from "@multica/core/api";
import {
  isAgentRuntimeBound as hasAgentRuntime,
  useAgentPresenceDetail,
  useCustomizeConversationStartersHref,
  useWorkspaceAgentAvailability,
} from "@multica/core/agents";
import {
  chatSessionsOptions,
  chatMessagesPageOptions,
  pendingChatTaskOptions,
  chatKeys,
  isTaskMessageTaskId,
  sortChatSessions,
} from "@multica/core/chat/queries";
import {
  useCreateChatSession,
  useMarkChatSessionRead,
  useSetChatSessionProject,
  useSetChatSessionArchived,
} from "@multica/core/chat/mutations";
import { useChatStore } from "@multica/core/chat";
import { mergeChatResourceSnapshots, rememberPendingChatResources, upsertChatMessageToCaches } from "@multica/core/chat/message-cache";
import {
  enqueuePendingChatTask,
  hideQueuedChatMessages,
} from "@multica/core/chat/pending";
import { visibleGroupPendingTasks } from "./group-pending-pills";
import { useChatDraftRestore } from "./use-chat-draft-restore";
import { useChatTaskActions } from "./use-chat-task-actions";
import { useChatProjectContextSupport } from "./use-chat-project-context-support";
import { createLogger } from "@multica/core/logger";
import type {
  Agent,
  Attachment,
  ChatMessage,
  ChatMessageResource,
  ChatPendingTask,
  ChatResourceRefInput,
  ConversationKind,
  GroupPendingAgentTask,
} from "@multica/core/types";
import { useT } from "../../i18n";
import { extractMentionsFromContent } from "../lib/mention-extract";
import { preparePageSurfaceSend, usePageSurfaceContext } from "../lib/page-surface-context";
import { fanOutChatMessage, useChatFanout } from "../lib/fanout-agents";
import { useAppForeground } from "../../common/use-app-foreground";

const uiLogger = createLogger("chat.ui");
const apiLogger = createLogger("chat.api");

// Derive a concise session title from the first user message: first line,
// markdown stripped, whitespace collapsed, capped. A deterministic title
// (no LLM) — the server has no summarization model, so this is the sensible
// default until a runtime-generated title is wired up.
const CHAT_TITLE_MAX = 30;
export function deriveChatTitle(content: string): string {
  const firstLine = (content.split("\n").find((l) => l.trim()) ?? content).trim();
  const cleaned = firstLine
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*`>~_]/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown links/images → their text
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= CHAT_TITLE_MAX) return cleaned;
  return cleaned.slice(0, CHAT_TITLE_MAX - 1).trimEnd() + "…";
}

/**
 * After a send resolves: is the user still composing to the target they sent
 * from? Decides whether to scrub the composer and open the sent session, or
 * treat the send as fire-and-forget (the reply surfaces as unread instead).
 *
 * The active session answers this on its own, deliberately. The new-chat
 * composer is ONE box per workspace (see DRAFT_NEW_SESSION), so moving the
 * agent picker re-points where the next send goes without moving the view or
 * the draft slot — that is not "navigating away" (MUL-4864). Counting it as
 * such would leave a completed send's text sitting in the composer, primed to
 * be sent a second time to the agent just picked.
 *
 * Shared by both send chains — the chat tab's controller and the floating
 * ChatWindow — so the rule cannot drift between the two surfaces.
 */
export function isStillOnComposeTarget(
  liveActiveSessionId: string | null,
  sentFromSessionId: string | null,
): boolean {
  return liveActiveSessionId === sentFromSessionId;
}

/**
 * Decide what a project-context change should do, given the open session.
 *
 *  - `awaitSession`: an active session id is set but its row has not loaded
 *    yet. Bail so a persisted selection resolving before its sessions query
 *    cannot misfile a project change into the new-chat draft.
 *  - `detachCurrent`: removing context from the open session — safe in place,
 *    it only changes what future turns receive.
 *  - `startFreshChat`: switching to a DIFFERENT project. A fresh chat is
 *    started so the old project's provider memory / reused workdir cannot
 *    bleed in. It must stay bound to the agent whose session we are leaving
 *    (`agentId`): clearing the active session otherwise drops selection back
 *    to the stored `selectedAgentId`, which can be a stale preference for a
 *    different agent, sending the lazily-created session to the wrong agent.
 *  - `bindCurrent`: a dm/group has no owning agent to fork. Write the project
 *    onto the open session so the next agent turn reads that project.
 *  - `setDraftProject`: no open session, so this only adjusts the new-chat
 *    draft's project.
 *
 * Shared by both send chains — the chat tab's controller and the floating
 * ChatWindow — so the stale-agent rule cannot drift between the two surfaces.
 */
export type ProjectContextChange =
  | { kind: "awaitSession" }
  | { kind: "detachCurrent"; sessionId: string }
  | { kind: "bindCurrent"; sessionId: string; projectId: string }
  | { kind: "startFreshChat"; agentId: string; projectId: string }
  | { kind: "setDraftProject"; projectId: string | null };

export function planProjectContextChange(input: {
  targetProjectId: string | null;
  activeSessionId: string | null;
  currentSession: { id: string; agent_id: string | null } | null;
}): ProjectContextChange {
  if (input.activeSessionId) {
    if (!input.currentSession) return { kind: "awaitSession" };
    if (input.targetProjectId === null) {
      return { kind: "detachCurrent", sessionId: input.currentSession.id };
    }
    // A dm/group conversation has no owning agent to fork a fresh chat onto.
    // Bind the project on this session; a draft-only write would leave
    // activeProjectId on the session row and the picker would look empty.
    if (!input.currentSession.agent_id) {
      return {
        kind: "bindCurrent",
        sessionId: input.currentSession.id,
        projectId: input.targetProjectId,
      };
    }
    return {
      kind: "startFreshChat",
      agentId: input.currentSession.agent_id,
      projectId: input.targetProjectId,
    };
  }
  return { kind: "setDraftProject", projectId: input.targetProjectId };
}

// True when a session has an in-flight pending task in the cache — the signal
// of a just-created (or actively-sending) session still awaiting server
// confirmation, before the sessions-list refetch includes it. `handleSend`
// seeds this task from the server response the instant the send is accepted, so
// it is populated before `setActiveSession` publishes the new session.
// Deliberately NOT "has cached messages": a session deleted elsewhere can still
// have real cached history, which must not exempt it from the stale-session
// self-heal.
export function hasInFlightPendingTask(
  qc: ReturnType<typeof useQueryClient>,
  sessionId: string,
): boolean {
  const pending = qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId));
  return Boolean(pending?.task_id);
}

export function seedAcceptedPendingTask(
  qc: ReturnType<typeof useQueryClient>,
  sessionId: string,
  task: {
    task_id: string;
    created_at: string;
    message_id: string;
    content: string;
    supports_queue?: boolean;
    queued?: boolean;
  },
) {
  qc.setQueryData<ChatPendingTask>(
    chatKeys.pendingTask(sessionId),
    (old) => {
      const next = enqueuePendingChatTask(old, {
        task_id: task.task_id,
        status: "queued",
        created_at: task.created_at,
        message_id: task.message_id,
        content: task.content,
      }, task.queued);
      if (task.supports_queue === true || old?.supports_queue === true) {
        next.supports_queue = true;
      }
      return next;
    },
  );
  qc.invalidateQueries({ queryKey: chatKeys.pendingTask(sessionId) });
}

const CHAT_VIRTUOSO_INITIAL_FIRST_ITEM_INDEX = 1_000_000;


/**
 * Layout-agnostic chat controller. Holds every piece of chat conversation
 * state and behavior — agent resolution, session lookup, the await-then-render
 * send/stop/cancel flow, message pagination, and auto-mark-read — so that
 * both surfaces render the same conversation logic:
 *
 *  - ChatWindow: the floating FAB overlay (adds resize / expand / minimize).
 *  - ChatPage:   the first-class Chat tab (two-pane thread list + conversation).
 *
 * The only thing the caller supplies is `isActive` — whether its surface is
 * currently on screen — which gates auto-mark-read so a background overlay
 * doesn't silently clear unread state the user hasn't actually seen.
 */
export function useChatController(opts?: { isActive?: boolean }) {
  const isActive = opts?.isActive ?? true;
  const { t } = useT("chat");
  const wsId = useWorkspaceId();
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const selectedAgentId = useChatStore((s) => s.selectedAgentId);
  const selectedProjectId = useChatStore((s) => s.selectedProjectId);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const setSelectedAgentId = useChatStore((s) => s.setSelectedAgentId);
  const setSelectedProjectId = useChatStore((s) => s.setSelectedProjectId);
  const user = useAuthStore((s) => s.user);
  const { data: agents = [], isSuccess: agentsLoaded } = useQuery(
    agentListOptions(wsId),
  );
  const { data: members = [], isSuccess: membersLoaded } = useQuery(
    memberListOptions(wsId),
  );
  const { data: sessions = [], isSuccess: sessionsLoaded } = useQuery(
    chatSessionsOptions(wsId),
  );

  // Conversation-kind gate (plan 20261025). Computed from the open session's
  // kind (defaulting to the legacy "agent"), NOT from agent presence: a dm/
  // group session has no owning agent, so every agent-driven affordance —
  // pending-task poll, runtime/queue/quick-action chrome, agent upload gating —
  // must be bypassed. The agent path is left byte-for-byte unchanged.
  const activeSessionKind: ConversationKind =
    (activeSessionId ? sessions.find((s) => s.id === activeSessionId)?.kind : undefined) ??
    "agent";
  const isConversationSession =
    activeSessionKind === "dm" || activeSessionKind === "group";
  const {
    data: projects = [],
    isSuccess: projectsLoaded,
    isPending: projectsPending,
    isError: projectsError,
  } = useQuery(projectListOptions(wsId));
  const {
    data: rawMessagePages,
    isLoading: messagesLoading,
    fetchNextPage: fetchOlderMessages,
    hasNextPage: hasOlderMessages,
    isFetchingNextPage: isFetchingOlderMessages,
  } = useInfiniteQuery(chatMessagesPageOptions(activeSessionId ?? ""));

  const messagePages = activeSessionId ? rawMessagePages?.pages ?? [] : [];
  const allMessages = [...messagePages].reverse().flatMap((page) => page.messages);

  const { data: pendingTask, isLoading: pendingTaskLoading } = useQuery({
    ...pendingChatTaskOptions(activeSessionId ?? ""),
    // dm never enqueues an agent task — polling /pending-task would seed a
    // phantom pill and gate the composer for a session that has no runtime.
    // Group DOES poll: the §6 response carries the per-agent in-flight set
    // (`agent_tasks`) with no root task_id, so it renders the parallel stage
    // pills without touching the single-task pill/queue logic.
    enabled: !!activeSessionId && (!isConversationSession || activeSessionKind === "group"),
  });
  const showSkeleton =
    !!activeSessionId && (messagesLoading || pendingTaskLoading);
  const messages = hideQueuedChatMessages(allMessages, pendingTask);
  const olderMessageCount = messagePages
    .slice(1)
    .reduce((sum, page) => sum + page.messages.length, 0);
  const firstItemIndex =
    messages.length > 0
      ? CHAT_VIRTUOSO_INITIAL_FIRST_ITEM_INDEX - olderMessageCount
      : 0;
  const pendingTaskId = pendingTask?.task_id ?? null;
  // Group parallel-dispatch set (§6). Non-group responses never carry
  // agent_tasks. Declared next to pendingTaskId rather than at the tail of the
  // hook because the running signal and Stop handler below both read it — a
  // group runs N independent tasks and carries no root task_id, which is what
  // used to leave the composer with no Stop affordance at all.
  const groupPendingTasks: GroupPendingAgentTask[] | undefined =
    activeSessionKind === "group"
      ? visibleGroupPendingTasks(pendingTask?.agent_tasks, messages)
      : undefined;
  // "Something is running right now" for the composer. Agent/direct chats key
  // off the single pending task; a group keys off its live per-agent set.
  const isRunning =
    !!pendingTaskId || (groupPendingTasks?.length ?? 0) > 0;
  const stopRequestedBeforeTaskRef = useRef(false);
  // Session whose Stop was pressed before the server had assigned a task id
  // (the send is still being accepted). Kept so the press can be honoured once
  // the real id lands instead of evaporating — see the effect next to
  // handleStop.
  const stopPendingSessionRef = useRef<string | null>(null);
  // Durable deferred-cancellation draft restores (#5219). The whole lifecycle —
  // fetch, offer, skip-and-re-offer, apply, consume, reconcile — lives in this
  // hook, shared with the floating chat window.
  //
  // Gated on isActive AND app foreground: a backgrounded browser tab still renders
  // this controller, and it must not fetch/apply/consume a restore the user is
  // waiting on in a foreground surface. It recovers on its next fetch once the
  // surface is on screen and the app is refocused. (appForeground also gates auto
  // mark-read below.)
  const appForeground = useAppForeground();
  const { restoreDraftRequest, enqueueLocalRestore, handleRestoreDraftApplied } =
    useChatDraftRestore(activeSessionId, isActive && appForeground);
  const {
    cancelChatTask,
    cancellingTaskIds,
    handleEditQueuedTask,
    handleRemoveQueuedTask,
    handleClearQueuedTasks,
    handleSendQueuedTaskNow,
  } = useChatTaskActions(activeSessionId, enqueueLocalRestore);
  // "The user already pressed Stop and we are waiting on the server for that
  // task." Lets the composer answer the press immediately (spinner + label)
  // instead of looking unresponsive while the request is in flight.
  const isCancellingTask = useCallback(
    (taskId: string | null | undefined) =>
      !!taskId && cancellingTaskIds.includes(taskId),
    [cancellingTaskIds],
  );
  // Nonce handed to ChatInput to pull focus into the compose box when a new
  // chat starts. Bumped by handleNewChat / handleStartNewChat only, so
  // selecting an existing chat or a deep link never steals focus.
  const [focusInputRequest, setFocusInputRequest] = useState(0);
  const requestInputFocus = useCallback(
    () => setFocusInputRequest((n) => n + 1),
    [],
  );
  const [conversationStarterRequest, setConversationStarterRequest] = useState<{
    id: number;
    content: string;
  } | null>(null);
  const nextConversationStarterRequestIdRef = useRef(0);
  const prefillConversationStarter = useCallback(
    (prompt: string) => {
      setConversationStarterRequest({
        id: ++nextConversationStarterRequestIdRef.current,
        content: prompt,
      });
      requestInputFocus();
    },
    [requestInputFocus],
  );
  const handleConversationStarterApplied = useCallback(
    () => setConversationStarterRequest(null),
    [],
  );

  const currentSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId)
    : null;
  const isSessionArchived = currentSession?.status === "archived";
  const candidateProjectId = currentSession
    ? currentSession.project_id ?? null
    : selectedProjectId;
  const activeProjectId = candidateProjectId &&
    (!projectsLoaded || projects.some((project) => project.id === candidateProjectId))
    ? candidateProjectId
    : null;

  // A project may be deleted on another client while this workspace's next
  // chat preference is still persisted locally. Normalize it as soon as the
  // authoritative project list settles so a future send cannot carry a stale
  // selection.
  useEffect(() => {
    if (!projectsLoaded || !selectedProjectId) return;
    if (projects.some((project) => project.id === selectedProjectId)) return;
    setSelectedProjectId(null);
  }, [projectsLoaded, projects, selectedProjectId, setSelectedProjectId]);

  const qc = useQueryClient();
  const createSession = useCreateChatSession();
  const markRead = useMarkChatSessionRead();
  const setSessionProject = useSetChatSessionProject();
  const setArchived = useSetChatSessionArchived();

  const currentMember = members.find((m) => m.user_id === user?.id);
  const memberRole = currentMember?.role;
  const availableAgents = agents.filter(
    (a) => !a.archived_at && canAssignAgent(a, user?.id, memberRole),
  );
  // `availableAgents` is only trustworthy once BOTH queries above succeeded:
  // the permission filter reads the member role, so agents-without-members
  // misreports a public_to agent as unavailable. Consumers that must tell
  // "still loading" apart from "settled and not available" (the `?agent=`
  // deep link) gate on this instead of sniffing list emptiness. Query errors
  // deliberately keep this false — a failed fetch is not a permission verdict.
  const agentsSettled = agentsLoaded && membersLoaded;

  // The agent bound to the OPEN session, resolved from the full agent list
  // (archived included, since agentListOptions passes include_archived). An
  // archived agent is filtered out of `availableAgents`, so resolving the
  // active agent only from that list would make an archived-agent session
  // silently render some *other* available agent — wrong avatar/name/presence
  // in the header, and a send that targets the wrong agent. Binding to the
  // session's real agent keeps the conversation honest; the archived state
  // then makes it read-only (see isAgentArchived).
  const sessionAgent = currentSession
    ? agents.find((a) => a.id === currentSession.agent_id) ?? null
    : null;
  const isAgentArchived = !!sessionAgent?.archived_at;

  // Resolve selected agent: open session's agent → stored preference → first
  // available. New chats have no session, so they fall through to the picker.
  // DM/Group have no owning agent. Falling through to the workspace picker
  // would stamp a stranger's name, runtime banner, and send gate onto a
  // human conversation.
  const activeAgent = isConversationSession
    ? null
    : sessionAgent ??
      availableAgents.find((a) => a.id === selectedAgentId) ??
      availableAgents[0] ??
      null;
  const isAgentRuntimeBound = !!activeAgent && hasAgentRuntime(activeAgent);

  // A session outlives the permission that created it. The agent can be flipped
  // to personal, change owner, or drop this member from its allow-list, and the
  // server then refuses every send with `invocation_not_allowed` while still
  // serving the transcript (MUL-4525 — read uses the view gate, send re-runs the
  // invoke gate). Judge the SESSION's agent, not just the picker list, so the
  // composer goes read-only up front instead of after the user types
  // (MUL-6380). Same rule the server enforces, via the shared predicate.
  const isAgentAccessRevoked =
    !!activeAgent && !canAssignAgent(activeAgent, user?.id, memberRole);

  // "Customize" under the starter buttons in the empty state — the only place
  // that admits those buttons are configuration. Resolved here so the full
  // page and the floating window cannot disagree about who sees it.
  const customizeConversationStartersHref = useCustomizeConversationStartersHref(
    activeAgent,
    wsId,
  );

  const agentAvailability = useWorkspaceAgentAvailability();
  const noAgent = agentAvailability === "none";

  const projectContextSupport = useChatProjectContextSupport(wsId, activeAgent);
  const pageSurface = usePageSurfaceContext((state) => state.context);

  const presenceDetail = useAgentPresenceDetail(wsId, activeAgent?.id);
  const availability =
    presenceDetail === "loading" ? undefined : presenceDetail.availability;

  // Auto mark-as-read whenever the user is actively looking at a session with
  // unread state. `isActive` lets the caller say "my surface is on screen":
  // the floating overlay passes `isOpen`, the tab passes `true`. `appForeground`
  // additionally requires the window to be visible and focused: a reply landing
  // while the app is backgrounded must stay unread so the sidebar badges it
  // (MUL-4485); it clears the moment the user returns and this effect re-runs.
  //
  // The read is deferred by a tick and cancelled on cleanup, so a session that
  // is only *momentarily* active never gets marked read. This is the fix for
  // MUL-4360's mount race: `activeSessionId` is persisted, so on a bare `/chat`
  // navigation the page restores the last session for one frame before its
  // URL→store effect (which runs AFTER this hook's effects, since the hook is
  // called first) clears it back to null. Without the defer, that restored-but-
  // never-opened session was marked read in that gap — its badge vanished
  // though the user never opened it (right pane still shows "select a chat").
  // Deferring lets the subsequent activeSessionId change cancel the pending
  // read via cleanup; the store re-check is a belt-and-suspenders guard. Only a
  // session that stays active past the tick — a real select, deep link, or
  // refresh — is read.
  const currentHasUnread =
    sessions.find((s) => s.id === activeSessionId)?.has_unread ?? false;
  useEffect(() => {
    if (!isActive || !appForeground || !activeSessionId) return;
    if (!currentHasUnread) return;
    const sessionId = activeSessionId;
    const timer = setTimeout(() => {
      if (useChatStore.getState().activeSessionId !== sessionId) return;
      uiLogger.info("auto markRead", { sessionId });
      markRead.mutate(sessionId);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markRead ref stable
  }, [isActive, appForeground, activeSessionId, currentHasUnread]);

  const sessionPromiseRef = useRef<Promise<string | null> | null>(null);
  const ensureSession = useCallback(
    async (titleSeed: string): Promise<string | null> => {
      // Trust the current session id only when it's real: present in the
      // loaded list, or a just-created one still awaiting the list refetch
      // (has an optimistic write). A dangling id (deleted / no access) must not
      // be treated as an existing session — fall through and create a fresh one
      // so the message lands somewhere instead of POSTing into a 404.
      if (
        activeSessionId &&
        (!sessionsLoaded ||
          sessions.some((s) => s.id === activeSessionId) ||
          hasInFlightPendingTask(qc, activeSessionId))
      ) {
        return activeSessionId;
      }
      if (!activeAgent) return null;
      if (sessionPromiseRef.current) return sessionPromiseRef.current;

      const promise = (async () => {
        try {
          const session = await createSession.mutateAsync({
            agent_id: activeAgent.id,
            title: deriveChatTitle(titleSeed),
            project_id: activeProjectId,
          });
          return session.id;
        } finally {
          sessionPromiseRef.current = null;
        }
      })();
      sessionPromiseRef.current = promise;
      return promise;
    },
    [
      activeSessionId,
      activeAgent,
      activeProjectId,
      createSession,
      sessions,
      sessionsLoaded,
      qc,
    ],
  );

  // Self-heal a dangling `activeSessionId`. Once the sessions list has loaded
  // and it isn't in the list — with no in-flight optimistic write exempting a
  // just-created session — the id was deleted, lost access, or never existed
  // (a stale `?session=` deep link, or a persisted floating-window selection).
  // Clearing it stops BOTH surfaces (the tab and the floating window) from
  // rendering an editable empty chat whose send would POST into a nonexistent
  // session. Lives in the shared controller so every surface self-heals.
  useEffect(() => {
    if (!activeSessionId || !sessionsLoaded) return;
    if (sessions.some((s) => s.id === activeSessionId)) return;
    if (hasInFlightPendingTask(qc, activeSessionId)) return;
    uiLogger.info("clearing dangling activeSessionId", { sessionId: activeSessionId });
    setActiveSession(null);
  }, [activeSessionId, sessionsLoaded, sessions, qc, setActiveSession]);

  // Upload transport moved into the coordinated-upload engine inside ChatInput
  // (MUL-5181 L2); surfaces only forward whether the affordance exists.
  // dm/group carry attachments too — gate on the conversation, not the agent.
  const uploadEnabled = !!activeAgent || isConversationSession;

  const handleSend = useCallback(
    async (
      content: string,
      attachmentIds?: string[],
      commitInput?: (options?: { extraDraftKeys?: string[]; clearEditor?: boolean }) => void,
      draftAttachments: Attachment[] = [],
      resourceRefs?: ChatResourceRefInput[],
      resourceSnapshots?: ChatMessageResource[],
    ): Promise<boolean> => {
      // dm/group send path (plan 20261025 §6.2). A conversation session has no
      // owning agent, so the entire agent guard chain below (runtime/archived/
      // access/queue) is inapplicable, and the send produces no task. The server
      // persists the member-authored row and fans it to the peers over directed
      // realtime; no pending-task seeding. Reached only when the open session is
      // a dm/group — the agent path below is untouched.
      if (isConversationSession) {
        const dmSessionId = activeSessionId;
        if (!dmSessionId) {
          apiLogger.warn("sendChatMessage skipped: conversation session not open");
          return false;
        }
        let dmPrepared;
        try {
          dmPrepared = await preparePageSurfaceSend(api, content, pageSurface, dmSessionId);
        } catch (err) {
          apiLogger.error("sendChatMessage.pageSurface.error", { sessionId: dmSessionId, err });
          dmPrepared = { content, attachmentIds: [], attachments: [] };
        }
        const dmContent = dmPrepared.content;
        const dmAttachmentIds = [...(attachmentIds ?? []), ...dmPrepared.attachmentIds];
        const dmAttachments = [...draftAttachments, ...dmPrepared.attachments];
        // Both DM and Group submit the mention:// links the editor rendered.
        // The server re-checks that each target is a current participant.
        const dmMentions = extractMentionsFromContent(dmContent);
        rememberPendingChatResources(dmSessionId, dmContent, resourceSnapshots ?? []);
        const dmOptions =
          (dmMentions && dmMentions.length > 0) || (resourceRefs?.length ?? 0) > 0
            ? {
                ...(dmMentions && dmMentions.length > 0 ? { mentions: dmMentions } : {}),
                ...(resourceRefs && resourceRefs.length > 0 ? { resource_refs: resourceRefs } : {}),
              }
            : undefined;
        let dmResult;
        try {
          dmResult = await api.sendChatMessage(
            dmSessionId,
            dmContent,
            dmAttachmentIds.length > 0 ? dmAttachmentIds : undefined,
            dmOptions,
          );
        } catch (err) {
          apiLogger.error("sendChatMessage.conversation.error", { sessionId: dmSessionId, err });
          toast.error(t(($) => $.input.send_failed_toast));
          return false;
        }
        const dmSent: ChatMessage = {
          id: dmResult.message_id,
          chat_session_id: dmSessionId,
          role: "user",
          content: dmContent,
          task_id: null,
          created_at: dmResult.created_at,
          attachments: dmAttachments,
          author_type: "member",
          author_id: user?.id ?? null,
          resources: mergeChatResourceSnapshots(dmResult.resources, resourceSnapshots),
          has_resources: (mergeChatResourceSnapshots(dmResult.resources, resourceSnapshots)?.length ?? 0) > 0 || undefined,
        };
        upsertChatMessageToCaches(qc, dmSessionId, dmSent, { seedIfMissing: true });
        const dmLive = useChatStore.getState();
        const dmStillOnSource = isStillOnComposeTarget(dmLive.activeSessionId, dmSessionId);
        commitInput?.({ extraDraftKeys: [dmSessionId], clearEditor: dmStillOnSource });
        qc.invalidateQueries({ queryKey: chatKeys.messages(dmSessionId) });
        qc.invalidateQueries({ queryKey: chatKeys.messagesPage(dmSessionId) });
        qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
        // Fan-out accepted: refresh the per-agent in-flight set immediately so
        // the stage pills appear without waiting for the next poll/task:queued
        // event (server dispatches one task per mentioned agent, §4).
        if ((dmResult.dispatches?.length ?? 0) > 0) {
          qc.invalidateQueries({ queryKey: chatKeys.pendingTask(dmSessionId) });
        }
        return true;
      }
      if (!activeAgent) {
        apiLogger.warn("sendChatMessage skipped: no active agent");
        return false;
      }
      // Read-only conversation: the agent is retired and can no longer pick up
      // work, so refuse to enqueue a task that would sit orphaned forever. The
      // input is disabled in this state; this is the belt-and-braces guard.
      if (isAgentArchived) {
        apiLogger.warn("sendChatMessage skipped: agent is archived", {
          sessionId: activeSessionId,
          agentId: activeAgent.id,
        });
        return false;
      }
      // Invoke permission was revoked while this session was open. The server
      // would refuse with a 403 before persisting anything; not attempting the
      // send keeps the draft and avoids a pointless roundtrip. The input is
      // disabled in this state — this is the belt-and-braces guard.
      if (isAgentAccessRevoked) {
        apiLogger.warn("sendChatMessage skipped: invoke permission revoked", {
          sessionId: activeSessionId,
          agentId: activeAgent.id,
        });
        return false;
      }
      if (pendingTaskId && pendingTask?.supports_queue !== true) {
        apiLogger.warn("sendChatMessage skipped: server does not support follow-up queues", {
          sessionId: activeSessionId,
        });
        return false;
      }
      if (!isAgentRuntimeBound) {
        toast.error(t(($) => $.input.runtime_required_toast));
        return false;
      }

      const isNewSession = !activeSessionId;

      apiLogger.info("sendChatMessage.start", {
        sessionId: activeSessionId,
        isNewSession,
        agentId: activeAgent.id,
        contentLength: content.length,
        attachmentCount: attachmentIds?.length ?? 0,
      });

      let sessionId: string | null = null;
      try {
        sessionId = await ensureSession(content);
      } catch (err) {
        apiLogger.error("sendChatMessage.ensureSession.error", err);
        // A revoked invoke permission blocks session create with a structured
        // 403 (MUL-4525) — name the cause instead of a generic failure.
        const reason = dispatchReasonCode(err);
        toast.error(
          reason === "invocation_not_allowed"
            ? t(($) => $.input.send_blocked_toast)
            : reason === "agent_runtime_required"
              ? t(($) => $.input.runtime_required_toast)
              : t(($) => $.input.send_failed_toast),
        );
        return false;
      }
      if (!sessionId) {
        apiLogger.warn("sendChatMessage aborted: ensureSession returned null");
        return false;
      }

      // Await-then-render: the composer keeps the user's text and attachments
      // in place (editor locked, button spinning via `submitting`) until the
      // server accepts the send. Nothing is written into the caches, and the
      // draft is never cleared, before the roundtrip settles — a slow send never
      // reads as "posted but the box is still full", and a rejected one keeps
      // the draft for retry (ChatInput never cleared it).
      let prepared;
      try {
        prepared = await preparePageSurfaceSend(api, content, pageSurface, sessionId);
      } catch (err) {
        apiLogger.error("sendChatMessage.pageSurface.error", { sessionId, err });
        prepared = { content, attachmentIds: [], attachments: [] };
      }
      const finalContent = prepared.content;
      const mergedAttachmentIds = [...(attachmentIds ?? []), ...prepared.attachmentIds];
      const mergedAttachments = [...draftAttachments, ...prepared.attachments];
      rememberPendingChatResources(sessionId, finalContent, resourceSnapshots ?? []);

      let result;
      try {
        result = await api.sendChatMessage(
          sessionId,
          finalContent,
          mergedAttachmentIds.length > 0 ? mergedAttachmentIds : undefined,
          resourceRefs && resourceRefs.length > 0
            ? { resource_refs: resourceRefs }
            : undefined,
        );
      } catch (err) {
        apiLogger.error("sendChatMessage.error", { sessionId, err });
        // Invoke permission can be revoked mid-session; the send is refused with
        // a structured 403 before anything persists (MUL-4525). Surface the
        // specific cause so the user knows it is a permission change, not a
        // transient failure they should retry.
        const reason = dispatchReasonCode(err);
        toast.error(
          reason === "invocation_not_allowed"
            ? t(($) => $.input.send_blocked_toast)
            : reason === "agent_runtime_required"
              ? t(($) => $.input.runtime_required_toast)
              : t(($) => $.input.send_failed_toast),
        );
        return false;
      }
      apiLogger.info("sendChatMessage.success", {
        sessionId,
        messageId: result.message_id,
        taskId: result.task_id,
      });

      // Render the accepted message from the server response. Prime the message
      // caches BEFORE publishing the session so the first useQuery read after
      // activeSessionId flips hits data synchronously (no new-chat skeleton
      // flash), and seed the pending task with the server's real id and
      // created_at so the StatusPill mounts anchored to the true clock and the
      // stale-session self-heal exempts this just-created session until the
      // sessions-list refetch includes it.
      const sent: ChatMessage = {
        id: result.message_id,
        chat_session_id: sessionId,
        role: "user",
        content: finalContent,
        task_id: result.task_id ?? null,
        created_at: result.created_at,
        attachments: mergedAttachments,
        resources: mergeChatResourceSnapshots(result.resources, resourceSnapshots),
        has_resources: (mergeChatResourceSnapshots(result.resources, resourceSnapshots)?.length ?? 0) > 0 || undefined,
      };
      // Single door into the message caches (MUL-5711): idempotent by id, so
      // this row and the chat:message echo of the same send converge in either
      // arrival order, and this richer row (it carries the draft attachments)
      // is never downgraded by the echo, which has no attachments field.
      upsertChatMessageToCaches(qc, sessionId, sent, { seedIfMissing: true });
      seedAcceptedPendingTask(qc, sessionId, {
        task_id: result.task_id ?? "",
        created_at: result.created_at,
        message_id: result.message_id,
        content: finalContent,
        supports_queue: result.supports_queue,
        queued: result.queued,
      });
      // Cache primed → publish the new active session, but only if the user
      // hasn't navigated away mid-send. See isStillOnComposeTarget. commitInput
      // clears the sent draft, and scrubs the shared editor only when the user
      // is still on the session they sent from.
      const live = useChatStore.getState();
      const stillOnSourceSession = isStillOnComposeTarget(live.activeSessionId, activeSessionId);
      if (stillOnSourceSession) {
        setActiveSession(sessionId);
      }
      commitInput?.({ extraDraftKeys: [sessionId], clearEditor: stillOnSourceSession });

      if (stopRequestedBeforeTaskRef.current) {
        stopRequestedBeforeTaskRef.current = false;
        await cancelChatTask(result.task_id ?? "", sessionId, {
          restoreDraftToInput: true,
          source: "deferred-send",
        });
        return false;
      }
      if (mergedAttachmentIds.length > 0 && result.attachment_ids) {
        const boundIds = new Set(result.attachment_ids);
        const missing = mergedAttachmentIds.filter((id) => !boundIds.has(id));
        if (missing.length > 0) {
          apiLogger.warn("sendChatMessage.attachments missing after send", {
            sessionId,
            messageId: result.message_id,
            missing,
          });
          toast.error(t(($) => $.input.attachment_bind_failed_toast));
        }
      }
      qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
      qc.invalidateQueries({ queryKey: chatKeys.messagesPage(sessionId) });

      const extraAgentIds = useChatFanout.getState().extraAgentIds;
      if (extraAgentIds.length > 0) {
        const fanout = await fanOutChatMessage({
          extraAgentIds,
          agents: availableAgents,
          content,
          projectId: activeProjectId,
          pageSurface,
          api,
          createSession: (data) => createSession.mutateAsync(data),
        });
        if (fanout.failed === 0) {
          toast.success(t(($) => $.input.fanout_ok, { count: fanout.sent + 1 }));
        } else if (fanout.sent === 0) {
          toast.error(t(($) => $.input.fanout_failed));
        } else {
          toast.error(
            t(($) => $.input.fanout_partial, { sent: fanout.sent + 1, failed: fanout.failed }),
          );
        }
      }
      return true;
    },
    [
      activeSessionId,
      activeAgent,
      isAgentArchived,
      isAgentAccessRevoked,
      pendingTask,
      pendingTaskId,
      isAgentRuntimeBound,
      ensureSession,
      cancelChatTask,
      qc,
      setActiveSession,
      pageSurface,
      availableAgents,
      createSession,
      activeProjectId,
      t,
      isConversationSession,
      activeSessionKind,
      user?.id,
      wsId,
    ],
  );

  // Stop one agent's run inside a group. Each agent owns an independent task,
  // so the per-pill affordance cancels exactly that task and leaves its peers
  // running. Draft restore is off on purpose: a group's triggering message
  // owns no task (chat_message.task_id IS NULL), so there is nothing to put
  // back, and pulling a message out of a shared transcript would be wrong.
  const handleStopAgentTask = useCallback(
    (taskId: string) => {
      if (!activeSessionId || !taskId) return;
      void cancelChatTask(taskId, activeSessionId, {
        restoreDraftToInput: false,
        source: "group-agent-stop",
        reportFailure: true,
      });
    },
    [activeSessionId, cancelChatTask],
  );

  const handleStop = useCallback(() => {
    // Group: there is no single pending task to stop. Cancel every live agent
    // task — the composer's Stop is the "stop everything running here" door,
    // and per-agent pills exist for surgical stops.
    if (activeSessionKind === "group") {
      const taskIds = (groupPendingTasks ?? [])
        .map((task) => task.task_id)
        .filter(Boolean);
      if (!activeSessionId || taskIds.length === 0) {
        apiLogger.debug("cancelTask skipped: no running group agent");
        return;
      }
      apiLogger.info("cancelTask.groupStopAll", {
        sessionId: activeSessionId,
        taskCount: taskIds.length,
      });
      for (const taskId of taskIds) {
        void cancelChatTask(taskId, activeSessionId, {
          restoreDraftToInput: false,
          source: "group-stop-all",
          reportFailure: true,
        });
      }
      return;
    }
    if (!pendingTaskId || !activeSessionId) {
      apiLogger.debug("cancelTask skipped: no pending task");
      return;
    }
    if (!isTaskMessageTaskId(pendingTaskId)) {
      // The send has not been accepted yet, so there is no id to cancel. Keep
      // the intent and fire it from the effect below the moment the real id
      // arrives; the old silent return made Stop look broken at exactly the
      // moment a user reaches for it ("启动中").
      stopRequestedBeforeTaskRef.current = true;
      stopPendingSessionRef.current = activeSessionId;
      apiLogger.info("cancelTask.deferred until server task id", {
        taskId: pendingTaskId,
        sessionId: activeSessionId,
      });
      toast.info(t(($) => $.input.stop_pending_toast));
      return;
    }
    void cancelChatTask(pendingTaskId, activeSessionId, {
      restoreDraftToInput: true,
      source: "active-input",
      reportFailure: true,
    });
  }, [
    activeSessionId,
    activeSessionKind,
    groupPendingTasks,
    pendingTaskId,
    cancelChatTask,
    t,
  ]);

  // Honour a Stop that was pressed before the task id existed. Without this the
  // flag was only consumed by the NEXT send, so the press was lost.
  useEffect(() => {
    const sessionId = stopPendingSessionRef.current;
    if (!sessionId || sessionId !== activeSessionId) return;
    if (!pendingTaskId || !isTaskMessageTaskId(pendingTaskId)) return;
    stopPendingSessionRef.current = null;
    stopRequestedBeforeTaskRef.current = false;
    void cancelChatTask(pendingTaskId, sessionId, {
      restoreDraftToInput: true,
      source: "deferred-stop",
      reportFailure: true,
    });
  }, [activeSessionId, pendingTaskId, cancelChatTask]);

  const handleNewChat = useCallback(() => {
    uiLogger.info("newChat", {
      previousSessionId: activeSessionId,
      previousPendingTask: pendingTaskId,
    });
    // A fresh chat has no project unless the user explicitly chooses one.
    // The open session's project is server-owned history, not a default for
    // the next session.
    setSelectedProjectId(null);
    setActiveSession(null);
    requestInputFocus();
  }, [
    activeSessionId,
    pendingTaskId,
    setSelectedProjectId,
    setActiveSession,
    requestInputFocus,
  ]);

  // Start a fresh chat bound to a chosen agent. Unlike handleSelectAgent this
  // does not no-op when the agent is unchanged — "new chat" always clears the
  // active session so the user lands on an empty compose for that agent. The
  // session row is created lazily on the first send (see ensureSession).
  const handleStartNewChat = useCallback(
    (agent: Agent) => {
      uiLogger.info("startNewChat", {
        agentId: agent.id,
        previousSessionId: activeSessionId,
      });
      setSelectedAgentId(agent.id);
      setSelectedProjectId(null);
      setActiveSession(null);
      requestInputFocus();
    },
    [
      activeSessionId,
      setSelectedAgentId,
      setSelectedProjectId,
      setActiveSession,
      requestInputFocus,
    ],
  );

  const handleSelectSession = useCallback(
    (session: { id: string; agent_id: string | null; project_id?: string | null }) => {
      // Sessions are bound 1:1 to an agent — picking a session from a
      // different agent implicitly switches the agent too. dm/group sessions
      // carry no owning agent (agent_id null) and never drive an agent switch.
      if (session.agent_id && activeAgent && session.agent_id !== activeAgent.id) {
        uiLogger.info("selectSession (cross-agent)", {
          from: activeAgent.id,
          toAgent: session.agent_id,
          toSession: session.id,
        });
        setSelectedAgentId(session.agent_id);
      }
      setActiveSession(session.id);
    },
    [activeAgent, setSelectedAgentId, setActiveSession],
  );

  const handleProjectChange = useCallback(
    (projectId: string | null) => {
      if (projectId === activeProjectId) return;
      uiLogger.info("selectProjectContext", {
        from: activeProjectId,
        to: projectId,
        previousSessionId: activeSessionId,
      });
      const plan = planProjectContextChange({
        targetProjectId: projectId,
        activeSessionId,
        currentSession: currentSession ?? null,
      });
      switch (plan.kind) {
        case "awaitSession":
          return;
        case "detachCurrent":
          setSessionProject.mutate({ sessionId: plan.sessionId, projectId: null });
          break;
        case "bindCurrent":
          setSessionProject.mutate({ sessionId: plan.sessionId, projectId: plan.projectId });
          break;
        case "startFreshChat":
          setSelectedAgentId(plan.agentId);
          setSelectedProjectId(plan.projectId);
          setActiveSession(null);
          break;
        case "setDraftProject":
          setSelectedProjectId(plan.projectId);
          break;
      }
      requestInputFocus();
    }, [
      activeProjectId,
      activeSessionId,
      currentSession,
      setSessionProject,
      setSelectedAgentId,
      setSelectedProjectId,
      setActiveSession,
      requestInputFocus,
    ],
  );

  // Archiving the chat currently in view would otherwise strand the
  // conversation pane on a now read-only, "dangling" session. Mirror the Inbox
  // list: advance selection to the next chat in the (sorted, non-archived)
  // history, fall back to the previous one, and clear only when nothing is
  // left. Routing the non-null advance through handleSelectSession keeps
  // selectedAgentId in sync, so a follow-up "new chat" still defaults to the
  // right agent even when the next chat belongs to a different agent. A no-op
  // when the archived session isn't the open one — that selection stays put.
  const advanceSelectionAfterArchive = useCallback(
    (session: { id: string; agent_id: string | null }) => {
      if (activeSessionId !== session.id) return;
      const history = sortChatSessions(
        sessions.filter((s) => s.status !== "archived"),
      );
      const idx = history.findIndex((s) => s.id === session.id);
      const next = history[idx + 1] ?? history[idx - 1] ?? null;
      if (next) handleSelectSession(next);
      else setActiveSession(null);
    },
    [activeSessionId, sessions, handleSelectSession, setActiveSession],
  );

  const archiveSession = useCallback(
    (sessionId: string) => setArchived.mutate({ sessionId, archived: true }),
    [setArchived],
  );

  const hasMessages = messages.length > 0 || !!pendingTaskId;

  return {
    // identity / lists
    wsId,
    user,
    agents,
    availableAgents,
    agentsSettled,
    sessions,
    projects,
    projectsLoading: projectsPending && !projectsLoaded,
    projectsError,
    activeSessionId,
    selectedAgentId,
    activeProjectId,
    projectContextUnsupported: projectContextSupport === false,
    isProjectUpdating:
      setSessionProject.isPending || (!!activeSessionId && !currentSession),
    currentSession,
    isSessionArchived,
    activeSessionKind,
    isConversationSession,
    isAgentArchived,
    isAgentAccessRevoked,
    isAgentRuntimeBound,
    activeAgent,
    customizeConversationStartersHref,
    noAgent,
    availability,
    // messages
    messages,
    pendingTask,
    pendingTaskId,
    groupPendingTasks,
    isRunning,
    isCancellingTask,
    memberRole,
    showSkeleton,
    hasMessages,
    firstItemIndex,
    hasOlderMessages: !!hasOlderMessages,
    isFetchingOlderMessages,
    fetchOlderMessages,
    // draft restore
    restoreDraftRequest,
    handleRestoreDraftApplied,
    // compose-box focus nonce (bumped on new chat)
    focusInputRequest,
    conversationStarterRequest,
    handleConversationStarterApplied,
    prefillConversationStarter,
    // actions
    handleSend,
    handleStop,
    handleStopAgentTask,
    cancellingTaskIds,
    handleSendQueuedTaskNow,
    handleEditQueuedTask,
    handleRemoveQueuedTask,
    handleClearQueuedTasks,
    uploadEnabled,
    handleNewChat,
    handleStartNewChat,
    handleSelectSession,
    handleProjectChange,
    advanceSelectionAfterArchive,
    archiveSession,
    // store setters (for surfaces that sync selection to the URL, etc.)
    setActiveSession,
    setSelectedAgentId,
  };
}

export type ChatController = ReturnType<typeof useChatController>;
