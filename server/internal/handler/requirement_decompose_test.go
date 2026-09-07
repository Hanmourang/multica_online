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

// TestDecomposeRequirement covers POST /api/issues/{id}/decompose (spec §8/§9):
// confirm/auto modes materialize the stage-2 PM child task from the roster
// snapshot; manual mode returns the draft template schema without creating
// anything. The PM must have an enabled roster row, and decomposition is
// one-shot — a second start is a 409.
func TestDecomposeRequirement(t *testing.T) {
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	insertRequirement := func(t *testing.T, decomposeMode, goal string, repoResourceID *string) string {
		t.Helper()
		// 走 workspace.issue_counter 分配号段，与 IssueService.Create 的
		// AllocateIssueNumber 同源，避免子任务建号撞唯一约束。
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
                                number, position, goal, decompose_mode, repo_resource_id
                        )
                        VALUES (
                                $1, $2, 'todo', 'none', 'member', $3,
                                $4, 100, $5, $6, $7
                        )
                        RETURNING id
                `, testWorkspaceID, "Decompose "+suffix, testUserID, number, goal, decomposeMode, repoResourceID).Scan(&id); err != nil {
			t.Fatalf("insert requirement: %v", err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM issue_role_assignment WHERE issue_id = $1`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1 OR parent_issue_id = $1`, id)
		})
		return id
	}

	insertRosterRow := func(t *testing.T, issueID, role, assigneeType, assigneeID string, enabled bool) {
		t.Helper()
		if _, err := testPool.Exec(ctx, `
                        INSERT INTO issue_role_assignment (issue_id, workspace_id, role, assignee_type, assignee_id, enabled, ordinal)
                        VALUES ($1, $2, $3, $4, $5, $6, 0)
                `, issueID, testWorkspaceID, role, assigneeType, assigneeID, enabled); err != nil {
			t.Fatalf("insert roster row: %v", err)
		}
	}

	setupProjectWithRepo := func(t *testing.T, repoLabel string) (projectID, repoResourceID string) {
		t.Helper()
		if err := testPool.QueryRow(ctx, `
                        INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id
                `, testWorkspaceID, "Decompose project "+suffix).Scan(&projectID); err != nil {
			t.Fatalf("insert project: %v", err)
		}
		t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM project WHERE id = $1`, projectID) })
		if err := testPool.QueryRow(ctx, `
                        INSERT INTO project_resource (project_id, workspace_id, resource_type, resource_ref, label)
                        VALUES ($1, $2, 'repo', '{}'::jsonb, $3)
                        RETURNING id
                `, projectID, testWorkspaceID, repoLabel).Scan(&repoResourceID); err != nil {
			t.Fatalf("insert repo resource: %v", err)
		}
		return projectID, repoResourceID
	}

	t.Run("confirm mode creates the stage-2 PM task with goal and repo in the brief", func(t *testing.T) {
		_, repoID := setupProjectWithRepo(t, "multica/app")
		issueID := insertRequirement(t, "confirm", "把积分规则引擎化", &repoID)
		insertRosterRow(t, issueID, "pm", "member", testUserID, true)
		insertRosterRow(t, issueID, "developer", "member", testUserID, true)

		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
		req = withURLParam(req, "id", issueID)
		testHandler.DecomposeRequirement(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("DecomposeRequirement: expected 201, got %d: %s", w.Code, w.Body.String())
		}
		var resp IssueResponse
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}

		var stage int32
		var parentID, assigneeID, description string
		if err := testPool.QueryRow(ctx, `
                        SELECT stage, parent_issue_id::text, assignee_id::text, COALESCE(description, '')
                        FROM issue WHERE id = $1
                `, resp.ID).Scan(&stage, &parentID, &assigneeID, &description); err != nil {
			t.Fatalf("read created child: %v", err)
		}
		if stage != 2 {
			t.Fatalf("expected stage=2, got %d", stage)
		}
		if parentID != issueID {
			t.Fatalf("expected parent %s, got %s", issueID, parentID)
		}
		if assigneeID != testUserID {
			t.Fatalf("expected pm assignee %s, got %s", testUserID, assigneeID)
		}
		if !strings.Contains(description, "把积分规则引擎化") {
			t.Fatalf("expected goal in the brief, got: %s", description)
		}
		if !strings.Contains(description, "multica/app") {
			t.Fatalf("expected repo label in the brief, got: %s", description)
		}
		if !strings.Contains(description, "禁止开工") {
			t.Fatalf("expected PM no-implementation contract in the brief, got: %s", description)
		}
		if !strings.Contains(description, issueID) {
			t.Fatalf("expected parent issue id in the brief so the PM comments on the requirement, got: %s", description)
		}
		if !strings.Contains(description, "## 目标分解") {
			t.Fatalf("expected structured plan headings in the brief, got: %s", description)
		}
	})

	t.Run("no enabled pm in the roster is a 409", func(t *testing.T) {
		issueID := insertRequirement(t, "confirm", "目标", nil)
		insertRosterRow(t, issueID, "pm", "member", testUserID, false)

		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
		req = withURLParam(req, "id", issueID)
		testHandler.DecomposeRequirement(w, req)
		if w.Code != http.StatusConflict {
			t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "pm role") {
			t.Fatalf("expected pm role message, got %s", w.Body.String())
		}
	})

	t.Run("a second start is rejected once a stage-2 task exists", func(t *testing.T) {
		issueID := insertRequirement(t, "confirm", "目标", nil)
		insertRosterRow(t, issueID, "pm", "member", testUserID, true)

		first := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
		req = withURLParam(req, "id", issueID)
		testHandler.DecomposeRequirement(first, req)
		if first.Code != http.StatusCreated {
			t.Fatalf("first decompose: expected 201, got %d: %s", first.Code, first.Body.String())
		}

		second := httptest.NewRecorder()
		req2 := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
		req2 = withURLParam(req2, "id", issueID)
		testHandler.DecomposeRequirement(second, req2)
		if second.Code != http.StatusConflict {
			t.Fatalf("second decompose: expected 409, got %d: %s", second.Code, second.Body.String())
		}
	})

	t.Run("manual mode returns the draft template schema and creates nothing", func(t *testing.T) {
		issueID := insertRequirement(t, "manual", "目标", nil)
		insertRosterRow(t, issueID, "pm", "member", testUserID, true)

		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
		req = withURLParam(req, "id", issueID)
		testHandler.DecomposeRequirement(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "feature_points") ||
			!strings.Contains(w.Body.String(), "acceptance_spec") {
			t.Fatalf("expected template schema keys, got %s", w.Body.String())
		}

		var childCount int
		if err := testPool.QueryRow(ctx,
			`SELECT COUNT(*) FROM issue WHERE parent_issue_id = $1`, issueID,
		).Scan(&childCount); err != nil {
			t.Fatalf("count children: %v", err)
		}
		if childCount != 0 {
			t.Fatalf("manual mode must not create children, found %d", childCount)
		}
	})

	t.Run("auto mode with an agent pm also enqueues the run", func(t *testing.T) {
		var agentID string
		if err := testPool.QueryRow(ctx, `
                        INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config,
                                runtime_id, visibility, permission_mode, max_concurrent_tasks, owner_id,
                                instructions, custom_env, custom_args)
                        VALUES ($1, $2, '', 'cloud', '{}'::jsonb, $3, 'private', 'public_to', 1, $4,
                                '', '{}'::jsonb, '[]'::jsonb)
                        RETURNING id
                `, testWorkspaceID, "decompose-pm-"+suffix, handlerTestRuntimeID(t), testUserID).Scan(&agentID); err != nil {
			t.Fatalf("insert agent: %v", err)
		}
		t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID) })

		issueID := insertRequirement(t, "auto", "自动拆解目标", nil)
		insertRosterRow(t, issueID, "pm", "agent", agentID, true)

		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
		req = withURLParam(req, "id", issueID)
		testHandler.DecomposeRequirement(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}
		var resp IssueResponse
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}

		var queued int
		if err := testPool.QueryRow(ctx,
			`SELECT COUNT(*) FROM agent_task_queue WHERE issue_id = $1 AND agent_id = $2`,
			resp.ID, agentID,
		).Scan(&queued); err != nil {
			t.Fatalf("count queued tasks: %v", err)
		}
		if queued != 1 {
			t.Fatalf("expected 1 queued agent task, got %d", queued)
		}
	})
}

