"use client";

import type { ReactNode, SyntheticEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2, SendHorizontal, Square, TriangleAlert, X } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import {
  ContentEditor,
  type ContentEditorRef,
  useFileDropZone,
  FileDropOverlay,
  useUploadGate,
  useComposerSubmit,
} from "../../editor";
import { PASTE_AS_FILE_THRESHOLD } from "../../editor/paste-as-file";
import {
  useCoordinatedUploads,
  type UploadDraftBinding,
} from "../../editor/use-coordinated-uploads";
import { SubmitButton } from "@multica/ui/components/common/submit-button";
import { ChatAddMenu } from "./chat-add-menu";
import { CHAT_COLUMN, CHAT_GUTTER } from "./chat-column";
import { GroupPendingPills } from "./group-pending-pills";
import { useChatStore, DRAFT_NEW_SESSION } from "@multica/core/chat";
import { useFeatureEnabled } from "@multica/core/config";
import { MODULE_PROTOTYPE_CHAT_FLAG } from "@multica/core/feature-flags";
import { attachmentToDraftUpload, type DraftUpload } from "@multica/core/drafts";
import { createLogger } from "@multica/core/logger";
import type { MentionItem } from "../../editor/extensions/mention-suggestion";
import type {
  Attachment,
  ChatMessageResource,
  ChatResourceRefInput,
  GroupPendingAgentTask,
  Project,
  ProjectModule,
} from "@multica/core/types";
import { ProjectPicker } from "../../projects/components/project-picker";
import { ClearablePillButton } from "../../common/pill-button";
import { useT } from "../../i18n";
import { pageSurfaceChip, usePageSurfaceContext } from "../lib/page-surface-context";
import { useChatFanout } from "../lib/fanout-agents";
import { ResourcePickerDialog, type ResourceTab } from "./resource-picker-dialog";
import {
  addChatResourceDraft,
  canSubmitChatComposer,
  CHAT_RESOURCE_DRAFT_LIMIT,
  chatModuleResource,
  chatResourceDraftKey,
  chatResourceMark,
  chatResourceRef,
} from "./chat-resource-drafts";

const logger = createLogger("chat.ui");
const EMPTY_UPLOADS: DraftUpload[] = [];
const EMPTY_RESOURCES: ChatMessageResource[] = [];
const EMPTY_TASK_IDS: string[] = [];
/** Editor identity for the chat composer — see the editorKey note below. */
const CHAT_COMPOSER_EDITOR_KEY = "chat-composer";

/** Keep the composer focused so Send and Stop do not dismiss Android's keyboard. */
function keepComposerFocus(event: SyntheticEvent<HTMLButtonElement>) {
  event.preventDefault();
}

function attachmentReferenceUrls(attachment: Attachment): string[] {
  const withUploadFields = attachment as Attachment & {
    markdownLink?: string;
    link?: string;
  };
  return [
    withUploadFields.markdownLink,
    attachment.markdown_url,
    attachment.download_url,
    attachment.url,
    withUploadFields.link,
    attachment.id ? `/api/attachments/${attachment.id}/download` : "",
  ].filter((url): url is string => !!url);
}

function isAttachmentReferenced(content: string, attachment: Attachment): boolean {
  return attachmentReferenceUrls(attachment).some((url) => content.includes(url));
}

interface ChatInputProps {
  onSend: (
    content: string,
    attachmentIds: string[] | undefined,
    commitInput: (options?: { extraDraftKeys?: string[]; clearEditor?: boolean }) => void,
    draftAttachments: Attachment[],
    resourceRefs?: ChatResourceRefInput[],
    resourceSnapshots?: ChatMessageResource[],
  ) => void | boolean | Promise<void | boolean>;
  restoreDraftRequest?: {
    id: string;
    content: string;
    attachments?: Attachment[];
    /**
     * Draft slot this restore targets. When set, the restore only fires while
     * the user is viewing that session — a fire-and-forget send that later
     * fails restores into the session it was sent from, not whatever the user
     * navigated to. Omit to restore into the current draft (legacy behavior).
     */
    sessionId?: string;
  } | null;
  /** Explicit replacement requested by a conversation-starter button. Unlike a
   * synchronized draft write, this may intentionally replace dirty editor
   * content, so ChatInput adopts it after cancelling any pending debounce. */
  conversationStarterRequest?: {
    id: number;
    content: string;
  } | null;
  /** Fired after the request has replaced both the stored and live draft. */
  onConversationStarterApplied?: () => void;
  /**
   * Fired when — and only when — the restore's content/attachments were written
   * into the draft. A restore the composer cannot apply yet (the user has work
   * in progress) is NOT reported: it stays pending and lands as soon as the
   * draft is clear. Owners holding a durable server-side restore (#5219) can
   * therefore treat this as the single terminal transition and consume the row.
   */
  onRestoreDraftApplied?: () => void;
  /** True when uploads are available for this composer (an agent is selected).
   *  The transport itself is the coordinated-upload engine (MUL-5181 L2) —
   *  the owner only says whether the affordance exists. When false,
   *  paste/drag/button still type into the editor but no upload fires. */
  uploadEnabled?: boolean;
  onStop?: () => void;
  isRunning?: boolean;
  /** A cancel for this conversation's task is already on the wire. Keeps the
   *  Stop button from re-firing and turns it into "stopping…" so the press is
   *  visibly acknowledged instead of looking dead. */
  stopping?: boolean;
  /** Task ids with a cancel in flight; used to gate the group "stop all" door. */
  cancellingTaskIds?: string[];
  /** Enabled only after the server explicitly advertises follow-up queues. */
  allowSubmitWhileRunning?: boolean;
  /** What a submit does while a run is in flight. `queue` is the direct-chat
   *  follow-up queue; `supplement` is a group message that fans out as a fresh
   *  per-agent task (no queue exists there). Drives the button tooltip only. */
  runningSendKind?: "queue" | "supplement";
  disabled?: boolean;
  /** True when the user has no agent available — disables the editor and
   *  surfaces a distinct placeholder. Kept separate from `disabled` so
   *  archived-session copy stays untouched. */
  noAgent?: boolean;
  /** True when `disabled` is because the bound agent was archived (retired),
   *  as opposed to the session itself being archived — swaps the placeholder
   *  copy so the read-only reason reads accurately. */
  agentArchived?: boolean;
  /** True when `disabled` is because the caller may no longer INVOKE the bound
   *  agent (flipped to personal, ownership moved, dropped from the allow-list).
   *  Distinct from `noAgent`: an agent IS bound and its transcript is readable,
   *  the caller just cannot run it (MUL-6380). Takes precedence over `noAgent`
   *  in the placeholder — when the only agent in the workspace is the revoked
   *  one, both are true and "create an agent" would be the wrong instruction. */
  agentAccessRevoked?: boolean;
  agentRuntimeRequired?: boolean;
  /** Name of the currently selected agent, used in the placeholder. */
  agentName?: string;
  /** DM/Group composers ignore agent gates and use interpersonal copy. */
  conversationKind?: "agent" | "dm" | "group";
  /** Closed @ candidates for the open DM or group. Ignored for agent chats. */
  mentionItems?: MentionItem[];
  /** Rendered at the bottom-left of the input bar — typically the agent picker. */
  leftAdornment?: ReactNode;
  /** Chat @ suggestions: current/recent issue/project entries. */
  contextItems?: MentionItem[];
  /** Optional project context for the draft or current chat session. */
  projects?: Project[];
  projectsLoading?: boolean;
  projectsError?: boolean;
  projectId?: string | null;
  onProjectChange?: (projectId: string | null) => void;
  isProjectUpdating?: boolean;
  /** True when the active agent's daemon is too old to inject the project
   *  description into the run brief. Soft signal: selection stays enabled,
   *  the composer only surfaces a warning next to the chip and in the
   *  project submenu. */
  projectContextUnsupported?: boolean;
  /** Monotonic nonce bumped by the owner whenever the compose box should grab
   *  keyboard focus — currently on "new chat" so the user can type right away.
   *  0 (the initial value) is inert, so a plain deep-link open never steals
   *  focus; only an explicit bump does. */
  focusRequest?: number;
  /**
   * Optional storage/identity isolation for embedded chat surfaces that use
   * the shared composer without participating in the global chat selection
   * store (for example Agent Builder).
   */
  draftKeyOverride?: string;
  editorKeyOverride?: string;
  /** In-flight group agent tasks, shown as a dock above the composer. */
  groupRuns?: GroupPendingAgentTask[];
  groupAgentNames?: Map<string, string>;
  /** Stop one agent's run inside a group (per-pill affordance). */
  onStopGroupTask?: (taskId: string) => void;
  /** Optional controlled resource draft used by tests and embedded hosts. */
  resources?: ChatMessageResource[];
  onResourcesChange?: (resources: ChatMessageResource[]) => void;
  resourceSharingEnabled?: boolean;
}

