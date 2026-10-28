package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Group 多用户 + Agent 群聊（plan 20261025-聊天模块-人与人群聊 §02）。
//
// 复用统一 chat_session/chat_message，kind='group'、agent_id=NULL、dm_pair_key=NULL。
// 参与者（人类成员 + 0..10 个 Agent）是唯一权限与受众源。本切片实现：建群、群成员/
// Agent 管理（增删/退群/admin）、人类消息落库与 @成员 inbox 通知。多 Agent @Agent 扇出
// 任务（§4/§5 service 事务 + chat_group_task_input 快照 + daemon claim 三分支）作为紧接
// 其后的独立切片实现；在其落地前，一条 @Agent 的消息按 §4.1「整次原子接受」原则以 503
// 明确拒发，而不是静默丢弃 Agent 执行，避免「消息已发但 Agent 未跑」的歧义。

// 群规模上限（plan 02 §2.1）：人类成员含创建者 2..50，Agent 0..10，mentions 去重后 ≤20。
const (
	groupMaxMembers = 50
	groupMaxAgents  = 10
	groupMaxTitle   = 200
)

type CreateGroupChatSessionRequest struct {
	Title     string   `json:"title"`
	MemberIDs []string `json:"member_ids"`
	AgentIDs  []string `json:"agent_ids"`
	ProjectID *string  `json:"project_id"`
}

// dedupeIDs 去重并剔除空串，保持首次出现顺序。
func dedupeIDs(ids []string) []string {
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// validateGroupAgents 在事务外预检每个 Agent：属于当前工作区、未归档、创建者可访问，
// 并把合法 Agent 解析为 UUID。任一非法即返回 (nil, statusCode, message)。
func (h *Handler) validateGroupAgents(ctx context.Context, workspaceID string, agentIDs []string, actorUserID string) ([]pgtype.UUID, int, string) {
	workspaceUUID, err := util.ParseUUID(workspaceID)
	if err != nil {
		return nil, http.StatusBadRequest, "invalid workspace id"
	}
	out := make([]pgtype.UUID, 0, len(agentIDs))
	for _, raw := range agentIDs {
		aid, err := util.ParseUUID(raw)
		if err != nil {
			return nil, http.StatusBadRequest, "invalid agent id"
		}
		agent, err := h.Queries.GetAgent(ctx, aid)
		if errors.Is(err, pgx.ErrNoRows) {
			// 不区分「不存在」与「跨工作区」，避免枚举泄露；统一 404。
			return nil, http.StatusNotFound, "agent not found"
		} else if err != nil {
			return nil, http.StatusInternalServerError, "failed to load agent"
		}
		if uuidToString(agent.WorkspaceID) != uuidToString(workspaceUUID) {
			return nil, http.StatusNotFound, "agent not found"
		}
		if agent.ArchivedAt.Valid {
			return nil, http.StatusForbidden, "agent is archived"
		}
		// 私有 Agent 必须对创建者可访问，防止借群聊泄露。
		if !h.canAccessPrivateAgent(ctx, agent, "member", actorUserID, workspaceID) {
			return nil, http.StatusForbidden, "agent is not accessible"
		}
		out = append(out, aid)
	}
	return out, 0, ""
}

// validateGroupMembers 预检每个成员属于当前工作区并解析为 UUID；调用者自身剔除。
func (h *Handler) validateGroupMembers(ctx context.Context, workspaceID string, memberIDs []string, creatorID string) ([]pgtype.UUID, int, string) {
	out := make([]pgtype.UUID, 0, len(memberIDs))
	seen := map[string]bool{creatorID: true}
	for _, raw := range memberIDs {
		if seen[raw] {
			continue
		}
		seen[raw] = true
		uid, err := util.ParseUUID(raw)
		if err != nil {
			return nil, http.StatusBadRequest, "invalid member id"
		}
		if _, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
			UserID:      uid,
			WorkspaceID: parseUUID(workspaceID),
		}); err != nil {
			return nil, http.StatusNotFound, "member not found"
		}
		out = append(out, uid)
	}
	return out, 0, ""
}

