package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Group 成员管理（plan 20261025 §02 §2.2/§3.2）。所有写操作先 requireGroupAdmin 载入
// 并校验调用者为群 admin，再在事务内以 `SELECT ... FOR UPDATE` 锁住 chat_session 行，
// 复算「至少一名人类 admin」不变式后修改 chat_participant（新表，一律原生 SQL，
// 与 chat_conversation_store.go 的 sqlc 门禁边界一致），提交后向受影响的人类定向发布
// chat:participants_changed。移除成员事件同时发给被移除者（removed=true，不含正文），
// 用于其本地缓存清理。
//
// 移除 Agent 时，在同一会话锁内收集其 queued/running 任务，提交参与者删除后再走
// TaskService.CancelTaskWithReason，让运行态、归因和 realtime 与普通取消一致。
// daemon claim 对已移除 Agent 的复查仍是第二道防线。

// errNotGroupSession 用于锁内复查 kind 时发现并非 group（并发中被改）。
var errNotGroupSession = errors.New("not a group session")

// participantsChangedPayload 是定向发布的成员变更事件体；removed/changedUserID 让前端
// 区分「自己被移除需关窗」与「仅失效 participants 缓存」。
type participantsChangedPayload struct {
	WorkspaceID   string `json:"workspace_id"`
	ChatSessionID string `json:"chat_session_id"`
	Removed       bool   `json:"removed"`
	ChangedUserID string `json:"changed_user_id,omitempty"`
}

// lockGroupSessionTx 锁住会话行并复查 kind='group'；status 返回当前会话状态。
func lockGroupSessionTx(ctx context.Context, tx pgx.Tx, sessionID pgtype.UUID) (string, error) {
	var kind, status string
	if err := tx.QueryRow(ctx,
		`SELECT kind, status FROM chat_session WHERE id = $1 FOR UPDATE`, sessionID,
	).Scan(&kind, &status); err != nil {
		return "", err
	}
	if kind != "group" {
		return "", errNotGroupSession
	}
	return status, nil
}

