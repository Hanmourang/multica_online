import type { AgentTask } from "./agent";
import type { Issue } from "./issue";
import type { ProjectArtifact } from "./artifact";

/** A user's pinned "quick agent" for the Chat list top bar. */
export interface ChatPinnedAgent {
  agent_id: string;
  position: number;
}

/**
 * Conversation kind (plan 20261025 §6). Additive: an older server omits it, so
 * treat a missing/unknown value as "agent" — the pre-existing single-agent
 * conversation. "dm" is a private 1:1 between two members (no agent), "group"
 * a multi-member room that may @-fan-out to agents.
 */
export type ConversationKind = "agent" | "dm" | "group";

/** Who authored a chat message. "member" for human authors in dm/group, "agent"
 *  for assistant replies, "system" for platform-synthesized rows. */
export type ChatAuthorType = "member" | "agent" | "system";

/** A resolved @-mention target inside a dm/group message. */
export interface ChatMention {
  type: "member" | "agent";
  id: string;
}

export type ChatResourceRefInput =
  | { type: "issue"; id: string; kind: "task" | "requirement" }
  | {
      type: "document";
      id: string;
      source: "artifact" | "attachment";
      project_id?: string;
    };

/** Server-resolved resource card. No client-provided title/path is trusted. */
export interface ChatMessageResource {
  type: "issue" | "document";
  id: string;
  kind?: "task" | "requirement";
  source?: "artifact" | "attachment";
  project_id?: string;
  access: "granted" | "denied" | "missing";
  /** Composer-only label for a picker result; send DTOs retain only the ref. */
  title?: string;
  issue?: Issue;
  artifact?: ProjectArtifact;
  attachment?: import("./attachment").Attachment;
}

/**
 * A first-class participant of a dm/group conversation. Carries the per-member
 * read/pin/archived cursors so one member's actions never move another's view.
 */
export interface ChatParticipant {
  chat_session_id: string;
  participant_type: "member" | "agent";
  participant_id: string;
  display_name: string;
  avatar_url?: string | null;
  admin: boolean;
  joined_at: string;
  last_read_at: string;
  last_read_message_id?: string | null;
  pinned?: boolean;
}

/**
 * Per-agent outcome of a group send fan-out. A single @-multi-agent message
 * dispatches an independent task per mentioned agent; each reports whether it
 * queued or was blocked (e.g. no access to the room's agent).
 */
export interface ChatAgentDispatch {
  agent_id: string;
  task_id?: string;
  status: "queued" | "blocked";
  reason?: string;
}

/**
 * Persisted per-agent outcome of a group fan-out, attached to the message
 * that triggered it. The send response only reports the initial queue/block
 * decision; the persisted row carries the whole life cycle
 * (queued → running → completed / failed / blocked) so a reader can see who
 * answered and who did not, even after the live pill is gone.
 */
export interface ChatMessageDispatch {
  agent_id: string;
  task_id?: string | null;
  /** Free-form server status; see the stage map in group-pending-pills.tsx. */
  status: string;
  reason?: string | null;
}

/**
 * Kind of a chat message. Additive (MUL-4351): the server always sends a
 * concrete value, but treat a missing/unknown value as "message" so an older
 * server or a future kind never breaks rendering.
 * - "message"     — an ordinary user/assistant message.
 * - "no_response" — a completed direct-chat turn that produced no text reply.
 * - "onboarding_kickoff" — a product-authored opening input that is sent to
 *   Mika but never rendered as a member message.
 * - "onboarding_opening" — Mika's reply to the kickoff; chat renders the
 *   onboarding starter cards under it instead of quick-action chips.
 */
export type ChatMessageKind =
  | "message"
  | "no_response"
  | "onboarding_kickoff"
  | "onboarding_opening";

/**
 * A concise follow-up offered by an assistant reply. `label` is rendered in
 * the UI while `prompt` is the full text sent back to the agent. At most one
 * action should be primary; clients still render safely if an older or future
 * server sends more than one.
 */
export interface ChatQuickAction {
  label: string;
  prompt: string;
  primary?: boolean;
}

