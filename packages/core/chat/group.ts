import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { createLogger } from "../logger";
import { chatKeys } from "./queries";
import type { ChatParticipant, ChatSession } from "../types";

const logger = createLogger("chat.group");

/**
 * Create a multi-member group (plan 20261025 §6.2, mirrors useCreateDMChatSession).
 *
 * Unlike the DM endpoint this is NOT idempotent — every call opens a fresh
 * room — so there is no existing-session branch to navigate to; the created
 * id is what the caller opens. The server derives the roster from the
 * member/agent ids (creator is admin implicitly), so we seed the detail cache
 * AND, when the response carries the participant list, the roster cache — the
 * settings sheet and header can then render without waiting on a GET. The
 * sessions list is invalidated on settle so the thread row lands.
 */
export function useCreateGroupChatSession() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (data: { title?: string; member_ids: string[]; agent_ids?: string[]; project_id?: string }) => {
      logger.info("createGroupChatSession.start", {
        memberCount: data.member_ids.length,
        agentCount: data.agent_ids?.length ?? 0,
      });
      return api.createGroupChatSession(data);
    },
    onSuccess: (session: ChatSession) => {
      logger.info("createGroupChatSession.success", { sessionId: session.id });
      qc.setQueryData(chatKeys.session(wsId, session.id), session);
      if (session.participants && session.participants.length > 0) {
        qc.setQueryData(chatKeys.participants(session.id), session.participants);
      }
    },
    onError: (err) => {
      logger.error("createGroupChatSession.error", { err });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
    },
  });
}

/**
 * Admin add/remove/set-admin mutations share one contract: the server answers
 * with the FULL fresh roster (`{ participants }`), so each success writes the
 * roster cache directly (no refetch roundtrip) and invalidates the sessions
 * list — participant count feeds the thread row and the header subtitle.
 * 403 (not admin) / 409 (zero-admin invariant, raced membership) are expected
 * operator conflicts: they throw to the caller for a toast, and onSettled
 * re-converges the roster either way because the server state may have moved.
 */
function useGroupRosterMutationBase() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return { qc, wsId };
}

function groupRosterSettled(qc: ReturnType<typeof useQueryClient>, wsId: string, sessionId: string) {
  qc.invalidateQueries({ queryKey: chatKeys.participants(sessionId) });
  qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
}

export function useAddGroupParticipants() {
  const { qc, wsId } = useGroupRosterMutationBase();
  return useMutation({
    mutationFn: (vars: { sessionId: string; memberIds?: string[]; agentIds?: string[] }) => {
      logger.info("addGroupParticipants.start", { sessionId: vars.sessionId });
      return api.addGroupParticipants(vars.sessionId, {
        member_ids: vars.memberIds,
        agent_ids: vars.agentIds,
      });
    },
    onSuccess: (participants, vars) => {
      logger.info("addGroupParticipants.success", { sessionId: vars.sessionId, count: participants.length });
      qc.setQueryData(chatKeys.participants(vars.sessionId), participants);
    },
    onError: (err, vars) => {
      logger.error("addGroupParticipants.error", { sessionId: vars.sessionId, err });
    },
    onSettled: (_d, _e, vars) => groupRosterSettled(qc, wsId, vars.sessionId),
  });
}

export function useRemoveGroupParticipant() {
  const { qc, wsId } = useGroupRosterMutationBase();
  return useMutation({
    mutationFn: (vars: { sessionId: string; participantType: "member" | "agent"; participantId: string }) => {
      logger.info("removeGroupParticipant.start", { sessionId: vars.sessionId, participantId: vars.participantId });
      return api.removeGroupParticipant(vars.sessionId, vars.participantType, vars.participantId);
    },
    onSuccess: (participants, vars) => {
      logger.info("removeGroupParticipant.success", { sessionId: vars.sessionId, count: participants.length });
      qc.setQueryData(chatKeys.participants(vars.sessionId), participants);
    },
    onError: (err, vars) => {
      logger.error("removeGroupParticipant.error", { sessionId: vars.sessionId, err });
    },
    onSettled: (_d, _e, vars) => groupRosterSettled(qc, wsId, vars.sessionId),
  });
}

