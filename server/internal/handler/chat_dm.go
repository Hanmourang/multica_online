package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// DM 用户↔用户 1:1 私聊（plan 20261025-聊天模块-人与人群聊 §01）。
//
// 复用统一 chat_session/chat_message，kind='dm'、agent_id=NULL、dm_pair_key 防重。
// 消息只落库，绝不创建 AgentTask；实时事件只发两名成员（见 publishConversationEvent）。

type CreateDMChatSessionRequest struct {
	MemberID string `json:"member_id"`
}

// dmPairKey 生成稳定、无序的配对键，保证 A→B 与 B→A 命中同一会话。
func dmPairKey(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + ":" + b
}

// CreateDMChatSession 创建或恢复与目标成员的唯一 1:1 会话。
// 201 新建；200 命中既有 dm_pair_key 返回原会话；400 目标是自己/非法 UUID；
// 404 目标不是当前工作区成员。
func (h *Handler) CreateDMChatSession(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())

	var req CreateDMChatSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.MemberID == "" {
		writeError(w, http.StatusBadRequest, "member_id is required")
		return
	}
	if req.MemberID == userID {
		writeError(w, http.StatusBadRequest, "cannot start a direct message with yourself")
		return
	}
	targetUUID, ok := parseUUIDOrBadRequest(w, req.MemberID, "member_id")
	if !ok {
		return
	}
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}

	pairKey := dmPairKey(userID, req.MemberID)

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	if _, err := qtx.LockWorkspaceForChatSessionCreate(r.Context(), workspaceUUID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to lock workspace")
		return
	}
	// 目标必须是当前工作区成员；调用者已由 workspace middleware 校验。
	if _, err := qtx.GetMemberByUserAndWorkspace(r.Context(), db.GetMemberByUserAndWorkspaceParams{
		UserID:      targetUUID,
		WorkspaceID: workspaceUUID,
	}); err != nil {
		writeError(w, http.StatusNotFound, "member not found")
		return
	}

	var session db.ChatSession
	newSession := true
	err = tx.QueryRow(r.Context(), `
		INSERT INTO chat_session (id, workspace_id, agent_id, creator_id, kind, dm_pair_key, explicitly_created_at)
		VALUES ($1, $2, NULL, $3, 'dm', $4, now())
		ON CONFLICT (workspace_id, dm_pair_key) WHERE kind = 'dm' DO NOTHING
		RETURNING id, workspace_id, agent_id, creator_id, title, status, kind, dm_pair_key, created_at, updated_at, project_id, pinned_at`,
		dbid.NewV7(), workspaceUUID, parseUUID(userID), pairKey,
	).Scan(&session.ID, &session.WorkspaceID, &session.AgentID, &session.CreatorID,
		&session.Title, &session.Status, &session.Kind, &session.DmPairKey,
		&session.CreatedAt, &session.UpdatedAt, &session.ProjectID, &session.PinnedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// 命中唯一索引：并发或重复请求，取回既有会话。
		newSession = false
		session, err = qtx.GetChatSessionByDMPairKey(r.Context(), db.GetChatSessionByDMPairKeyParams{
			WorkspaceID: workspaceUUID,
			DmPairKey:   pgtype.Text{String: pairKey, Valid: true},
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load dm session")
			return
		}
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create dm session")
		return
	}

	if newSession {
		// 两名成员参与者，admin=false，阅读游标默认 now()（历史不计未读）。
		if err := insertChatParticipantTx(r.Context(), tx, session.ID, "member", parseUUID(userID), false); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to add dm participant")
			return
		}
		if err := insertChatParticipantTx(r.Context(), tx, session.ID, "member", targetUUID, false); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to add dm participant")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit dm create")
		return
	}

	resp := chatSessionToResponse(session)
	peerName := h.userDisplayName(r.Context(), peerOfPair(userID, req.MemberID))
	resp.Title = peerName
	resp.Participants = h.participantResponses(r, session.ID)

	if newSession {
		h.publishConversationEvent(r, session, protocol.EventChatSessionCreated, "member", userID, protocol.ChatSessionCreatedPayload{
			WorkspaceID:   uuidToString(session.WorkspaceID),
			ChatSessionID: uuidToString(session.ID),
			Title:         peerName,
		})
		writeJSON(w, http.StatusCreated, resp)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// peerOfPair 返回配对中除自己以外的另一方。
func peerOfPair(self, other string) string { return other }

// userDisplayName 取用户显示名，缺失回退空串。
func (h *Handler) userDisplayName(ctx context.Context, userID string) string {
	u, err := h.Queries.GetUser(ctx, parseUUID(userID))
	if err != nil {
		return ""
	}
	return u.Name
}

// participantResponses 组装某会话的参与者 DTO（成员在前、Agent 在后）。
func (h *Handler) participantResponses(r *http.Request, sessionID pgtype.UUID) []ChatParticipantResponse {
	ps, err := h.listChatParticipants(r.Context(), sessionID)
	if err != nil {
		return nil
	}
	sort.SliceStable(ps, func(i, j int) bool {
		mi := ps[i].ParticipantType == "member"
		mj := ps[j].ParticipantType == "member"
		return mi && !mj
	})
	out := make([]ChatParticipantResponse, 0, len(ps))
	for _, p := range ps {
		out = append(out, h.hydrateParticipantDisplay(r, p))
	}
	return out
}

// sendDMChatMessage persists a member message into a DM session and delivers it
// ONLY to the two members. It never creates an AgentTask, never calls agent
// readiness, and never touches the queue (plan 20261025 §4.2). The caller has
// already run loadChatSessionForActor, so access.Participant confirms the sender
// is a member; we re-verify under a row lock in case they were removed between
// the gate and this write.
func (h *Handler) sendDMChatMessage(w http.ResponseWriter, r *http.Request, access ChatAccess, userID, workspaceID string, req SendChatMessageRequest, attachmentIDs []pgtype.UUID) {
	session := access.Session
	// A DM turn may contain only attachments or resource references.
	if strings.TrimSpace(req.Content) == "" && len(attachmentIDs) == 0 && len(req.ResourceRefs) == 0 {
		writeError(w, http.StatusBadRequest, "content, attachments, or resources are required")
		return
	}
	if session.Status != "active" {
		writeError(w, http.StatusConflict, "chat session is archived")
		return
	}

	// Member set for mention validation, resolved before the transaction (a
	// read failure here must not hold an open tx).
	humanIDs, err := h.humanParticipantIDs(r.Context(), nil, session.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load conversation")
		return
	}
	memberSet := make(map[string]bool, len(humanIDs))
	for _, id := range humanIDs {
		memberSet[id] = true
	}
	// Mentions must be members of this DM, deduped, and never the sender. Any
	// other target is a 400 (enumeration-safe: no existence leak beyond the pair).
	seen := make(map[string]bool)
	validMentions := make([]protocol.ChatMention, 0, len(req.Mentions))
	mentioned := make([]string, 0, len(req.Mentions))
	for _, m := range req.Mentions {
		if m.Type != "member" {
			writeError(w, http.StatusBadRequest, "dm mentions must target members")
			return
		}
		if !memberSet[m.ID] {
			writeError(w, http.StatusBadRequest, "mention is not a participant")
			return
		}
		if m.ID == userID || seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		validMentions = append(validMentions, protocol.ChatMention{Type: "member", ID: m.ID})
		mentioned = append(mentioned, m.ID)
	}
	mentionsJSON, err := json.Marshal(validMentions)
	if err != nil {
		mentionsJSON = []byte("[]")
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	// Row-lock the session and re-verify kind/status after the gate window.
	var lockedKind, lockedStatus string
	if err := tx.QueryRow(r.Context(),
		`SELECT kind, status FROM chat_session WHERE id = $1 FOR UPDATE`, session.ID,
	).Scan(&lockedKind, &lockedStatus); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to lock conversation")
		return
	}
	if lockedKind != "dm" || lockedStatus != "active" {
		writeError(w, http.StatusConflict, "chat session is archived")
		return
	}
	// Sender must still be a participant under the lock, else 404 (no existence leak).
	var stillMember int
	if err := tx.QueryRow(r.Context(), `SELECT 1 FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = 'member' AND participant_id = $2::uuid`,
		session.ID, userID).Scan(&stillMember); err != nil {
		writeError(w, http.StatusNotFound, "chat session not found")
		return
	}

	msg, err := qtx.CreateChatMessage(r.Context(), db.CreateChatMessageParams{
		ID:            dbid.NewV7(),
		ChatSessionID: session.ID,
		Role:          "user",
		Content:       req.Content,
		TaskID:        pgtype.UUID{}, // DM messages own no agent task
		MessageKind:   pgtype.Text{String: protocol.ChatMessageKindMessage, Valid: true},
		AuthorType:    pgtype.Text{String: "member", Valid: true},
		AuthorID:      parseUUID(userID),
		Mentions:      mentionsJSON,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to send message")
		return
	}
	if err := writeChatResourceRefs(r.Context(), qtx, msg.ID, req.ResourceRefs); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to link chat resources")
		return
	}

	boundIDs := make([]string, 0, len(attachmentIDs))
	if len(attachmentIDs) > 0 {
		bound, err := qtx.LinkAttachmentsToChatMessage(r.Context(), db.LinkAttachmentsToChatMessageParams{
			ChatMessageID: msg.ID,
			ChatSessionID: session.ID,
			WorkspaceID:   session.WorkspaceID,
			UploaderType:  "member",
			UploaderID:    parseUUID(userID),
			AttachmentIds: attachmentIDs,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to attach files")
			return
		}
		for _, id := range bound {
			boundIDs = append(boundIDs, uuidToString(id))
		}
	}

	if err := qtx.TouchChatSession(r.Context(), session.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update conversation")
		return
	}
	// New activity clears every member's own archive except the sender's, so a
	// DM the peer had archived re-surfaces in their list without touching status.
	if err := clearOtherParticipantsArchivedTx(r.Context(), tx, session.ID, userID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update conversation")
		return
	}

	// @member → one inbox item per mentioned peer (title is the sender's name,
	// body is a truncated summary; never embeds an attachment URL). Details is
	// navigation-only so the inbox renderer can deep-link the DM.
	type navDetails struct {
		ChatSessionID string `json:"chat_session_id"`
		MessageID     string `json:"message_id"`
	}
	senderName := h.userDisplayName(r.Context(), userID)
	summary := summarizeMessage(req.Content)
	inboxItems := make([]db.InboxItem, 0, len(mentioned))
	for _, uid := range mentioned {
		details, _ := json.Marshal(navDetails{ChatSessionID: uuidToString(session.ID), MessageID: uuidToString(msg.ID)})
		item, err := qtx.CreateInboxItem(r.Context(), db.CreateInboxItemParams{
			ID:            dbid.NewV7(),
			WorkspaceID:   session.WorkspaceID,
			RecipientType: "member",
			RecipientID:   parseUUID(uid),
			Type:          "chat_mention",
			Severity:      "info",
			IssueID:       pgtype.UUID{},
			Title:         senderName,
			Body:          pgtype.Text{String: summary, Valid: summary != ""},
			ActorType:     pgtype.Text{String: "member", Valid: true},
			ActorID:       parseUUID(userID),
			Details:       details,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to notify mention")
			return
		}
		inboxItems = append(inboxItems, item)
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to send message")
		return
	}

	resolvedSessionID := uuidToString(session.ID)
	resources := h.groupChatMessageResources(r, session.WorkspaceID, []pgtype.UUID{msg.ID})[uuidToString(msg.ID)]
	// Directed delivery to exactly the two members (publishConversationEvent
	// resolves the audience from the participant set; nil audience is dropped).
	h.publishConversationEvent(r, session, protocol.EventChatMessage, "member", userID, protocol.ChatMessagePayload{
		ChatSessionID: resolvedSessionID,
		MessageID:     uuidToString(msg.ID),
		Role:          "user",
		Content:       req.Content,
		CreatedAt:     timestampToString(msg.CreatedAt),
		Kind:          "dm",
		AuthorType:    "member",
		AuthorID:      userID,
		Mentions:      validMentions,
		HasResources:  len(req.ResourceRefs) > 0,
	})
	for _, item := range inboxItems {
		h.Bus.Publish(events.Event{
			Type:        protocol.EventInboxNew,
			WorkspaceID: uuidToString(item.WorkspaceID),
			ActorType:   "member",
			ActorID:     userID,
			ChatKind:    session.Kind,
			Payload:     map[string]any{"item": dmInboxItemFields(item)},
		})
	}

	writeJSON(w, http.StatusCreated, SendChatMessageResponse{
		MessageID:     uuidToString(msg.ID),
		SupportsQueue: false,
		Queued:        false,
		CreatedAt:     timestampToString(msg.CreatedAt),
		AttachmentIDs: boundIDs,
		Kind:          "dm",
		Dispatches:    []any{},
		Resources:     resources,
	})
}

// sendGroupChatMessage persists a member message into a Group session and
// delivers it ONLY to the session's current human participants. Plain group
// chatter and @member inbox notifications are fully supported here (plan 02
// §2.3: no @Agent → dispatches=[], task count unchanged). When the message
// @-mentions Agents the whole send goes through TaskService.SendGroupMessage
// (plan 02 §4): one atomic transaction persists the single human message
// (task_id=NULL), one agent task per mentioned Agent with an immutable
// chat_group_task_input snapshot, and @member inbox items; any precheck or
// in-tx recheck failure rolls everything back (§4.1 all-or-nothing, SEC-12),
// so the client is never left believing an Agent fired when it did not.
// The sender's access was already gated by loadChatSessionForActor; the
// sender-participant and kind are re-verified under a row lock below.
func (h *Handler) sendGroupChatMessage(w http.ResponseWriter, r *http.Request, access ChatAccess, userID, workspaceID string, req SendChatMessageRequest, attachmentIDs []pgtype.UUID) {
	session := access.Session
	if strings.TrimSpace(req.Content) == "" && len(attachmentIDs) == 0 && len(req.ResourceRefs) == 0 {
		writeError(w, http.StatusBadRequest, "content, attachments, or resources are required")
		return
	}
	if session.Status != "active" {
		writeError(w, http.StatusConflict, "chat session is archived")
		return
	}

	// Human participant set for audience + mention validation (resolved before
	// the tx). Agent participants are collected separately: an @Agent mention
	// must target a current agent participant or the send is rejected outright.
	humanIDs, err := h.humanParticipantIDs(r.Context(), nil, session.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load conversation")
		return
	}
	memberSet := make(map[string]bool, len(humanIDs))
	for _, id := range humanIDs {
		memberSet[id] = true
	}
	agentParticipantIDs, err := h.agentParticipantIDs(r.Context(), session.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load conversation")
		return
	}
	agentSet := make(map[string]bool, len(agentParticipantIDs))
	for _, id := range agentParticipantIDs {
		agentSet[uuidToString(id)] = true
	}

	// Validate mentions (plan 02 §2.3): type must be member/agent and target a
	// current participant; the mention:// markdown link must actually appear in
	// content (SEC-07 — a hidden structured mention never triggers a dispatch);
	// dedup by (type,id); sender self-notify is dropped; total capped at 20.
	seen := make(map[string]bool)
	validMentions := make([]protocol.ChatMention, 0, len(req.Mentions))
	mentioned := make([]string, 0, len(req.Mentions))
	var agentMentionIDs []pgtype.UUID
	for _, m := range req.Mentions {
		if m.Type != "member" && m.Type != "agent" {
			writeError(w, http.StatusBadRequest, "group mentions must target members or agents")
			return
		}
		if !strings.Contains(req.Content, "mention://"+m.Type+"/"+m.ID) {
			writeError(w, http.StatusBadRequest, "mention must appear in the message text")
			return
		}
		dedupKey := m.Type + "/" + m.ID
		if seen[dedupKey] {
			continue
		}
		if m.Type == "agent" {
			if !agentSet[m.ID] {
				writeError(w, http.StatusBadRequest, "mention is not a group agent participant")
				return
			}
			seen[dedupKey] = true
			validMentions = append(validMentions, protocol.ChatMention{Type: "agent", ID: m.ID})
			agentMentionIDs = append(agentMentionIDs, parseUUID(m.ID))
			continue
		}
		if !memberSet[m.ID] {
			writeError(w, http.StatusBadRequest, "mention is not a participant")
			return
		}
		if m.ID == userID {
			continue
		}
		seen[dedupKey] = true
		validMentions = append(validMentions, protocol.ChatMention{Type: "member", ID: m.ID})
		mentioned = append(mentioned, m.ID)
	}
	if len(validMentions) > 20 {
		writeError(w, http.StatusBadRequest, "too many mentions in one message")
		return
	}
	mentionsJSON, err := json.Marshal(validMentions)
	if err != nil {
		mentionsJSON = []byte("[]")
	}

	// ── @Agent 扇出分支（plan 02 §4）─────────────────────────────────────────
	// 事务前逐 Agent 预检：同工作区、未归档、发起人仍有 invoke。非拥有者触发时，
	// 还要求全体现存人类成员都能 view，避免权限回收后旧群继续借群触发（R4）。
	// 拥有者本人可以在群里使用自己的私有 Agent，不因其他成员缺少 view 而被拒绝。
	// 任一失败整次拒收，附带脱敏的 blocked_agents（只含 id+粗粒度原因，SEC-11）。
	if len(agentMentionIDs) > 0 {
		type blockedAgent struct {
			ID     string `json:"id"`
			Reason string `json:"reason"`
		}
		blocked := make([]blockedAgent, 0)
		for _, aid := range agentMentionIDs {
			agent, err := h.Queries.GetAgent(r.Context(), aid)
			if err != nil || uuidToString(agent.WorkspaceID) != workspaceID {
				blocked = append(blocked, blockedAgent{ID: uuidToString(aid), Reason: "unavailable"})
				continue
			}
			if agent.ArchivedAt.Valid {
				blocked = append(blocked, blockedAgent{ID: uuidToString(aid), Reason: "archived"})
				continue
			}
			if !h.canInvokeAgent(r.Context(), agent, "member", userID, userID, workspaceID) {
				blocked = append(blocked, blockedAgent{ID: uuidToString(aid), Reason: "invocation_revoked"})
				continue
			}
			if uuidToString(agent.OwnerID) == userID {
				continue
			}
			visible := true
			for _, hid := range humanIDs {
				if !h.canAccessPrivateAgent(r.Context(), agent, "member", hid, workspaceID) {
					visible = false
					break
				}
			}
			if !visible {
				blocked = append(blocked, blockedAgent{ID: uuidToString(aid), Reason: "visibility_revoked"})
			}
		}
		if len(blocked) > 0 {
			// 预检失败同样零落库（整个请求在任何写入前就被拒绝）。
			writeJSON(w, http.StatusForbidden, map[string]any{
				"error":          "group agent dispatch rejected",
				"blocked_agents": blocked,
			})
			return
		}
		send, err := h.TaskService.SendGroupMessageWithResources(r.Context(), session, parseUUID(userID),
			req.Content, attachmentIDs, agentMentionIDs, mentionUUIDs(mentioned), mentionsJSON, req.ResourceRefs)
		if err != nil {
			switch {
			case errors.Is(err, service.ErrGroupChatSessionNotGroup),
				errors.Is(err, service.ErrGroupChatNotParticipant),
				errors.Is(err, service.ErrChatSessionArchived):
				// 并发中成员/会话被变更：整次回滚，零消息零任务（§4.1）。
				writeError(w, http.StatusConflict, "group membership changed; message not sent")
			case errors.Is(err, service.ErrChatTaskAgentArchived):
				writeError(w, http.StatusForbidden, "group agent dispatch rejected: agent archived")
			case errors.Is(err, service.ErrChatTaskAgentNoRuntime):
				writeError(w, http.StatusConflict, "group agent dispatch rejected: agent has no runtime")
			default:
				writeError(w, http.StatusInternalServerError, "failed to send message")
			}
			return
		}
		// §4.2 提交后事件次序：先 chat:message（含 agent mentions），再 inbox，
		// 最后每任务 task:queued + daemon 唤醒。
		resolvedSessionID := uuidToString(session.ID)
		resources := h.groupChatMessageResources(r, session.WorkspaceID, []pgtype.UUID{send.Message.ID})[uuidToString(send.Message.ID)]
		h.publishConversationEvent(r, session, protocol.EventChatMessage, "member", userID, protocol.ChatMessagePayload{
			ChatSessionID: resolvedSessionID,
			MessageID:     uuidToString(send.Message.ID),
			Role:          "user",
			Content:       req.Content,
			CreatedAt:     timestampToString(send.Message.CreatedAt),
			Kind:          "group",
			AuthorType:    "member",
			AuthorID:      userID,
			Mentions:      validMentions,
			HasResources:  len(req.ResourceRefs) > 0,
		})
		for _, item := range send.InboxItems {
			h.Bus.Publish(events.Event{
				Type:        protocol.EventInboxNew,
				WorkspaceID: uuidToString(item.WorkspaceID),
				ActorType:   "member",
				ActorID:     userID,
				ChatKind:    session.Kind,
				Payload:     map[string]any{"item": dmInboxItemFields(item)},
			})
		}
		h.TaskService.NotifyGroupDispatches(r.Context(), send.Dispatches)
		dispatches := make([]any, 0, len(send.Dispatches))
		for _, d := range send.Dispatches {
			dispatches = append(dispatches, map[string]any{
				"agent_id": uuidToString(d.AgentID),
				"task_id":  uuidToString(d.Task.ID),
				"status":   "queued",
			})
		}
		boundIDs := make([]string, 0, len(send.BoundAttachmentIDs))
		for _, id := range send.BoundAttachmentIDs {
			boundIDs = append(boundIDs, uuidToString(id))
		}
		writeJSON(w, http.StatusCreated, SendChatMessageResponse{
			MessageID:     uuidToString(send.Message.ID),
			SupportsQueue: false,
			Queued:        false,
			CreatedAt:     timestampToString(send.Message.CreatedAt),
			AttachmentIDs: boundIDs,
			Kind:          "group",
			Dispatches:    dispatches,
			Resources:     resources,
		})
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	var lockedKind, lockedStatus string
	if err := tx.QueryRow(r.Context(),
		`SELECT kind, status FROM chat_session WHERE id = $1 FOR UPDATE`, session.ID,
	).Scan(&lockedKind, &lockedStatus); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to lock conversation")
		return
	}
	if lockedKind != "group" || lockedStatus != "active" {
		writeError(w, http.StatusConflict, "chat session is archived")
		return
	}
	var stillMember int
	if err := tx.QueryRow(r.Context(), `SELECT 1 FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = 'member' AND participant_id = $2::uuid`,
		session.ID, userID).Scan(&stillMember); err != nil {
		writeError(w, http.StatusNotFound, "chat session not found")
		return
	}

	msg, err := qtx.CreateChatMessage(r.Context(), db.CreateChatMessageParams{
		ID:            dbid.NewV7(),
		ChatSessionID: session.ID,
		Role:          "user",
		Content:       req.Content,
		TaskID:        pgtype.UUID{}, // member group message owns no agent task
		MessageKind:   pgtype.Text{String: protocol.ChatMessageKindMessage, Valid: true},
		AuthorType:    pgtype.Text{String: "member", Valid: true},
		AuthorID:      parseUUID(userID),
		Mentions:      mentionsJSON,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to send message")
		return
	}
	if err := writeChatResourceRefs(r.Context(), qtx, msg.ID, req.ResourceRefs); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to link chat resources")
		return
	}

	boundIDs := make([]string, 0, len(attachmentIDs))
	if len(attachmentIDs) > 0 {
		bound, err := qtx.LinkAttachmentsToChatMessage(r.Context(), db.LinkAttachmentsToChatMessageParams{
			ChatMessageID: msg.ID,
			ChatSessionID: session.ID,
			WorkspaceID:   session.WorkspaceID,
			UploaderType:  "member",
			UploaderID:    parseUUID(userID),
			AttachmentIds: attachmentIDs,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to attach files")
			return
		}
		for _, id := range bound {
			boundIDs = append(boundIDs, uuidToString(id))
		}
	}

	if err := qtx.TouchChatSession(r.Context(), session.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update conversation")
		return
	}
	if err := clearOtherParticipantsArchivedTx(r.Context(), tx, session.ID, userID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update conversation")
		return
	}

	type navDetails struct {
		ChatSessionID string `json:"chat_session_id"`
		MessageID     string `json:"message_id"`
	}
	senderName := h.userDisplayName(r.Context(), userID)
	summary := summarizeMessage(req.Content)
	inboxItems := make([]db.InboxItem, 0, len(mentioned))
	for _, uid := range mentioned {
		details, _ := json.Marshal(navDetails{ChatSessionID: uuidToString(session.ID), MessageID: uuidToString(msg.ID)})
		item, err := qtx.CreateInboxItem(r.Context(), db.CreateInboxItemParams{
			ID:            dbid.NewV7(),
			WorkspaceID:   session.WorkspaceID,
			RecipientType: "member",
			RecipientID:   parseUUID(uid),
			Type:          "chat_mention",
			Severity:      "info",
			IssueID:       pgtype.UUID{},
			Title:         senderName,
			Body:          pgtype.Text{String: summary, Valid: summary != ""},
			ActorType:     pgtype.Text{String: "member", Valid: true},
			ActorID:       parseUUID(userID),
			Details:       details,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to notify mention")
			return
		}
		inboxItems = append(inboxItems, item)
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to send message")
		return
	}

	resolvedSessionID := uuidToString(session.ID)
	resources := h.groupChatMessageResources(r, session.WorkspaceID, []pgtype.UUID{msg.ID})[uuidToString(msg.ID)]
	h.publishConversationEvent(r, session, protocol.EventChatMessage, "member", userID, protocol.ChatMessagePayload{
		ChatSessionID: resolvedSessionID,
		MessageID:     uuidToString(msg.ID),
		Role:          "user",
		Content:       req.Content,
		CreatedAt:     timestampToString(msg.CreatedAt),
		Kind:          "group",
		AuthorType:    "member",
		AuthorID:      userID,
		Mentions:      validMentions,
		HasResources:  len(req.ResourceRefs) > 0,
	})
	for _, item := range inboxItems {
		h.Bus.Publish(events.Event{
			Type:        protocol.EventInboxNew,
			WorkspaceID: uuidToString(item.WorkspaceID),
			ActorType:   "member",
			ActorID:     userID,
			ChatKind:    session.Kind,
			Payload:     map[string]any{"item": dmInboxItemFields(item)},
		})
	}

	writeJSON(w, http.StatusCreated, SendChatMessageResponse{
		MessageID:     uuidToString(msg.ID),
		SupportsQueue: false,
		Queued:        false,
		CreatedAt:     timestampToString(msg.CreatedAt),
		AttachmentIDs: boundIDs,
		Kind:          "group",
		Dispatches:    []any{},
		Resources:     resources,
	})
}

// mentionUUIDs 把已校验的成员 ID 字符串解析为 UUID，供扇出侧 inbox 写入。
func mentionUUIDs(ids []string) []pgtype.UUID {
	out := make([]pgtype.UUID, 0, len(ids))
	for _, id := range ids {
		out = append(out, parseUUID(id))
	}
	return out
}

// summarizeMessage truncates a message to an inbox-body-safe length.
func summarizeMessage(content string) string {
	r := []rune(strings.TrimSpace(content))
	if len(r) <= 200 {
		return string(r)
	}
	return string(r[:200])
}

// dmInboxItemFields mirrors the inbox:new WS payload shape the listener
// (cmd/server/listeners.go) expects: a nested "item" map whose recipient_id is a
// plain string used to route the event to the mentioned member only.
func dmInboxItemFields(item db.InboxItem) map[string]any {
	return map[string]any{
		"id":             uuidToString(item.ID),
		"workspace_id":   uuidToString(item.WorkspaceID),
		"recipient_type": item.RecipientType,
		"recipient_id":   uuidToString(item.RecipientID),
		"type":           item.Type,
		"severity":       item.Severity,
		"issue_id":       uuidToPtr(item.IssueID),
		"title":          item.Title,
		"body":           textToPtr(item.Body),
		"read":           item.Read,
		"archived":       item.Archived,
		"created_at":     timestampToString(item.CreatedAt),
		"actor_type":     textToPtr(item.ActorType),
		"actor_id":       uuidToPtr(item.ActorID),
		"details":        json.RawMessage(item.Details),
	}
}