/**
 * Client-only marker (never persisted, never fetched) that the identified
 * turn's quick-actions supplement is still in flight — drives the pill
 * skeleton between chat:done and chat:quick_actions.
 */
export interface ChatQuickActionsPendingState {
  message_id: string;
  task_id: string;
  /**
   * Absolute epoch-ms deadline after which a client gives up waiting for the
   * chat:quick_actions supplement and clears this marker. Stored on the marker
   * (not as a component timer) so switching chat surfaces — which unmounts and
   * remounts the timeout hook — resumes the SAME deadline instead of re-arming
   * a fresh window each time (MUL-5149 review).
   */
  expires_at: number;
}

/**
 * Client-only signal (never persisted, never fetched) that an explicit refresh's
 * background regeneration FAILED — the daemon suggestion pass never completed, so
 * the turn's pills are unchanged. Set by the realtime layer off a failed
 * chat:quick_actions and consumed once by a view to toast "couldn't refresh"
 * before clearing itself. `at` is a per-event nonce so a second failure re-fires
 * even when the message_id repeats (MUL-5149 review).
 */
export interface ChatQuickActionsFailureState {
  message_id: string;
  at: number;
}

/** Preview of a session's most recent message, for the IM-style list. */
export interface ChatLastMessage {
  content: string;
  role: "user" | "assistant";
  created_at: string;
  /** Present when the last message is a failed assistant reply. */
  failure_reason?: string | null;
  /** "message" (default) or "no_response". Optional for older servers. */
  message_kind?: ChatMessageKind;
  /** Set on DM/Group previews so the rail does not treat every user role as "you". */
  author_type?: ChatAuthorType;
  author_id?: string | null;
}

export interface ChatChannelSource {
  channel_type: string;
  installation_id: string;
  route_revision: number;
}

export interface ChatSession {
  id: string;
  workspace_id: string;
  /** Bound agent for an "agent" conversation. Null for dm/group, which have no
   *  single owning agent. Optional-chain at read sites. */
  agent_id: string | null;
  /** Conversation kind. Missing/unknown reads as the legacy "agent" session. */
  kind?: ConversationKind;
  /** Participants for dm/group. Absent for agent sessions and on older servers. */
  participants?: ChatParticipant[];
  creator_id: string;
  /** Durable project context for every turn in this session. Null when the
   *  conversation uses workspace context only; optional for older servers. */
  project_id?: string | null;
  title: string;
  status: "active" | "archived";
  /** True when the session has any unread assistant replies. List-only.
   *  Convenience for `unread_count > 0`. */
  has_unread: boolean;
  /** Number of unread assistant messages (after the read cursor). List-only;
   *  optional so older clients / non-list payloads stay valid. */
  unread_count?: number;
  /** Latest message in the session, or null when empty. List-only. */
  last_message?: ChatLastMessage | null;
  /** True when the user has pinned this chat to the top of the list.
   *  Optional so older clients / non-list payloads stay valid. */
  pinned?: boolean;
  /** Present for Chats created by an external Channel. Historical Chats keep
   *  their source even after a newer route generation becomes current. */
  channel_source?: ChatChannelSource;
  /** Absent for first-party Chats. */
  is_current_channel_route?: boolean;
  created_at: string;
  updated_at: string;
}

export interface PendingChatTaskItem {
  task_id: string;
  status: string;
  chat_session_id: string;
}

export interface PendingChatTasksResponse {
  tasks: PendingChatTaskItem[];
}

/**
 * Boolean fast-path payload for the FAB "running" indicator — returned by
 * GET /api/chat/pending-tasks/has-any. The FAB only needs to know whether any
 * in-flight chat task exists, so it avoids fetching the full task list.
 */
export interface HasPendingChatTasksResponse {
  has_pending: boolean;
}

