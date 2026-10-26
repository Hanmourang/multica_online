package dingtalk

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// countingDeliveryQueries is the noDelivery rig plus a counter on the delivery
// snapshot lookup. GetChannelTaskDelivery is the first query processEvent
// touches, so how many times it is called tells us whether the private-
// conversation guard short-circuited before any binding lookup / delivery write.
type countingDeliveryQueries struct {
	noDeliveryOutboundQueries
	lookups *int
}

func (c countingDeliveryQueries) GetChannelTaskDelivery(context.Context, pgtype.UUID) (db.ChannelTaskDelivery, error) {
	*c.lookups++
	return db.ChannelTaskDelivery{}, pgx.ErrNoRows
}

// TestOutboundRefusesDMAndGroupBeforeBindingLookup (plan 20261025 §5.4).
// Red-green on a single fixture that only differs by ChatKind: an agent session
// gets as far as the delivery-snapshot lookup, while a dm/group session must be
// refused at the guard so a forged or legacy binding can never egress privately.
func TestOutboundRefusesDMAndGroupBeforeBindingLookup(t *testing.T) {
	buildEvent := func(kind string) events.Event {
		return events.Event{
			Type:          protocol.EventChatDone,
			TaskID:        "11111111-1111-1111-1111-111111111111",
			ChatSessionID: "22222222-2222-2222-2222-222222222222",
			ChatKind:      kind,
			Payload:       protocol.ChatDonePayload{Content: "must stay in Multica"},
		}
	}

	t.Run("agent reaches delivery lookup", func(t *testing.T) {
		lookups := 0
		o := NewOutbound(countingDeliveryQueries{lookups: &lookups}, nil, nil, nil)
		if err := o.processEvent(context.Background(), buildEvent("agent")); err != nil {
			t.Fatalf("processEvent: %v", err)
		}
		if lookups != 1 {
			t.Fatalf("agent session should reach the delivery lookup, got %d calls", lookups)
		}
	})

	for _, kind := range []string{"dm", "group"} {
		t.Run(kind+" refused before lookup", func(t *testing.T) {
			lookups := 0
			o := NewOutbound(countingDeliveryQueries{lookups: &lookups}, nil, nil, nil)
			if err := o.processEvent(context.Background(), buildEvent(kind)); err != nil {
				t.Fatalf("processEvent: %v", err)
			}
			if lookups != 0 {
				t.Fatalf("%s session must be refused before any lookup, got %d calls", kind, lookups)
			}
		})
	}
}
