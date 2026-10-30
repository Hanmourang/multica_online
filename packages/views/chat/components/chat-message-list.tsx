"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { Virtuoso, type Components, type VirtuosoHandle } from "react-virtuoso";
import { cn } from "@multica/ui/lib/utils";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Button } from "@multica/ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@multica/ui/components/ui/collapsible";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@multica/ui/components/ui/tooltip";
import {
  ChevronRight,
  ChevronDown,
  Brain,
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  Copy,
  RotateCw,
} from "lucide-react";
import { useScrollFade } from "@multica/ui/hooks/use-scroll-fade";
import { isTaskMessageTaskId, taskMessagesOptions } from "@multica/core/chat/queries";
import { ActorAvatar } from "../../common/actor-avatar";
import { RichContent } from "../../rich-content";
import { RichContentScrollRootProvider } from "../../rich-content/scroll-root";
import { copyText } from "@multica/ui/lib/clipboard";
import { AttachmentList } from "../../issues/components/comment-card";
import { ImageSequenceProvider } from "../../editor";
import { collectImageSequence } from "@multica/core/attachments/image-sequence";
import type { AgentAvailability } from "@multica/core/agents";
import { resolveFailureReasonKey } from "@multica/core/agents";
import type {
  ChatMessage,
  ChatMessageDispatch,
  ChatParticipant,
  ChatPendingTask,
  ChatQuickAction,
  ConversationKind,
  GroupPendingAgentTask,
  TaskMessagePayload,
} from "@multica/core/types";
import type { ChatTimelineItem } from "@multica/core/chat";
import { buildTimeline } from "../../common/task-transcript";
import { OnboardingStarterCards } from "./onboarding-starter-cards";
import { RunProgressPanel } from "./run-progress-panel";
import {
  GroupDispatchPills,
  GroupPendingPills,
  visibleGroupPendingTasks,
} from "./group-pending-pills";
import { ChatMessageFeedback } from "./chat-message-feedback";
import { ChatMessageResources } from "./chat-message-resources";
import { CHAT_COLUMN, CHAT_GUTTER } from "./chat-column";
import { FOLLOW_EDGE_THRESHOLD } from "../../common/task-transcript/transcript-follow";
import { LIVE_END_ROW_ATTR, useStickToBottom } from "./stick-to-bottom";
import { formatElapsedMs } from "../lib/format";
import { splitTimeline, extractCopyText } from "../lib/copy-text";
import {
  orderMessagesForConversation,
  resolveConversationAnchors,
} from "../lib/conversation-order";
import { visiblePageSurfaceContent } from "../lib/page-surface-context";
import { stripChatQuickActionsProtocol } from "../lib/quick-actions";
import { useT } from "../../i18n";

// ─── Public component ────────────────────────────────────────────────────

interface ChatMessageListProps {
  messages: ChatMessage[];
  /**
   * Server-authoritative pending-task snapshot. `null` / undefined means
   * no in-flight task — list renders without StatusPill.
   */
  pendingTask: ChatPendingTask | null | undefined;
  /** Resolved presence; pass `undefined` while loading to keep the pill copy neutral. */
  availability: AgentAvailability | undefined;
  firstItemIndex?: number;
  hasOlderMessages?: boolean;
  isFetchingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
  /** Transform assistant task text for embedded chat protocols before render/copy. */
  transformContent?: (content: string) => string;
  /** Send the full hidden prompt behind an assistant follow-up chip. */
  onQuickAction?: (action: ChatQuickAction) => void | Promise<unknown>;
  quickActionsDisabled?: boolean;
  /**
   * Regenerate the follow-up suggestions for the session's latest assistant
   * turn (the "refresh" affordance, MUL-5149). Only offered on that turn —
   * regeneration resumes the newest provider state, so an older turn's pills
   * can't be refreshed in place.
   */
  onRegenerateQuickActions?: (message: ChatMessage) => void | Promise<unknown>;
  /**
   * Message currently awaiting its quick-actions supplement (client-only
   * marker raised by chat:done or a refresh) — renders pill skeletons under
   * that reply until chat:quick_actions resolves it.
   */
  quickActionsPendingMessageId?: string | null;
  /**
   * Conversation kind (plan 20261025). For `agent` sessions the legacy
   * role-based bubble side is preserved untouched. For `dm`/`group`, every
   * human message is persisted with `role: "user"`, so the side a bubble lands
   * on is decided by author attribution (`author_id === currentUserId`) rather
   * than role — otherwise both participants would render as "self".
   */
  conversationKind?: ConversationKind;
  /** Current user's id — the reference for DM/Group left/right attribution. */
  currentUserId?: string;
  /**
   * Group agent-id → display name for the parallel-dispatch pills, resolved
   * by the caller from the roster (session.participants / participants
   * query) — the list stays agnostic of where the roster came from.
   */
  groupAgentNames?: Map<string, string>;
  /**
   * Stop one agent's in-flight task. A group fans out one independent task per
   * @-mentioned agent, so the inline pill for a still-running agent carries
   * its own stop control — the runaway run can be cut without stopping the
   * peers that are still producing useful work.
   */
  onStopGroupTask?: (taskId: string) => void;
  participants?: ChatParticipant[];
}

// ─── Virtuoso chrome ─────────────────────────────────────────────────────
//
// Header/Footer MUST be stable component references (module scope), never
// inline arrows in the `components` prop: an inline `components={{ Footer:
// () => … }}` creates a new component *type* every render, so React unmounts
// and remounts the whole Header/Footer subtree each time. During task
// streaming that tore down and rebuilt the entire live timeline — every row
// and every Markdown parse — on every `task:message` event, freezing the
// renderer for seconds at a time (MUL-3960). Per-render data flows through
// Virtuoso's `context` prop instead, which reaches these components as an
// ordinary prop (re-render, not remount).

interface ChatListContext {
  isFetchingOlderMessages: boolean;
  showStatusPill: boolean;
  pendingTask: ChatPendingTask | null | undefined;
  liveTaskMessages: readonly TaskMessagePayload[] | undefined;
  availability: AgentAvailability | undefined;
  /** Group parallel-dispatch set — empty/undefined renders nothing (§6). */
  groupPendingTasks: GroupPendingAgentTask[] | undefined;
  groupAgentNames: Map<string, string> | undefined;
}

/**
 * One Virtuoso row. A live (still-streaming) task and the persisted assistant
 * message it becomes share ONE key — `task:<taskId>` — so the handoff replaces
 * this item's data in place instead of unmounting a Footer subtree and mounting
 * a different row (MUL-4922). That identity is what keeps an already-rendered
 * Mermaid diagram or HTML iframe mounted across task completion.
 */
type ChatRenderItem =
  | { key: string; kind: "message"; message: ChatMessage; taskId: string | null; showDay: boolean }
  | { key: string; kind: "live"; taskId: string; agentId?: string };

/**
 * Row key for a persisted message. Assistant turns carrying a task_id key on
 * the task so they can inherit the live row; everything else keys on its own
 * id.
 */
function localDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function messageClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function messageRowKey(message: ChatMessage): string {
  return message.role === "assistant" && message.task_id
    ? `task:${message.task_id}`
    : message.id;
}

function ChatListHeader({ context }: { context?: ChatListContext }) {
  const { t } = useT("chat");
  return (
    <div className={cn(CHAT_COLUMN, "pt-4")}>
      {context?.isFetchingOlderMessages && (
        <div className="text-center text-caption text-muted-foreground">
          {t(($) => $.message_list.loading_older)}
        </div>
      )}
    </div>
  );
}

