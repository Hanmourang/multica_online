package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/attribution"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Group 多 Agent 扇出（plan 20261025-聊天模块-人与人群聊 §02 任务 2/§4）。
//
// 一条人类消息只落一行（chat_message.task_id=NULL），被 @ 的每个 Agent 获得：
//   - 独立 agent_task_queue 行（ForceFreshSession=true，RuntimeID=该 Agent 自己的
//     runtime，initiator/归因=发送成员）；
//   - 独立、不可变的输入快照 chat_group_task_input（触发前最近 19 条可见消息 +
//     触发消息本体，按 (created_at,id) 升序编号，排除 channel_command /
//     onboarding_kickoff），多个 Agent 共享同一份内容但互不覆盖、绝不读取
//     chat_session 的续聊指针。
//
// §4.1 整次原子接受：任一 Agent 在锁内复查时已归档 / 无 runtime / 不再是参与者，
// 整个事务回滚，人类消息也不落库，客户端收到明确错误后可自行处置，绝不出现
// 「消息已发但部分 Agent 静默未执行」的歧义半态。

// ErrGroupChatNotParticipant 表示锁内复查发现发送者或某个被 @ 的 Agent 已不再是
// 群参与者（TOCTOU 回收，SEC-12）。
var ErrGroupChatNotParticipant = errors.New("chat group: principal is not a participant")

// ErrGroupChatSessionNotGroup 表示目标会话已不是 group（并发中被改写，fail-closed）。
var ErrGroupChatSessionNotGroup = errors.New("chat group: session is not a group")

// GroupAgentDispatch 是一次扇出中某个 Agent 的任务回执。
type GroupAgentDispatch struct {
	AgentID pgtype.UUID
	Task    db.AgentTaskQueue
}

// GroupMessageSend 是 SendGroupMessage 的提交结果，供 handler 组装响应与事件。
type GroupMessageSend struct {
	Message            db.ChatMessage
	BoundAttachmentIDs []pgtype.UUID
	Dispatches         []GroupAgentDispatch
	InboxItems         []db.InboxItem
}

// groupSnapshotMessage 是输入快照的一行。
type groupSnapshotMessage struct {
	ID      pgtype.UUID
	Created pgtype.Timestamptz
}

// groupSnapshotLimit 是快照容量：触发消息之前最近 19 条 + 触发消息 = 最多 20 条
// （plan 02 §4.2 步骤 4）。
const groupSnapshotLimit = 19

// SendGroupMessage 在单一事务内落组消息 + N 个 Agent 任务 + 每任务输入快照 +
// @成员 inbox。提交后才发布 task:queued / NotifyTaskEnqueued（顺序与 direct 路径
// 一致：先 commit 后通知，回滚绝不通知）。
func (s *TaskService) SendGroupMessage(
	ctx context.Context,
	session db.ChatSession,
	senderID pgtype.UUID,
	content string,
	attachmentIDs []pgtype.UUID,
	agentIDs []pgtype.UUID,
	memberMentionIDs []pgtype.UUID,
	mentionsJSON []byte,
) (*GroupMessageSend, error) {
	return s.SendGroupMessageWithResources(ctx, session, senderID, content, attachmentIDs, agentIDs, memberMentionIDs, mentionsJSON, nil)
}