export interface ChatMessage {
  id: string;
  chat_session_id: string;
  role: "user" | "assistant";
  content: string;
  task_id: string | null;
  created_at: string;
  /**
   * Attachments linked to this message via the attachment table's
   * chat_message_id FK. Populated by ListChatMessages. UI renders these
   * as file/image cards inside the bubble; the markdown URL inline in
   * `content` may have an expiring signature, while attachment metadata
   * here is stable and the source of truth for click-time download.
   */
  attachments?: import("./attachment").Attachment[];
  /**
   * When set, this is an assistant message synthesized by the server's
   * FailTask fallback (mirrors the issue path's failure system comment).
   * `content` carries the raw daemon-reported errMsg; the front-end maps
   * `failure_reason` (an enum like "agent_error" / "connection_error" /
   * "timeout") to a user-facing label and renders a destructive bubble.
   * Null on success messages and on user messages.
   */
  failure_reason?: string | null;
  /**
   * Wall-clock duration from `task.created_at` (user hit send) to terminal
   * state (completed/failed). Set by the server on assistant messages
   * synthesized by CompleteTask/FailTask. UI renders it as "Replied in
   * 38s" / "Failed after 12s" beneath the bubble. Null on user messages
   * and on legacy assistant messages predating migration 063.
   */
  elapsed_ms?: number | null;
  /**
   * "message" (default) or "no_response" — a completed direct-chat turn that
   * produced no text reply (MUL-4351). Optional/additive: absent on older
   * servers and on user messages; treat a missing value as "message".
   */
  message_kind?: ChatMessageKind;
  /** Up to three server-validated follow-ups generated with this reply. */
  quick_actions?: ChatQuickAction[];
  /**
   * Message author attribution (plan 20261025 §6). Additive: agent sessions
   * keep the legacy `role` and omit these; treat a missing author_type as a
   * role-derived author. `author_id` is the member or agent id behind the
   * message; `mentions` are resolved @-targets in a dm/group message.
   */
  author_type?: ChatAuthorType;
  author_id?: string | null;
  mentions?: ChatMention[];
  resources?: ChatMessageResource[];
  has_resources?: boolean;
  /** Emoji reactions on this message. Absent on older servers. */
  reactions?: ChatMessageReaction[];
  /** Short replies left on this message. Absent on older servers. */
  replies?: ChatMessageReply[];
  /**
   * Per-agent fan-out results for a group send. Present on the message that
   * triggered the fan-out; absent on agent/dm conversations and on older
   * servers.
   */
  dispatches?: ChatMessageDispatch[];
}

export interface ChatMessageReaction {
  emoji: string;
  actor_id: string;
}

export interface ChatMessageReply {
  id: string;
  author_id: string;
  content: string;
  created_at?: string;
}

export interface ChatMessagesCursor {
  created_at: string;
  id: string;
}

export interface ChatMessagesPage {
  messages: ChatMessage[];
  limit: number;
  has_more: boolean;
  next_cursor?: ChatMessagesCursor | null;
}

export interface SendChatMessageResponse {
  message_id: string;
  /**
   * Queued agent task for the legacy single-agent path. Optional because a
   * dm/group send has no owning agent task at the root — per-agent outcomes
   * come back in `dispatches` instead.
   */
  task_id?: string;
  /** Conversation kind echoed back so the client can branch on the response. */
  kind?: ConversationKind;
  /** Per-agent fan-out results for a group send. Absent on agent/dm paths. */
  dispatches?: ChatAgentDispatch[];
  /** True when the server supports queued follow-up sends. */
  supports_queue?: boolean;
  /**
   * True only when this task was accepted behind another in-flight task in
   * the same chat session. Optional for compatibility with older servers.
   */
  queued?: boolean;
  /**
   * Server-authoritative task creation time. Optimistic StatusPill seed
   * uses this as its anchor so the timer starts from the real `0s` —
   * without it the front-end falls back to its local clock and the
   * timer "snaps backwards" later when WS events update the cache.
   */
  created_at: string;
  /**
   * Attachment ids the server actually bound to this message. The client
   * diffs these against the ids it requested to warn when an attachment
   * silently failed to bind — no extra fetch needed. Optional for forward
   * compat with servers that predate the field.
   */
  attachment_ids?: string[];
  /** Sender-scoped snapshots for immediate rendering; realtime recipients hydrate via GET. */
  resources?: ChatMessageResource[];
}