export function ChatInput({
  onSend,
  restoreDraftRequest,
  conversationStarterRequest,
  onConversationStarterApplied,
  onRestoreDraftApplied,
  uploadEnabled: uploadAllowed,
  onStop,
  isRunning,
  stopping = false,
  cancellingTaskIds,
  allowSubmitWhileRunning,
  runningSendKind = "queue",
  disabled,
  noAgent,
  agentArchived,
  agentAccessRevoked,
  agentRuntimeRequired,
  agentName,
  conversationKind = "agent",
  mentionItems,
  leftAdornment,
  contextItems,
  projects = [],
  projectsLoading,
  projectsError,
  projectId,
  onProjectChange,
  isProjectUpdating,
  projectContextUnsupported,
  focusRequest,
  draftKeyOverride,
  editorKeyOverride,
  groupRuns,
  groupAgentNames,
  onStopGroupTask,
  resources: controlledResources,
  onResourcesChange,
  resourceSharingEnabled = false,
}: ChatInputProps) {
  const { t } = useT("chat");
  const { t: tConv } = useT("conversations");
  const { t: tEditor } = useT("editor");
  const isHumanConversation = conversationKind === "dm" || conversationKind === "group";
  const noAgentGate = isHumanConversation ? false : noAgent;
  const extraAgentCount = useChatFanout((state) => state.extraAgentIds.length);
  const editorRef = useRef<ContentEditorRef>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  // Two keys with deliberately different concerns:
  //
  // `draftKey` — zustand storage key. Scopes the in-progress draft per session
  // so different sessions don't bleed text into each other. An uncreated chat
  // uses ONE slot per workspace, deliberately NOT keyed by agent: the composer
  // is "the chat I have not created yet", and `selectedAgentId` only decides
  // where the first send goes (MUL-4864). This is a STORAGE key, not a React
  // identity.
  //
  // `editorKey` — React `key` on the ContentEditor, i.e. editor identity. It is
  // constant for the chat composer, because nothing about switching what you
  // are composing to should throw away the instance you are typing in:
  //   - Agent switch: same draft slot now, so a remount would only serve to
  //     drop the last <100ms of typing the draft debounce has not persisted.
  //   - Placeholder: ContentEditor's placeholder-sync effect refreshes it live,
  //     so it never needed a remount.
  //   - Draft restore (a cancelled run, a failed send): writes into
  //     `inputDraft`, and the editor's synchronized-value effect pushes it into
  //     the live instance. There is no second copy to drift or resurface.
  //   - Session switch / lazy create: sending from a brand-new chat flips
  //     `activeSessionId` from null → uuid while an upload's blob preview may
  //     still be in the document. A session-keyed editor would unmount right
  //     then, dropping the image node before file-upload.ts could swap in the
  //     CDN URL — the user would watch the image flash on and vanish. Stable
  //     identity is what makes first-upload-creates-session behave like every
  //     later upload.
  // Embedded surfaces (Agent Builder) still pass `editorKeyOverride` to isolate
  // their own composer.
  const pageSurface = usePageSurfaceContext((state) => state.context);
  const draftKey = draftKeyOverride ?? activeSessionId ?? DRAFT_NEW_SESSION;
  const [resourceDrafts, setResourceDrafts] = useState<Record<string, ChatMessageResource[]>>({});
  const [resourcePickerOpen, setResourcePickerOpen] = useState(false);
  const [resourcePickerTab, setResourcePickerTab] = useState<ResourceTab>("task");
  const resources = controlledResources ?? resourceDrafts[draftKey] ?? EMPTY_RESOURCES;
  // 模块挂载是独立灰度的：flag 关闭时入口与 tab 都不渲染，服务端也会拒收这两类引用。
  // 模块列表由 ChatModuleMenu 在子菜单展开时才拉取，这里不持有查询。
  const moduleAttachEnabled = useFeatureEnabled(MODULE_PROTOTYPE_CHAT_FLAG, false) && resourceSharingEnabled;
  const changeResources = useCallback((next: ChatMessageResource[]) => {
    if (controlledResources) onResourcesChange?.(next);
    else setResourceDrafts((current) => ({ ...current, [draftKey]: next }));
  }, [controlledResources, draftKey, onResourcesChange]);
  // 从「+」菜单选模块 = 直接落到草稿 chip；额度已满时不动（与选择器一致）。
  const attachModule = useCallback((module: ProjectModule) => {
    changeResources(addChatResourceDraft(resources, chatModuleResource(module)));
  }, [changeResources, resources]);
  // Select a primitive — empty-string fallback keeps referential stability.
  const inputDraft = useChatStore((s) => s.inputDrafts[draftKey] ?? "");
  const storeUploads = useChatStore(
    (s) => s.inputDraftAttachments[draftKey] ?? EMPTY_UPLOADS,
  );
  const setInputDraft = useChatStore((s) => s.setInputDraft);
  const setInputDraftAttachments = useChatStore((s) => s.setInputDraftAttachments);
  const clearInputDraft = useChatStore((s) => s.clearInputDraft);
  const [isEmpty, setIsEmpty] = useState(!inputDraft.trim());
  // `isEmpty` tracks the LIVE editor, which the persisted draft lags by a
  // debounce, so the send affordance cannot be derived from `inputDraft` alone.
  // But `isEmpty` is never re-derived when the composer switches draft slots
  // either: ChatInput does not remount on a session switch, and ContentEditor's
  // synchronized-value effect pushes the incoming draft in with `emitUpdate: false`, so
  // no onUpdate fires. Read BOTH signals — a draft `isEmpty` has not seen yet (a
  // restored or parked one, or any persisted draft the user typed in another
  // session) still enables the button. A false enable costs nothing: handleSend
  // reads the live editor and bails when it is empty.
  const hasNothingToSend = !canSubmitChatComposer(isEmpty ? inputDraft : "content", resources);
  const appliedRestoreIdRef = useRef<string | null>(null);
  const appliedConversationStarterIdRef = useRef<number | null>(null);
  const editorKey = editorKeyOverride ?? CHAT_COMPOSER_EDITOR_KEY;

  // The draft whose document the editor instance is currently HOLDING.
  //
  // Normally identical to `draftKey`. The two diverge only while an in-flight
  // upload pins the instance to the source document: ContentEditor's Guard 0
  // refuses to `setContent` over an `uploading` node, because wiping that node
  // strands the upload's finalize and the file silently disappears. Until the
  // upload settles the composer still shows — and still edits — the source
  // draft, so every byte the instance produces belongs to THIS key, not to
  // wherever the user has since navigated.
  //
  // `draftKey` answers "what is selected"; this answers "what is loaded". Every
  // write the editor drives must use the latter.
  const editorDraftKeyRef = useRef(draftKey);

  // Write a document into a draft slot: text, plus a prune of the attachments
  // its body no longer references (deleting an image's markdown drops the
  // staged upload with it). Shared by the live `onUpdate` and the draft-switch
  // flush below, so a document can never be filed under one rule by one path
  // and a different rule by the other. Attachments are read live for `key`
  // rather than passed in — during a divergence the rendered `draftAttachments`
  // belongs to the selected draft, not the loaded one.
  const commitDraft = useCallback(
    (key: string, markdown: string) => {
      setInputDraft(key, markdown);
      const uploads =
        useChatStore.getState().inputDraftAttachments[key] ?? EMPTY_UPLOADS;
      if (uploads.length === 0) return;
      // Prune only COMPLETED uploads the body no longer references — deleting
      // an image's markdown drops the staged upload with it. Placeholders
      // (uploading / failed / interrupted) have no body reference yet; the
      // status chips are their only UI, so they must survive every keystroke.
      const referenced = uploads.filter(
        (u) => u.status !== "uploaded" || isAttachmentReferenced(markdown, u.attachment),
      );
      if (referenced.length !== uploads.length) {
        setInputDraftAttachments(key, referenced);
      }
    },
    [setInputDraft, setInputDraftAttachments],
  );
  // Submit gate. `uploading` disables the SubmitButton the instant an upload
  // starts; `isBlocked()` is re-read inside handleSend for the paths that skip
  // the button entirely (Mod+Enter mid-paste, drag-drop racing the keyboard).
  // Both read the editor document, which is the actual upload queue — this
  // used to be a local in-flight counter that a manual delete of the pending
  // image would leave stuck (MUL-4808).
  const uploadGate = useUploadGate(editorRef);

  // Reactive mirror of `editorDraftKeyRef` for the live-editor registry: a
  // write-back may insert into this editor only while its DOCUMENT belongs to
  // the settling draft, and a ref advance alone re-runs no effect. Updated by
  // the adopt layout effect below, alongside the ref.
  const [loadedDraftKey, setLoadedDraftKey] = useState(draftKey);

  // Store-backed accessors for one draft slot, buildable for ANY key: the
  // engine snapshots `resolveUploadTarget()` at pick time so an upload lands
  // in — and settles against — the draft the editor was HOLDING, even if the
  // user has since switched sessions.
  const makeUploadBinding = useCallback((key: string): UploadDraftBinding => ({
    registryKey: `chat:${key}`,
    getUploads: () => useChatStore.getState().inputDraftAttachments[key] ?? EMPTY_UPLOADS,
    addUpload: (u) => useChatStore.getState().addInputDraftUpload(key, u),
    settleUpload: (id, att) => useChatStore.getState().settleInputDraftUpload(key, id, att),
    failUpload: (id, err) => useChatStore.getState().failInputDraftUpload(key, id, err),
    removeUpload: (id) => useChatStore.getState().removeInputDraftUpload(key, id),
    getBody: () => useChatStore.getState().inputDrafts[key] ?? "",
    appendToBody: (md) => useChatStore.getState().appendToInputDraft(key, md),
  }), []);
  const uploadBinding = useMemo(
    () => makeUploadBinding(draftKey),
    [makeUploadBinding, draftKey],
  );
  // Coordinator-owned uploads (MUL-5181 L2): survive window close, abort on
  // logout, are dropped after a reload. `gate` widens the editor gate
  // with the draft's placeholders so a REOPENED composer over a still-running
  // upload cannot send past it.
  const {
    uploads: draftUploads,
    attachments: draftAttachments,
    handleUpload,
    gate,
  } = useCoordinatedUploads(uploadBinding, storeUploads, {}, uploadGate, editorRef, {
    resolveUploadTarget: () => makeUploadBinding(editorDraftKeyRef.current),
    liveRegistryKey: `chat:${loadedDraftKey}`,
  });

  // Move the editor from the draft it holds to the draft that is selected.
  //
  // Two hazards make this more than "let the value sync handle it":
  //
  // 1. Unflushed keystrokes. `onUpdate` is debounced, and by the time a
  //    debounce armed under draft A fires, `onUpdate` resolves to the latest
  //    render's closure — it would file A's document under B. Flushing takes
  //    those bytes back and commits them to the key they were typed in.
  // 2. An in-flight upload. Guard 0 pins the document (see editorDraftKeyRef),
  //    so the switch cannot happen yet at all: we leave BOTH the document and
  //    its writes on the source key and retry when the gate clears
  //    (`uploadGate.uploading` is a dep). Blocking navigation instead would be
  //    a worse trade — the user waits on a network round-trip to change tabs.
  //
  // Case 2 also has to force the adopt afterwards: ContentEditor's sync effect
  // CONSUMED the value change while Guard 0 was up (lastSyncedValueRef
  // advances before the guard), so it will never re-run for that value and the
  // target draft would never load on its own.
  //
  // useLayoutEffect, not useEffect, for two ordering reasons: passive effects
  // run child-first, so a passive flush here would land AFTER ContentEditor's
  // sync effect had already skipped on a dirty editor; and a layout effect is
  // part of the commit, so no pending debounce timer can fire ahead of it.
  const deferredAdoptRef = useRef(false);
  useLayoutEffect(() => {
    const loadedKey = editorDraftKeyRef.current;
    if (loadedKey === draftKey) return;
    if (editorRef.current?.hasActiveUploads() === true) {
      // Pinned. Stay bound to the source draft until the upload settles.
      deferredAdoptRef.current = true;
      logger.debug("input.draft switch deferred by in-flight upload", {
        from: loadedKey,
        to: draftKey,
      });
      return;
    }
    const pending = editorRef.current?.flushPendingUpdate() ?? null;
    if (pending !== null) {
      logger.debug("input.draft flush on key change", { from: loadedKey, to: draftKey });
      commitDraft(loadedKey, pending);
    }
    editorDraftKeyRef.current = draftKey;
    setLoadedDraftKey(draftKey);
    if (!deferredAdoptRef.current) return;
    deferredAdoptRef.current = false;
    const incoming = useChatStore.getState().inputDrafts[draftKey] ?? "";
    logger.debug("input.draft adopting after upload settled", { key: draftKey });
    editorRef.current?.adoptContent(incoming);
    setIsEmpty(!incoming.trim());
  }, [draftKey, uploadGate.uploading, commitDraft]);

  // Grab keyboard focus when the owner bumps `focusRequest` (a new chat was
  // started) so the user can type immediately. The editor's `focus()` latches
  // through to `onCreate` when it isn't mounted yet, so this works even on the
  // first render of a freshly-mounted compose box. `0` is inert on purpose.
  useEffect(() => {
    if (!focusRequest) return;
    editorRef.current?.focus();
  }, [focusRequest]);

  // A conversation-starter click is an explicit replacement, not an ordinary
  // external store sync. ContentEditor deliberately rejects external values
  // while it has dirty local text, so adopting here prevents the old text's
  // pending debounce from winning the race and overwriting the chosen prompt.
  // Wait out active uploads: adopting content while an upload node is present
  // would strand its completion callback.
  useLayoutEffect(() => {
    if (!conversationStarterRequest) return;
    if (appliedConversationStarterIdRef.current === conversationStarterRequest.id) return;
    if (editorDraftKeyRef.current !== draftKey) return;
    if (editorRef.current?.hasActiveUploads() === true) return;

    editorRef.current?.flushPendingUpdate();
    appliedConversationStarterIdRef.current = conversationStarterRequest.id;
    commitDraft(draftKey, conversationStarterRequest.content);
    editorRef.current?.adoptContent(conversationStarterRequest.content);
    setIsEmpty(!conversationStarterRequest.content.trim());
    onConversationStarterApplied?.();
  }, [
    commitDraft,
    draftKey,
    onConversationStarterApplied,
    conversationStarterRequest,
    uploadGate.uploading,
  ]);

  useEffect(() => {
    if (!restoreDraftRequest) {
      appliedRestoreIdRef.current = null;
      return;
    }
    if (appliedRestoreIdRef.current === restoreDraftRequest.id) return;
    // Session-scoped restore: if this draft belongs to a specific session,
    // wait until the user is actually viewing it. A fire-and-forget send that
    // failed after the user navigated away must not dump its content into the
    // session they're now looking at — the request stays pending until they
    // return to the source session (draftKey then matches).
    if (restoreDraftRequest.sessionId && restoreDraftRequest.sessionId !== draftKey) {
      return;
    }
    // A draft with text OR staged attachments is user work in progress — never
    // overwrite either with a restore (the attachment write below replaces the
    // whole staged list). This is a WAIT, not a decision: the request stays
    // pending and this effect re-runs on every draft change, so the restore
    // lands as soon as the user sends or clears what they were typing. Marking
    // it done here would strand it for the rest of this composer's life.
    if (inputDraft.trim() || draftUploads.length > 0) {
      logger.debug("input.restore waiting: draft has content", {
        draftKey,
        restoreId: restoreDraftRequest.id,
      });
      return;
    }
    appliedRestoreIdRef.current = restoreDraftRequest.id;
    setInputDraft(draftKey, restoreDraftRequest.content);
    // Restores carry completed server rows — stage them as uploaded entries.
    setInputDraftAttachments(
      draftKey,
      (restoreDraftRequest.attachments ?? []).map(attachmentToDraftUpload),
    );
    setIsEmpty(!restoreDraftRequest.content.trim());
    onRestoreDraftApplied?.();
  }, [
    draftKey,
    inputDraft,
    draftUploads,
    onRestoreDraftApplied,
    restoreDraftRequest,
    setInputDraft,
    setInputDraftAttachments,
  ]);

  // Drop zone wraps the rounded card so a drop anywhere on the input
  // surface routes the file through the editor's upload extension (same
  // handler as the in-editor paste path).
  const { isDragOver, dropZoneProps } = useFileDropZone({
    onDrop: (files) => files.forEach((f) => editorRef.current?.uploadFile(f)),
  });

  // The unified await-then-render send contract (MUL-5181). `useComposerSubmit`
  // owns the six-step pessimistic submit — empty-guard, synchronous single-flight
  // (a ref, so a double Mod+Enter in one tick cannot slip past a render-behind
  // state boolean and double-send), the submit-time upload re-check, and the
  // `submitting` lock/spinner. The chat-specific work — the loaded-draft guard,
  // attachment-id resolution, and the owner-driven `commitInput` handoff — stays
  // here in `onSubmit`, which receives the already-normalized content.
  // Set by `commitInput` when it actually scrubbed the visible document; read
  // back by `afterAccepted` a moment later to decide whether the caret may
  // return. Reset at the top of every submit so a rejected send cannot leave a
  // stale `true` behind for the next one.
  const editorScrubbedRef = useRef(false);

  const { submitting, submit } = useComposerSubmit({
    editorRef,
    uploadGate: gate,
    allowEmpty: resources.length > 0,
    containerRef: composerRef,
    // Chat keeps the caret in the box after a send (the next turn is typed in
    // the same place), except when the commit left the editor alone — see
    // `editorScrubbedRef`.
    afterAccepted: () => (editorScrubbedRef.current ? "refocus" : "none"),
    onSubmit: async (content: string): Promise<boolean> => {
      editorScrubbedRef.current = false;
      // These states disable the SubmitButton, but Mod+Enter bypasses it — so a
      // read-only or busy composer must still refuse the keyboard path.
      if (disabled || noAgentGate || (isRunning && !allowSubmitWhileRunning)) {
        logger.debug("input.send skipped", {
          disabled,
          noAgent: noAgentGate,
          runningWithoutQueueSupport: !!isRunning && !allowSubmitWhileRunning,
        });
        return false;
      }
      // The editor is still holding a DIFFERENT draft's document than the one
      // selected — an upload pinned it and the adopt below has not run yet. The
      // upload gate (re-checked inside useComposerSubmit) covers most of that
      // window, but not the sliver between the upload's final dispatch (node
      // gone) and the re-render that adopts: React flushes that state update on a
      // scheduler task, so a submit can land first. Sending here would post the
      // source draft's text into the selected session and then clear the wrong
      // draft.
      if (editorDraftKeyRef.current !== draftKey) {
        logger.debug("input.send skipped: composer still holds another draft", {
          loaded: editorDraftKeyRef.current,
          selected: draftKey,
        });
        return false;
      }
      // Only send attachment IDs for uploads still present in the content.
      // Edits / deletions that remove the markdown URL also drop the binding.
      const activeIds: string[] = [];
      for (const attachment of draftAttachments) {
        if (isAttachmentReferenced(content, attachment)) activeIds.push(attachment.id);
      }
      const uniqueActiveIds = Array.from(new Set(activeIds));
      // Capture draft key BEFORE onSend — creating a new session mutates
      // activeSessionId synchronously, so reading it after onSend would point
      // at the new session and leave the old draft orphaned.
      const keyAtSend = draftKey;
      const resourcesAtSend = resources;
      // D1：模块是主上下文，固定排在前面，让服务端把 position=0 给它。
      const orderedResources = [
        ...resourcesAtSend.filter((item) => item.type === "module"),
        ...resourcesAtSend.filter((item) => item.type !== "module"),
      ];
      const resourceRefs = orderedResources.map(chatResourceRef);
      // Stale-submit guard (MUL-5181 P0): snapshot the sent draft's persisted
      // value, flushing the editor's pending debounce first so pre-submit
      // typing is inside the snapshot. A late success may only clear what it
      // actually sent — text typed DURING the send (or by a reopened composer
      // after this one unmounted) survives in both the editor and the store.
      const pendingFlush = editorRef.current?.flushPendingUpdate?.();
      if (pendingFlush != null) commitDraft(editorDraftKeyRef.current, pendingFlush);
      const draftValueAtSend = useChatStore.getState().inputDrafts[keyAtSend];
      let committed = false;
      const commitInput = (options?: { extraDraftKeys?: string[]; clearEditor?: boolean }) => {
        if (committed) return;
        committed = true;
        // `clearEditor === false` means the owner sent fire-and-forget while the
        // user had already navigated to another session. The editor instance is
        // shared across sessions, so it now shows (and the user may be typing
        // into) a DIFFERENT draft — clearing it or blurring would wipe that
        // visible input. Only scrub the editor when the user is still on the
        // session they sent from.
        // Flush typing still inside the debounce window before judging: it
        // belongs to the LOADED document and must count as a mid-flight edit.
        const lateMd = editorRef.current?.flushPendingUpdate?.();
        if (lateMd != null) commitDraft(editorDraftKeyRef.current, lateMd);
        const liveDraft = useChatStore.getState().inputDrafts[keyAtSend];
        const untouched = liveDraft === undefined || liveDraft === draftValueAtSend;
        if (options?.clearEditor !== false && untouched) {
          editorRef.current?.clearContent();
          // Scrubbed the document the user was looking at, so the caret belongs
          // back here: chat is a conversation and the next turn is typed in the
          // same box. `useComposerSubmit` reads this flag to decide, because the
          // other branches must NOT grab focus — a fire-and-forget send from
          // another session (`clearEditor: false`) leaves this shared editor
          // showing a DIFFERENT draft the user may be typing into.
          editorScrubbedRef.current = true;
          setIsEmpty(true);
        }
        // The sent draft's data is cleared only when untouched — the message
        // is on its way, but a draft replaced since the snapshot is NEWER work
        // and must not resurface as collateral.
        if (untouched) clearInputDraft(keyAtSend);
        const sentKeys = new Set(resourcesAtSend.map(chatResourceDraftKey));
        if (controlledResources) {
          onResourcesChange?.(resources.filter((item) => !sentKeys.has(chatResourceDraftKey(item))));
        } else {
          setResourceDrafts((current) => ({
            ...current,
            [keyAtSend]: (current[keyAtSend] ?? []).filter(
              (item) => !sentKeys.has(chatResourceDraftKey(item)),
            ),
          }));
        }
        for (const key of options?.extraDraftKeys ?? []) {
          if (key !== keyAtSend) clearInputDraft(key);
        }
      };
      logger.info("input.send", {
        contentLength: content.length,
        draftKey: keyAtSend,
        attachmentCount: uniqueActiveIds.length,
      });
      const sendAttachments = draftAttachments.filter((attachment) =>
        uniqueActiveIds.includes(attachment.id)
      );
      const accepted = await onSend(
        content,
        uniqueActiveIds.length > 0 ? uniqueActiveIds : undefined,
        commitInput,
        sendAttachments,
        resourceRefs.length > 0 ? resourceRefs : undefined,
        resourcesAtSend.length > 0 ? resourcesAtSend : undefined,
      );
      // Owner rejected the send (or threw, which useComposerSubmit also treats
      // as a rejection): the draft was never committed, so it stays put for
      // retry. Only a commit — here or by the owner — clears it.
      if (accepted === false) return false;
      if (!committed) commitInput();
      return true;
    },
  });

  // While a run is in flight the composer stops being "the next message" and
  // becomes either a clarification (group: a fresh per-agent task) or a queue
  // slot. Spell that out in the placeholder rather than leaving the user to
  // guess what typing here will do — the ambiguity was the whole complaint.
  const runningComposer =
    !!isRunning && !!allowSubmitWhileRunning && !disabled && !noAgentGate;
  const placeholder = runningComposer
    ? conversationKind === "group"
      ? t(($) => $.input.placeholder_group_running)
      : t(($) => $.input.placeholder_queue_running)
    : isHumanConversation
    ? conversationKind === "dm"
      ? tConv(($) => $.dm.composer_placeholder)
      : tConv(($) => $.group.composer_placeholder)
    : agentAccessRevoked
    ? t(($) => $.input.placeholder_access_revoked)
    : noAgentGate
    ? t(($) => $.input.placeholder_no_agent)
    : disabled
      ? agentArchived
        ? t(($) => $.input.placeholder_archived_agent)
        : agentRuntimeRequired
          ? t(($) => $.input.placeholder_runtime_required)
        : t(($) => $.input.placeholder_archived)
      : agentName
        ? extraAgentCount > 0
          ? t(($) => $.input.placeholder_named_multiple, {
              name: agentName,
              count: extraAgentCount + 1,
            })
          : t(($) => $.input.placeholder_named, { name: agentName })
        : t(($) => $.input.placeholder_default);

  // Explicit verbs for the two actions available while a run is in flight.
  // `supplement` is a group message that fans out as a fresh per-agent task;
  // `queue` is the direct-chat follow-up slot. Neither is an icon-only swap
  // any more: an icon that changes shape under the cursor was unreadable.
  const runningSendLabel =
    runningSendKind === "supplement"
      ? t(($) => $.input.supplement_send_label)
      : t(($) => $.input.queue_send_label);
  const runningSendTooltip =
    runningSendKind === "supplement"
      ? t(($) => $.input.supplement_send_tooltip)
      : t(($) => $.input.queue_send_tooltip);
  const groupRunning = (groupRuns?.length ?? 0) > 0;
  // The bulk dock door is only useful until every run in it is already being
  // cancelled; past that point it is a dead control.
  const groupStopAllInFlight =
    groupRunning &&
    (groupRuns ?? []).every((task) =>
      (cancellingTaskIds ?? EMPTY_TASK_IDS).includes(task.task_id),
    );
  // The composer's Stop only renders outside a group: there the dock above it
  // owns both stop doors (per agent + "stop all"), so this one stays the plain
  // single-task verb.
  const stopActionLabel = stopping
    ? t(($) => $.input.stop_in_progress)
    : t(($) => $.input.stop_tooltip);

  const uploadEnabled = !!uploadAllowed && !disabled && !noAgentGate;
  // Lock only while the send request itself is creating/resolving the target
  // session. Once accepted, its project can still be detached while agent work
  // continues: changing session metadata does not cancel or move that task.
  const projectSelectionEnabled =
    !!onProjectChange &&
    !disabled &&
    !noAgentGate &&
    !submitting &&
    !isProjectUpdating;
  const selectedProject = projects.find((project) => project.id === projectId);

  return (
    <div
      ref={composerRef}
      className={cn(
        // The composer grows with the draft up to half the surface it sits on
        // — a fixed 160px cap made long drafts unreadable in a five-line
        // porthole (MUL-5196). `max-h-[50%]` resolves against the chat
        // surface (floating window, chat tab, agent builder), all of which
        // give this wrapper a definite height, so the cap scales when the
        // user resizes or expands the window. The wrapper must be a flex
        // column for the card below to shrink into that cap instead of
        // spilling out of it.
        "flex max-h-[50%] min-h-0 flex-col pb-4 pt-1",
        CHAT_GUTTER,
        // Static elevation, NOT queue-conditional: ChatQueue tucks its bottom
        // edge under this surface (z-0 + negative margin on its side), and the
        // composer simply always paints on top. Its own chrome never varies.
        "relative z-10",
        // Outer wrapper carries the disabled cursor. Inner card sets
        // pointer-events-none, which suppresses hover (and therefore
        // any cursor of its own) — splitting the two layers lets hover
        // bubble back here so the browser actually reads cursor.
        noAgentGate && "cursor-not-allowed",
      )}
    >
      {groupRuns && groupRuns.length > 0 && (
        <div
          className={cn(
            CHAT_COLUMN,
            "mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-border bg-card px-3 py-2",
          )}
        >
          <span className="inline-flex shrink-0 items-center gap-1 text-caption font-medium text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t(($) => $.status_pill.group.running_count, { count: groupRuns.length })}
          </span>
          <GroupPendingPills
            tasks={groupRuns}
            agentNames={groupAgentNames}
            onStop={onStopGroupTask}
            variant="dock"
          />
          {onStop && (
            // The bulk door, stated as a verb. Per-agent pills cover surgical
            // stops; this is the "everything here is running away" button.
            <Button
              variant="outline"
              size="xs"
              className="ml-auto shrink-0 gap-1 border-destructive/35 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onStop}
              disabled={groupStopAllInFlight}
              aria-busy={groupStopAllInFlight || undefined}
              aria-label={t(($) => $.status_pill.group.stop_all)}
              title={t(($) => $.input.stop_all_tooltip)}
            >
              {groupStopAllInFlight ? (
                <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
              ) : (
                <Square className="size-2.5 fill-current" aria-hidden="true" />
              )}
              {t(($) => $.status_pill.group.stop_all)}
            </Button>
          )}
        </div>
      )}
      {conversationKind === "group" && (
        <p className={cn(CHAT_COLUMN, "mb-2 rounded-lg border border-amber-200/80 bg-amber-50 px-2.5 py-1.5 text-caption text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100")}>
          {tConv(($) => $.group.composer_hint)}
        </p>
      )}
      <div
        data-slot="chat-input-surface"
        {...(uploadEnabled ? dropZoneProps : {})}
        className={cn(
          // max-h-96 is the absolute ceiling on top of the wrapper's 50%: on a
          // tall surface half the height is more composer than anyone reads at
          // once, and it keeps the cap finite if a future host ever mounts the
          // composer without a definite height (percentage max-height would
          // then resolve to none).
          CHAT_COLUMN,
          "relative flex min-h-[4.5rem] max-h-96 flex-col rounded-2xl border border-surface-border bg-surface pb-10 shadow-[0_12px_28px_-22px_rgba(45,32,12,0.55)] transition-[border-color,box-shadow] focus-within:border-brand focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_18%,transparent)]",
          // Visual + interaction lock when there's no agent. We don't
          // toggle ContentEditor's editable mode (Tiptap can't switch
          // cleanly post-mount, and the prop has been removed); instead
          // we drop pointer events at the wrapper level so clicks miss
          // the editor entirely, and dim the surface so it reads as
          // "disabled" rather than "broken".
          noAgentGate && "pointer-events-none opacity-60",
        )}
        aria-disabled={noAgentGate || undefined}
      >
        {resources.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2" aria-label={t(($) => $.resources.draft_aria)}>
            {resources.map((resource) => {
              const key = chatResourceDraftKey(resource);
              const title = resource.title
                ?? resource.issue?.title
                ?? resource.module?.name
                ?? resource.prototype?.name
                ?? resource.prototype?.issue_title
                ?? resource.artifact?.rel_path
                ?? resource.attachment?.filename
                ?? resource.id;
              const code = resource.issue?.identifier;
              const label = code ? `${code} · ${title}` : title;
              return (
                <span
                  key={key}
                  className={cn(
                    "inline-flex max-w-60 items-center gap-1.5 rounded-lg border py-1 pl-1.5 pr-1 text-[11px]",
                    resource.type === "document" && "border-violet-200 bg-violet-50 text-violet-950 dark:border-violet-400/30 dark:bg-violet-500/10 dark:text-violet-100",
                    resource.type === "module" && "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100",
                    resource.type === "module_prototype" && "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-950 dark:border-fuchsia-400/30 dark:bg-fuchsia-500/10 dark:text-fuchsia-100",
                    resource.kind === "requirement" && "border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-100",
                    resource.type === "issue" && resource.kind !== "requirement" && "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100",
                  )}
                >
                  <b className="font-mono text-[9px] font-extrabold">{chatResourceMark(resource)}</b>
                  <span className="truncate">{label}</span>
                  {resource.type === "module" && (resource.module?.spec_version ?? 0) > 0 && (
                    <span className="shrink-0 text-[10px] opacity-70">
                      {t(($) => $.resources.spec_version, { version: resource.module?.spec_version })}
                    </span>
                  )}
                  <button
                    type="button"
                    className="grid size-5 shrink-0 place-items-center rounded hover:bg-muted disabled:opacity-50"
                    disabled={submitting}
                    aria-label={t(($) => $.resources.remove, { name: label })}
                    onClick={() => changeResources(resources.filter((item) => chatResourceDraftKey(item) !== key))}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {selectedProject && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2">
            <div
              className={cn(
                "inline-flex max-w-full",
                !projectSelectionEnabled && "pointer-events-none opacity-60",
              )}
            >
              <ProjectPicker
                projectId={selectedProject.id}
                onUpdate={(updates) => onProjectChange?.(updates.project_id ?? null)}
                disabled={!projectSelectionEnabled}
                triggerRender={
                  <ClearablePillButton
                    disabled={!projectSelectionEnabled}
                    aria-label={t(($) => $.input.change_project_context)}
                    title={t(($) => $.input.change_project_context)}
                    onClear={() => onProjectChange?.(null)}
                    clearLabel={t(($) => $.input.remove_project_context)}
                    className="h-6 border-surface-border bg-surface-raised font-medium text-foreground"
                  />
                }
              />
            </div>
            {projectContextUnsupported && (
              <span className="inline-flex min-w-0 items-center gap-1 text-caption text-warning">
                <TriangleAlert className="size-3 shrink-0" />
                {t(($) => $.input.project_context_unsupported)}
              </span>
            )}
            <p className="min-w-0 basis-full text-caption text-muted-foreground">
              {conversationKind === "group"
                ? t(($) => $.input.project_attached_hint_group)
                : t(($) => $.input.project_attached_hint)}
            </p>
          </div>
        )}
        {pageSurface?.surface === "prototype" && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
            <span className="inline-flex max-w-full items-center rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-[10.5px] font-semibold text-primary">
              {t(($) => $.input.page_prototype_mounted, { name: pageSurfaceChip(pageSurface) })}
            </span>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto px-3.5 py-3">
          <ContentEditor
            // See the editorKey / draftKey split note above — editor identity
            // intentionally tracks neither the session nor the agent.
            key={editorKey}
            ref={editorRef}
            value={inputDraft}
            placeholder={placeholder}
            onUpdate={(md) => {
              setIsEmpty(!md.trim());
              // The LOADED key, not the selected one: while an upload pins the
              // document this fires for the source draft's body — including the
              // upload's own completion dispatch.
              commitDraft(editorDraftKeyRef.current, md);
            }}
            onSubmit={submit}
            submitOnPlainEnter
            onUploadFile={uploadEnabled ? handleUpload : undefined}
            pasteAsFileThreshold={PASTE_AS_FILE_THRESHOLD}
            onUploadingChange={uploadGate.onUploadingChange}
            attachments={draftAttachments}
            debounceMs={100}
            mentionMode={isHumanConversation ? "roster" : contextItems ? "context" : "default"}
            mentionContextItems={isHumanConversation ? mentionItems : contextItems}
            enableSlashCommands
            // The bubble menu carries the only affordance that can strip
            // formatting — "Normal text" (setParagraph) plus the mark/list
            // toggles. Once a `# ` input rule or a Markdown/HTML paste turns a
            // line into a heading, chat has no other way to remove it, so
            // without the bubble menu formatting can be created but never
            // undone (MUL-5106).
            showBubbleMenu
          />
        </div>
        {(uploadEnabled || projectSelectionEnabled || resourceSharingEnabled || leftAdornment) && (
          <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1">
            {(uploadEnabled || projectSelectionEnabled || resourceSharingEnabled) && (
              <ChatAddMenu
                onSelectFile={uploadEnabled
                  ? (file) => editorRef.current?.uploadFile(file)
                  : undefined}
                projects={projects}
                projectsLoading={projectsLoading}
                projectsError={projectsError}
                projectId={projectId}
                onSelectModule={moduleAttachEnabled && !disabled && !noAgentGate ? attachModule : undefined}
                onSelectProject={projectSelectionEnabled ? onProjectChange : undefined}
                onSelectResource={resourceSharingEnabled && !disabled && !noAgentGate ? () => {
                  setResourcePickerTab("task");
                  setResourcePickerOpen(true);
                } : undefined}
                projectContextUnsupported={projectContextUnsupported}
              />
            )}
            {leftAdornment}
          </div>
        )}
        <div className="absolute bottom-1 right-1.5 flex items-center gap-1">
          {isRunning && onStop ? (
            // While the run is live both intents are on screen and named:
            // "send a clarification" and "stop". The old single slot swapped an
            // icon under the cursor (empty ⇒ square, typing ⇒ arrow), which
            // read as Stop disappearing exactly when the user reached for it.
            // In a group the dock above the composer already carries both
            // stop doors (per agent + all), so the composer only adds the
            // clarification send there instead of duplicating them.
            <>
              {allowSubmitWhileRunning && (
                <Button
                  variant="brand"
                  size="sm"
                  className="gap-1 rounded-full px-3 shadow-[0_6px_16px_-8px_var(--brand)]"
                  onPointerDown={keepComposerFocus}
                  onMouseDown={keepComposerFocus}
                  onClick={submit}
                  disabled={
                    hasNothingToSend || submitting || !!disabled || !!noAgentGate || gate.uploading
                  }
                  aria-busy={submitting || gate.uploading || undefined}
                  aria-label={runningSendLabel}
                  title={runningSendTooltip}
                >
                  {submitting || gate.uploading ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <SendHorizontal aria-hidden="true" />
                  )}
                  {runningSendLabel}
                </Button>
              )}
              {!groupRunning && (
                <Button
                  variant="outline"
                  size="sm"
                  // `pointer-events-auto` is load-bearing: the card above drops
                  // pointer events when the composer is locked (noAgentGate),
                  // and Stop lives inside it — a live run used to become
                  // un-stoppable the moment the composer locked.
                  className="pointer-events-auto gap-1 rounded-full border-destructive/35 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onPointerDown={keepComposerFocus}
                  onMouseDown={keepComposerFocus}
                  onClick={onStop}
                  disabled={stopping}
                  aria-busy={stopping || undefined}
                  aria-label={stopActionLabel}
                  title={stopActionLabel}
                >
                  {stopping ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <Square className="size-3 fill-current" aria-hidden="true" />
                  )}
                  {stopActionLabel}
                </Button>
              )}
            </>
          ) : (
            <SubmitButton
              variant="brand"
              className="shadow-[0_6px_16px_-8px_var(--brand)]"
              onClick={submit}
              disabled={hasNothingToSend || submitting || !!disabled || !!noAgentGate}
              loading={submitting}
              busy={gate.uploading}
              tooltip={gate.uploading
                ? tEditor(($) => $.upload.in_progress)
                : tConv(($) => $.message.enter_send)}
              ariaLabel={gate.uploading
                ? tEditor(($) => $.upload.in_progress)
                : t(($) => $.input.send_tooltip)}
            />
          )}
        </div>
        {uploadEnabled && isDragOver && <FileDropOverlay />}
      </div>
      {resourceSharingEnabled && (
        <ResourcePickerDialog
          open={resourcePickerOpen}
          onOpenChange={setResourcePickerOpen}
          selected={resources}
          projectId={projectId}
          initialTab={resourcePickerTab}
          moduleTabEnabled={moduleAttachEnabled}
          onApply={(next) => changeResources(next.slice(0, CHAT_RESOURCE_DRAFT_LIMIT))}
        />
      )}
    </div>
  );
}