// CreateGroupChatSession 建群：创建者自动加入且 admin=true。
// 201 成功；400 输入非法；404 成员不存在；403 Agent 不可访问。
func (h *Handler) CreateGroupChatSession(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())

	var req CreateGroupChatSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" || len([]rune(title)) > groupMaxTitle {
		writeError(w, http.StatusBadRequest, "title must be 1-200 characters")
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
	// 人类成员含创建者至少 2、至多 50。必须在 validateGroupMembers 之后用去重/剔除
	// 自身后的 validMembers 判定：只填自己时 validMembers 为空 → 1+0<2 → 400，不能被
	// 去重前的 memberIDs 误判为达标而放行。
	if humanTotal := 1 + len(validMembers); humanTotal < 2 || humanTotal > groupMaxMembers {
		writeError(w, http.StatusBadRequest, "group must have 2-50 human members")
		return
	}

	var projectUUID pgtype.UUID
	if req.ProjectID != nil && strings.TrimSpace(*req.ProjectID) != "" {
		pu, err := util.ParseUUID(strings.TrimSpace(*req.ProjectID))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid project id")
			return
		}
		projectUUID = pu
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	workspaceUUID, ok2 := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok2 {
		return
	}
	if _, err := qtx.LockWorkspaceForChatSessionCreate(r.Context(), workspaceUUID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to lock workspace")
		return
	}

	var session db.ChatSession
	err = tx.QueryRow(r.Context(), `
		INSERT INTO chat_session (id, workspace_id, agent_id, creator_id, kind, title, project_id, explicitly_created_at)
		VALUES ($1, $2, NULL, $3, 'group', $4, NULLIF($5, '00000000-0000-0000-0000-000000000000'::uuid), now())
		RETURNING id, workspace_id, agent_id, creator_id, title, status, kind, dm_pair_key, created_at, updated_at, project_id, pinned_at`,
		dbid.NewV7(), workspaceUUID, parseUUID(userID), title, projectUUID,
	).Scan(&session.ID, &session.WorkspaceID, &session.AgentID, &session.CreatorID,
		&session.Title, &session.Status, &session.Kind, &session.DmPairKey,
		&session.CreatedAt, &session.UpdatedAt, &session.ProjectID, &session.PinnedAt)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create group session")
		return
	}

	// 创建者为 admin 成员，其余成员非 admin，Agent 非 admin；阅读游标默认 now()。
	if err := insertChatParticipantTx(r.Context(), tx, session.ID, "member", parseUUID(userID), true); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to add group participant")
		return
	}
	for _, m := range validMembers {
		if err := insertChatParticipantTx(r.Context(), tx, session.ID, "member", m, false); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to add group participant")
			return
		}
	}
	for _, a := range validAgents {
		if err := insertChatParticipantTx(r.Context(), tx, session.ID, "agent", a, false); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to add group agent")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit group create")
		return
	}

	// 建群是唯一可用的"用户还在打字"窗口：此刻每个 Agent 的首次 checkout 可
	// 提前在 daemon 侧完成，首条消息的 19s worktree add 就落在打字时间里。
	h.requestGroupPrewarms(r.Context(), workspaceID, projectUUID, session.ID, validAgents)

	resp := chatSessionToResponse(session)
	resp.Participants = h.participantResponses(r, session.ID)

	h.publishConversationEvent(r, session, protocol.EventChatSessionCreated, "member", userID, protocol.ChatSessionCreatedPayload{
		WorkspaceID:   uuidToString(session.WorkspaceID),
		ChatSessionID: uuidToString(session.ID),
		Title:         title,
	})
	writeJSON(w, http.StatusCreated, resp)
}

// requireGroupAdmin 载入 group 会话并校验调用者是 admin 参与者；否则写错误响应并返回 ok=false。
// 群成员增删/退群/admin 转让（plan 02 §2.2）随群管理切片接入，复用本入口。
func (h *Handler) requireGroupAdmin(w http.ResponseWriter, r *http.Request, userID, sessionID string) (ChatAccess, bool) {
	workspaceID := ctxWorkspaceID(r.Context())
	access, ok := h.loadChatSessionForActor(w, r, userID, workspaceID, sessionID)
	if !ok {
		return ChatAccess{}, false
	}
	if access.Session.Kind != "group" {
		writeError(w, http.StatusBadRequest, "not a group session")
		return ChatAccess{}, false
	}
	if access.Participant == nil || !access.Participant.Admin {
		writeError(w, http.StatusForbidden, "group admin privilege required")
		return ChatAccess{}, false
	}
	return access, true
}