// The Footer now carries only the status pill — task chrome, not content. The
// live timeline moved into a real row so it can keep its identity when the
// task completes (see ChatRenderItem).
//
// The pill is wrapped in RunProgressPanel: a one-line "what is it doing" label
// plus the step list derived from the same task:message cache, so a long run
// shows its progress instead of just a spinner.
//
// The container always renders (even with no pill) so the list keeps a
// constant bottom inset: without it the last row's own py-2 was the only gap
// between the final reply (and its follow-up pills) and the composer.
function ChatListFooter({ context }: { context?: ChatListContext }) {
  return (
    <div className={cn(CHAT_COLUMN, "pb-4 space-y-4")}>
      {context?.showStatusPill && context.pendingTask ? (
        <RunProgressPanel
          pendingTask={context.pendingTask}
          taskMessages={context.liveTaskMessages ?? []}
          availability={context.availability}
        />
      ) : null}
    </div>
  );
}

const LIST_COMPONENTS: Components<ChatRenderItem, ChatListContext> = {
  Header: ChatListHeader,
  Footer: ChatListFooter,
};

export function ChatMessageList({
  messages,
  pendingTask,
  availability,
  firstItemIndex = 0,
  hasOlderMessages = false,
  isFetchingOlderMessages = false,
  onLoadOlderMessages,
  transformContent,
  onQuickAction,
  quickActionsDisabled = false,
  onRegenerateQuickActions,
  quickActionsPendingMessageId = null,
  conversationKind = "agent",
  currentUserId,
  groupAgentNames,
  onStopGroupTask,
  participants,
}: ChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);
  const setScrollContainerRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollContainerEl(node);
  }, []);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // The bottom-stick corrects through Virtuoso, never by writing `scrollTop`
  // on the container: `scrollHeight` is an estimate over the unrendered rows,
  // so the pixel bottom moves as Virtuoso measures (see stick-to-bottom.ts).
  const pinToLiveEnd = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
  }, []);
  const { isFollowing, onContentHeightChanged, hasReachedLiveEnd } = useStickToBottom(
    scrollContainerEl,
    pinToLiveEnd,
  );
  // Soft edge fade hinting more content above/below. Kept small so it barely
  // grazes full-bleed previews (image / HTML) at the edges.
  const fadeStyle = useScrollFade(scrollRef, 16);

  const pendingTaskId = pendingTask?.task_id ?? null;
  // Group fan-out runs N tasks in parallel and the response carries no root
  // task_id, so the legacy single-task pill never fires for a group — the
  // per-agent stages render in its place (§6).
  const isGroupConversation = conversationKind === "group";
  const groupPendingTasks = isGroupConversation
    ? visibleGroupPendingTasks(pendingTask?.agent_tasks, messages)
    : undefined;
  // The same scan also yields the task → trigger link the ordering pass needs
  // for a task still in flight. It is a heuristic (the newest message whose
  // body or mentions name the agent) and only a fallback: once `messages`
  // carries `dispatches`, the persisted link wins (see conversation-order.ts).
  const { pendingByMessageId, liveTaskAnchors } = useMemo(() => {
    const byMessage = new Map<string, GroupPendingAgentTask[]>();
    const anchors = new Map<string, string>();
    for (const task of groupPendingTasks ?? []) {
      let triggerId: string | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || message.role !== "user") continue;
        const mentioned =
          message.content.includes(task.agent_id) ||
          message.mentions?.some((mention) => mention.type === "agent" && mention.id === task.agent_id);
        if (mentioned) {
          triggerId = message.id;
          break;
        }
      }
      if (!triggerId) continue;
      if (task.task_id) anchors.set(task.task_id, triggerId);
      const list = byMessage.get(triggerId) ?? [];
      list.push(task);
      byMessage.set(triggerId, list);
    }
    return { pendingByMessageId: byMessage, liveTaskAnchors: anchors };
  }, [groupPendingTasks, messages]);

  // Persisted per-agent fan-out outcomes, keyed by the message that triggered
  // the fan-out. The persisted row records the whole life cycle, but it lags
  // the daemon while the task is still running, so a live pending task with
  // the same id overrides the persisted status. The live set comes from
  // `visibleGroupPendingTasks`, which already drops tasks whose reply is on
  // screen, so a settled task falls back to its persisted outcome.
  const dispatchByMessageId = useMemo(() => {
    const map = new Map<string, ChatMessageDispatch[]>();
    const liveStatus = new Map<string, string>();
    for (const task of groupPendingTasks ?? []) {
      liveStatus.set(task.task_id, task.status);
    }
    for (const message of messages) {
      const dispatches = message.dispatches;
      if (!dispatches?.length) continue;
      map.set(
        message.id,
        dispatches.map((dispatch) => {
          const live = dispatch.task_id
            ? liveStatus.get(dispatch.task_id)
            : undefined;
          return live && live !== dispatch.status
            ? { ...dispatch, status: live }
            : dispatch;
        }),
      );
    }
    return map;
  }, [messages, groupPendingTasks]);

  // The session's newest assistant turn — the only one whose quick actions can
  // be refreshed (regeneration resumes the newest provider state). Computed off
  // the persisted list so the affordance tracks the real tail, not a live row.
  const latestAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "assistant" && m.task_id) return m.id;
    }
    return null;
  }, [messages]);

  // Mika's onboarding opening self-describes (message_kind stamped by the
  // completion path — the hidden kickoff row never reaches clients) and
  // carries the product's starter cards instead of that turn's quick-action
  // chips (MUL-5765).
  const starterCardsMessageId = useMemo(
    () =>
      messages.find(
        (m) => m.role === "assistant" && m.message_kind === "onboarding_opening",
      )?.id ?? null,
    [messages],
  );

  // Once the assistant message for this pending task has landed in the
  // messages list, AssistantMessage owns its rendering — suppress the live
  // timeline (and pill) to avoid rendering the same content in two places
  // during the invalidate → refetch window.
  const pendingAlreadyPersisted = !!pendingTaskId && messages.some(
    (m) => m.role === "assistant" && m.task_id === pendingTaskId,
  );

  // Live timeline for the in-flight task. useRealtimeSync keeps this cache
  // current via setQueryData on task:message events. Only used here to decide
  // whether the live row exists and to feed the status pill — the row itself
  // reads the same cache entry through AssistantMessage.
  const showLiveTimeline = !!pendingTaskId && !pendingAlreadyPersisted;
  const canFetchLiveTimeline = isTaskMessageTaskId(pendingTaskId) && !pendingAlreadyPersisted;
  const { data: liveTaskMessages } = useQuery({
    ...taskMessagesOptions(pendingTaskId ?? ""),
    enabled: canFetchLiveTimeline,
  });
  const hasLive = showLiveTimeline && (liveTaskMessages?.length ?? 0) > 0;
  const showStatusPill = !!pendingTaskId && !pendingAlreadyPersisted && !!pendingTask;

  // Persisted messages plus, while a task is in flight, one synthetic row for
  // it. When the assistant message persists, `hasLive` goes false and the
  // message takes the SAME key at the SAME position — an in-place data swap,
  // not a remount. The onboarding kickoff is a server-authored carrier for
  // Mika's first task, not something the member typed, so it never becomes a
  // visible bubble.
  //
  // Rows render in CONVERSATION order, not `created_at` order. An assistant
  // row is stamped when its task completes, so a group where a member asks a
  // second agent while the first is still working persists the second
  // question "before" the first answer and the transcript reads as if the
  // member answered themselves. Each reply is slotted under the message whose
  // dispatch started its task; replies with no discoverable trigger keep their
  // own position (see conversation-order.ts).
  const renderItems: ChatRenderItem[] = useMemo(() => {
    const anchors = resolveConversationAnchors(messages, liveTaskAnchors);
    const ordered = orderMessagesForConversation(
      messages.filter((message) => message.message_kind !== "onboarding_kickoff"),
      anchors,
    );

    const persistedTaskIds = new Set(
      ordered.flatMap((message) => (message.task_id ? [message.task_id] : [])),
    );
    const liveRows: { taskId: string; agentId?: string }[] = [];
    if (hasLive && pendingTaskId && !persistedTaskIds.has(pendingTaskId)) {
      liveRows.push({ taskId: pendingTaskId });
    }
    for (const task of groupPendingTasks ?? []) {
      if (!task.task_id || persistedTaskIds.has(task.task_id)) continue;
      if (liveRows.some((row) => row.taskId === task.task_id)) continue;
      liveRows.push({ taskId: task.task_id, agentId: task.agent_id });
    }

    // A live row lands in the slot its persisted message will take, after the
    // replies already anchored there — so siblings stay in completion order
    // and the task:… handoff is still an in-place swap at one position. A row
    // with no anchor keeps the trailing position it always had.
    const orderedIds = new Set(ordered.map((message) => message.id));
    const lastReplyByAnchor = new Map<string, string>();
    for (const message of ordered) {
      const anchorId = anchors.anchorByMessageId.get(message.id);
      if (anchorId && orderedIds.has(anchorId)) lastReplyByAnchor.set(anchorId, message.id);
    }
    const liveAfter = new Map<string, { taskId: string; agentId?: string }[]>();
    const trailingLive: { taskId: string; agentId?: string }[] = [];
    for (const row of liveRows) {
      const anchorId = anchors.anchorByTaskId.get(row.taskId);
      const afterId = anchorId ? (lastReplyByAnchor.get(anchorId) ?? anchorId) : undefined;
      if (!afterId || !orderedIds.has(afterId)) {
        trailingLive.push(row);
        continue;
      }
      const bucket = liveAfter.get(afterId) ?? [];
      bucket.push(row);
      liveAfter.set(afterId, bucket);
    }

    const items: ChatRenderItem[] = [];
    const pushLive = (row: { taskId: string; agentId?: string }) => {
      items.push({
        key: `task:${row.taskId}`,
        kind: "live",
        taskId: row.taskId,
        agentId: row.agentId,
      });
    };
    let previousDay = "";
    for (const message of ordered) {
      const day = localDayKey(message.created_at);
      const showDay = day !== "" && day !== previousDay;
      if (day) previousDay = day;
      items.push({
        key: messageRowKey(message),
        kind: "message",
        message,
        taskId: message.task_id ?? null,
        showDay,
      });
      for (const row of liveAfter.get(message.id) ?? []) pushLive(row);
    }
    for (const row of trailingLive) pushLive(row);
    return items;
  }, [messages, hasLive, pendingTaskId, groupPendingTasks, liveTaskAnchors]);

  const firstIndex = renderItems.length > 0 ? firstItemIndex : 0;
  const liveEndKey = renderItems[renderItems.length - 1]?.key ?? null;

  const listContext: ChatListContext = {
    isFetchingOlderMessages,
    showStatusPill,
    pendingTask,
    liveTaskMessages,
    availability,
    groupPendingTasks,
    groupAgentNames,
  };

  // Every image in this session, in message order, so opening one lets the
  // reader page through the rest (MUL-5752). Built from the message data, not
  // from what Virtuoso currently has mounted.
  //
  // Persisted messages only: a task transcript's own attachments live behind a
  // separate query and its blocks are collapsed by default, so an image in
  // there keeps its standalone preview instead of entering a sequence the
  // reader can't see the rest of.
  const imageSequence = useMemo(
    () =>
      collectImageSequence(
        messages.map((message) => ({
          content: message.content,
          attachments: message.attachments,
        })),
      ),
    [messages],
  );

  return (
    <ImageSequenceProvider items={imageSequence}>
    <div
      ref={setScrollContainerRef}
      data-tab-scroll-root
      style={fadeStyle}
      // The gutter lives on the scroll container, so it applies once to the
      // whole list — rows, header, footer — and the scrollbar still rides the
      // surface edge rather than being inset with the text.
      // Hidden until Virtuoso has actually landed on the newest message. The
      // container paints nothing for that whole window anyway — the rows are
      // not measured yet — so this costs no visible time and spares the
      // reader a frame of the wrong messages (see stick-to-bottom.ts).
      className={cn("flex-1 overflow-y-auto", CHAT_GUTTER, !hasReachedLiveEnd && "invisible")}
    >
      {/* Already inside the gutter + column, so this pre-mount frame renders the
       *  skeleton BODY rather than <ChatMessageSkeleton>, which brings its own
       *  wrapper for use as a standalone sibling of the list. */}
      {!scrollContainerEl ? (
        <div className={cn(CHAT_COLUMN, "pt-4")}>
          <ChatSkeletonBody />
        </div>
      ) : (
      // Chat scrolls inside its own element, so rich blocks must measure
      // "near-viewport" against that element rather than the browser viewport —
      // otherwise a diagram only starts loading once it is already on screen.
      <RichContentScrollRootProvider scrollRoot={scrollContainerEl}>
      <Virtuoso
        ref={virtuosoRef}
        customScrollParent={scrollContainerEl}
        data={renderItems}
        firstItemIndex={firstIndex}
        // Open pinned to the newest message. The list is remounted per session
        // (`key={activeSessionId}` upstream), so this initial position is
        // re-applied on every session switch. Without it a fresh Virtuoso
        // renders from the top and the only thing that can scroll it down is
        // `followOutput`, which reacts to post-mount data growth — leaving the
        // landing spot racy: cached sessions resolve synchronously and stick at
        // the top, while fetched ones sometimes catch a growth tick and land at
        // the bottom. `align: "end"` bottom-aligns even a last message taller
        // than the viewport, so switching sessions always shows the latest reply.
        initialTopMostItemIndex={{ index: "LAST", align: "end" }}
        increaseViewportBy={{ top: 400, bottom: 600 }}
        atBottomThreshold={FOLLOW_EDGE_THRESHOLD}
        // Follow rapid streamed output only while Virtuoso says the reader is
        // at the live end. An in-flight smooth animation temporarily reports
        // "not at bottom" on the next append and permanently drops the follow
        // (#6697), so live growth must use an immediate scroll. `isFollowing`
        // narrows this further: the reader may have scrolled away by input the
        // 120px `atBottom` band forgives (see stick-to-bottom.ts).
        followOutput={(atBottom) =>
          !isFetchingOlderMessages && atBottom && isFollowing() ? "auto" : false
        }
        // `followOutput` never fires for a single row growing mid-stream, so
        // content resizes route to the bottom-stick through Virtuoso's own
        // height signal instead.
        totalListHeightChanged={onContentHeightChanged}
        startReached={() => {
          if (hasOlderMessages && !isFetchingOlderMessages) {
            onLoadOlderMessages?.();
          }
        }}
        computeItemKey={(_, item) => item.key}
        context={listContext}
        components={LIST_COMPONENTS}
        itemContent={(_, item) => (
          <div
            className={cn(CHAT_COLUMN, "py-3")}
            {...(item.key === liveEndKey ? { [LIVE_END_ROW_ATTR]: "" } : {})}
          >
            <MessageBubble
              item={item}
              isPending={
                item.kind === "live" ||
                (!!item.taskId &&
                  (item.taskId === pendingTaskId ||
                    (groupPendingTasks ?? []).some((task) => task.task_id === item.taskId)))
              }
              transformContent={transformContent}
              onQuickAction={onQuickAction}
              quickActionsDisabled={quickActionsDisabled}
              onRegenerateQuickActions={onRegenerateQuickActions}
              latestAssistantMessageId={latestAssistantMessageId}
              quickActionsPendingMessageId={quickActionsPendingMessageId}
              starterCardsMessageId={starterCardsMessageId}
              conversationKind={conversationKind}
              currentUserId={currentUserId}
              participants={participants}
              relatedTasks={
                item.kind === "message" && item.message.role === "user"
                  ? pendingByMessageId.get(item.message.id)
                  : undefined
              }
              relatedDispatches={
                item.kind === "message" && item.message.role === "user"
                  ? dispatchByMessageId.get(item.message.id)
                  : undefined
              }
              groupAgentNames={groupAgentNames}
              onStopGroupTask={onStopGroupTask}
            />
          </div>
        )}
      />
      </RichContentScrollRootProvider>
      )}
    </div>
    </ImageSequenceProvider>
  );
}

