package service

import (
	"context"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// applyChatAudience stamps ChatKind and, for DM/Group, a non-nil recipient
// list of the current human participants. Agent sessions keep nil recipients
// so the existing workspace fanout is unchanged. A DM/Group lookup failure or
// an empty audience returns false: the caller must drop the event instead of
// broadcasting it to the workspace.
func (s *TaskService) applyChatAudience(ctx context.Context, e *events.Event, sessionID string) bool {
	if sessionID == "" || s == nil || s.Queries == nil {
		return true
	}
	cs, err := s.Queries.GetChatSession(ctx, util.MustParseUUID(sessionID))
	if err != nil {
		return true
	}
	return s.applyChatAudienceSession(ctx, e, cs)
}

func (s *TaskService) applyChatAudienceSession(ctx context.Context, e *events.Event, cs db.ChatSession) bool {
	e.ChatKind = cs.Kind
	if cs.Kind != "dm" && cs.Kind != "group" {
		return true
	}
	ids, err := s.Queries.ListHumanChatParticipantIDs(ctx, cs.ID)
	if err != nil {
		return false
	}
	recipients := make([]string, 0, len(ids))
	for _, id := range ids {
		if sid := util.UUIDToString(id); sid != "" {
			recipients = append(recipients, sid)
		}
	}
	if len(recipients) == 0 {
		return false
	}
	e.RecipientUserIDs = recipients
	return true
}
