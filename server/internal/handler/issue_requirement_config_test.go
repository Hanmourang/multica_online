package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestUpdateIssueRequirementConfig(t *testing.T) {
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	insertRequirement := func(t *testing.T) string {
		t.Helper()
		var id string
		if err := testPool.QueryRow(ctx, `
                        INSERT INTO issue (
                                workspace_id, title, status, priority, creator_type, creator_id,
                                number, position, goal, decompose_mode, auto_trigger
                        )
                        VALUES (
                                $1, $2, 'todo', 'none', 'member', $3,
                                (SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE workspace_id = $1),
                                100, '旧目标', 'confirm', true
                        )
                        RETURNING id
                `, testWorkspaceID, "Config "+suffix, testUserID).Scan(&id); err != nil {
			t.Fatalf("insert issue: %v", err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, id)
		})
		return id
	}

	t.Run("updates goal decompose_mode and auto_trigger", func(t *testing.T) {
		issueID := insertRequirement(t)
		w := httptest.NewRecorder()
		req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{
			"goal":           "新目标",
			"decompose_mode": "auto",
			"auto_trigger":   false,
		})
		req = withURLParam(req, "id", issueID)
		testHandler.UpdateIssue(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("UpdateIssue: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var updated IssueResponse
		if err := json.NewDecoder(w.Body).Decode(&updated); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if updated.Goal == nil || *updated.Goal != "新目标" {
			t.Fatalf("goal = %v, want 新目标", updated.Goal)
		}
		if updated.DecomposeMode != "auto" {
			t.Fatalf("decompose_mode = %q, want auto", updated.DecomposeMode)
		}
		if updated.AutoTrigger {
			t.Fatal("auto_trigger still true")
		}
	})

	t.Run("rejects invalid decompose_mode", func(t *testing.T) {
		issueID := insertRequirement(t)
		w := httptest.NewRecorder()
		req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{
			"decompose_mode": "instant",
		})
		req = withURLParam(req, "id", issueID)
		testHandler.UpdateIssue(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("clears goal with explicit null", func(t *testing.T) {
		issueID := insertRequirement(t)
		w := httptest.NewRecorder()
		req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{
			"goal": nil,
		})
		req = withURLParam(req, "id", issueID)
		testHandler.UpdateIssue(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var updated IssueResponse
		if err := json.NewDecoder(w.Body).Decode(&updated); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if updated.Goal != nil && *updated.Goal != "" {
			t.Fatalf("goal should be cleared, got %v", updated.Goal)
		}
	})
}