/**
 * Placeholder shown while `chat_message` for a session is being fetched
 * (initial refresh, or switching to an un-cached session). Shape roughly
 * mirrors an assistant → user → assistant exchange so the window doesn't
 * shift under the user when real messages arrive.
 */
export function ChatMessageSkeleton() {
  return (
    <div className={cn("flex-1 overflow-hidden", CHAT_GUTTER)}>
      <div className={cn(CHAT_COLUMN, "py-4")}>
        <ChatSkeletonBody />
      </div>
    </div>
  );
}

// The rows themselves, so the list's pre-mount frame can drop them straight
// into the gutter + column it already established.
function ChatSkeletonBody() {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-8 w-48 rounded-2xl" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3.5 w-5/6" />
        <Skeleton className="h-3.5 w-1/3" />
      </div>
    </div>
  );
}

// ─── Message bubbles ─────────────────────────────────────────────────────

// memo: every streamed task:message re-renders ChatMessageList, and with it
// every VISIBLE row via itemContent. Message objects are referentially
// stable for unchanged messages and isPending is a boolean, so a shallow
// memo skips reconciling rows the stream didn't touch — the persisted
// history stays inert while only the live footer updates.
const MessageBubble = memo(function MessageBubble({
  item,
  isPending,
  transformContent,
  onQuickAction,
  quickActionsDisabled,
  onRegenerateQuickActions,
  latestAssistantMessageId,
  quickActionsPendingMessageId,
  starterCardsMessageId,
  conversationKind = "agent",
  currentUserId,
  participants,
  groupAgentNames,
  onStopGroupTask,
  relatedTasks,
  relatedDispatches,
}: {
  item: ChatRenderItem;
  isPending: boolean;
  transformContent?: (content: string) => string;
  onQuickAction?: (action: ChatQuickAction) => void | Promise<unknown>;
  quickActionsDisabled: boolean;
  onRegenerateQuickActions?: (message: ChatMessage) => void | Promise<unknown>;
  latestAssistantMessageId: string | null;
  quickActionsPendingMessageId: string | null;
  starterCardsMessageId: string | null;
  conversationKind?: ConversationKind;
  currentUserId?: string;
  participants?: ChatParticipant[];
  groupAgentNames?: Map<string, string>;
  onStopGroupTask?: (taskId: string) => void;
  relatedTasks?: GroupPendingAgentTask[];
  relatedDispatches?: ChatMessageDispatch[];
}) {
  const { t: tConv } = useT("conversations");
  // The live row and the persisted assistant row both land here under one key,
  // and both render <AssistantMessage> — same component type, same position —
  // so React reconciles rather than remounts at task completion.
  if (item.kind === "live") {
    const live = (
      <AssistantMessage
        taskId={item.taskId}
        isPending={isPending}
        transformContent={transformContent}
        onQuickAction={onQuickAction}
        quickActionsDisabled={quickActionsDisabled}
      />
    );
    if (conversationKind !== "group" && conversationKind !== "dm") {
      // The row root MUST have the same element type as the persisted
      // assistant row below (day chip / assistant / feedback). The live →
      // persisted handoff swaps this row's data in place; a different root
      // type would unmount the whole subtree and re-render every diagram it
      // holds (MUL-4922). The nulls keep the three child slots aligned.
      return (
        <div>
          {null}
          {live}
          {null}
        </div>
      );
    }
    const name = (item.agentId && groupAgentNames?.get(item.agentId)) || tConv(($) => $.message.unknown_author);
    return (
      <div>
        {null}
        <AgentFrame name={name} tag={tConv(($) => $.message.agent_tag)} actorId={item.agentId}>
          {live}
        </AgentFrame>
        {null}
      </div>
    );
  }

  const { message } = item;
  const isConversation = conversationKind === "dm" || conversationKind === "group";
  const day = item.showDay ? <DayChip iso={message.created_at} /> : null;

  if (message.author_type === "system") {
    return (
      <div>
        {day}
        <div className="flex items-center gap-3 px-6 text-caption text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          <span>{visiblePageSurfaceContent(message.content)}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      </div>
    );
  }

  if (message.role === "user") {
    // Agent sessions have exactly one human author, so every `role: "user"`
    // message is the current user's — keep the legacy right-aligned bubble
    // untouched (zero regression). dm/group persist every human message as
    // `role: "user"` too, but there are several authors: the side is decided
    // by author attribution. A missing author id stays on the left as unknown
    // instead of being painted as the current user.
    const isSelf = !isConversation
      ? true
      : Boolean(message.author_id && currentUserId && message.author_id === currentUserId);
    const author = participants?.find((participant) => participant.participant_id === message.author_id);
    const authorName = author?.display_name || tConv(($) => $.message.unknown_author);
    const clock = messageClock(message.created_at);
    const content = visiblePageSurfaceContent(message.content);
    const hasContentBubble = content.trim().length > 0 || (message.attachments?.length ?? 0) > 0;
    const tasksForMessage = relatedTasks ?? [];
    // A task that is still in flight already renders as a live pill below.
    // Rendering its persisted dispatch row as well would duplicate it, and the
    // persisted label lags the live one (the row settles only when the task
    // does), so the stale status would be the one the reader sees.
    const liveTaskIds = new Set(tasksForMessage.map((task) => task.task_id));
    const dispatchRows = (relatedDispatches ?? []).filter(
      (dispatch) => !dispatch.task_id || !liveTaskIds.has(dispatch.task_id),
    );
    return (
      <div>
        {day}
        <div className={cn("flex w-full items-start gap-2.5", isSelf ? "justify-end" : "justify-start")}>
          {isConversation && !isSelf && (
            <MessageAvatar
              actorType="member"
              actorId={message.author_id || undefined}
              name={authorName}
              avatarUrl={author?.avatar_url}
            />
          )}
          <div className={cn("flex max-w-[min(78%,620px)] flex-col", isSelf ? "items-end" : "items-start")}>
            {isConversation && !isSelf && (
              <span className="mb-1 flex items-center gap-1.5 px-1 text-micro text-muted-foreground">
                <span className="font-medium text-foreground">{authorName}</span>
                <span className="rounded bg-muted px-1">{tConv(($) => $.message.member_tag)}</span>
                {clock && <time>{clock}</time>}
              </span>
            )}
            {hasContentBubble && (
              <div
                className={cn(
                  "rounded-2xl px-4 py-2.5 text-body break-words text-foreground",
                  isConversation && isSelf
                    ? "rounded-tr-md border border-border bg-card"
                    : isConversation
                      ? "rounded-tl-md border border-border bg-card"
                      : "bg-muted",
                )}
              >
                <RichContent
                  content={content}
                  attachments={message.attachments}
                  density="compact"
                  phase="settled"
                />
                <AttachmentList
                  attachments={message.attachments}
                  content={content}
                  className="mt-1.5"
                />
              </div>
            )}
            <ChatMessageResources message={message} />
            <ChatMessageFeedback
              message={message}
              currentUserId={currentUserId}
              participants={participants}
              allowCompose={!isSelf}
            />
            {tasksForMessage.length > 0 && (
              <div className="mt-1.5">
                <GroupPendingPills
                  tasks={tasksForMessage}
                  agentNames={groupAgentNames}
                  onStop={onStopGroupTask}
                  variant="dock"
                />
              </div>
            )}
            {dispatchRows.length > 0 && (
              <div className="mt-1.5">
                <GroupDispatchPills dispatches={dispatchRows} agentNames={groupAgentNames} />
              </div>
            )}
            {isConversation && isSelf && clock && (
              <div className="mt-1 px-1 text-micro text-muted-foreground">
                {tConv(($) => $.message.sent)} · {clock}
              </div>
            )}
          </div>
          {isConversation && isSelf && (
            <MessageAvatar
              actorType="member"
              actorId={currentUserId}
              name={authorName}
              avatarUrl={author?.avatar_url}
            />
          )}
        </div>
      </div>
    );
  }

  const agentAuthor = participants?.find((participant) => participant.participant_id === message.author_id);
  const assistant = (
    <AssistantMessage
      taskId={message.task_id ?? null}
      message={message}
      isPending={isPending}
      transformContent={transformContent}
      onQuickAction={onQuickAction}
      quickActionsDisabled={quickActionsDisabled}
      onRegenerateQuickActions={onRegenerateQuickActions}
      canRegenerateQuickActions={message.id === latestAssistantMessageId}
      quickActionsPending={quickActionsPendingMessageId === message.id}
      showStarterCards={message.id === starterCardsMessageId}
    />
  );
  const feedback = (
    <ChatMessageFeedback
      message={message}
      currentUserId={currentUserId}
      participants={participants}
      allowCompose
    />
  );
  if (!isConversation) {
    return (
      <div>
        {day}
        {assistant}
        {feedback}
      </div>
    );
  }
  const agentName = agentAuthor?.display_name || tConv(($) => $.message.unknown_author);
  return (
    <div>
      {day}
      <AgentFrame
        name={agentName}
        tag={tConv(($) => $.message.agent_tag)}
        time={messageClock(message.created_at)}
        actorId={message.author_id || undefined}
      >
        {assistant}
      </AgentFrame>
      <div className="pl-11">{feedback}</div>
    </div>
  );
});