// 拆解确认 API（POST /api/issues/{id}/decomposition/confirm）：解析草稿 →
// service.ConfirmDecomposition → 错误码映射（400/409）→ 生效结果列表。
func TestConfirmDecompositionHandler(t *testing.T) {
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	insertRequirement := func(t *testing.T) string {
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
                                number, position, decompose_mode)
                        VALUES ($1, $2, 'todo', 'none', 'member', $3, $4, 100, 'confirm')
                        RETURNING id
                `, testWorkspaceID, "Confirm "+suffix, testUserID, number).Scan(&id); err != nil {
			t.Fatalf("insert requirement: %v", err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM issue_dependency WHERE issue_id IN
                                (SELECT id FROM issue WHERE parent_issue_id = $1)`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue_role_assignment WHERE issue_id = $1`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1 OR parent_issue_id = $1`, id)
		})
		return id
	}
	addRole := func(t *testing.T, issueID, role, userID string, enabled bool) {
		t.Helper()
		if _, err := testPool.Exec(ctx, `
                        INSERT INTO issue_role_assignment (issue_id, workspace_id, role, assignee_type, assignee_id, enabled, ordinal)
                        VALUES ($1, $2, $3, 'member', $4, $5, 0)
                `, issueID, testWorkspaceID, role, userID, enabled); err != nil {
			t.Fatalf("seed roster %s: %v", role, err)
		}
	}
	post := func(t *testing.T, issueID string, body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues/"+issueID+"/decomposition/confirm", body)
		req = withURLParam(req, "id", issueID)
		testHandler.ConfirmDecomposition(w, req)
		return w
	}
	execDraft := func(tempID, title, assigneeID string) map[string]any {
		return map[string]any{
			"temp_id": tempID, "title": title, "stage": 3,
			"assignee_type": "member", "assignee_id": assigneeID,
			"feature_points": []map[string]any{
				{"title": title + " fp", "kind": "new", "code_objects": []string{"x.go"}},
			},
			"acceptance_spec": map[string]any{"version": 1, "cases": []any{map[string]any{"name": "c1"}}},
		}
	}

	t.Run("happy path materializes exec + acceptance children", func(t *testing.T) {
		issueID := insertRequirement(t)
		addRole(t, issueID, "pm", testUserID, true)
		addRole(t, issueID, "developer", testUserID, true)
		addRole(t, issueID, "tester", testUserID, true)

		w := post(t, issueID, map[string]any{"drafts": []map[string]any{
			execDraft("t1", "账户模型扩展", testUserID),
			{"temp_id": "t2", "title": "整体验收", "stage": 4, "depends_on": []string{"t1"}},
		}})
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Issues []IssueResponse `json:"issues"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(resp.Issues) != 2 {
			t.Fatalf("expected 2 materialized issues, got %d", len(resp.Issues))
		}
	})

	t.Run("feature point without kind is a 400", func(t *testing.T) {
		issueID := insertRequirement(t)
		addRole(t, issueID, "pm", testUserID, true)
		addRole(t, issueID, "developer", testUserID, true)

		bad := execDraft("t1", "账户模型扩展", testUserID)
		bad["feature_points"] = []map[string]any{{"title": "缺 kind"}}
		w := post(t, issueID, map[string]any{"drafts": []map[string]any{bad}})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "feature_point kind required") {
			t.Fatalf("unexpected body: %s", w.Body.String())
		}
	})

	t.Run("second confirm is a 409", func(t *testing.T) {
		issueID := insertRequirement(t)
		addRole(t, issueID, "pm", testUserID, true)
		addRole(t, issueID, "developer", testUserID, true)

		body := map[string]any{"drafts": []map[string]any{execDraft("t1", "账户模型扩展", testUserID)}}
		if w := post(t, issueID, body); w.Code != http.StatusOK {
			t.Fatalf("first confirm: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		if w := post(t, issueID, body); w.Code != http.StatusConflict {
			t.Fatalf("second confirm: expected 409, got %d: %s", w.Code, w.Body.String())
		}
	})
}

// TestSplitDecompositionComment 覆盖 plan 评论的机读块拆析：无围栏/坏 JSON/
// 非数组都不算产出；围栏后的尾部说明并入 plan。
func TestSplitDecompositionComment(t *testing.T) {
	t.Run("no fence is not a decomposition comment", func(t *testing.T) {
		if _, _, ok := splitDecompositionComment("普通 plan 正文"); ok {
			t.Fatal("expected ok=false without the fence")
		}
	})

	t.Run("plan plus drafts block splits cleanly", func(t *testing.T) {
		content := "## 目标\n拆解为两个执行任务\n\n```decomposition-drafts\n" +
			`[{"temp_id":"t1","title":"账户模型","stage":3},{"temp_id":"t2","title":"验收","stage":4,"depends_on":["t1"]}]` +
			"\n```"
		plan, drafts, ok := splitDecompositionComment(content)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if plan != "## 目标\n拆解为两个执行任务" {
			t.Fatalf("plan = %q", plan)
		}
		var arr []map[string]any
		if err := json.Unmarshal(drafts, &arr); err != nil {
			t.Fatalf("drafts not valid JSON: %v", err)
		}
		if len(arr) != 2 || arr[0]["temp_id"] != "t1" {
			t.Fatalf("drafts = %s", drafts)
		}
	})

	t.Run("trailing text after the fence folds back into plan", func(t *testing.T) {
		content := "plan 正文\n```decomposition-drafts\n[]\n```\n\n备注：验收依赖 t1"
		plan, _, ok := splitDecompositionComment(content)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if plan != "plan 正文\n\n备注：验收依赖 t1" {
			t.Fatalf("plan = %q", plan)
		}
	})

	t.Run("broken json is not a valid block", func(t *testing.T) {
		if _, _, ok := splitDecompositionComment("p\n```decomposition-drafts\n[{oops]\n```"); ok {
			t.Fatal("expected ok=false for broken JSON")
		}
	})

	t.Run("non-array json is not a valid block", func(t *testing.T) {
		if _, _, ok := splitDecompositionComment("p\n```decomposition-drafts\n{\"a\":1}\n```"); ok {
			t.Fatal("expected ok=false for object payload")
		}
		if _, _, ok := splitDecompositionComment("p\n```decomposition-drafts\nnull\n```"); ok {
			t.Fatal("expected ok=false for null payload")
		}
	})

	t.Run("language suffix on the fence is accepted", func(t *testing.T) {
		content := "## 目标分解\n拆两步\n\n```decomposition-drafts json\n" +
			`[{"temp_id":"t1","title":"账户模型","stage":3}]` + "\n```"
		plan, drafts, ok := splitDecompositionComment(content)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if !strings.Contains(plan, "目标分解") {
			t.Fatalf("plan = %q", plan)
		}
		if !hasDraftItems(drafts) {
			t.Fatalf("drafts = %s", drafts)
		}
	})
}

