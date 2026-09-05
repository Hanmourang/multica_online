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

// ListIssues / ListGroupedIssues 的 handler 走的是手工拼装的动态 SQL（排序/
// 多值过滤无法静态化），而不是 sqlc 的 ListIssues —— sqlc 版本补过的列
// （migration 452 需求字段 + requirement_status/stage_progress 派生投影）
// 必须同时存在于动态路径的 SELECT 列表里，否则列表/日历/看板拿到的全是
// 零值：日历色块消失（start_at null）、状态徽标缺失（requirement_status
// 空串被 omitempty 吃掉）。本测试锁死两条动态路径的投影。
func TestListIssues_RequirementFieldsProjection(t *testing.T) {
	ctx := context.Background()
	suffix := time.Now().UnixNano()

	var projectID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id
	`, testWorkspaceID, fmt.Sprintf("Req Projection %d", suffix)).Scan(&projectID); err != nil {
		t.Fatalf("create project: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM project WHERE id = $1`, projectID) })

	nextNumber := func() int {
		var number int
		if err := testPool.QueryRow(ctx, `
			UPDATE workspace
			SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1)) + 1
			WHERE id = $1 RETURNING issue_counter
		`, testWorkspaceID).Scan(&number); err != nil {
			t.Fatalf("next issue number: %v", err)
		}
		return number
	}

	// issue A：未拆解需求 —— 带 start_at/goal/confirm 模式，无子任务。
	var issueA string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, position, number, project_id,
			start_at, goal, decompose_mode, auto_trigger)
		VALUES ($1, $2, 'todo', 'none', 'member', $3, 0, $4, $5,
			'2026-09-06 10:00:00+08', '演示目标 A', 'confirm', false)
		RETURNING id
	`, testWorkspaceID, fmt.Sprintf("req-proj-a-%d", suffix), testUserID, nextNumber(), projectID).Scan(&issueA); err != nil {
		t.Fatalf("create issue A: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueA) })

	// issue B：已确认拆解 + 已触发，stage3 子任务 1/2 完成 → 执行中 + "1/2"。
	var issueB string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, position, number, project_id,
			goal, decompose_mode, auto_trigger, decomposition_confirmed_at, triggered_at)
		VALUES ($1, $2, 'in_progress', 'none', 'member', $3, 0, $4, $5,
			'演示目标 B', 'confirm', true, now(), now())
		RETURNING id
	`, testWorkspaceID, fmt.Sprintf("req-proj-b-%d", suffix), testUserID, nextNumber(), projectID).Scan(&issueB); err != nil {
		t.Fatalf("create issue B: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueB) })

	childStatuses := []string{"done", "todo"}
	for idx, st := range childStatuses {
		var childID string
		if err := testPool.QueryRow(ctx, `
			INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, position, number, project_id,
				parent_issue_id, stage)
			VALUES ($1, $2, $3, 'none', 'member', $4, 0, $5, $6, $7, 3)
			RETURNING id
		`, testWorkspaceID, fmt.Sprintf("req-proj-b-child-%d-%d", idx, suffix), st, testUserID, nextNumber(), projectID, issueB).Scan(&childID); err != nil {
			t.Fatalf("create issue B child %d: %v", idx, err)
		}
		t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, childID) })
	}

	findInList := func(t *testing.T, query string, wantID string) IssueResponse {
		t.Helper()
		path := fmt.Sprintf("/api/issues?workspace_id=%s&project_id=%s&limit=500%s",
			testWorkspaceID, projectID, query)
		w := httptest.NewRecorder()
		testHandler.ListIssues(w, newRequest("GET", path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("ListIssues: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Issues []IssueResponse `json:"issues"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode list response: %v", err)
		}
		for _, iss := range resp.Issues {
			if iss.ID == wantID {
				return iss
			}
		}
		t.Fatalf("issue %s not found in list response", wantID)
		return IssueResponse{}
	}

	assertRequirementFields := func(t *testing.T, label string, a, b IssueResponse) {
		t.Helper()
		if a.StartAt == nil || *a.StartAt == "" {
			t.Errorf("%s: issue A start_at lost in projection", label)
		}
		if a.Goal == nil || *a.Goal != "演示目标 A" {
			t.Errorf("%s: issue A goal = %v, want 演示目标 A", label, a.Goal)
		}
		if a.DecomposeMode != "confirm" {
			t.Errorf("%s: issue A decompose_mode = %q, want confirm", label, a.DecomposeMode)
		}
		if a.RequirementStatus != "未拆解" {
			t.Errorf("%s: issue A requirement_status = %q, want 未拆解", label, a.RequirementStatus)
		}
		if b.RequirementStatus != "执行中" {
			t.Errorf("%s: issue B requirement_status = %q, want 执行中", label, b.RequirementStatus)
		}
		if b.StageProgress == nil || *b.StageProgress != "1/2" {
			t.Errorf("%s: issue B stage_progress = %v, want 1/2", label, b.StageProgress)
		}
		if b.TriggeredAt == nil {
			t.Errorf("%s: issue B triggered_at lost in projection", label)
		}
	}

	t.Run("ListIssues dynamic SQL", func(t *testing.T) {
		assertRequirementFields(t, "list", findInList(t, "", issueA), findInList(t, "", issueB))
	})

	t.Run("ListGroupedIssues dynamic SQL", func(t *testing.T) {
		path := fmt.Sprintf("/api/issues/grouped?workspace_id=%s&project_id=%s&limit=500",
			testWorkspaceID, projectID)
		w := httptest.NewRecorder()
		testHandler.ListGroupedIssues(w, newRequest("GET", path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("ListGroupedIssues: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp GroupedIssuesResponse
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode grouped response: %v", err)
		}
		var a, b IssueResponse
		foundA, foundB := false, false
		for _, g := range resp.Groups {
			for _, iss := range g.Issues {
				if iss.ID == issueA {
					a, foundA = iss, true
				}
				if iss.ID == issueB {
					b, foundB = iss, true
				}
			}
		}
		if !foundA || !foundB {
			t.Fatalf("grouped response missing fixtures: A=%v B=%v", foundA, foundB)
		}
		assertRequirementFields(t, "grouped", a, b)
	})

	// table/rows 契约是前端 status/group 分支（含日历视图数据源）的实际供给：
	// 同一投影缺列在这里会让日历色块与状态徽标静默消失。
	t.Run("ListIssueTableRows dynamic SQL", func(t *testing.T) {
		fetchRow := func(t *testing.T, groupKey string, wantID string) IssueResponse {
			t.Helper()
			w := httptest.NewRecorder()
			testHandler.ListIssueTableRows(w, newRequest(http.MethodPost, "/api/issues/table/rows", issueTableRowsRequest{
				Query: issueTableQuerySpec{
					Scope: issueTableScope{Kind: "project", ProjectID: projectID},
					Sort:  issueTableSortRequest{Field: "position", Direction: "asc"},
				},
				Group:     issueTableGroupSpec{Kind: "status"},
				GroupKey:  &groupKey,
				Hierarchy: issueTableHierarchyRequest{Enabled: false},
				Page:      issueTablePageRequest{Limit: 50},
			}))
			if w.Code != http.StatusOK {
				t.Fatalf("ListIssueTableRows(%s): expected 200, got %d: %s", groupKey, w.Code, w.Body.String())
			}
			var resp issueTableRowsResponse
			if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
				t.Fatalf("decode table rows: %v", err)
			}
			for _, row := range resp.Rows {
				if row.Issue.ID == wantID {
					return row.Issue
				}
			}
			t.Fatalf("issue %s not found in table rows (group %s)", wantID, groupKey)
			return IssueResponse{}
		}
		assertRequirementFields(t, "table-rows",
			fetchRow(t, "status:todo", issueA),
			fetchRow(t, "status:in_progress", issueB),
		)
	})
}
