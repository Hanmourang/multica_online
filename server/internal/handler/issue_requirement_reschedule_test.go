package handler

import (
        "context"
        "encoding/json"
        "fmt"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
        "time"
)

// TestUpdateIssueStartAtReschedule covers the requirement-calendar reschedule
// path on UpdateIssue (spec §7.2): start_at is minute-granularity writable
// while the requirement is untriggered, but once triggered_at is set the
// schedule is owned by the running pipeline and PATCH start_at is rejected
// 409 (cancel the run first). due_date stays writable — extending the window
// of an already-running requirement does not rewrite history.
func TestUpdateIssueStartAtReschedule(t *testing.T) {
        ctx := context.Background()
        suffix := fmt.Sprintf("%d", time.Now().UnixNano())

        insertRequirement := func(t *testing.T, triggered bool) string {
                t.Helper()
                var id string
                if err := testPool.QueryRow(ctx, `
                        INSERT INTO issue (
                                workspace_id, title, status, priority, creator_type, creator_id,
                                number, position, start_at, triggered_at
                        )
                        VALUES (
                                $1, $2, 'todo', 'none', 'member', $3,
                                (SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE workspace_id = $1),
                                100, '2026-09-10T09:30:00Z',
                                CASE WHEN $4 THEN now() ELSE NULL END
                        )
                        RETURNING id
                `, testWorkspaceID, "Reschedule "+suffix, testUserID, triggered).Scan(&id); err != nil {
                        t.Fatalf("insert issue: %v", err)
                }
                t.Cleanup(func() {
                        testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, id)
                })
                return id
        }

        t.Run("untriggered requirement accepts minute-granularity start_at", func(t *testing.T) {
                issueID := insertRequirement(t, false)

                w := httptest.NewRecorder()
                req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{
                        "start_at": "2026-09-12T14:45:00Z",
                })
                req = withURLParam(req, "id", issueID)
                testHandler.UpdateIssue(w, req)
                if w.Code != http.StatusOK {
                        t.Fatalf("UpdateIssue: expected 200, got %d: %s", w.Code, w.Body.String())
                }
                var updated IssueResponse
                if err := json.NewDecoder(w.Body).Decode(&updated); err != nil {
                        t.Fatalf("decode response: %v", err)
                }
                // The response serializes in the session timezone; compare the
                // instant, not the string.
                if updated.StartAt == nil {
                        t.Fatalf("expected start_at set, got nil")
                }
                got, err := time.Parse(time.RFC3339, *updated.StartAt)
                if err != nil {
                        t.Fatalf("parse response start_at: %v", err)
                }
                want, _ := time.Parse(time.RFC3339, "2026-09-12T14:45:00Z")
                if !got.Equal(want) {
                        t.Fatalf("expected start_at %v, got %v", want, got)
                }
        })

        t.Run("triggered requirement rejects start_at change with 409", func(t *testing.T) {
                issueID := insertRequirement(t, true)

                w := httptest.NewRecorder()
                req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{
                        "start_at": "2026-09-12T14:45:00Z",
                })
                req = withURLParam(req, "id", issueID)
                testHandler.UpdateIssue(w, req)
                if w.Code != http.StatusConflict {
                        t.Fatalf("UpdateIssue: expected 409 for triggered requirement, got %d: %s", w.Code, w.Body.String())
                }
                if !strings.Contains(w.Body.String(), "already triggered") {
                        t.Fatalf("expected trigger-guard message, got %s", w.Body.String())
                }

                var stored string
                if err := testPool.QueryRow(ctx,
                        `SELECT to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM issue WHERE id = $1`, issueID,
                ).Scan(&stored); err != nil {
                        t.Fatalf("read stored start_at: %v", err)
                }
                if stored != "2026-09-10T09:30:00Z" {
                        t.Fatalf("rejected update still moved start_at to %s", stored)
                }
        })

        t.Run("triggered requirement still accepts due_date", func(t *testing.T) {
                issueID := insertRequirement(t, true)

                w := httptest.NewRecorder()
                req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{
                        "due_date": "2026-09-20",
                })
                req = withURLParam(req, "id", issueID)
                testHandler.UpdateIssue(w, req)
                if w.Code != http.StatusOK {
                        t.Fatalf("UpdateIssue: expected 200 for due_date on triggered requirement, got %d: %s", w.Code, w.Body.String())
                }
        })

        t.Run("explicit null clears start_at while untriggered", func(t *testing.T) {
                issueID := insertRequirement(t, false)

                w := httptest.NewRecorder()
                req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{
                        "start_at": nil,
                })
                req = withURLParam(req, "id", issueID)
                testHandler.UpdateIssue(w, req)
                if w.Code != http.StatusOK {
                        t.Fatalf("UpdateIssue: expected 200, got %d: %s", w.Code, w.Body.String())
                }
                var updated IssueResponse
                if err := json.NewDecoder(w.Body).Decode(&updated); err != nil {
                        t.Fatalf("decode response: %v", err)
                }
                if updated.StartAt != nil {
                        t.Fatalf("expected start_at cleared, got %v", *updated.StartAt)
                }
        })
}
