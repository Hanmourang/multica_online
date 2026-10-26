package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// 会话通用化访问门控与共享端点（migration 478，plan 20261025 §4）。
//
// 单一入口 loadChatSessionForActor 按 kind 分流：agent 沿用既有 creator + public
// 投影 + 私有 agent 门控；dm/group 走参与者集合判定，非参与者一律 404（绝不套用
// public 投影把私域会话变成全员可达）。所有读消息/分页/发送/已读/附件/pin/archive
// 都必须经此入口。

// ChatAccess 是门控后的会话视图。Participant 对 dm/group 必有；agent 为 nil。
type ChatAccess struct {
	Session     db.ChatSession
	Participant *ChatParticipant
}

// loadChatSessionForActor 解析 {sessionId} 并按 kind 做访问门控。
// 返回 ok=false 时已写好错误响应，调用方直接 return。
func (h *Handler) loadChatSessionForActor(w http.ResponseWriter, r *http.Request, userID, workspaceID, sessionID string) (ChatAccess, bool) {
	sessionUUID, ok := parseUUIDOrBadRequest(w, sessionID, "chat session id")
	if !ok {
		return ChatAccess{}, false
	}
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return ChatAccess{}, false
	}
	session, err := h.Queries.GetChatSessionInWorkspace(r.Context(), db.GetChatSessionInWorkspaceParams{
		ID:          sessionUUID,
		WorkspaceID: workspaceUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "chat session not found")
		return ChatAccess{}, false
	}

	switch session.Kind {
	case "dm", "group":
		// 私域会话：仅当前人类参与者可达；非参与者统一 404，不泄露存在性。
		part, found := h.getChatParticipant(r.Context(), session.ID, "member", parseUUID(userID))
		if !found {
			writeError(w, http.StatusNotFound, "chat session not found")
			return ChatAccess{}, false
		}
		p := part
		return ChatAccess{Session: session, Participant: &p}, true
	default:
		// agent：完全沿用既有门控，保持存量语义零回归。
		sess, ok := h.gatePublicChatSessionForUser(w, r, userID, workspaceID, sessionID)
		if !ok {
			return ChatAccess{}, false
		}
		return ChatAccess{Session: sess}, true
	}
}

// GetChatParticipants 返回会话的成员与 Agent 列表（含展示信息）。
// agent 会话返回其 creator + 绑定的单一 agent，保持形状统一。
func (h *Handler) GetChatParticipants(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	sessionID := chi.URLParam(r, "sessionId")

	access, ok := h.loadChatSessionForActor(w, r, userID, workspaceID, sessionID)
	if !ok {
		return
	}

	participants, err := h.listChatParticipants(r.Context(), access.Session.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load participants")
		return
	}
	resp := make([]ChatParticipantResponse, 0, len(participants))
	for _, p := range participants {
		resp = append(resp, h.hydrateParticipantDisplay(r, p))
	}
	writeJSON(w, http.StatusOK, resp)
}

// ChatParticipantResponse 是对外参与者 DTO，附加展示名/头像。
type ChatParticipantResponse struct {
	ChatSessionID   string  `json:"chat_session_id"`
	ParticipantType string  `json:"participant_type"`
	ParticipantID   string  `json:"participant_id"`
	DisplayName     string  `json:"display_name"`
	AvatarURL       *string `json:"avatar_url,omitempty"`
	Admin           bool    `json:"admin"`
	JoinedAt        string  `json:"joined_at"`
	Pinned          bool    `json:"pinned"`
}

// publishConversationEvent fans a DM/Group event out to the session's current
// human participants via the in-process directed audience. agent-kind sessions
// keep the legacy workspace/creator broadcast (nil recipients). It never
// downgrades a non-nil empty audience to a workspace broadcast — sendTargeted
// drops it (fail-closed). See plan 20261025 §5.
func (h *Handler) publishConversationEvent(r *http.Request, session db.ChatSession, eventType, actorType, actorID string, payload any) {
	if session.Kind == "agent" || session.Kind == "" {
		h.publishChat(eventType, uuidToString(session.WorkspaceID), actorType, actorID, uuidToString(session.ID), payload)
		return
	}
	recipients, err := h.humanParticipantIDs(r.Context(), nil, session.ID)
	if err != nil {
		// Audience resolution failed: publish nothing rather than leak to the
		// workspace. Fail-closed is required for private conversations.
		return
	}
	h.Bus.Publish(events.Event{
		Type:             eventType,
		WorkspaceID:      uuidToString(session.WorkspaceID),
		ActorType:        actorType,
		ActorID:          actorID,
		ChatSessionID:    uuidToString(session.ID),
		Payload:          payload,
		ChatKind:         session.Kind,
		RecipientUserIDs: recipients,
	})
}

// hydrateParticipantDisplay 批量避免 N+1 的职责留给上层；此处逐条解析，仅在
// participants 端点（低频、集合小）使用。
func (h *Handler) hydrateParticipantDisplay(r *http.Request, p ChatParticipant) ChatParticipantResponse {
	out := ChatParticipantResponse{
		ChatSessionID:   p.ChatSessionID,
		ParticipantType: p.ParticipantType,
		ParticipantID:   p.ParticipantID,
		Admin:           p.Admin,
		JoinedAt:        p.JoinedAt,
		Pinned:          p.Pinned,
	}
	switch p.ParticipantType {
	case "agent":
		if a, err := h.Queries.GetAgent(r.Context(), parseUUID(p.ParticipantID)); err == nil {
			out.DisplayName = a.Name
			if a.AvatarUrl.Valid {
				out.AvatarURL = &a.AvatarUrl.String
			}
		}
	default:
		if u, err := h.Queries.GetUser(r.Context(), parseUUID(p.ParticipantID)); err == nil {
			out.DisplayName = u.Name
			if u.AvatarUrl.Valid {
				out.AvatarURL = &u.AvatarUrl.String
			}
		}
	}
	return out
}