// countHumanAdminsTx 统计群内人类 admin 数量，用于 admin 不变式复算。
func countHumanAdminsTx(ctx context.Context, tx pgx.Tx, sessionID pgtype.UUID) (int, error) {
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = 'member' AND admin`,
		sessionID).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

func (h *Handler) writeManageError(w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, errNotGroupSession):
		writeError(w, http.StatusBadRequest, "not a group session")
	default:
		writeError(w, http.StatusInternalServerError, fallback)
	}
}

// AddGroupParticipantsRequest 与建群 body 同形，幂等去重；admin 增量添加成员/Agent。
type AddGroupParticipantsRequest struct {
	MemberIDs []string `json:"member_ids"`
	AgentIDs  []string `json:"agent_ids"`
}

// AddGroupParticipants POST /{sessionId}/participants — 群 admin 增量添加成员与 Agent。
// 已存在参与者按 ON CONFLICT DO NOTHING 跳过，新成员 joined_at/last_read_at=now()（历史
// 不计未读）。任一目标成员不在本工作区 → 404；Agent 不可访问 → 403；超上限 → 400。
func (h *Handler) AddGroupParticipants(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	access, ok := h.requireGroupAdmin(w, r, userID, chi.URLParam(r, "sessionId"))
	if !ok {
		return
	}
	session := access.Session

	var req AddGroupParticipantsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	memberIDs := dedupeIDs(req.MemberIDs)
	agentIDs := dedupeIDs(req.AgentIDs)
	if len(agentIDs) > groupMaxAgents {
		writeError(w, http.StatusBadRequest, "too many agents")
		return
	}
	validAgents, code, msg := h.validateGroupAgents(r.Context(), workspaceID, agentIDs, userID)
	if code != 0 {
		writeError(w, code, msg)
		return
	}
	validMembers, code, msg := h.validateGroupMembers(r.Context(), workspaceID, memberIDs, userID)
	if code != 0 {
		writeError(w, code, msg)
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := lockGroupSessionTx(r.Context(), tx, session.ID); err != nil {
		h.writeManageError(w, err, "failed to lock conversation")
		return
	}

	// 上限在锁内用当前实际人数复核，避免并发添加突破 50 人类 / 10 Agent。
	var curMembers, curAgents int
	if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = 'member'`, session.ID).Scan(&curMembers); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load participants")
		return
	}
	if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = 'agent'`, session.ID).Scan(&curAgents); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load participants")
		return
	}
	if curMembers+len(validMembers) > groupMaxMembers {
		writeError(w, http.StatusBadRequest, "group exceeds member limit")
		return
	}
	if curAgents+len(validAgents) > groupMaxAgents {
		writeError(w, http.StatusBadRequest, "group exceeds agent limit")
		return
	}

	// 新成员必须能 view 群内现有 Agent（此处以添加的 Agent 与既有成员做同权限校验已由
	// validateGroupAgents 对 admin 完成；跨成员泄露防护随扇出/权限切片强化）。
	for _, m := range validMembers {
		if err := insertChatParticipantTx(r.Context(), tx, session.ID, "member", m, false); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to add participant")
			return
		}
	}
	for _, a := range validAgents {
		if err := insertChatParticipantTx(r.Context(), tx, session.ID, "agent", a, false); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to add participant")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit participant add")
		return
	}

	audience, _ := h.humanParticipantIDs(r.Context(), nil, session.ID)
	h.publishConversationEventToAudience(r, session, protocol.EventChatParticipantsChanged, "member", userID, audience, participantsChangedPayload{
		WorkspaceID:   uuidToString(session.WorkspaceID),
		ChatSessionID: uuidToString(session.ID),
	})
	writeJSON(w, http.StatusOK, map[string]any{"participants": h.participantResponses(r, session.ID)})
}

// RemoveGroupParticipant DELETE /{sessionId}/participants/{participantType}/{participantId}
// — 群 admin 移除成员或 Agent。禁止移除最后一名人类 admin。DM 不支持（应 400）。
func (h *Handler) RemoveGroupParticipant(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	access, ok := h.requireGroupAdmin(w, r, userID, chi.URLParam(r, "sessionId"))
	if !ok {
		return
	}
	session := access.Session
	ptype := chi.URLParam(r, "participantType")
	pid := chi.URLParam(r, "participantId")
	if ptype != "member" && ptype != "agent" {
		writeError(w, http.StatusBadRequest, "participant type must be member or agent")
		return
	}
	targetUUID, ok := parseUUIDOrBadRequest(w, pid, "participant id")
	if !ok {
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := lockGroupSessionTx(r.Context(), tx, session.ID); err != nil {
		h.writeManageError(w, err, "failed to lock conversation")
		return
	}

	// 移除人类成员时保护「至少留一名 admin」：目标是唯一 admin → 409。
	if ptype == "member" {
		targetAdmin, err := isParticipantAdminTx(r.Context(), tx, session.ID, targetUUID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load participant")
			return
		}
		if targetAdmin {
			admins, err := countHumanAdminsTx(r.Context(), tx, session.ID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to load participants")
				return
			}
			if admins <= 1 {
				writeError(w, http.StatusConflict, "cannot remove the last group admin; transfer admin first")
				return
			}
		}
	}

	tag, err := tx.Exec(r.Context(), `DELETE FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = $2 AND participant_id = $3`,
		session.ID, ptype, targetUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove participant")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "participant not found")
		return
	}
	var cancelTaskIDs []pgtype.UUID
	if ptype == "agent" {
		taskRows, qerr := tx.Query(r.Context(), `
			SELECT id FROM agent_task_queue
			WHERE chat_session_id = $1 AND agent_id = $2
			  AND status IN ('queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred')
			  AND regenerate_quick_actions_for IS NULL`, session.ID, targetUUID)
		if qerr != nil {
			writeError(w, http.StatusInternalServerError, "failed to load agent tasks")
			return
		}
		for taskRows.Next() {
			var id pgtype.UUID
			if err := taskRows.Scan(&id); err != nil {
				taskRows.Close()
				writeError(w, http.StatusInternalServerError, "failed to load agent tasks")
				return
			}
			cancelTaskIDs = append(cancelTaskIDs, id)
		}
		if err := taskRows.Err(); err != nil {
			taskRows.Close()
			writeError(w, http.StatusInternalServerError, "failed to load agent tasks")
			return
		}
		taskRows.Close()
	}
	remaining, _ := h.humanParticipantIDs(r.Context(), tx, session.ID)
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit participant removal")
		return
	}
	if ptype == "agent" && h.TaskService != nil {
		for _, taskID := range cancelTaskIDs {
			if _, err := h.TaskService.CancelTaskWithReason(r.Context(), taskID, "removed from group", "agent_removed_from_group"); err != nil {
				slog.Warn("group agent removal: cancel task", "task_id", uuidToString(taskID), "err", err)
			}
		}
	}

	// 变更事件发给「移除后仍在群」的人类；被移除者单独收一次 removed=true 以清缓存，
	// 且不包含任何历史正文。
	changed := uuidToString(targetUUID)
	h.publishConversationEventToAudience(r, session, protocol.EventChatParticipantsChanged, "member", userID, remaining, participantsChangedPayload{
		WorkspaceID:   uuidToString(session.WorkspaceID),
		ChatSessionID: uuidToString(session.ID),
		ChangedUserID: changed,
	})
	if ptype == "member" {
		h.publishConversationEventToAudience(r, session, protocol.EventChatParticipantsChanged, "member", userID, []string{changed}, participantsChangedPayload{
			WorkspaceID:   uuidToString(session.WorkspaceID),
			ChatSessionID: uuidToString(session.ID),
			Removed:       true,
			ChangedUserID: changed,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"participants": h.participantResponses(r, session.ID)})
}

// LeaveGroup POST /{sessionId}/participants/leave — 调用者自己退群；最后一名 admin 不得
// 直接离开（必须先转让 admin）。无需 admin 权限，仅需是群成员。
func (h *Handler) LeaveGroup(w http.ResponseWriter, r *http.Request) {
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
	session := access.Session
	if session.Kind != "group" {
		writeError(w, http.StatusBadRequest, "not a group session")
		return
	}
	if access.Participant == nil {
		writeError(w, http.StatusNotFound, "not a group participant")
		return
	}

	selfUUID, ok := parseUUIDOrBadRequest(w, userID, "user id")
	if !ok {
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := lockGroupSessionTx(r.Context(), tx, session.ID); err != nil {
		h.writeManageError(w, err, "failed to lock conversation")
		return
	}
	if access.Participant.Admin {
		admins, err := countHumanAdminsTx(r.Context(), tx, session.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load participants")
			return
		}
		if admins <= 1 {
			writeError(w, http.StatusConflict, "last admin cannot leave; transfer admin first")
			return
		}
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = 'member' AND participant_id = $2`,
		session.ID, selfUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to leave group")
		return
	}
	remaining, _ := h.humanParticipantIDs(r.Context(), tx, session.ID)
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit leave")
		return
	}

	h.publishConversationEventToAudience(r, session, protocol.EventChatParticipantsChanged, "member", userID, remaining, participantsChangedPayload{
		WorkspaceID:   uuidToString(session.WorkspaceID),
		ChatSessionID: uuidToString(session.ID),
		ChangedUserID: userID,
	})
	h.publishConversationEventToAudience(r, session, protocol.EventChatParticipantsChanged, "member", userID, []string{userID}, participantsChangedPayload{
		WorkspaceID:   uuidToString(session.WorkspaceID),
		ChatSessionID: uuidToString(session.ID),
		Removed:       true,
		ChangedUserID: userID,
	})
	writeJSON(w, http.StatusOK, map[string]any{"left": true})
}