function MessageAvatar({
  actorType,
  actorId,
  name,
  avatarUrl,
}: {
  actorType: "member" | "agent";
  actorId?: string;
  name: string;
  avatarUrl?: string | null;
}) {
  if (actorId) {
    return (
      <ActorAvatar
        actorType={actorType}
        actorId={actorId}
        name={name}
        avatarUrl={avatarUrl}
        size="lg"
        enableHoverCard
        profileLink={false}
        className="shrink-0"
      />
    );
  }
  const letter = name.trim().slice(0, 1) || "?";
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-micro font-semibold">
      {letter}
    </span>
  );
}

function AgentFrame({
  name,
  tag,
  time,
  actorId,
  children,
}: {
  name: string;
  tag: string;
  time?: string;
  actorId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full items-start gap-2.5">
      <MessageAvatar actorType="agent" actorId={actorId} name={name} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-1.5 px-1 text-micro text-violet-700">
          <span className="font-medium">{name}</span>
          <span className="rounded bg-violet-100 px-1">{tag}</span>
          {time && <time className="font-normal text-muted-foreground">{time}</time>}
        </div>
        <div className="rounded-2xl rounded-tl-md border border-violet-200 border-l-[3px] border-l-violet-400 bg-card px-4 py-3 text-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}

function DayChip({ iso }: { iso: string }) {
  const { t } = useT("conversations");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const diff = Math.round((start.getTime() - dayStart.getTime()) / 86_400_000);
  const label = diff === 0
    ? t(($) => $.message.today)
    : diff === 1
      ? t(($) => $.message.yesterday)
      : date.toLocaleDateString();
  return (
    <div className="mb-3 flex justify-center">
      <span className="rounded-full border border-border bg-card px-3 py-0.5 text-micro text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/**
 * Assistant turn body — renders BOTH the in-flight (live) and the persisted
 * form of one task (MUL-4922).
 *
 * `message` is undefined while the task streams and becomes the persisted
 * `chat_message` when it lands. Both forms are rendered by this one component,
 * mounted under one stable row key (`task:<taskId>`), so the live → persisted
 * handoff is a prop change rather than an unmount: the RichContent subtree and
 * any Mermaid diagram / HTML iframe inside it stay mounted, keep their pan-zoom
 * state, and never re-run their expensive render. Before this, the live
 * timeline lived in Virtuoso's Footer and the persisted row keyed on
 * `message.id`, so every completed task tore down and rebuilt its diagrams.
 *
 * The timeline itself comes from `taskMessagesOptions(taskId)` in both forms —
 * the same cache entry useRealtimeSync seeds during execution — so no refetch
 * and no data discontinuity happens at the handoff either.
 */
function AssistantMessage({
  taskId,
  message,
  isPending,
  transformContent,
  onQuickAction,
  quickActionsDisabled,
  onRegenerateQuickActions,
  canRegenerateQuickActions = false,
  quickActionsPending = false,
  showStarterCards = false,
}: {
  taskId: string | null;
  message?: ChatMessage;
  isPending: boolean;
  transformContent?: (content: string) => string;
  onQuickAction?: (action: ChatQuickAction) => void | Promise<unknown>;
  quickActionsDisabled: boolean;
  onRegenerateQuickActions?: (message: ChatMessage) => void | Promise<unknown>;
  canRegenerateQuickActions?: boolean;
  quickActionsPending?: boolean;
  /** This turn is Mika's onboarding opening — render starter cards, not chips. */
  showStarterCards?: boolean;
}) {
  const canFetchTaskMessages = isTaskMessageTaskId(taskId);

  // Use the shared taskMessagesOptions so this cache entry is the same one
  // seeded by useRealtimeSync during task execution — zero refetch when the
  // task finishes, since WS already populated it.
  const { data: taskMessages } = useQuery({
    ...taskMessagesOptions(taskId ?? ""),
    enabled: canFetchTaskMessages,
  });

  // Memoized on the cache array identity: mergeTaskMessagesBySeq preserves the
  // array reference when a duplicate event arrives, so this recomputes only
  // when a genuinely new message lands.
  const timeline: ChatTimelineItem[] = useMemo(
    () => transformTimeline(buildTimeline(taskMessages ?? []), transformContent),
    [taskMessages, transformContent],
  );

  // Content is settled once the persisted message exists; until then text is
  // still arriving and a trailing fence may be half-written.
  const phase: "streaming" | "settled" = message ? "settled" : "streaming";

  // Failure bubble path: when the server's FailTask wrote a failure
  // chat_message (failure_reason set), render a destructive bubble with the
  // human-readable reason label + collapsible raw errMsg + the same timeline
  // so the user can see exactly where the run broke.
  if (message?.failure_reason) {
    return (
      <FailureBubble
        reason={message.failure_reason}
        rawError={message.content}
        timeline={timeline}
        elapsedMs={message.elapsed_ms}
      />
    );
  }

  // no_response path (MUL-4351): the agent completed this direct-chat turn
  // without any text. Keep whatever tool/thinking timeline the run produced and
  // show a localized "no text reply" notice instead of an empty markdown block.
  const isNoResponse = message?.message_kind === "no_response";

  return (
    <div className="w-full space-y-1.5">
      {timeline.length > 0 && (
        <TimelineView
          items={timeline}
          attachments={message?.attachments}
          phase={phase}
          isStreaming={!message}
        />
      )}
      {isNoResponse ? (
        <NoResponseNotice />
      ) : message && timeline.length === 0 ? (
        <RichContent
          content={message.content}
          attachments={message.attachments}
          density="compact"
          phase="settled"
          className="leading-relaxed"
        />
      ) : null}
      {message && (
        <>
          <AttachmentList
            attachments={message.attachments}
            content={message.content}
          />
          <ChatMessageResources message={message} />
          <MessageFooter
            message={message}
            timeline={timeline}
            isPending={isPending}
          />
          {onQuickAction && showStarterCards ? (
            // The opening's starter cards own this turn's suggestion strip
            // (MUL-5765); the server skips chip generation for it.
            <OnboardingStarterCards
              onPick={onQuickAction}
              disabled={quickActionsDisabled || isPending}
            />
          ) : onQuickAction && (message.quick_actions?.length ?? 0) > 0 ? (
            <QuickActions
              actions={message.quick_actions ?? []}
              disabled={quickActionsDisabled || isPending}
              onSelect={onQuickAction}
              onRegenerate={
                onRegenerateQuickActions && canRegenerateQuickActions
                  ? () => onRegenerateQuickActions(message)
                  : undefined
              }
              pending={quickActionsPending}
            />
          ) : onQuickAction && quickActionsPending ? (
            <QuickActionsSkeleton />
          ) : null}
        </>
      )}
    </div>
  );
}

function transformTimeline(
  timeline: ChatTimelineItem[],
  transformContent?: (content: string) => string,
): ChatTimelineItem[] {
  return timeline.map((item) =>
    item.type === "text" && item.content
      ? {
          ...item,
          content: transformContent
            ? transformContent(stripChatQuickActionsProtocol(item.content))
            : stripChatQuickActionsProtocol(item.content),
        }
      : item,
  );
}

function QuickActions({
  actions,
  disabled,
  onSelect,
  onRegenerate,
  pending = false,
}: {
  actions: ChatQuickAction[];
  disabled: boolean;
  onSelect: (action: ChatQuickAction) => void | Promise<unknown>;
  /** Present only on the session's latest turn — re-runs the suggestion pass. */
  onRegenerate?: () => void | Promise<unknown>;
  /**
   * The turn is awaiting a supplement (a refresh is in flight): its old pills
   * stay visible but inert, and the refresh icon spins until chat:quick_actions
   * lands. Distinct from the local `regenerating` guard, which only covers the
   * click → HTTP-ack window before the pending marker is observed.
   */
  pending?: boolean;
}) {
  const { t } = useT("chat");
  const [submitting, setSubmitting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // The pending marker is the single source of truth: chat:quick_actions clears
  // it on success, and useQuickActionsPendingTimeout clears it from the query
  // cache if no supplement ever arrives. So `pending` going false is what stops
  // the spinner — no component-local "expired" flag that only masks the UI while
  // the cache stays stuck (MUL-5149 review).
  const blocked = disabled || submitting || regenerating || pending;

  const handleSelect = async (action: ChatQuickAction) => {
    if (blocked) return;
    setSubmitting(true);
    try {
      await onSelect(action);
    } catch {
      // The send path owns user-facing error feedback and optimistic rollback.
      // Re-enable the chip so a transient failure can be retried.
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegenerate = async () => {
    if (blocked || !onRegenerate) return;
    setRegenerating(true);
    try {
      await onRegenerate();
    } catch {
      // The caller's mutation rolls the pending marker back; surface a toast so
      // the silent re-enable isn't mistaken for "no suggestions this time".
      toast.error(t(($) => $.message_list.quick_actions_regenerate_failed));
    } finally {
      setRegenerating(false);
    }
  };

  const regenerateLabel = t(($) => $.message_list.quick_actions_regenerate);

  return (
    <div className="mt-2 border-t border-border/40 pt-2 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div
        className="flex flex-wrap items-center gap-2"
        aria-label={t(($) => $.message_list.quick_actions_aria)}
      >
        <QuickActionsHeading />
        {actions.slice(0, 3).map((action, index) => (
          // The whole pill previews its hidden prompt on hover: clicking
          // sends a message the user has never seen, in their name — the
          // tooltip flips that from commit-then-learn to learn-then-commit.
          <Tooltip key={`${action.label}-${index}`}>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={action.primary ? "brandSubtle" : "outline"}
                  size="sm"
                  className="max-w-full rounded-full px-3"
                  disabled={blocked}
                  onClick={() => void handleSelect(action)}
                />
              }
            >
              <span className="truncate">{action.label}</span>
              {action.primary ? <ArrowUpRight aria-hidden="true" /> : null}
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-sm whitespace-pre-wrap break-words">
              {action.prompt}
            </TooltipContent>
          </Tooltip>
        ))}
        {onRegenerate ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 rounded-full text-faint-foreground hover:text-foreground"
                  disabled={blocked}
                  aria-label={regenerateLabel}
                  onClick={() => void handleRegenerate()}
                />
              }
            >
              <RotateCw
                aria-hidden="true"
                className={
                  pending || regenerating ? "animate-spin" : undefined
                }
              />
            </TooltipTrigger>
            <TooltipContent side="top">{regenerateLabel}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

// Light inline prefix label for the follow-up pill row — the row sits below
// the reply footer ("Replied in Xs · Copy") behind a faint top border, so
// the pills read as a labelled next-steps strip, not part of the reply body.
// shrink-0 keeps the label whole at the row start when narrow widths wrap
// the pills.
function QuickActionsHeading() {
  const { t } = useT("chat");
  return (
    <span className="shrink-0 text-caption text-muted-foreground">
      {t(($) => $.message_list.quick_actions_heading)}
    </span>
  );
}

// Pill-shaped placeholders shown between chat:done (which declared a pending
// supplement) and chat:quick_actions. Widths are staggered so the row reads
// as "buttons coming", not a loading bar. aria-hidden: nothing actionable to
// announce yet.
function QuickActionsSkeleton() {
  // No local timeout: the shared pending marker drives visibility, and
  // useQuickActionsPendingTimeout clears it from the query cache if no
  // chat:quick_actions ever resolves it — so this unmounts on its own instead
  // of only hiding itself while the cache stays stuck (MUL-5149 review).
  return (
    <div className="mt-2 border-t border-border/40 pt-2 animate-in fade-in duration-300">
      <div className="flex flex-wrap items-center gap-2" aria-hidden="true">
        <QuickActionsHeading />
        <Skeleton className="h-8 w-24 rounded-full" />
        <Skeleton className="h-8 w-32 rounded-full" />
        <Skeleton className="h-8 w-28 rounded-full" />
      </div>
    </div>
  );
}

// Muted, localized notice shown in place of assistant text when a turn
// completed with no reply (message_kind === "no_response"). Explains the empty
// turn instead of rendering a blank bubble (MUL-4351).
function NoResponseNotice() {
  const { t } = useT("chat");
  return (
    <div className="text-body italic text-muted-foreground">
      {t(($) => $.message_list.no_response)}
    </div>
  );
}

// Inline footer row beneath the assistant reply: "Replied in 38s · [Copy]".
// Action icons live here (not as a hover-floating overlay) so they're
// discoverable on first read and don't shift content. Buttons stay quiet
// (muted) until hover. Copy is suppressed during streaming because the
// final text is still being appended.
function MessageFooter({
  message,
  timeline,
  isPending,
}: {
  message: ChatMessage;
  timeline: ChatTimelineItem[];
  isPending: boolean;
}) {
  // A no_response turn has nothing to copy, and its caption uses a neutral
  // "Finished in Xs" instead of "Replied in Xs" (MUL-4351).
  const isNoResponse = message.message_kind === "no_response";
  const showCopy = !isPending && !isNoResponse;
  if (message.elapsed_ms == null && !showCopy) return null;
  return (
    <div className="flex items-center gap-1.5">
      {message.elapsed_ms != null && (
        <ElapsedCaption
          variant={isNoResponse ? "finished" : "replied"}
          elapsedMs={message.elapsed_ms}
        />
      )}
      {showCopy && <MessageCopyButton message={message} timeline={timeline} />}
    </div>
  );
}

function MessageCopyButton({
  message,
  timeline,
}: {
  message: ChatMessage;
  timeline: ChatTimelineItem[];
}) {
  const { t } = useT("chat");
  const handleCopy = async () => {
    if (await copyText(extractCopyText(message, timeline))) {
      toast.success(t(($) => $.message_list.copied_toast));
    } else {
      toast.error(t(($) => $.message_list.copy_failed_toast));
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-faint-foreground hover:text-foreground"
            onClick={handleCopy}
            aria-label={t(($) => $.message_list.copy_action)}
          />
        }
      >
        <Copy />
      </TooltipTrigger>
      <TooltipContent side="top">
        {t(($) => $.message_list.copy_action)}
      </TooltipContent>
    </Tooltip>
  );
}

// Persisted "Replied in 38s" / "Failed after 12s" line under the assistant
// bubble. Reads `elapsed_ms` straight off the chat_message — server computes
// it once at task completion, so this caption is identical across reloads
// and devices. Skipped silently when null (legacy messages predating
// migration 063 + user messages).
function ElapsedCaption({
  variant,
  elapsedMs,
  className,
}: {
  variant: "replied" | "failed" | "finished";
  elapsedMs: number;
  className?: string;
}) {
  const { t } = useT("chat");
  const elapsed = formatElapsedMs(elapsedMs);
  const text =
    variant === "replied"
      ? t(($) => $.message_list.replied_in, { elapsed })
      : variant === "finished"
        ? t(($) => $.message_list.finished_in, { elapsed })
        : t(($) => $.message_list.failed_after, { elapsed });
  return (
    <div className={cn("text-caption text-muted-foreground", className)}>
      {text}
    </div>
  );
}

function FailureBubble({
  reason,
  rawError,
  timeline,
  elapsedMs,
}: {
  reason: string;
  rawError: string;
  timeline: ChatTimelineItem[];
  elapsedMs?: number | null;
}) {
  const { t } = useT("chat");
  const [open, setOpen] = useState(false);
  // Chat gets its own friendly, reassuring copy per failure reason — plain
  // language + a "try again" nudge — instead of the terse developer labels
  // (`failureReasonLabel`) used on the agent-detail / execution-log surfaces.
  // The raw error stays tucked under the collapsible below for anyone who
  // wants the technical detail.
  //
  // Keyed by the raw wire value, not a closed enum — `failure_reason` is an
  // open string that grows as classifier rules land, same as
  // `failureReasonLabel`'s map. Deliberately partial: the taxonomy is larger
  // than the set worth writing distinct chat copy for, so an entry earns its
  // place only when it can say something the `agent_error` family line can't,
  // usually a different next step (re-auth, top up, check the network).
  //
  // Where this diverges from the operator surfaces: they fall back to the raw
  // wire value, which is machine-y but searchable. A chat bubble is read by
  // the person who just sent a message, so it degrades through
  // `resolveFailureReasonKey` to the family line and finally to friendly
  // generic copy. The raw error is still one click away under the collapsible.
  const chatFailureCopy: Record<string, string> = {
    agent_error: t(($) => $.message_list.failure.agent_error),
    timeout: t(($) => $.message_list.failure.timeout),
    codex_semantic_inactivity: t(($) => $.message_list.failure.codex_semantic_inactivity),
    runtime_offline: t(($) => $.message_list.failure.runtime_offline),
    runtime_recovery: t(($) => $.message_list.failure.runtime_recovery),
    manual: t(($) => $.message_list.failure.manual),
    cancelled: t(($) => $.message_list.failure.manual),
    skill_bundle_unavailable: t(($) => $.message_list.failure.skill_bundle_unavailable),
    runtime_cli_timeout: t(($) => $.message_list.failure.runtime_cli_timeout),
    environment_prepare_failed: t(($) => $.message_list.failure.environment_prepare_failed),
    "agent_error.provider_network": t(($) => $.message_list.failure.provider_network),
    "agent_error.provider_auth_or_access": t(($) => $.message_list.failure.provider_auth_or_access),
    "agent_error.provider_quota_limit": t(($) => $.message_list.failure.provider_quota_limit),
    "agent_error.provider_capacity_or_rate_limit": t(
      ($) => $.message_list.failure.provider_capacity_or_rate_limit,
    ),
    "agent_error.context_overflow": t(($) => $.message_list.failure.context_overflow),
    "agent_error.runtime_missing_executable": t(
      ($) => $.message_list.failure.runtime_missing_executable,
    ),
    "agent_error.runtime_version_unsupported": t(
      ($) => $.message_list.failure.runtime_version_unsupported,
    ),
  };
  const copyKey = resolveFailureReasonKey(reason, chatFailureCopy);
  const label =
    (copyKey && chatFailureCopy[copyKey]) ??
    t(($) => $.message_list.failure.fallback);

  return (
    <div className="w-full space-y-1.5">
      {/* Failure read as an inline, low-key note — not a destructive
       *  alert. Intentionally borderless / no background tint: a chat
       *  failure is informational ("this didn't work"), not a system
       *  error. The icon + muted destructive text are signal enough,
       *  the rest stays in the normal reply rhythm. */}
      <div className="flex items-start gap-1.5 text-body">
        <AlertTriangle className="size-3.5 shrink-0 text-destructive mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-destructive">{label}</div>
          {rawError.trim() && (
            <Collapsible open={open} onOpenChange={setOpen}>
              <CollapsibleTrigger className="mt-0.5 flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground transition-colors">
                {open ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                <span>{t(($) => $.message_list.show_details)}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/40 p-2 text-caption text-muted-foreground whitespace-pre-wrap break-all">
                  {rawError}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
      {timeline.length > 0 && <TimelineView items={timeline} />}
      {elapsedMs != null && (
        <ElapsedCaption variant="failed" elapsedMs={elapsedMs} />
      )}
    </div>
  );
}

// ─── Timeline: outer process fold + final text (Conductor-style) ─────────
//
// splitTimeline (lib/copy-text.ts) carves the items into:
//   preface — text before the first thinking/tool item
//   middle  — first → last non-text item (inclusive, may sandwich text)
//   final   — text after the last non-text item
//
// We render preface + final outside an outer Collapsible ("X steps") that
// wraps middle. The inner row Collapsibles (ThinkingRow / ToolCallRow /
// ToolResultRow) are unchanged — clicking them toggles independently of
// the outer fold. Copy mirrors what's visible when the outer fold is
// closed: preface + final, never middle. See extractCopyText for the
// authoritative copy logic.

function TimelineView({
  items,
  isStreaming,
  attachments,
  phase = "settled",
}: {
  items: ChatTimelineItem[];
  isStreaming?: boolean;
  attachments?: import("@multica/core/types").Attachment[];
  phase?: "streaming" | "settled";
}) {
  const { preface, middle, final } = splitTimeline(items);

  return (
    <>
      {preface.length > 0 && (
        <RichContent
          content={preface.map((t) => t.content ?? "").join("")}
          attachments={attachments}
          density="compact"
          phase={phase}
          className="leading-relaxed"
        />
      )}
      {middle.length > 0 && (
        <OuterProcessFold
          items={middle}
          isStreaming={!!isStreaming}
          attachments={attachments}
          phase={phase}
        />
      )}
      {final.length > 0 && (
        <RichContent
          content={final.map((t) => t.content ?? "").join("")}
          attachments={attachments}
          density="compact"
          phase={phase}
          className="leading-relaxed"
        />
      )}
    </>
  );
}

function OuterProcessFold({
  items,
  isStreaming,
  attachments,
  phase = "settled",
}: {
  items: ChatTimelineItem[];
  isStreaming?: boolean;
  attachments?: import("@multica/core/types").Attachment[];
  phase?: "streaming" | "settled";
}) {
  const { t } = useT("chat");
  // Open while the task streams (so the user watches progress), collapsed once
  // it settles. This used to fall out of a remount: the live TimelineView was
  // torn down and the persisted one mounted closed. The row is now stable
  // across that handoff (MUL-4922) — which is the point, it keeps Mermaid and
  // HTML blocks alive — so the collapse has to be expressed directly.
  const [open, setOpen] = useState(!!isStreaming);
  const wasStreaming = useRef(!!isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) setOpen(false);
    wasStreaming.current = !!isStreaming;
  }, [isStreaming]);
  const stepCount = items.length;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground transition-colors">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span>{t(($) => $.message_list.process_steps, { count: stepCount })}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 rounded-lg border bg-muted/20 p-2 space-y-0.5">
          {items.map((item) =>
            item.type === "text" ? (
              <MiddleTextRow
                key={item.seq}
                item={item}
                attachments={attachments}
                phase={phase}
              />
            ) : (
              <ItemRow key={item.seq} item={item} />
            ),
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Intermediate text segment rendered inside the outer fold. Visually
// down-shifted (xs / muted) so it reads as part of the agent's process,
// not the final answer — the final answer renders below the fold at full
// prose size.
function MiddleTextRow({
  item,
  attachments,
  phase = "settled",
}: {
  item: ChatTimelineItem;
  attachments?: import("@multica/core/types").Attachment[];
  phase?: "streaming" | "settled";
}) {
  return (
    <div className="py-0.5 text-caption text-muted-foreground">
      <RichContent
        content={item.content ?? ""}
        attachments={attachments}
        density="compact"
        phase={phase}
      />
    </div>
  );
}

// ─── Individual item rows ────────────────────────────────────────────────

function ItemRow({ item }: { item: ChatTimelineItem }) {
  switch (item.type) {
    case "tool_use":
      return <ToolCallRow item={item} />;
    case "tool_result":
      return <ToolResultRow item={item} />;
    case "thinking":
      return <ThinkingRow item={item} />;
    case "error":
      return <ErrorRow item={item} />;
    default:
      return null;
  }
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-2).join("/");
}

function getToolSummary(item: ChatTimelineItem): string {
  if (!item.input) return "";
  const inp = item.input as Record<string, string>;
  if (inp.query) return inp.query;
  if (inp.file_path) return shortenPath(inp.file_path);
  if (inp.path) return shortenPath(inp.path);
  if (inp.pattern) return inp.pattern;
  if (inp.description) return String(inp.description);
  if (inp.command) {
    const cmd = String(inp.command);
    return cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd;
  }
  if (inp.prompt) {
    const p = String(inp.prompt);
    return p.length > 100 ? p.slice(0, 100) + "..." : p;
  }
  if (inp.skill) return String(inp.skill);
  for (const v of Object.values(inp)) {
    if (typeof v === "string" && v.length > 0 && v.length < 120) return v;
  }
  return "";
}

function ToolCallRow({ item }: { item: ChatTimelineItem }) {
  const [open, setOpen] = useState(false);
  const summary = getToolSummary(item);
  const hasInput = item.input && Object.keys(item.input).length > 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded px-1 -mx-1 py-0.5 text-caption hover:bg-accent/30 transition-colors">
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            !hasInput && "invisible",
          )}
        />
        <span className="font-medium text-foreground shrink-0">{item.tool}</span>
        {summary && <span className="truncate text-muted-foreground">{summary}</span>}
      </CollapsibleTrigger>
      {hasInput && (
        <CollapsibleContent>
          <pre className="ml-[18px] mt-0.5 max-h-32 overflow-auto rounded bg-muted/50 p-2 text-caption text-muted-foreground whitespace-pre-wrap break-all">
            {JSON.stringify(item.input, null, 2)}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function ToolResultRow({ item }: { item: ChatTimelineItem }) {
  const { t } = useT("chat");
  const [open, setOpen] = useState(false);
  const output = item.output ?? "";
  if (!output) return null;

  const preview = output.length > 120 ? output.slice(0, 120) + "..." : output;
  const labelPrefix = item.tool
    ? t(($) => $.message_list.tool_result_named, { tool: item.tool })
    : t(($) => $.message_list.tool_result_unnamed);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-start gap-1.5 rounded px-1 -mx-1 py-0.5 text-caption hover:bg-accent/30 transition-colors">
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform mt-0.5", open && "rotate-90")}
        />
        <span className="text-muted-foreground truncate">
          {labelPrefix}{preview}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="ml-[18px] mt-0.5 max-h-40 overflow-auto rounded bg-muted/50 p-2 text-caption text-muted-foreground whitespace-pre-wrap break-all">
          {output.length > 4000 ? output.slice(0, 4000) + "\n... (truncated)" : output}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ThinkingRow({ item }: { item: ChatTimelineItem }) {
  const [open, setOpen] = useState(false);
  const text = item.content ?? "";
  if (!text) return null;

  const preview = text.length > 150 ? text.slice(0, 150) + "..." : text;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-start gap-1.5 rounded px-1 -mx-1 py-0.5 text-caption hover:bg-accent/30 transition-colors">
        <Brain className="h-3 w-3 shrink-0 text-faint-foreground mt-0.5" />
        <span className="text-muted-foreground italic truncate">{preview}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="ml-[18px] mt-0.5 max-h-40 overflow-auto rounded bg-muted/30 p-2 text-caption text-muted-foreground whitespace-pre-wrap break-words">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ErrorRow({ item }: { item: ChatTimelineItem }) {
  return (
    <div className="flex items-start gap-1.5 px-1 -mx-1 py-0.5 text-caption">
      <AlertCircle className="h-3 w-3 shrink-0 text-destructive mt-0.5" />
      <span className="text-destructive">{item.content}</span>
    </div>
  );
}

// ─── Shared ──────────────────────────────────────────────────────────────