export function useSetGroupParticipantAdmin() {
  const { qc, wsId } = useGroupRosterMutationBase();
  return useMutation({
    mutationFn: (vars: { sessionId: string; participantId: string; admin: boolean }) => {
      logger.info("setGroupParticipantAdmin.start", { sessionId: vars.sessionId, admin: vars.admin });
      return api.setGroupParticipantAdmin(vars.sessionId, vars.participantId, vars.admin);
    },
    onSuccess: (participants, vars) => {
      logger.info("setGroupParticipantAdmin.success", { sessionId: vars.sessionId, count: participants.length });
      qc.setQueryData(chatKeys.participants(vars.sessionId), participants);
    },
    onError: (err, vars) => {
      logger.error("setGroupParticipantAdmin.error", { sessionId: vars.sessionId, err });
    },
    onSettled: (_d, _e, vars) => groupRosterSettled(qc, wsId, vars.sessionId),
  });
}

/**
 * Leave the group as the caller. The server drops the membership row and
 * directs the participant-change event to the rest of the room; locally the
 * session must vanish from EVERY list cache (the caller navigates away) and
 * its message/pending caches are dropped so a stale re-open cannot render a
 * transcript the user no longer has access to. Last-admin 409s propagate —
 * the sheet tells the user to transfer admin first.
 */
export function useLeaveGroupChatSession() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (sessionId: string) => {
      logger.info("leaveGroupChatSession.start", { sessionId });
      return api.leaveGroupChatSession(sessionId);
    },
    onSuccess: (_void, sessionId) => {
      logger.info("leaveGroupChatSession.success", { sessionId });
      qc.removeQueries({ queryKey: chatKeys.participants(sessionId) });
      qc.removeQueries({ queryKey: chatKeys.messages(sessionId) });
      qc.removeQueries({ queryKey: chatKeys.messagesPage(sessionId) });
      qc.removeQueries({ queryKey: chatKeys.pendingTask(sessionId) });
      qc.removeQueries({ queryKey: chatKeys.session(wsId, sessionId) });
    },
    onError: (err, sessionId) => {
      logger.error("leaveGroupChatSession.error", { sessionId, err });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
    },
  });
}

/**
 * Group-member agents eligible for @-fan-out: the agent participants of the
 * roster. Message-list attribution and the multi-task pending pill both key
 * agent state off this set rather than the session's (null) owning agent.
 */
export function selectGroupAgents(
  participants: ChatParticipant[] | undefined,
): ChatParticipant[] {
  if (!participants) return [];
  return participants.filter((p) => p.participant_type === "agent");
}

/**
 * Whether the roster still lists the given user as a member participant —
 * the settings sheet self-checks after every remove/set-admin so an
 * admin-demotes-self or removed-by-peer transition can navigate the view away
 * from a room the user just lost (same directed event the roster invalidation
 * rides, but the navigation decision needs the settled roster, not a guess).
 */
/**
 * Drop every private cache for a conversation the viewer just lost. The
 * removed event carries no transcript, and a refetch would 404 — leaving the
 * old pages in place would keep the history readable.
 */
export function clearRemovedConversationCaches(
  qc: QueryClient,
  wsId: string | null | undefined,
  sessionId: string,
) {
  qc.removeQueries({ queryKey: chatKeys.participants(sessionId) });
  qc.removeQueries({ queryKey: chatKeys.messages(sessionId) });
  qc.removeQueries({ queryKey: chatKeys.messagesPage(sessionId) });
  qc.removeQueries({ queryKey: chatKeys.pendingTask(sessionId) });
  qc.removeQueries({ queryKey: chatKeys.quickActionsPending(sessionId) });
  if (wsId) {
    qc.removeQueries({ queryKey: chatKeys.session(wsId, sessionId) });
    qc.setQueryData<ChatSession[] | undefined>(chatKeys.sessions(wsId), (old) =>
      old?.filter((session) => session.id !== sessionId),
    );
  }
}

export function selectGroupStillMember(
  participants: ChatParticipant[] | undefined,
  currentUserId: string | undefined,
): boolean {
  if (!participants || !currentUserId) return true;
  return participants.some(
    (p) => p.participant_type === "member" && p.participant_id === currentUserId,
  );
}
