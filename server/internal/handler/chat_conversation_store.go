package handler

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// 参与者存储（migration 478，plan 20261025-聊天模块-人与人群聊 §2/§4）。
//
// chat_participant 晚于当前 sqlc 快照新增，且既有模块惯例（project_asset 等）对新表走
// h.DB / tx 原生 SQL，避免零散 sqlc 文件与并行会话在途重生。既有 chat_session /
// chat_message 的列扩展已由 478 + make sqlc 生成，读写仍走 h.Queries。

// ChatParticipant 是参与者的响应内模型（成员或 Agent）。admin/阅读游标仅对 member 有意义。
type ChatParticipant struct {
	ChatSessionID   string  `json:"chat_session_id"`
	ParticipantType string  `json:"participant_type"` // member | agent
	ParticipantID   string  `json:"participant_id"`
	Admin           bool    `json:"admin"`
	JoinedAt        string  `json:"joined_at"`
	LastReadAt      string  `json:"last_read_at"`
	LastReadMsgID   *string `json:"last_read_message_id"`
	Pinned          bool    `json:"pinned"`
	archivedAt      pgtype.Timestamptz
}

type participantRow struct {
	chatSessionID   pgtype.UUID
	participantType string
	participantID   pgtype.UUID
	admin           bool
	joinedAt        pgtype.Timestamptz
	lastReadAt      pgtype.Timestamptz
	lastReadMsgID   pgtype.UUID
	pinnedAt        pgtype.Timestamptz
	archivedAt      pgtype.Timestamptz
}

func (r participantRow) toDomain() ChatParticipant {
	return ChatParticipant{
		ChatSessionID:   uuidToString(r.chatSessionID),
		ParticipantType: r.participantType,
		ParticipantID:   uuidToString(r.participantID),
		Admin:           r.admin,
		JoinedAt:        timestampToString(r.joinedAt),
		LastReadAt:      timestampToString(r.lastReadAt),
		LastReadMsgID:   uuidToPtr(r.lastReadMsgID),
		Pinned:          r.pinnedAt.Valid,
		archivedAt:      r.archivedAt,
	}
}

const participantSelectCols = `chat_session_id, participant_type, participant_id, admin,
	joined_at, last_read_at, last_read_message_id, pinned_at, archived_at`

func scanParticipant(row pgx.Row) (participantRow, error) {
	var r participantRow
	err := row.Scan(
		&r.chatSessionID, &r.participantType, &r.participantID, &r.admin,
		&r.joinedAt, &r.lastReadAt, &r.lastReadMsgID, &r.pinnedAt, &r.archivedAt,
	)
	return r, err
}

// insertChatParticipantTx 幂等插入一个参与者；已存在则不覆盖其阅读/置顶游标。
// joined_at/last_read_at 在首次插入时取 now()，保证新成员把历史计为已读（不产生未读洪流）。
func insertChatParticipantTx(ctx context.Context, tx pgx.Tx, sessionID pgtype.UUID, ptype string, pID pgtype.UUID, admin bool) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO chat_participant (chat_session_id, participant_type, participant_id, admin)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (chat_session_id, participant_type, participant_id) DO NOTHING`,
		sessionID, ptype, pID, admin)
	return err
}

// getChatParticipant 查询某参与者行；不存在返回 found=false。
func (h *Handler) getChatParticipant(ctx context.Context, sessionID pgtype.UUID, ptype string, pID pgtype.UUID) (ChatParticipant, bool) {
	row := h.DB.QueryRow(ctx, `SELECT `+participantSelectCols+` FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = $2 AND participant_id = $3`,
		sessionID, ptype, pID)
	r, err := scanParticipant(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ChatParticipant{}, false
		}
		return ChatParticipant{}, false
	}
	return r.toDomain(), true
}

// isChatMember 判定 userID 是否为该会话的人类成员（DM/Group 访问门控）。
func (h *Handler) isChatMember(ctx context.Context, sessionID pgtype.UUID, userID string) bool {
	var one int
	err := h.DB.QueryRow(ctx, `SELECT 1 FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = 'member' AND participant_id = $2`,
		sessionID, parseUUID(userID)).Scan(&one)
	return err == nil
}

// listChatParticipants 返回会话的全部参与者（成员在前，Agent 在后，按加入时间）。
func (h *Handler) listChatParticipants(ctx context.Context, sessionID pgtype.UUID) ([]ChatParticipant, error) {
	rows, err := h.DB.Query(ctx, `SELECT `+participantSelectCols+` FROM chat_participant
		WHERE chat_session_id = $1
		ORDER BY (participant_type = 'member') DESC, joined_at ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChatParticipant
	for rows.Next() {
		r, err := scanParticipant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r.toDomain())
	}
	return out, rows.Err()
}