// setConversationPin archives/pins at the PARTICIPANT level for dm/group, never
// touching chat_session.pinned_at/status (those are agent-session, per-creator
// fields). Pin/archive is viewer-local: the caller's row changes, the peer's does
// not. plan 20261025 §5.2.
func (h *Handler) setConversationPin(w http.ResponseWriter, r *http.Request, session db.ChatSession, userID string, pinned bool) {
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	if err := setParticipantPinned(r.Context(), tx, session.ID, userID, pinned); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update chat session")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update chat session")
		return
	}
	// Viewer-local state: notify ONLY the caller's own devices, so a peer's list
	// ordering is never disturbed.
	h.publishConversationEventToAudience(r, session, protocol.EventChatSessionUpdated, "member", userID,
		[]string{userID}, protocol.ChatSessionUpdatedPayload{
			ChatSessionID: uuidToString(session.ID),
			Title:         session.Title,
			Pinned:        &pinned,
			UpdatedAt:     timestampToString(session.UpdatedAt),
		})
	writeJSON(w, http.StatusOK, chatSessionToResponse(session))
}

// setConversationArchived archives/unarchives a dm/group at the participant
// level. It deliberately skips the agent task-cancel / channel-binding logic in
// SetChatSessionArchived: a dm/group message creates no AgentTask and has no
// external binding, so there is nothing to sever or cancel. plan 20261025 §5.2.
func (h *Handler) setConversationArchived(w http.ResponseWriter, r *http.Request, session db.ChatSession, userID string, archived bool) {
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	if err := setParticipantArchived(r.Context(), tx, session.ID, userID, archived); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update chat session")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update chat session")
		return
	}
	h.publishConversationEventToAudience(r, session, protocol.EventChatSessionUpdated, "member", userID,
		[]string{userID}, protocol.ChatSessionUpdatedPayload{
			ChatSessionID: uuidToString(session.ID),
			Title:         session.Title,
			UpdatedAt:     timestampToString(session.UpdatedAt),
		})
	writeJSON(w, http.StatusOK, chatSessionToResponse(session))
}

// markConversationRead advances ONLY the caller's participant read cursor with
// the composite (created_at,id) key, so a concurrent message with a larger id
// that lands after the read is still counted unread for them. The peer's cursor
// is never touched. Absent through_message_id, the cursor is the latest visible
// message — never now(), which would swallow a message that arrived mid-read.
// plan 20261025 §5.1.
func (h *Handler) markConversationRead(w http.ResponseWriter, r *http.Request, session db.ChatSession, userID, throughMessageID string) {
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())

	var (
		cursorAt pgtype.Timestamptz
		cursorID pgtype.UUID
	)
	if throughMessageID != "" {
		msgUUID, ok := parseUUIDOrBadRequest(w, throughMessageID, "through_message_id")
		if !ok {
			return
		}
		// The referenced message must belong to THIS session, else 404 (an
		// attacker-supplied id from another conversation must not move the cursor).
		err = tx.QueryRow(r.Context(), `SELECT created_at, id FROM chat_message
			WHERE id = $1 AND chat_session_id = $2`, msgUUID, session.ID).Scan(&cursorAt, &cursorID)
		if err != nil {
			writeError(w, http.StatusNotFound, "message not found")
			return
		}
	} else {
		err = tx.QueryRow(r.Context(), `SELECT created_at, id FROM chat_message
			WHERE chat_session_id = $1 AND message_kind IS DISTINCT FROM 'channel_command'
			ORDER BY created_at DESC, id DESC LIMIT 1`, session.ID).Scan(&cursorAt, &cursorID)
		if errors.Is(err, pgx.ErrNoRows) {
			// Nothing to read yet: succeed without moving any cursor and without
			// falling back to a workspace-clock now().
			if err := tx.Commit(r.Context()); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to mark session read")
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to mark session read")
			return
		}
	}

	if err := markConversationReadTx(r.Context(), tx, session.ID, userID, cursorAt, cursorID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to mark session read")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to mark session read")
		return
	}

	resolvedSessionID := uuidToString(session.ID)
	readerID := userID
	h.publishConversationEventToAudience(r, session, protocol.EventChatSessionRead, "member", userID, []string{userID},
		protocol.ChatSessionReadPayload{
			ChatSessionID:     resolvedSessionID,
			ReaderID:          readerID,
			LastReadAt:        timestampToString(cursorAt),
			LastReadMessageID: uuidToString(cursorID),
		})
	w.WriteHeader(http.StatusNoContent)
}

// publishConversationEventToAudience publishes a directed event to an explicit
// recipient set (viewer-local updates such as pin/archive/read). It never falls
// back to a workspace broadcast: a dm/group event with an empty audience is
// dropped fail-closed by sendTargeted. agent-kind sessions route through the
// legacy broadcast helper instead.
func (h *Handler) publishConversationEventToAudience(r *http.Request, session db.ChatSession, eventType, actorType, actorID string, recipients []string, payload any) {
	if session.Kind == "agent" || session.Kind == "" {
		h.publishChat(eventType, uuidToString(session.WorkspaceID), actorType, actorID, uuidToString(session.ID), payload)
		return
	}
	h.Bus.Publish(events.Event{
		Type:             eventType,
		WorkspaceID:      uuidToString(session.WorkspaceID),
		ActorType:        actorType,
		ActorID:          actorID,
		ChatSessionID:    uuidToString(session.ID),
		Payload:          payload,
		ChatKind:         session.Kind,
		RecipientUserIDs: recipients,
	})
}