func (s *TaskService) SendGroupMessageWithResources(
	ctx context.Context,
	session db.ChatSession,
	senderID pgtype.UUID,
	content string,
	attachmentIDs []pgtype.UUID,
	agentIDs []pgtype.UUID,
	memberMentionIDs []pgtype.UUID,
	mentionsJSON []byte,
	resourceRefs []protocol.ChatResourceRef,
) (*GroupMessageSend, error) {
	if len(agentIDs) == 0 {
		return nil, fmt.Errorf("group fanout requires at least one agent")
	}

	// 事务外预计算每个 Agent 的 Composio overlay 与归因 fallback（可发生网络 I/O、
	// 策略读，均不允许在事务内做），与 SendDirectChatMessage 的约束一致。
	type agentPre struct {
		agent   db.Agent
		overlay runtimeMCPOverlayData
		attr    attribution.Result
	}
	pres := make([]agentPre, 0, len(agentIDs))
	for _, aid := range agentIDs {
		agent, err := s.Queries.GetAgent(ctx, aid)
		if err != nil {
			return nil, fmt.Errorf("load group agent: %w", err)
		}
		attr := attribution.DirectHumanRun(senderID, attribution.EvidenceChat, session.ID)
		attr, err = s.applyAttributionFallback(ctx, attr, agent)
		if err != nil {
			return nil, err
		}
		pres = append(pres, agentPre{
			agent:   agent,
			overlay: s.buildRuntimeMCPOverlay(ctx, senderID, agent),
			attr:    attr,
		})
	}

	senderName := ""
	if u, err := s.Queries.GetUser(ctx, senderID); err == nil {
		senderName = u.Name
	}
	summary := groupSummarize(content)

	var out GroupMessageSend
	// 自管事务：sqlc 的 *db.Queries 不暴露底层 Tx，而快照/参与者复查需要对新表的原生
	// SQL，因此这里不用 runInTx 包装，改为 Begin/Commit/rollback 显式管理。
	tx, txErr := s.TxStarter.Begin(ctx)
	if txErr != nil {
		return nil, fmt.Errorf("begin group fanout tx: %w", txErr)
	}
	defer tx.Rollback(ctx)
	qtx := s.Queries.WithTx(tx)
	if err := func() error {
		// 1. 锁会话行并复查 kind/status（与 handler 普通群路径同形：FOR UPDATE）。
		var kind, status string
		if err := tx.QueryRow(ctx,
			`SELECT kind, status FROM chat_session WHERE id = $1 FOR UPDATE`, session.ID,
		).Scan(&kind, &status); err != nil {
			return fmt.Errorf("lock group session: %w", err)
		}
		if kind != "group" {
			return ErrGroupChatSessionNotGroup
		}
		if status != "active" {
			return ErrChatSessionArchived
		}

		// 2. 锁内复查发送者仍是人类成员、每个被 @ Agent 仍是 agent 参与者（SEC-12）。
		if !s.isParticipantTx(ctx, tx, session.ID, "member", senderID) {
			return ErrGroupChatNotParticipant
		}
		for _, aid := range agentIDs {
			if !s.isParticipantTx(ctx, tx, session.ID, "agent", aid) {
				return ErrGroupChatNotParticipant
			}
		}

		// 3. 人类消息恰好一行：task_id=NULL、成员归因、结构化 mentions。
		msg, err := qtx.CreateChatMessage(ctx, db.CreateChatMessageParams{
			ID:            dbid.NewV7(),
			ChatSessionID: session.ID,
			Role:          "user",
			Content:       content,
			TaskID:        pgtype.UUID{},
			MessageKind:   pgtype.Text{String: protocol.ChatMessageKindMessage, Valid: true},
			AuthorType:    pgtype.Text{String: "member", Valid: true},
			AuthorID:      senderID,
			Mentions:      mentionsJSON,
		})
		if err != nil {
			return fmt.Errorf("create group message: %w", err)
		}
		out.Message = msg
		if err := persistChatResourceRefs(ctx, qtx, msg.ID, resourceRefs); err != nil {
			return fmt.Errorf("link group chat resources: %w", err)
		}

		// 4. 附件绑定 + touch + 清他人归档（与 DM/直连语义一致：归档只是 viewer 态）。
		if len(attachmentIDs) > 0 {
			bound, err := qtx.LinkAttachmentsToChatMessage(ctx, db.LinkAttachmentsToChatMessageParams{
				ChatMessageID: msg.ID,
				ChatSessionID: session.ID,
				WorkspaceID:   session.WorkspaceID,
				UploaderType:  "member",
				UploaderID:    senderID,
				AttachmentIds: attachmentIDs,
			})
			if err != nil {
				return fmt.Errorf("link group attachments: %w", err)
			}
			out.BoundAttachmentIDs = bound
		}
		if err := qtx.TouchChatSession(ctx, session.ID); err != nil {
			return fmt.Errorf("touch group session: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE chat_participant SET archived_at = NULL
			WHERE chat_session_id = $1 AND participant_type = 'member' AND participant_id <> $2`,
			session.ID, senderID); err != nil {
			return fmt.Errorf("clear group archived: %w", err)
		}

		// 5. 固化输入快照集合：触发前最近 19 条可见消息 + 触发消息本体，升序。
		snapshot, err := s.buildGroupSnapshot(ctx, tx, session.ID, msg.ID)
		if err != nil {
			return err
		}

		// 6. 每个被 @ Agent：复查 archived/runtime（与直连同形）→ 建任务（独立
		//    chat_input_task_id=自身、ForceFreshSession=true）→ 写同一份快照链接。
		for i := range agentIDs {
			pre := pres[i]
			carrier, err := qtx.GetAgentForClaimUpdate(ctx, agentIDs[i])
			if err != nil {
				return fmt.Errorf("reload group agent: %w", err)
			}
			if carrier.ArchivedAt.Valid {
				return ErrChatTaskAgentArchived
			}
			if !carrier.RuntimeID.Valid {
				return ErrChatTaskAgentNoRuntime
			}
			attrSource, delegatedFrom, attrEvidenceKind, attrEvidenceRef := attributionCreateParams(pre.attr)
			task, err := qtx.CreateChatTask(ctx, db.CreateChatTaskParams{
				ID:                   dbid.NewV7(),
				AgentID:              agentIDs[i],
				RuntimeID:            carrier.RuntimeID,
				Priority:             2,
				ChatSessionID:        session.ID,
				InitiatorUserID:      senderID,
				OriginatorUserID:     pre.attr.UserID,
				AccountableUserID:    pre.attr.AccountableUserID,
				ForceFreshSession:    pgtype.Bool{Bool: true, Valid: true},
				RuntimeMcpOverlay:    pre.overlay.Overlay,
				RuntimeConnectedApps: pre.overlay.ConnectedApps,
				OriginatorSource:     attrSource,
				TriggerEvidenceKind:  attrEvidenceKind,
				TriggerEvidenceRefID: attrEvidenceRef,
			})
			if err != nil {
				return fmt.Errorf("create group agent task: %w", err)
			}
			if _, err := qtx.SetChatTaskInputOwnerSelf(ctx, task.ID); err != nil {
				return fmt.Errorf("stamp group task input owner: %w", err)
			}
			_ = delegatedFrom // 群任务与直连同源，delegated_from 走 CreateChatTask 内默认。
			for pos, sm := range snapshot {
				isTrigger := sm.ID == msg.ID
				if _, err := tx.Exec(ctx, `INSERT INTO chat_group_task_input (task_id, message_id, position, is_trigger)
					VALUES ($1, $2, $3, $4)`, task.ID, sm.ID, pos, isTrigger); err != nil {
					return fmt.Errorf("write group input snapshot: %w", err)
				}
			}
			// 每任务恰有一个 trigger（uq_chat_group_task_input_trigger），缺失即损坏。
			out.Dispatches = append(out.Dispatches, GroupAgentDispatch{AgentID: agentIDs[i], Task: task})
		}

		// 7. @成员 inbox（与 handler 普通群路径同 shape，recipient 精确到被 @ 者）。
		for _, uid := range memberMentionIDs {
			details, _ := json.Marshal(map[string]string{
				"chat_session_id": util.UUIDToString(session.ID),
				"message_id":      util.UUIDToString(msg.ID),
			})
			item, err := qtx.CreateInboxItem(ctx, db.CreateInboxItemParams{
				ID:            dbid.NewV7(),
				WorkspaceID:   session.WorkspaceID,
				RecipientType: "member",
				RecipientID:   uid,
				Type:          "chat_mention",
				Severity:      "info",
				IssueID:       pgtype.UUID{},
				Title:         senderName,
				Body:          pgtype.Text{String: summary, Valid: summary != ""},
				ActorType:     pgtype.Text{String: "member", Valid: true},
				ActorID:       senderID,
				Details:       details,
			})
			if err != nil {
				return fmt.Errorf("create group mention inbox: %w", err)
			}
			out.InboxItems = append(out.InboxItems, item)
		}
		return nil
	}(); err != nil {
		slog.Error("group chat fanout failed",
			"chat_session_id", util.UUIDToString(session.ID),
			"agents", len(agentIDs),
			"error", err)
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Error("group chat fanout commit failed",
			"chat_session_id", util.UUIDToString(session.ID),
			"error", err)
		return nil, fmt.Errorf("commit group fanout: %w", err)
	}

	// 提交成功。task:queued / daemon 唤醒由调用方（handler）在 chat:message 发布之后
	// 通过 NotifyGroupDispatches 触发，保证 §4.2 的事件次序：先消息、后任务。
	return &out, nil
}

// NotifyGroupDispatches 在 chat:message 事件发布后调用：逐任务广播 task:queued 并
// 唤醒 daemon。唤醒必须在 commit 之后（旧唤醒会提前领取/误报），与
// SendDirectChatMessage 的 commit→notify 次序约束一致。
func (s *TaskService) NotifyGroupDispatches(ctx context.Context, dispatches []GroupAgentDispatch) {
	for _, d := range dispatches {
		s.broadcastTaskEvent(ctx, protocol.EventTaskQueued, d.Task)
		s.NotifyTaskEnqueued(ctx, d.Task)
	}
}

// isParticipantTx 锁内复查某参与者行是否存在。
func (s *TaskService) isParticipantTx(ctx context.Context, tx pgx.Tx, sessionID pgtype.UUID, ptype string, pid pgtype.UUID) bool {
	var one int
	err := tx.QueryRow(ctx, `SELECT 1 FROM chat_participant
		WHERE chat_session_id = $1 AND participant_type = $2 AND participant_id = $3`,
		sessionID, ptype, pid).Scan(&one)
	return err == nil
}

// buildGroupSnapshot 取触发前最近 19 条可见消息 + 触发消息本体，按 (created_at,id)
// 升序返回（最多 20 条）。排除 channel_command 与 onboarding_kickoff。
func (s *TaskService) buildGroupSnapshot(ctx context.Context, tx pgx.Tx, sessionID, triggerID pgtype.UUID) ([]groupSnapshotMessage, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, created_at FROM chat_message
		WHERE chat_session_id = $1
		  AND COALESCE(message_kind, 'message') NOT IN ('channel_command', 'onboarding_kickoff')
		ORDER BY created_at DESC, id DESC
		LIMIT $2`, sessionID, groupSnapshotLimit+1)
	if err != nil {
		return nil, fmt.Errorf("load group snapshot candidates: %w", err)
	}
	defer rows.Close()
	var picked []groupSnapshotMessage
	for rows.Next() {
		var sm groupSnapshotMessage
		if err := rows.Scan(&sm.ID, &sm.Created); err != nil {
			return nil, fmt.Errorf("scan group snapshot row: %w", err)
		}
		picked = append(picked, sm)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read group snapshot rows: %w", err)
	}
	// DESC 取最新（含刚插入的触发消息本体），保留触发消息并回退到最多 19 条历史，
	// 最后反转为 (created_at,id) 升序。
	var history []groupSnapshotMessage
	hasTrigger := false
	for _, sm := range picked {
		if sm.ID == triggerID {
			hasTrigger = true
			continue
		}
		if len(history) < groupSnapshotLimit {
			history = append(history, sm)
		}
	}
	if !hasTrigger {
		// 理论上不可能：消息刚在同一事务插入。fail-closed 而非静默降级，
		// 避免把缺失 trigger 的快照固化给 daemon（§5 损坏快照判定的源头侧对偶）。
		return nil, fmt.Errorf("group snapshot missing trigger message")
	}
	// 反转 history（当前为 DESC）为升序，再追加触发消息（最新）。
	out := make([]groupSnapshotMessage, 0, len(history)+1)
	for i := len(history) - 1; i >= 0; i-- {
		out = append(out, history[i])
	}
	out = append(out, groupSnapshotMessage{ID: triggerID})
	return out, nil
}

// groupSummarize 截断 inbox 正文（与 handler.summarizeMessage 语义一致；service
// 不能依赖 handler 包，故此处独立实现保持单一真相源在调用侧的形态）。
func groupSummarize(content string) string {
	r := []rune(strings.TrimSpace(content))
	if len(r) <= 200 {
		return string(r)
	}
	return string(r[:200])
}