// SetGroupParticipantAdminRequest 目标 admin 状态。
type SetGroupParticipantAdminRequest struct {
	Admin bool `json:"admin"`
}

// SetGroupParticipantAdmin PATCH /{sessionId}/participants/member/{participantId}
// — 群 admin 提升或降级某成员的 admin 位。降级唯一 admin → 409。
func (h *Handler) SetGroupParticipantAdmin(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	access, ok := h.requireGroupAdmin(w, r, userID, chi.URLParam(r, "sessionId"))
	if !ok {
		return
	}
	session := access.Session
	if chi.URLParam(r, "participantType") != "member" {
		writeError(w, http.StatusBadRequest, "only member admin can be changed")
		return
	}
	targetUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "participantId"), "participant id")
	if !ok {
		return
	}
	var req SetGroupParticipantAdminRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := lockGroupSessionTx(r.Context(), tx, session.ID); err != nil {
		h.writeManageError(w, err, "failed to lock conversation")
		return
	}
	// 降级会导致零 admin 时拒绝：目标是当前唯一 admin 且要置 false。
	if !req.Admin {
		targetAdmin, err := isParticipantAdminTx(r.Context(), tx, session.ID, targetUUID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load participant")
			return
		}
		if targetAdmin {
			admins, err := countHumanAdminsTx(r.Context(), tx, session.ID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to load participants")
				return
			}
			if admins <= 1 {
				writeError(w, http.StatusConflict, "group must retain at least one admin")
				return
			}
		}
	}
	tag, err := tx.Exec(r.Context(), `UPDATE chat_participant SET admin = $3
		WHERE chat_session_id = $1 AND participant_type = 'member' AND participant_id = $2`,
		session.ID, targetUUID, req.Admin)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update participant")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "participant not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit admin change")
		return
	}

	audience, _ := h.humanParticipantIDs(r.Context(), nil, session.ID)
	h.publishConversationEventToAudience(r, session, protocol.EventChatParticipantsChanged, "member", userID, audience, participantsChangedPayload{
		WorkspaceID:   uuidToString(session.WorkspaceID),
		ChatSessionID: uuidToString(session.ID),
		ChangedUserID: uuidToString(targetUUID),
	})
	writeJSON(w, http.StatusOK, map[string]any{"participants": h.participantResponses(r, session.ID)})
}

// isParticipantAdminTx 在事务内读取某参与者的 admin 位；不存在返回 (false, nil)。
func isParticipantAdminTx(ctx context.Context, tx pgx.Tx, sessionID, pID pgtype.UUID) (bool, error) {
	var admin bool
	err := tx.QueryRow(ctx, `SELECT admin FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = 'member' AND participant_id = $2`,
		sessionID, pID).Scan(&admin)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return admin, nil
}