export interface StartMikaOnboardingResponse {
  /** True only for the request that wrote the opening. */
  started: boolean;
  /**
   * The opening message, already persisted and final. No agent runs to
   * produce it, so there is no task to await — a `started` response means the
   * member's first message from Mika is in the transcript right now.
   */
  message_id?: string;
  created_at?: string;
}

export interface CancelledChatMessage {
  chat_session_id: string;
  message_id: string;
  content: string;
  restore_to_input: boolean;
  /**
   * Attachments detached from the deleted message so a restored draft can
   * re-bind them on re-send. Absent on servers that predate the field.
   */
  attachments?: import("./attachment").Attachment[];
}

export interface CancelTaskResponse extends AgentTask {
  cancelled_chat_message?: CancelledChatMessage;
}

/**
 * One durable draft restore from GET /api/chat/sessions/{id}/draft-restores
 * (#5219): a deferred cancellation settled as empty-transcript after the
 * cancel HTTP response had returned, so the deleted prompt is held
 * server-side until the creator's client applies it to the composer and
 * consumes it (DELETE, idempotent). The chat:cancel_finalized event is only
 * an invalidation hint for this fetch.
 */
export interface ChatDraftRestore {
  /** The deleted user chat message id — stable dedup and consume key. */
  id: string;
  chat_session_id: string;
  task_id?: string;
  content: string;
  /**
   * Attachments detached from the deleted message so a restored draft can
   * re-bind them on re-send.
   */
  attachments?: import("./attachment").Attachment[];
  created_at?: string;
}

export interface ChatDraftRestoresResponse {
  restores: ChatDraftRestore[];
}

/**
 * Response from GET /api/chat/sessions/{id}/pending-task.
 * All fields are absent when the session has no in-flight task.
 *
 * `created_at` is the server-authoritative anchor for the chat StatusPill's
 * elapsed-seconds timer — the optimistic seed in chat-window.tsx fills in
 * task_id/status only, then this query catches up with the real created_at
 * so the timer survives refresh / reopen without "resetting to 0s".
 */
export interface ChatQueuedTask {
  task_id: string;
  status: string;
  created_at: string;
  message_id?: string;
  content?: string;
}

export interface PrioritizeQueuedChatTaskResponse {
  task_id: string;
  /** Server-authoritative task to stop after the selected task is prioritized. */
  active_task_id?: string;
}

/**
 * One in-flight agent task of a group conversation. Group fan-out dispatches
 * an independent task per @-mentioned agent and they run in parallel, so the
 * pending state is a SET keyed by agent, not the legacy single root task
 * (plan 20261025 §6). `wait_reason` is only set while the task is parked in
 * `waiting_local_directory`, matching the root field's clearing rules.
 */
export interface GroupPendingAgentTask {
  agent_id: string;
  task_id: string;
  status: string;
  created_at: string;
  wait_reason?: string;
}

export interface ChatPendingTask {
  task_id?: string;
  status?: string;
  created_at?: string;
  /**
   * Why a `waiting_local_directory` task is parked: the directory it needs and,
   * when known, the short id of the task holding it. Set only while that status
   * is current — see promotePendingChatTask, which clears it on every other
   * transition so a stale hold can never be read as a live one. Absent on
   * servers predating the field, which renders as the bare waiting label.
   */
  wait_reason?: string;
  /** Explicit capability gate; absent on servers predating follow-up queues. */
  supports_queue?: boolean;
  /**
   * Ordered follow-ups behind the root task. The root may itself still have
   * database status `queued` before claim, but is never duplicated here.
   */
  queued_tasks?: ChatQueuedTask[];
  /**
   * Parallel in-flight tasks for a group session. Absent (not merely empty)
   * on agent/dm responses — callers distinguish "older server" from "group
   * with no in-flight task" via the session kind, never via this field.
   */
  agent_tasks?: GroupPendingAgentTask[];
}
