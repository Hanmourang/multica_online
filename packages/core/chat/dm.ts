import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { createLogger } from "../logger";
import { chatKeys } from "./queries";
import type { ChatParticipant, ChatSession } from "../types";

const logger = createLogger("chat.dm");

/**
 * Create (or resume) a 1:1 DM with a workspace member (plan 20261025 §6.1).
 *
 * The server is idempotent on the ordered member pair: a second create for the
 * same peer returns the existing session (200) rather than duplicating it, so
 * the caller never has to de-dupe the list itself — it just navigates to the
 * `id` that comes back. We seed that session into its detail cache and
 * invalidate the list so the thread row (title/participants from the roster)
 * lands on the next fetch. No optimistic row: the title/participants are
 * derived server-side from the peer, not from anything the client already has.
 */
export function useCreateDMChatSession() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (memberId: string) => {
      logger.info("createDMChatSession.start", { memberId });
      return api.createDMChatSession({ member_id: memberId });
    },
    onSuccess: (session: ChatSession) => {
      logger.info("createDMChatSession.success", { sessionId: session.id });
      qc.setQueryData(chatKeys.session(wsId, session.id), session);
    },
    onError: (err, memberId) => {
      logger.error("createDMChatSession.error", { memberId, err });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
    },
  });
}

/**
 * Participant roster for a dm/group session. Agent sessions have no roster
 * query — callers gate on `enabled` (conversation kind + flag). Invalidated by
 * the chat:participants_changed realtime event via chatKeys.participants.
 */
export function chatParticipantsOptions(sessionId: string, enabled = true) {
  return queryOptions({
    queryKey: chatKeys.participants(sessionId),
    queryFn: () => api.getChatParticipants(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: Infinity,
  });
}

/**
 * The "other side" of a DM — the member participant that isn't the current
 * user. Used by the thread list / session header to render the peer's name and
 * avatar without assuming every row owns an agent. Returns undefined for agent
 * sessions or a roster that hasn't hydrated yet.
 */
export function selectDMPeer(
  participants: ChatParticipant[] | undefined,
  currentUserId: string,
): ChatParticipant | undefined {
  if (!participants) return undefined;
  return participants.find(
    (p) => p.participant_type === "member" && p.participant_id !== currentUserId,
  );
}
