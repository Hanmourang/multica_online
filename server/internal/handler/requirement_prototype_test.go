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

// 原型一键生成 API（spec: 2026-09-04-requirement-calendar-design.md §5.3/§8/§9）：
// POST /api/issues/{id}/prototype/generate。
//
//   - 同事务登记新版本（version=MAX+1）并把旧 pending 版本置 superseded
//   - 建/复用 stage=1 子任务派给班底第一个 enabled prototyper，任务负载含组装
//     提示词五段 + 产出约定路径 docs/prototypes/<KEY>-<slug>.html
//   - 班底 prototyper 停用 → 409（不该有 stage 1）
//   - 已有 confirmed 版本 → 409（需先取消确认）
func TestGeneratePrototype(t *testing.T) {
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	insertRequirement := func(t *testing.T, goal string) string {
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
			INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id,
				number, position, goal, decompose_mode)
			VALUES ($1, $2, 'todo', 'none', 'member', $3, $4, 100, $5, 'confirm')
			RETURNING id
		`, testWorkspaceID, "退款流程异步化改造 "+suffix, testUserID, number, goal).Scan(&id); err != nil {
			t.Fatalf("insert requirement: %v", err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM issue_prototype_version WHERE issue_id = $1`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue_role_assignment WHERE issue_id = $1`, id)
			testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE parent_issue_id = $1)`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1 OR parent_issue_id = $1`, id)
		})
		return id
	}
	addRole := func(t *testing.T, issueID, role, assigneeType, assigneeID string, enabled bool) {
		t.Helper()
		if _, err := testPool.Exec(ctx, `
			INSERT INTO issue_role_assignment (issue_id, workspace_id, role, assignee_type, assignee_id, enabled, ordinal)
			VALUES ($1, $2, $3, $4, $5, $6, 0)
		`, issueID, testWorkspaceID, role, assigneeType, assigneeID, enabled); err != nil {
			t.Fatalf("seed roster %s: %v", role, err)
		}
	}
	post := func(t *testing.T, issueID string, body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+issueID+"/prototype/generate", body)
		req = withURLParam(req, "id", issueID)
		testHandler.GeneratePrototype(w, req)
		return w
	}

	t.Run("first generate registers version 1 and creates the stage-1 task", func(t *testing.T) {
		issueID := insertRequirement(t, "退款处理时长 P99 30min → 5min")
		addRole(t, issueID, "pm", "member", testUserID, true)
		addRole(t, issueID, "prototyper", "member", testUserID, true)

		w := post(t, issueID, nil)
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Version struct {
				Version  int32  `json:"version"`
				Status   string `json:"status"`
				HtmlPath string `json:"html_path"`
				Prompt   string `json:"prompt"`
			} `json:"version"`
			Task IssueResponse `json:"task"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.Version.Version != 1 || resp.Version.Status != "pending" {
			t.Fatalf("expected version=1 pending, got %+v", resp.Version)
		}
		if !strings.HasPrefix(resp.Version.HtmlPath, "docs/prototypes/HAN-") ||
			!strings.HasSuffix(resp.Version.HtmlPath, ".html") {
			t.Fatalf("unexpected html_path: %s", resp.Version.HtmlPath)
		}
		// 组装提示词五段齐备（spec §8）。
		for _, seg := range []string{"〔需求〕", "〔目标〕", "〔仓库〕", "〔产出〕", "〔风格〕"} {
			if !strings.Contains(resp.Version.Prompt, seg) {
				t.Fatalf("prompt missing segment %s:\n%s", seg, resp.Version.Prompt)
			}
		}

		// stage-1 子任务：parent/stage/assignee 落位，负载含提示词与产出路径。
		var stage int32
		var parentID, assigneeID, description string
		if err := testPool.QueryRow(ctx, `
			SELECT stage, parent_issue_id::text, assignee_id::text, COALESCE(description, '')
			FROM issue WHERE id = $1
		`, resp.Task.ID).Scan(&stage, &parentID, &assigneeID, &description); err != nil {
			t.Fatalf("read stage-1 child: %v", err)
		}
		if stage != 1 {
			t.Fatalf("expected stage=1, got %d", stage)
		}
		if parentID != issueID {
			t.Fatalf("expected parent %s, got %s", issueID, parentID)
		}
		if assigneeID != testUserID {
			t.Fatalf("expected prototyper assignee %s, got %s", testUserID, assigneeID)
		}
		if !strings.Contains(description, "〔需求〕") || !strings.Contains(description, resp.Version.HtmlPath) {
			t.Fatalf("stage-1 brief missing prompt or output path:\n%s", description)
		}
	})

	t.Run("regenerate registers version 2 and supersedes version 1 reusing the stage-1 task", func(t *testing.T) {
		issueID := insertRequirement(t, "目标")
		addRole(t, issueID, "prototyper", "member", testUserID, true)

		if w := post(t, issueID, nil); w.Code != http.StatusCreated {
			t.Fatalf("first generate: expected 201, got %d: %s", w.Code, w.Body.String())
		}
		w := post(t, issueID, map[string]any{
			"marks": []map[string]any{{"detail_id": "d3", "verdict": "no", "note": "进度条太粗"}},
		})
		if w.Code != http.StatusCreated {
			t.Fatalf("regenerate: expected 201, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Version struct {
				Version int32  `json:"version"`
				Status  string `json:"status"`
				Prompt  string `json:"prompt"`
			} `json:"version"`
			Task IssueResponse `json:"task"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.Version.Version != 2 || resp.Version.Status != "pending" {
			t.Fatalf("expected version=2 pending, got %+v", resp.Version)
		}
		// ✗ 标记回流〔本轮修正〕段。
		if !strings.Contains(resp.Version.Prompt, "〔本轮修正〕") || !strings.Contains(resp.Version.Prompt, "进度条太粗") {
			t.Fatalf("regenerated prompt missing 〔本轮修正〕:\n%s", resp.Version.Prompt)
		}

		var superseded int
		if err := testPool.QueryRow(ctx, `
			SELECT COUNT(*) FROM issue_prototype_version WHERE issue_id = $1 AND version = 1 AND status = 'superseded'
		`, issueID).Scan(&superseded); err != nil {
			t.Fatalf("count superseded: %v", err)
		}
		if superseded != 1 {
			t.Fatalf("expected v1 superseded, got %d rows", superseded)
		}

		// 复用 stage-1 子任务：不得出现第二个 stage=1 子级。
		var stage1Count int
		if err := testPool.QueryRow(ctx, `
			SELECT COUNT(*) FROM issue WHERE parent_issue_id = $1 AND stage = 1
		`, issueID).Scan(&stage1Count); err != nil {
			t.Fatalf("count stage-1 children: %v", err)
		}
		if stage1Count != 1 {
			t.Fatalf("expected exactly 1 stage-1 child, got %d", stage1Count)
		}
	})

	t.Run("prototyper disabled is a 409 and creates nothing", func(t *testing.T) {
		issueID := insertRequirement(t, "目标")
		addRole(t, issueID, "prototyper", "member", testUserID, false)

		w := post(t, issueID, nil)
		if w.Code != http.StatusConflict {
			t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "prototyper") {
			t.Fatalf("expected prototyper message, got %s", w.Body.String())
		}
		var versions, children int
		if err := testPool.QueryRow(ctx, `SELECT COUNT(*) FROM issue_prototype_version WHERE issue_id = $1`, issueID).Scan(&versions); err != nil {
			t.Fatalf("count versions: %v", err)
		}
		if err := testPool.QueryRow(ctx, `SELECT COUNT(*) FROM issue WHERE parent_issue_id = $1`, issueID).Scan(&children); err != nil {
			t.Fatalf("count children: %v", err)
		}
		if versions != 0 || children != 0 {
			t.Fatalf("disabled prototyper must not create anything, versions=%d children=%d", versions, children)
		}
	})

	t.Run("generate after confirm is a 409", func(t *testing.T) {
		issueID := insertRequirement(t, "目标")
		addRole(t, issueID, "prototyper", "member", testUserID, true)

		if w := post(t, issueID, nil); w.Code != http.StatusCreated {
			t.Fatalf("first generate: expected 201, got %d: %s", w.Code, w.Body.String())
		}
		// 模拟已确认（确认门本体由 Task 14 覆盖，这里直接落库状态）。
		if _, err := testPool.Exec(ctx, `
			UPDATE issue_prototype_version SET status = 'confirmed' WHERE issue_id = $1
		`, issueID); err != nil {
			t.Fatalf("force confirm: %v", err)
		}

		w := post(t, issueID, nil)
		if w.Code != http.StatusConflict {
			t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "confirmed") {
			t.Fatalf("expected confirmed message, got %s", w.Body.String())
		}
	})
}
