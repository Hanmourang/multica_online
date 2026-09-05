package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestRequirementTriggerSweep covers spec §7.1 / §7.5①: the 30s sweep picks up
// confirmed, auto-trigger, past-due top-level requirements, stamps
// triggered_at (idempotent — a second sweep is a no-op), and pushes every
// stage-3 child with an agent assignee into agent_task_queue. Children with
// blocked_by edges are enqueued too; the 451 claim gate
// (ListQueuedClaimCandidates / ClaimAgentTask NOT EXISTS) holds them until
// their prerequisites reach done.
func TestRequirementTriggerSweep(t *testing.T) {
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	insertTriggerRequirement := func(t *testing.T, title string, autoTrigger bool, startAt *time.Time, confirmed bool) string {
		t.Helper()
		var number int
		if err := testPool.QueryRow(ctx, `
                        UPDATE workspace
                        SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1)) + 1
                        WHERE id = $1 RETURNING issue_counter
                `, testWorkspaceID).Scan(&number); err != nil {
			t.Fatalf("next issue number: %v", err)
		}
		var id string
		if err := testPool.QueryRow(ctx, `
                        INSERT INTO issue (
                                workspace_id, title, status, priority, creator_type, creator_id,
                                number, position, auto_trigger, start_at, decomposition_confirmed_at
                        )
                        VALUES ($1, $2, 'todo', 'medium', 'member', $3, $4, 100, $5, $6,
                                CASE WHEN $7 THEN now() ELSE NULL END)
                        RETURNING id
                `, testWorkspaceID, title+" "+suffix, testUserID, number, autoTrigger, startAt, confirmed).Scan(&id); err != nil {
			t.Fatalf("insert requirement: %v", err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM issue_dependency WHERE issue_id IN (SELECT id FROM issue WHERE parent_issue_id = $1) OR depends_on_issue_id IN (SELECT id FROM issue WHERE parent_issue_id = $1)`, id)
			testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE parent_issue_id = $1)`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1 OR parent_issue_id = $1`, id)
		})
		return id
	}

	insertStageChild := func(t *testing.T, parentID, title string, stage int, agentID string) string {
		t.Helper()
		var number int
		if err := testPool.QueryRow(ctx, `
                        UPDATE workspace
                        SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1)) + 1
                        WHERE id = $1 RETURNING issue_counter
                `, testWorkspaceID).Scan(&number); err != nil {
			t.Fatalf("next issue number: %v", err)
		}
		var id string
		if err := testPool.QueryRow(ctx, `
                        INSERT INTO issue (
                                workspace_id, title, status, priority, creator_type, creator_id,
                                number, position, parent_issue_id, stage, assignee_type, assignee_id
                        )
                        VALUES ($1, $2, 'todo', 'medium', 'member', $3, $4, 100, $5, $6,
                                'agent', $7)
                        RETURNING id
                `, testWorkspaceID, title, testUserID, number, parentID, stage, agentID).Scan(&id); err != nil {
			t.Fatalf("insert stage child: %v", err)
		}
		return id
	}

	linkDep := func(t *testing.T, issueID, dependsOnID string) {
		t.Helper()
		if _, err := testPool.Exec(ctx, `
                        INSERT INTO issue_dependency (issue_id, depends_on_issue_id, type)
                        VALUES ($1, $2, 'blocked_by')
                `, issueID, dependsOnID); err != nil {
			t.Fatalf("insert dependency: %v", err)
		}
	}

	testAgentID := func(t *testing.T) string {
		t.Helper()
		var id string
		if err := testPool.QueryRow(ctx,
			`SELECT id FROM agent WHERE workspace_id = $1 AND name = 'Handler Test Agent'`,
			testWorkspaceID).Scan(&id); err != nil {
			t.Fatalf("locate test agent: %v", err)
		}
		return id
	}

	triggeredAt := func(t *testing.T, id string) any {
		t.Helper()
		var v any
		if err := testPool.QueryRow(ctx, `SELECT triggered_at FROM issue WHERE id = $1`, id).Scan(&v); err != nil {
			t.Fatalf("read triggered_at: %v", err)
		}
		return v
	}
	queuedCount := func(t *testing.T, issueID string) int {
		t.Helper()
		var n int
		if err := testPool.QueryRow(ctx,
			`SELECT count(*) FROM agent_task_queue WHERE issue_id = $1 AND status = 'queued'`,
			issueID).Scan(&n); err != nil {
			t.Fatalf("count queued tasks: %v", err)
		}
		return n
	}

	past := time.Now().Add(-time.Minute)
	future := time.Now().Add(time.Hour)

	t.Run("sweep triggers due requirement and enqueues stage-3 children", func(t *testing.T) {
		agentID := testAgentID(t)
		reqA := insertTriggerRequirement(t, "Sweep A", true, &past, true)
		t1 := insertStageChild(t, reqA, "T1 无依赖", 3, agentID)
		t2 := insertStageChild(t, reqA, "T2 依赖 T1", 3, agentID)
		t3 := insertStageChild(t, reqA, "T3 依赖 T2", 3, agentID)
		linkDep(t, t2, t1)
		linkDep(t, t3, t2)
		// stage 4 验收子任务不由触发 loop 派发（T19 验收执行负责）。
		insertStageChild(t, reqA, "验收", 4, agentID)

		reqB := insertTriggerRequirement(t, "Sweep B 未到点", true, &future, true)
		insertStageChild(t, reqB, "B-T1", 3, agentID)
		reqC := insertTriggerRequirement(t, "Sweep C 手动模式", false, &past, true)
		insertStageChild(t, reqC, "C-T1", 3, agentID)
		reqD := insertTriggerRequirement(t, "Sweep D 未确认拆解", true, &past, false)
		insertStageChild(t, reqD, "D-T1", 3, agentID)

		n, err := testHandler.IssueService.SweepRequirementTriggers(ctx)
		if err != nil {
			t.Fatalf("SweepRequirementTriggers: %v", err)
		}
		if n != 1 {
			t.Fatalf("expected 1 requirement triggered, got %d", n)
		}
		if triggeredAt(t, reqA) == nil {
			t.Fatal("requirement A: triggered_at should be set")
		}
		// 依赖链子任务同样入队 queued；claim 闸门（451）在前置未 done
		// 前挡住领取，前置 done 后自然放行——spec §7.5⑤。
		for _, child := range []string{t1, t2, t3} {
			if got := queuedCount(t, child); got != 1 {
				t.Fatalf("child %s: expected 1 queued task, got %d", child, got)
			}
		}
		if triggeredAt(t, reqB) != nil {
			t.Fatal("requirement B (future start) must not trigger")
		}
		if triggeredAt(t, reqC) != nil {
			t.Fatal("requirement C (auto_trigger=false) must not trigger")
		}
		if triggeredAt(t, reqD) != nil {
			t.Fatal("requirement D (decomposition unconfirmed) must not trigger")
		}
		if got := queuedCount(t, reqB) + 0; got != 0 {
			t.Fatalf("requirement B children must stay unqueued, got %d", got)
		}

		// 幂等：再扫一轮，A 不重复触发、队列行数不变。
		n, err = testHandler.IssueService.SweepRequirementTriggers(ctx)
		if err != nil {
			t.Fatalf("second sweep: %v", err)
		}
		if n != 0 {
			t.Fatalf("second sweep should trigger nothing, got %d", n)
		}
		if got := queuedCount(t, t1); got != 1 {
			t.Fatalf("second sweep must not duplicate T1's task, got %d", got)
		}
	})

	t.Run("manual trigger fires immediately regardless of start_at", func(t *testing.T) {
		agentID := testAgentID(t)
		reqB := insertTriggerRequirement(t, "Manual B", true, &future, true)
		child := insertStageChild(t, reqB, "B-T1", 3, agentID)

		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+reqB+"/trigger", nil)
		req = withURLParam(req, "id", reqB)
		testHandler.TriggerRequirement(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("manual trigger: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		if triggeredAt(t, reqB) == nil {
			t.Fatal("manual trigger should set triggered_at")
		}
		if got := queuedCount(t, child); got != 1 {
			t.Fatalf("manual trigger should enqueue the stage-3 child, got %d", got)
		}

		// 已触发再调 → 409。
		w2 := httptest.NewRecorder()
		req2 := newRequest("POST", "/api/issues/"+reqB+"/trigger", nil)
		req2 = withURLParam(req2, "id", reqB)
		testHandler.TriggerRequirement(w2, req2)
		if w2.Code != http.StatusConflict {
			t.Fatalf("re-trigger: expected 409, got %d: %s", w2.Code, w2.Body.String())
		}
	})

	t.Run("manual trigger rejects unconfirmed requirement and non-top-level issue", func(t *testing.T) {
		agentID := testAgentID(t)
		reqUnconfirmed := insertTriggerRequirement(t, "Manual 未确认", true, &past, false)
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+reqUnconfirmed+"/trigger", nil)
		req = withURLParam(req, "id", reqUnconfirmed)
		testHandler.TriggerRequirement(w, req)
		if w.Code != http.StatusConflict {
			t.Fatalf("unconfirmed: expected 409, got %d: %s", w.Code, w.Body.String())
		}

		reqOK := insertTriggerRequirement(t, "Manual OK", true, &past, true)
		childID := insertStageChild(t, reqOK, "子任务", 3, agentID)
		w2 := httptest.NewRecorder()
		req2 := newRequest("POST", "/api/issues/"+childID+"/trigger", nil)
		req2 = withURLParam(req2, "id", childID)
		testHandler.TriggerRequirement(w2, req2)
		if w2.Code != http.StatusBadRequest {
			t.Fatalf("non-top-level: expected 400, got %d: %s", w2.Code, w2.Body.String())
		}
		if triggeredAt(t, reqOK) != nil {
			t.Fatal("child-trigger attempt must not trigger the parent")
		}
	})
}
