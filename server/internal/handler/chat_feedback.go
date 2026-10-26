package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Chat reactions stay on an allow-list so a message cannot carry arbitrary
// text disguised as an emoji. Keep this set identical to REACTION_EMOJIS in
// packages/views/chat/components/chat-message-feedback.tsx.
var chatReactionEmojis = map[string]struct{}{
	"👍": {}, "👎": {}, "👏": {}, "🙏": {}, "🤝": {}, "💪": {}, "🙌": {}, "👌": {},
	"😄": {}, "😂": {}, "🤣": {}, "😊": {}, "😍": {}, "😎": {}, "🤔": {}, "😮": {},
	"😅": {}, "😢": {}, "😭": {}, "😡": {}, "😱": {}, "😴": {}, "🥳": {}, "🤗": {},
	"❤️": {}, "🎉": {}, "🔥": {}, "👀": {}, "✅": {}, "⭐": {}, "💯": {}, "🚀": {},
	"💡": {}, "✨": {}, "📌": {}, "❓": {}, "💬": {}, "📝": {}, "⏰": {}, "☕": {},
}

type ChatMessageReactionResponse struct {
	Emoji   string `json:"emoji"`
	ActorID string `json:"actor_id"`
}

type ChatMessageReplyResponse struct {
	ID        string `json:"id"`
	AuthorID  string `json:"author_id"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

func (h *Handler) ToggleChatMessageReaction(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if _, ok := h.loadChatSessionForActor(w, r, userID, ctxWorkspaceID(r.Context()), chi.URLParam(r, "sessionId")); !ok {
		return
	}
	messageID := chi.URLParam(r, "messageId")
	if !h.chatMessageInSession(w, r, chi.URLParam(r, "sessionId"), messageID) {
		return
	}
	var req struct {
		Emoji string `json:"emoji"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	emoji := strings.TrimSpace(req.Emoji)
	if _, allowed := chatReactionEmojis[emoji]; !allowed {
		writeError(w, http.StatusBadRequest, "unsupported emoji")
		return
	}
	ctx := r.Context()
	tag, err := h.DB.Exec(ctx, `
		DELETE FROM chat_message_reaction
		WHERE message_id = $1 AND actor_id = $2 AND emoji = $3
	`, messageID, userID, emoji)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reaction update failed")
		return
	}
	if tag.RowsAffected() == 0 {
		_, err = h.DB.Exec(ctx, `
			INSERT INTO chat_message_reaction (message_id, actor_id, emoji)
			VALUES ($1, $2, $3)
		`, messageID, userID, emoji)
		if err != nil && !isUniqueViolation(err) {
			writeError(w, http.StatusInternalServerError, "reaction update failed")
			return
		}
	}
	reactions, err := h.listChatMessageReactions(ctx, []string{messageID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reaction update failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reactions": feedbackOrEmpty(reactions[messageID])})
}

func (h *Handler) CreateChatMessageReply(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	sessionID := chi.URLParam(r, "sessionId")
	if _, ok := h.loadChatSessionForActor(w, r, userID, ctxWorkspaceID(r.Context()), sessionID); !ok {
		return
	}
	messageID := chi.URLParam(r, "messageId")
	if !h.chatMessageInSession(w, r, sessionID, messageID) {
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	content := strings.TrimSpace(req.Content)
	if content == "" || utf8.RuneCountInString(content) > 1000 {
		writeError(w, http.StatusBadRequest, "invalid reply")
		return
	}
	ctx := r.Context()
	if _, err := h.DB.Exec(ctx, `
		INSERT INTO chat_message_reply (id, message_id, chat_session_id, author_id, content)
		VALUES ($1, $2, $3, $4, $5)
	`, uuid.NewString(), messageID, sessionID, userID, content); err != nil {
		writeError(w, http.StatusInternalServerError, "reply create failed")
		return
	}
	replies, err := h.listChatMessageReplies(ctx, []string{messageID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reply create failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"replies": feedbackOrEmpty(replies[messageID])})
}

func feedbackOrEmpty[T any](rows []T) []T {
	if rows == nil {
		return []T{}
	}
	return rows
}

func (h *Handler) chatMessageInSession(w http.ResponseWriter, r *http.Request, sessionID, messageID string) bool {
	var found string
	err := h.DB.QueryRow(r.Context(), `
		SELECT id::text FROM chat_message
		WHERE id = $1 AND chat_session_id = $2
	`, messageID, sessionID).Scan(&found)
	if err != nil || found == "" {
		writeError(w, http.StatusNotFound, "chat message not found")
		return false
	}
	return true
}

func (h *Handler) attachChatMessageFeedback(ctx context.Context, resp []ChatMessageResponse) {
	if h.DB == nil || len(resp) == 0 {
		return
	}
	ids := make([]string, len(resp))
	for i, message := range resp {
		ids[i] = message.ID
	}
	reactions, err := h.listChatMessageReactions(ctx, ids)
	if err != nil {
		slog.Warn("chat message reactions unavailable", "error", err)
		return
	}
	replies, err := h.listChatMessageReplies(ctx, ids)
	if err != nil {
		slog.Warn("chat message replies unavailable", "error", err)
		return
	}
	for i := range resp {
		if rows := reactions[resp[i].ID]; len(rows) > 0 {
			resp[i].Reactions = rows
		}
		if rows := replies[resp[i].ID]; len(rows) > 0 {
			resp[i].Replies = rows
		}
	}
}

func (h *Handler) listChatMessageReactions(ctx context.Context, messageIDs []string) (map[string][]ChatMessageReactionResponse, error) {
	out := map[string][]ChatMessageReactionResponse{}
	rows, err := h.DB.Query(ctx, `
		SELECT message_id::text, actor_id::text, emoji
		FROM chat_message_reaction
		WHERE message_id::text = ANY($1)
		ORDER BY created_at
	`, messageIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID, actorID, emoji string
		if err := rows.Scan(&messageID, &actorID, &emoji); err != nil {
			return nil, err
		}
		out[messageID] = append(out[messageID], ChatMessageReactionResponse{Emoji: emoji, ActorID: actorID})
	}
	return out, rows.Err()
}

func (h *Handler) listChatMessageReplies(ctx context.Context, messageIDs []string) (map[string][]ChatMessageReplyResponse, error) {
	out := map[string][]ChatMessageReplyResponse{}
	rows, err := h.DB.Query(ctx, `
		SELECT message_id::text, id::text, author_id::text, content, created_at
		FROM chat_message_reply
		WHERE message_id::text = ANY($1)
		ORDER BY created_at
	`, messageIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		var reply ChatMessageReplyResponse
		var created time.Time
		if err := rows.Scan(&messageID, &reply.ID, &reply.AuthorID, &reply.Content, &created); err != nil {
			return nil, err
		}
		reply.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		out[messageID] = append(out[messageID], reply)
	}
	return out, rows.Err()
}
