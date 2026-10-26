package wecom

import (
	"context"
	"errors"
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// TestProcessEvent_RefusesDMAndGroupDespiteValidBinding (plan 20261025 §5.4).
// Reuses the exact fixture that delivers a chat reply to a bound WeCom chat
// (TestProcessEvent_DeliversChatReplyToBoundChat) and flips only ChatKind: a
// dm/group completion must send nothing, even with a forged/legacy binding. The
// agent case is the positive control that the rig would otherwise deliver.
func TestProcessEvent_RefusesDMAndGroupDespiteValidBinding(t *testing.T) {
	t.Parallel()
	newRig := func(t *testing.T) (*Outbound, *recordingConn) {
		t.Helper()
		q := &fakeOutboundQueries{
			sessionBinding:  db.ChannelChatSessionBinding{ChannelChatID: "CHAT_1", ChatType: "group"},
			installation:    db.ChannelInstallation{Status: string(InstallationActive)},
			channelIngested: askedOverWecom(),
		}
		q.fileTask(t, "33333333-3333-3333-3333-333333333333")
		o, instID, conn := newOutboundWithConn(t, q)
		q.sessionBinding.InstallationID = instID
		q.installation.ID = instID
		return o, conn
	}

	t.Run("agent delivers (positive control)", func(t *testing.T) {
		o, conn := newRig(t)
		if err := o.processEvent(context.Background(), events.Event{
			ChatSessionID: "22222222-2222-2222-2222-222222222222",
			ChatKind:      "agent",
			Payload: protocol.ChatDonePayload{
				Content: "the agent reply",
				TaskID:  "33333333-3333-3333-3333-333333333333",
			},
		}); err != nil {
			t.Fatalf("processEvent: %v", err)
		}
		if len(conn.frames) == 0 {
			t.Fatal("agent session should have delivered to the bound chat")
		}
	})

	for _, kind := range []string{"dm", "group"} {
		kind := kind
		t.Run(kind+" refused", func(t *testing.T) {
			t.Parallel()
			o, conn := newRig(t)
			if err := o.processEvent(context.Background(), events.Event{
				ChatSessionID: "22222222-2222-2222-2222-222222222222",
				ChatKind:      kind,
				Payload: protocol.ChatDonePayload{
					Content: "private reply",
					TaskID:  "33333333-3333-3333-3333-333333333333",
				},
			}); err != nil {
				t.Fatalf("processEvent: %v", err)
			}
			if len(conn.frames) != 0 {
				t.Errorf("%s session must never egress to WeCom, got %d frames", kind, len(conn.frames))
			}
		})
	}
}

// TestHandleInboxNew_RefusesDMAndGroupDespiteLiveBinding covers the chat_mention
// push path. memberErr is set so that if the guard were absent the binding lookup
// would surface the error; a dm/group mention must return before any query, so
// nothing is pushed and the lookup is never reached.
func TestHandleInboxNew_RefusesDMAndGroupDespiteLiveBinding(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"dm", "group"} {
		kind := kind
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			q := &fakeOutboundQueries{memberErr: errors.New("binding lookup must not run")}
			o, _, conn := newOutboundWithConn(t, q)
			o.handleInboxNew(events.Event{
				ChatKind: kind,
				Payload: map[string]any{
					"item": map[string]any{
						"recipient_type": "member",
						"recipient_id":   "33333333-3333-3333-3333-333333333333",
						"workspace_id":   "44444444-4444-4444-4444-444444444444",
					},
				},
			})
			if len(conn.frames) != 0 {
				t.Errorf("%s mention must not be pushed to WeCom, got %d frames", kind, len(conn.frames))
			}
		})
	}
}