// humanParticipantIDs 返回当前人类成员的用户 ID 列表，作为定向 realtime 的接收集合。
func (h *Handler) humanParticipantIDs(ctx context.Context, tx pgx.Tx, sessionID pgtype.UUID) ([]string, error) {
	queryer := h.DB
	if tx != nil {
		queryer = tx
	}
	rows, err := queryer.Query(ctx, `SELECT participant_id::text FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = 'member'`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// agentParticipantIDs 返回会话当前的 Agent 参与者 ID 列表，供群发时的 @Agent
// mention 校验与扇出（plan 02 §2.3/§4.1）。
func (h *Handler) agentParticipantIDs(ctx context.Context, sessionID pgtype.UUID) ([]pgtype.UUID, error) {
	rows, err := h.DB.Query(ctx, `SELECT participant_id FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = 'agent'`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []pgtype.UUID
	for rows.Next() {
		var id pgtype.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// zeroUUIDCursor 是复合游标比较时对 last_read_message_id 为 NULL 的兜底下界。
const zeroUUIDCursor = `'00000000-0000-0000-0000-000000000000'::uuid`

// markConversationReadTx 用 (created_at,id) 复合游标前移某成员已读位；旧游标更大时不倒退。
// 只影响调用者自己的游标，绝不触碰其他成员（DM/Group 每成员独立未读）。
func markConversationReadTx(ctx context.Context, tx pgx.Tx, sessionID pgtype.UUID, userID string, readAt pgtype.Timestamptz, readMsgID pgtype.UUID) error {
	// Placeholders stay contiguous. A skipped $3 makes Postgres reject the
	// statement ("could not determine data type of parameter $3"), and the
	// client then retries mark-read forever.
	_, err := tx.Exec(ctx, `
		UPDATE chat_participant
		SET last_read_at = $3, last_read_message_id = $4
		WHERE chat_session_id = $1 AND participant_type = 'member' AND participant_id = $2::uuid
		  AND (last_read_at, COALESCE(last_read_message_id, `+zeroUUIDCursor+`))
		      <= ($3, COALESCE($4, `+zeroUUIDCursor+`))`,
		sessionID, userID, readAt, readMsgID)
	return err
}

// setParticipantPinned 只改调用者自己的置顶，不动 chat_session.pinned_at。
func setParticipantPinned(ctx context.Context, tx pgx.Tx, sessionID pgtype.UUID, userID string, pinned bool) error {
	_, err := tx.Exec(ctx, `UPDATE chat_participant
		SET pinned_at = CASE WHEN $3 THEN now() ELSE NULL END
		WHERE chat_session_id = $1 AND participant_type = 'member' AND participant_id = $2::uuid`,
		sessionID, userID, pinned)
	return err
}

// setParticipantArchived 只改调用者自己的归档状态，不动 chat_session.status。
func setParticipantArchived(ctx context.Context, tx pgx.Tx, sessionID pgtype.UUID, userID string, archived bool) error {
	_, err := tx.Exec(ctx, `UPDATE chat_participant
		SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END
		WHERE chat_session_id = $1 AND participant_type = 'member' AND participant_id = $2::uuid`,
		sessionID, userID, archived)
	return err
}

// clearOtherParticipantsArchivedTx 在新消息到来时清除除发送者外所有人类成员的归档，
// 让归档只是 viewer 个人状态、新消息可被重新发现。
func clearOtherParticipantsArchivedTx(ctx context.Context, tx pgx.Tx, sessionID pgtype.UUID, senderID string) error {
	_, err := tx.Exec(ctx, `UPDATE chat_participant SET archived_at = NULL
		WHERE chat_session_id = $1 AND participant_type = 'member' AND participant_id::text <> $2`,
		sessionID, senderID)
	return err
}

const listConversationSessionsSQL = `
SELECT cs.id, cs.workspace_id, cs.creator_id, cs.kind, cs.title, cs.project_id,
       cs.created_at, cs.updated_at, cp.pinned_at, cp.archived_at,
       (SELECT count(*) FROM chat_message m
        WHERE m.chat_session_id = cs.id
          AND (m.created_at, m.id) >
              (cp.last_read_at, COALESCE(cp.last_read_message_id, '00000000-0000-0000-0000-000000000000'::uuid))
          AND NOT (m.author_type = 'member' AND m.author_id = $2)
          AND m.message_kind <> 'channel_command')::int AS unread_count,
       COALESCE(NULLIF(lm.content, ''), lm.resource_summary, '') AS last_message_content,
       COALESCE(lm.role, '') AS last_message_role,
       lm.created_at AS last_message_at,
       lm.failure_reason AS last_message_failure_reason,
       COALESCE(lm.message_kind, '') AS last_message_kind,
       COALESCE(lm.author_type, '') AS last_message_author_type,
       lm.author_id AS last_message_author_id
FROM chat_session cs
JOIN chat_participant cp ON cp.chat_session_id = cs.id
 AND cp.participant_type = 'member' AND cp.participant_id = $2
LEFT JOIN LATERAL (
    SELECT content, role, created_at, failure_reason, message_kind, author_type, author_id,
           COALESCE((
               SELECT CASE
                   WHEN r.resource_type = 'document' THEN '[Document]'
                   WHEN r.resource_kind = 'requirement' THEN '[Requirement]'
                   ELSE '[Task]'
               END
               FROM chat_message_resource_ref r
               WHERE r.message_id = m.id
               ORDER BY r.position LIMIT 1
           ), '') AS resource_summary
    FROM chat_message m WHERE m.chat_session_id = cs.id
      AND m.message_kind <> 'channel_command'
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1
) lm ON true
WHERE cs.workspace_id = $1 AND cs.kind IN ('dm', 'group')
  AND ($3::boolean OR cp.archived_at IS NULL)
`

type conversationListRow struct {
	id             pgtype.UUID
	workspaceID    pgtype.UUID
	creatorID      pgtype.UUID
	kind           string
	title          string
	projectID      pgtype.UUID
	createdAt      pgtype.Timestamptz
	updatedAt      pgtype.Timestamptz
	pinnedAt       pgtype.Timestamptz
	archivedAt     pgtype.Timestamptz
	unreadCount    int32
	lastContent    string
	lastRole       string
	lastAt         pgtype.Timestamptz
	lastFailure    pgtype.Text
	lastKind       string
	lastAuthorType string
	lastAuthorID   pgtype.UUID
}

// listConversationSessionsForMember returns the caller's DM and group rows.
// Archive and pin are that member's participant state, not chat_session.status.
func (h *Handler) listConversationSessionsForMember(ctx context.Context, workspaceID, userID string, includeArchived bool) ([]ChatSessionResponse, error) {
	wsUUID, err := parseUUIDValue(workspaceID)
	if err != nil {
		return nil, err
	}
	userUUID, err := parseUUIDValue(userID)
	if err != nil {
		return nil, err
	}
	rows, err := h.DB.Query(ctx, listConversationSessionsSQL, wsUUID, userUUID, includeArchived)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scanned := make([]conversationListRow, 0)
	ids := make([]pgtype.UUID, 0)
	for rows.Next() {
		var row conversationListRow
		if err := rows.Scan(
			&row.id, &row.workspaceID, &row.creatorID, &row.kind, &row.title, &row.projectID,
			&row.createdAt, &row.updatedAt, &row.pinnedAt, &row.archivedAt, &row.unreadCount,
			&row.lastContent, &row.lastRole, &row.lastAt, &row.lastFailure, &row.lastKind,
			&row.lastAuthorType, &row.lastAuthorID,
		); err != nil {
			return nil, err
		}
		scanned = append(scanned, row)
		ids = append(ids, row.id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	bySession, err := h.conversationParticipantsBySession(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]ChatSessionResponse, 0, len(scanned))
	for _, row := range scanned {
		participants := bySession[uuidToString(row.id)]
		title := row.title
		if row.kind == "dm" {
			for _, p := range participants {
				if p.ParticipantType == "member" && p.ParticipantID != userID && p.DisplayName != "" {
					title = p.DisplayName
					break
				}
			}
		}
		status := "active"
		if row.archivedAt.Valid {
			status = "archived"
		}
		last := buildChatLastMessage(row.lastAt, row.lastContent, row.lastRole, row.lastFailure, row.lastKind)
		if last != nil {
			last.AuthorType = row.lastAuthorType
			last.AuthorID = uuidToPtr(row.lastAuthorID)
		}
		out = append(out, ChatSessionResponse{
			ID:           uuidToString(row.id),
			WorkspaceID:  uuidToString(row.workspaceID),
			AgentID:      "",
			CreatorID:    uuidToString(row.creatorID),
			ProjectID:    uuidToPtr(row.projectID),
			Title:        title,
			Status:       status,
			HasUnread:    row.unreadCount > 0,
			UnreadCount:  int(row.unreadCount),
			LastMessage:  last,
			Pinned:       row.pinnedAt.Valid,
			Kind:         row.kind,
			Participants: participants,
			CreatedAt:    timestampToString(row.createdAt),
			UpdatedAt:    timestampToString(row.updatedAt),
		})
	}
	return out, nil
}

func (h *Handler) conversationParticipantsBySession(ctx context.Context, sessionIDs []pgtype.UUID) (map[string][]ChatParticipantResponse, error) {
	out := map[string][]ChatParticipantResponse{}
	if len(sessionIDs) == 0 {
		return out, nil
	}
	rows, err := h.DB.Query(ctx, `
		SELECT `+participantSelectCols+`
		FROM chat_participant
		WHERE chat_session_id = ANY($1)`, sessionIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var participants []ChatParticipant
	for rows.Next() {
		row, err := scanParticipant(rows)
		if err != nil {
			return nil, err
		}
		participants = append(participants, row.toDomain())
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	userIDs := make([]pgtype.UUID, 0)
	agentIDs := make([]pgtype.UUID, 0)
	seenUser := map[string]bool{}
	seenAgent := map[string]bool{}
	for _, p := range participants {
		id := parseUUID(p.ParticipantID)
		if p.ParticipantType == "agent" {
			if !seenAgent[p.ParticipantID] {
				seenAgent[p.ParticipantID] = true
				agentIDs = append(agentIDs, id)
			}
			continue
		}
		if !seenUser[p.ParticipantID] {
			seenUser[p.ParticipantID] = true
			userIDs = append(userIDs, id)
		}
	}
	names := map[string]string{}
	avatars := map[string]string{}
	if len(userIDs) > 0 {
		users, err := h.Queries.GetUsersByIDs(ctx, userIDs)
		if err != nil {
			return nil, err
		}
		for _, u := range users {
			id := uuidToString(u.ID)
			names[id] = u.Name
			if u.AvatarUrl.Valid {
				avatars[id] = u.AvatarUrl.String
			}
		}
	}
	if len(agentIDs) > 0 {
		arows, err := h.DB.Query(ctx, `SELECT id, name, avatar_url FROM agent WHERE id = ANY($1)`, agentIDs)
		if err != nil {
			return nil, err
		}
		defer arows.Close()
		for arows.Next() {
			var id pgtype.UUID
			var name string
			var avatar pgtype.Text
			if err := arows.Scan(&id, &name, &avatar); err != nil {
				return nil, err
			}
			sid := uuidToString(id)
			names[sid] = name
			if avatar.Valid {
				avatars[sid] = avatar.String
			}
		}
		if err := arows.Err(); err != nil {
			return nil, err
		}
	}
	for _, p := range participants {
		resp := ChatParticipantResponse{
			ChatSessionID:   p.ChatSessionID,
			ParticipantType: p.ParticipantType,
			ParticipantID:   p.ParticipantID,
			DisplayName:     names[p.ParticipantID],
			Admin:           p.Admin,
			JoinedAt:        p.JoinedAt,
			Pinned:          p.Pinned,
		}
		if avatar := avatars[p.ParticipantID]; avatar != "" {
			resp.AvatarURL = &avatar
		}
		out[p.ChatSessionID] = append(out[p.ChatSessionID], resp)
	}
	return out, nil
}

func parseUUIDValue(raw string) (pgtype.UUID, error) {
	var id pgtype.UUID
	if err := id.Scan(raw); err != nil {
		return pgtype.UUID{}, err
	}
	return id, nil
}

func sortChatSessionResponses(sessions []ChatSessionResponse) {
	sort.SliceStable(sessions, func(i, j int) bool {
		if sessions[i].Pinned != sessions[j].Pinned {
			return sessions[i].Pinned
		}
		return sessionActivity(sessions[i]).After(sessionActivity(sessions[j]))
	})
}

func sessionActivity(session ChatSessionResponse) time.Time {
	if session.LastMessage != nil {
		if t, ok := parseSessionTime(session.LastMessage.CreatedAt); ok {
			return t
		}
	}
	if t, ok := parseSessionTime(session.UpdatedAt); ok {
		return t
	}
	return time.Time{}
}

func parseSessionTime(raw string) (time.Time, bool) {
	if raw == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t, true
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t, true
	}
	return time.Time{}, false
}
