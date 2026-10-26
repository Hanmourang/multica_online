package service

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func persistChatResourceRefs(ctx context.Context, qtx *db.Queries, messageID pgtype.UUID, refs []protocol.ChatResourceRef) error {
	for i, ref := range refs {
		resourceID, err := util.ParseUUID(ref.ID)
		if err != nil {
			return fmt.Errorf("invalid resource id: %w", err)
		}
		projectID := pgtype.UUID{}
		if ref.ProjectID != "" {
			projectID, err = util.ParseUUID(ref.ProjectID)
			if err != nil {
				return fmt.Errorf("invalid project id: %w", err)
			}
		}
		if err := qtx.CreateChatMessageResourceRef(ctx, db.CreateChatMessageResourceRefParams{
			MessageID: messageID, Position: int32(i), ResourceType: ref.Type,
			ResourceID: resourceID, ResourceKind: ref.Kind, ResourceSource: ref.Source, ProjectID: projectID,
		}); err != nil {
			return err
		}
	}
	return nil
}
