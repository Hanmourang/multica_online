package handler

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestDefaultRequirementDueDateUsesUTCDay(t *testing.T) {
	start := pgtype.Timestamptz{Time: time.Date(2026, 9, 14, 16, 30, 0, 0, time.UTC), Valid: true}
	got := defaultRequirementDueDate(start)
	if !got.Valid {
		t.Fatal("expected a due date")
	}
	if got.Time.Format("2006-01-02") != "2026-09-14" {
		t.Fatalf("due date = %s, want 2026-09-14", got.Time.Format("2006-01-02"))
	}
}

func TestCreateIssueDefaultsDueDateToStartDay(t *testing.T) {
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":    "same-day-window requirement",
		"status":   "todo",
		"priority": "none",
		"start_at": "2026-09-14T09:30:00Z",
	})
	testHandler.CreateIssue(w, req)
	if w.Code != 201 {
		t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	if err := json.NewDecoder(w.Body).Decode(&issue); err != nil {
		t.Fatalf("decode: %v", err)
	}
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })
	if issue.DueDate == nil || *issue.DueDate != "2026-09-14" {
		t.Fatalf("due_date = %v, want 2026-09-14", issue.DueDate)
	}
}