func TestParseDecompositionPayload(t *testing.T) {
	t.Run("recovers drafts from a generic json fence", func(t *testing.T) {
		content := "## 阶段\n先拆后做\n\n```json\n" +
			`[{"temp_id":"t1","title":"梳理模型","stage":3}]` + "\n```"
		plan, drafts, ok := parseDecompositionPayload(content)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if !strings.Contains(plan, "阶段") {
			t.Fatalf("plan = %q", plan)
		}
		if !hasDraftItems(drafts) {
			t.Fatalf("drafts = %s", drafts)
		}
	})

	t.Run("recovers an embedded drafts array", func(t *testing.T) {
		content := "如下草稿：\n" + `[{"temp_id":"t9","title":"验收","stage":4}]` + "\n请确认"
		plan, drafts, ok := parseDecompositionPayload(content)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if !strings.Contains(plan, "如下草稿") || !strings.Contains(plan, "请确认") {
			t.Fatalf("plan = %q", plan)
		}
		if !hasDraftItems(drafts) {
			t.Fatalf("drafts = %s", drafts)
		}
	})

	t.Run("plan headings without a fence still count as output", func(t *testing.T) {
		content := "## 目标分解\n完成数据模型梳理并输出文档\n\n## 阶段\n分析 → 文档\n\n## 风险\n档案未就绪"
		plan, drafts, ok := parseDecompositionPayload(content)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if plan != content {
			t.Fatalf("plan = %q", plan)
		}
		if hasDraftItems(drafts) {
			t.Fatalf("drafts should be empty, got %s", drafts)
		}
	})
}

