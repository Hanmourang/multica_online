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

// 原型标记 + 确认门（spec §5.3/§9 + 画面 4 标注 9）：
// POST /api/issues/{id}/prototypes/{version}/marks 与 .../confirm。
//
//   - marks 仅可写 pending 版本；verdict 非法 → 400
//   - 确认门：当前 pending 版本存在任一 verdict='no' 标记 → 409（✗ 必须随
//     新版本消解，note 备注不能替代重生成）；全 ok/pending → 200
//   - 确认后版本 status=confirmed，stage=1 子任务置 done，并触发既有
//     notifyParentOfChildDone stage barrier 唤醒父任务执行人（stage 2 PM）
func TestPrototypeMarksAndConfirmGate(t *testing.T) {
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	insertRequirement := func(t *testing.T, assigneeType, assigneeID string) string {
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
				number, position, goal, decompose_mode, assignee_type, assignee_id)
			VALUES ($1, $2, 'todo', 'none', 'member', $3, $4, 100, '目标', 'confirm', nullif($5, ''), nullif($6, '')::uuid)
			RETURNING id
		`, testWorkspaceID, "Confirm proto "+suffix, testUserID, number, assigneeType, assigneeID).Scan(&id); err != nil {
			t.Fatalf("insert requirement: %v", err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM comment WHERE issue_id = $1`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue_prototype_version WHERE issue_id = $1`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue_role_assignment WHERE issue_id = $1`, id)
			testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE parent_issue_id = $1 OR id = $1)`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1 OR parent_issue_id = $1`, id)
		})
		return id
	}
	addPrototyper := func(t *testing.T, issueID string) {
		t.Helper()
		if _, err := testPool.Exec(ctx, `
			INSERT INTO issue_role_assignment (issue_id, workspace_id, role, assignee_type, assignee_id, enabled, ordinal)
			VALUES ($1, $2, 'prototyper', 'member', $3, TRUE, 0)
		`, issueID, testWorkspaceID, testUserID); err != nil {
			t.Fatalf("seed prototyper: %v", err)
		}
	}
	generate := func(t *testing.T, issueID string, body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+issueID+"/prototype/generate", body)
		req = withURLParam(req, "id", issueID)
		testHandler.GeneratePrototype(w, req)
		return w
	}
	postMarks := func(t *testing.T, issueID string, version int, body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+issueID+"/prototypes/"+fmt.Sprint(version)+"/marks", body)
		req = withURLParams(req, "id", issueID, "version", fmt.Sprint(version))
		testHandler.UpdatePrototypeMarks(w, req)
		return w
	}
	confirm := func(t *testing.T, issueID string, version int) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+issueID+"/prototypes/"+fmt.Sprint(version)+"/confirm", nil)
		req = withURLParams(req, "id", issueID, "version", fmt.Sprint(version))
		testHandler.ConfirmPrototype(w, req)
		return w
	}
	marksBody := func(marks ...map[string]any) map[string]any {
		return map[string]any{"marks": marks}
	}

	t.Run("marks write persists and rejects invalid verdict", func(t *testing.T) {
		issueID := insertRequirement(t, "", "")
		addPrototyper(t, issueID)
		if w := generate(t, issueID, nil); w.Code != http.StatusCreated {
			t.Fatalf("generate: %d: %s", w.Code, w.Body.String())
		}

		w := postMarks(t, issueID, 1, marksBody(
			map[string]any{"detail_id": "d1", "verdict": "ok"},
			map[string]any{"detail_id": "d2", "verdict": "pending"},
		))
		if w.Code != http.StatusOK {
			t.Fatalf("marks: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var persisted string
		if err := testPool.QueryRow(ctx, `
			SELECT marks::text FROM issue_prototype_version WHERE issue_id = $1 AND version = 1
		`, issueID).Scan(&persisted); err != nil {
			t.Fatalf("read marks: %v", err)
		}
		if !strings.Contains(persisted, `"detail_id":"d1"`) && !strings.Contains(persisted, `"detail_id": "d1"`) {
			t.Fatalf("marks not persisted: %s", persisted)
		}

		bad := postMarks(t, issueID, 1, marksBody(map[string]any{"detail_id": "d1", "verdict": "maybe"}))
		if bad.Code != http.StatusBadRequest {
			t.Fatalf("invalid verdict: expected 400, got %d: %s", bad.Code, bad.Body.String())
		}
	})

	t.Run("confirm is blocked by a no-mark even when the note explains it", func(t *testing.T) {
		issueID := insertRequirement(t, "", "")
		addPrototyper(t, issueID)
		if w := generate(t, issueID, nil); w.Code != http.StatusCreated {
			t.Fatalf("generate: %d: %s", w.Code, w.Body.String())
		}
		// ✗ 项必须随新版本消解；note 写「已重生成覆盖」也不能替代重生成。
		if w := postMarks(t, issueID, 1, marksBody(
			map[string]any{"detail_id": "d3", "verdict": "no", "note": "已重生成v2覆盖"},
		)); w.Code != http.StatusOK {
			t.Fatalf("marks: %d: %s", w.Code, w.Body.String())
		}
		w := confirm(t, issueID, 1)
		if w.Code != http.StatusConflict {
			t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "no") {
			t.Fatalf("expected unresolved no-mark message, got %s", w.Body.String())
		}
	})

	t.Run("confirm on a superseded version is a 409", func(t *testing.T) {
		issueID := insertRequirement(t, "", "")
		addPrototyper(t, issueID)
		if w := generate(t, issueID, nil); w.Code != http.StatusCreated {
			t.Fatalf("generate v1: %d: %s", w.Code, w.Body.String())
		}
		if w := generate(t, issueID, nil); w.Code != http.StatusCreated {
			t.Fatalf("generate v2: %d: %s", w.Code, w.Body.String())
		}
		if w := confirm(t, issueID, 1); w.Code != http.StatusConflict {
			t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("regenerate resets the gate: v2 with ok marks confirms, closes stage-1 and wakes the parent", func(t *testing.T) {
		agentID := createHandlerTestAgent(t, "proto-gate-"+suffix, nil)
		issueID := insertRequirement(t, "agent", agentID)
		addPrototyper(t, issueID)

		if w := generate(t, issueID, nil); w.Code != http.StatusCreated {
			t.Fatalf("generate v1: %d: %s", w.Code, w.Body.String())
		}
		// v1 标 ✗（带修正诉求）→ 携 marks 重生成 v2（prompt 回流〔本轮修正〕）。
		noMarks := []map[string]any{{"detail_id": "d3", "verdict": "no", "note": "进度条太粗"}}
		if w := postMarks(t, issueID, 1, marksBody(noMarks...)); w.Code != http.StatusOK {
			t.Fatalf("marks v1: %d: %s", w.Code, w.Body.String())
		}
		if w := generate(t, issueID, map[string]any{"marks": noMarks}); w.Code != http.StatusCreated {
			t.Fatalf("generate v2: %d: %s", w.Code, w.Body.String())
		}
		// v2 全 ok/pending → 确认放行。
		if w := postMarks(t, issueID, 2, marksBody(
			map[string]any{"detail_id": "d1", "verdict": "ok"},
			map[string]any{"detail_id": "d2", "verdict": "pending"},
		)); w.Code != http.StatusOK {
			t.Fatalf("marks v2: %d: %s", w.Code, w.Body.String())
		}
		w := confirm(t, issueID, 2)
		if w.Code != http.StatusOK {
			t.Fatalf("confirm: expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var status string
		if err := testPool.QueryRow(ctx, `
			SELECT status FROM issue_prototype_version WHERE issue_id = $1 AND version = 2
		`, issueID).Scan(&status); err != nil {
			t.Fatalf("read version: %v", err)
		}
		if status != "confirmed" {
			t.Fatalf("expected confirmed, got %s", status)
		}

		// stage-1 子任务置 done。
		var childStatus string
		if err := testPool.QueryRow(ctx, `
			SELECT status FROM issue WHERE parent_issue_id = $1 AND stage = 1
		`, issueID).Scan(&childStatus); err != nil {
			t.Fatalf("read stage-1 child: %v", err)
		}
		if childStatus != "done" {
			t.Fatalf("expected stage-1 child done, got %s", childStatus)
		}

		// barrier 唤醒：父任务（agent 执行人）收到 stage-1 关闭的系统评论。
		var comments int
		if err := testPool.QueryRow(ctx, `
			SELECT COUNT(*) FROM comment
			WHERE issue_id = $1 AND author_type = 'system' AND content LIKE '%Stage 1%'
		`, issueID).Scan(&comments); err != nil {
			t.Fatalf("count barrier comments: %v", err)
		}
		if comments != 1 {
			t.Fatalf("expected 1 stage-barrier comment on the parent, got %d", comments)
		}
	})

	t.Run("marks on a confirmed version are rejected", func(t *testing.T) {
		issueID := insertRequirement(t, "", "")
		addPrototyper(t, issueID)
		if w := generate(t, issueID, nil); w.Code != http.StatusCreated {
			t.Fatalf("generate: %d: %s", w.Code, w.Body.String())
		}
		if w := confirm(t, issueID, 1); w.Code != http.StatusOK {
			t.Fatalf("confirm: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		w := postMarks(t, issueID, 1, marksBody(map[string]any{"detail_id": "d9", "verdict": "ok"}))
		if w.Code != http.StatusConflict {
			t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
		}
	})
}