// TestGetDecomposition covers GET /api/issues/{id}/decomposition (spec §9)：
// PM 产出的载体是需求评论（plan 正文 + ```decomposition-drafts 机读块），
// 端点取最新一条带有效块的评论拆出 plan 与草稿；无产出时 plan=null、drafts=[]。
func TestGetDecomposition(t *testing.T) {
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	insertRequirement := func(t *testing.T) string {
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
                        INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number, position)
                        VALUES ($1, $2, 'todo', 'none', 'member', $3, $4, 100)
                        RETURNING id
                `, testWorkspaceID, "DecompGET "+suffix, testUserID, number).Scan(&id); err != nil {
			t.Fatalf("insert requirement: %v", err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `
                                DELETE FROM comment
                                WHERE issue_id = $1
                                   OR issue_id IN (SELECT id FROM issue WHERE parent_issue_id = $1)`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE parent_issue_id = $1`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, id)
		})
		return id
	}
	insertComment := func(t *testing.T, issueID, content string, createdAt time.Time) string {
		t.Helper()
		var id string
		if err := testPool.QueryRow(ctx, `
                        INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content, created_at, updated_at)
                        VALUES ($1, $2, 'member', $3, $4, $5, $5)
                        RETURNING id
                `, issueID, testWorkspaceID, testUserID, content, createdAt).Scan(&id); err != nil {
			t.Fatalf("insert comment: %v", err)
		}
		return id
	}
	get := func(t *testing.T, issueID string) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("GET", "/api/issues/"+issueID+"/decomposition", nil)
		req = withURLParam(req, "id", issueID)
		testHandler.GetDecomposition(w, req)
		return w
	}

	t.Run("no decomposition comment yields empty payload", func(t *testing.T) {
		issueID := insertRequirement(t)
		insertComment(t, issueID, "普通讨论评论", time.Now())

		w := get(t, issueID)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Plan   *string          `json:"plan"`
			Drafts []map[string]any `json:"drafts"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.Plan != nil {
			t.Fatalf("plan = %v, want null", *resp.Plan)
		}
		if resp.Drafts == nil || len(resp.Drafts) != 0 {
			t.Fatalf("drafts = %v, want []", resp.Drafts)
		}
	})

	t.Run("plan and drafts split from the latest fenced comment", func(t *testing.T) {
		issueID := insertRequirement(t)
		older := time.Now().Add(-time.Hour)
		newer := time.Now()
		insertComment(t, issueID, "旧 plan\n```decomposition-drafts\n"+`[{"temp_id":"old","title":"旧稿","stage":3}]`+"\n```", older)
		latestID := insertComment(t, issueID, "新 plan 正文\n\n```decomposition-drafts\n"+
			`[{"temp_id":"t1","title":"账户模型","stage":3,"assignee_role":"developer","feature_points":[{"title":"积分账户","kind":"new"}]},{"temp_id":"t2","title":"验收","stage":4,"depends_on":["t1"]}]`+
			"\n```", newer)

		w := get(t, issueID)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Plan            *string          `json:"plan"`
			Drafts          []map[string]any `json:"drafts"`
			SourceCommentID *string          `json:"source_comment_id"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.Plan == nil || *resp.Plan != "新 plan 正文" {
			t.Fatalf("plan = %v", resp.Plan)
		}
		if len(resp.Drafts) != 2 || resp.Drafts[0]["temp_id"] != "t1" {
			t.Fatalf("drafts = %v", resp.Drafts)
		}
		// 草稿字段原样透传（assignee_role 等非确认门字段不丢失）。
		if resp.Drafts[0]["assignee_role"] != "developer" {
			t.Fatalf("draft[0] lost assignee_role: %v", resp.Drafts[0])
		}
		if resp.SourceCommentID == nil || *resp.SourceCommentID != latestID {
			t.Fatalf("source_comment_id = %v, want %s", resp.SourceCommentID, latestID)
		}
	})

	t.Run("broken latest block falls back to an older valid one", func(t *testing.T) {
		issueID := insertRequirement(t)
		insertComment(t, issueID, "有效 plan\n```decomposition-drafts\n"+`[{"temp_id":"ok","title":"稿","stage":3}]`+"\n```", time.Now().Add(-time.Hour))
		insertComment(t, issueID, "半截输出\n```decomposition-drafts\n[{被截断", time.Now())

		w := get(t, issueID)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Drafts []map[string]any `json:"drafts"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(resp.Drafts) != 1 || resp.Drafts[0]["temp_id"] != "ok" {
			t.Fatalf("drafts = %v, want fallback to the older valid block", resp.Drafts)
		}
	})

	t.Run("reads a valid block posted on the stage-2 PM child", func(t *testing.T) {
		issueID := insertRequirement(t)
		var childNumber int
		if err := testPool.QueryRow(ctx, `
                        UPDATE workspace
                        SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1)) + 1
                        WHERE id = $1 RETURNING issue_counter
                `, testWorkspaceID).Scan(&childNumber); err != nil {
			t.Fatalf("next child number: %v", err)
		}
		var childID string
		if err := testPool.QueryRow(ctx, `
                        INSERT INTO issue (
                                workspace_id, title, status, priority, creator_type, creator_id,
                                number, position, parent_issue_id, stage
                        )
                        VALUES (
                                $1, $2, 'todo', 'none', 'member', $3,
                                $4, 200, $5, 2
                        )
                        RETURNING id
                `, testWorkspaceID, "PM plan + 拆解 "+suffix, testUserID, childNumber, issueID).Scan(&childID); err != nil {
			t.Fatalf("insert stage-2 child: %v", err)
		}
		latestID := insertComment(t, childID, "子任务上的 plan\n```decomposition-drafts\n"+
			`[{"temp_id":"child","title":"从子任务回收","stage":3}]`+"\n```", time.Now())

		w := get(t, issueID)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Plan            *string          `json:"plan"`
			Drafts          []map[string]any `json:"drafts"`
			SourceCommentID *string          `json:"source_comment_id"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.Plan == nil || *resp.Plan != "子任务上的 plan" {
			t.Fatalf("plan = %v", resp.Plan)
		}
		if len(resp.Drafts) != 1 || resp.Drafts[0]["temp_id"] != "child" {
			t.Fatalf("drafts = %v", resp.Drafts)
		}
		if resp.SourceCommentID == nil || *resp.SourceCommentID != latestID {
			t.Fatalf("source_comment_id = %v, want %s", resp.SourceCommentID, latestID)
		}
	})

	t.Run("reads a plan-only markdown comment on the PM child", func(t *testing.T) {
		issueID := insertRequirement(t)
		var childNumber int
		if err := testPool.QueryRow(ctx, `
                        UPDATE workspace
                        SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1)) + 1
                        WHERE id = $1 RETURNING issue_counter
                `, testWorkspaceID).Scan(&childNumber); err != nil {
			t.Fatalf("next child number: %v", err)
		}
		var childID string
		if err := testPool.QueryRow(ctx, `
                        INSERT INTO issue (
                                workspace_id, title, status, priority, creator_type, creator_id,
                                number, position, parent_issue_id, stage
                        )
                        VALUES (
                                $1, $2, 'in_review', 'none', 'member', $3,
                                $4, 200, $5, 2
                        )
                        RETURNING id
                `, testWorkspaceID, "PM plan "+suffix, testUserID, childNumber, issueID).Scan(&childID); err != nil {
			t.Fatalf("insert stage-2 child: %v", err)
		}
		insertComment(t, childID, "## 目标分解\n完成数据模型梳理并输出文档\n\n## 阶段\n分析\n\n## 风险\n无", time.Now())

		w := get(t, issueID)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Plan   *string          `json:"plan"`
			Drafts []map[string]any `json:"drafts"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.Plan == nil || !strings.Contains(*resp.Plan, "目标分解") {
			t.Fatalf("plan = %v", resp.Plan)
		}
		if resp.Drafts == nil {
			t.Fatal("drafts should be []")
		}
	})

	t.Run("reads drafts from the PM child description", func(t *testing.T) {
		issueID := insertRequirement(t)
		var childNumber int
		if err := testPool.QueryRow(ctx, `
                        UPDATE workspace
                        SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1)) + 1
                        WHERE id = $1 RETURNING issue_counter
                `, testWorkspaceID).Scan(&childNumber); err != nil {
			t.Fatalf("next child number: %v", err)
		}
		var childID string
		if err := testPool.QueryRow(ctx, `
                        INSERT INTO issue (
                                workspace_id, title, status, priority, creator_type, creator_id,
                                number, position, parent_issue_id, stage, description
                        )
                        VALUES (
                                $1, $2, 'in_review', 'none', 'member', $3,
                                $4, 200, $5, 2, $6
                        )
                        RETURNING id
                `, testWorkspaceID, "PM plan desc "+suffix, testUserID, childNumber, issueID,
			"## 阶段\n分析\n\n```json\n"+`[{"temp_id":"d1","title":"从描述回收","stage":3}]`+"\n```").Scan(&childID); err != nil {
			t.Fatalf("insert stage-2 child: %v", err)
		}

		w := get(t, issueID)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Plan   *string          `json:"plan"`
			Drafts []map[string]any `json:"drafts"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(resp.Drafts) != 1 || resp.Drafts[0]["temp_id"] != "d1" {
			t.Fatalf("drafts = %v", resp.Drafts)
		}
	})
}
