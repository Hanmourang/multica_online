package handler

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

// 验收裁决闭环（spec §8 / WS4）：pass→需求 done；fail→round+1 建修复子任务；round>3→验收失败终态。
// 每个用例独立 project 隔离 fixture，直接调 handler 并断言 DB 事实。
func newAcceptanceProject(t *testing.T, name string) string {
	t.Helper()
	var id string
	dbfx.QueryRow(t, `INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id`,
		testWorkspaceID, "acc-"+name).Scan(&id)
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE project_id = $1)`, id)
		testPool.Exec(context.Background(), `DELETE FROM issue WHERE project_id = $1`, id)
		testPool.Exec(context.Background(), `DELETE FROM project WHERE id = $1`, id)
	})
	return id
}

// newAcceptanceRequirement 建一个已确认、已触发的顶层需求（stage 子任务由用例按需补）。
func newAcceptanceRequirement(t *testing.T, projectID string) string {
	t.Helper()
	var id string
	dbfx.QueryRow(t, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number, project_id,
		                   decomposition_confirmed_at, triggered_at)
		VALUES ($1, '需求-验收', 'todo', 'medium', 'member', $2,
		        (SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE workspace_id = $1), $3, now(), now())
		RETURNING id`,
		testWorkspaceID, testUserID, projectID).Scan(&id)
	// C-3 契约对齐：server 创建路径回填 root_requirement_id=自身（service/issue.go:371），
	// 裸 SQL INSERT 必须手动设，否则本需求 RootRequirementID 无效——stage3 barrier 关闭的
	// 日历专属自动派发闸门（issue_child_done.go:362）会漏判（同 requirement_trigger_test.go:317）。
	dbfx.Exec(t, `UPDATE issue SET root_requirement_id = id WHERE id = $1`, id)
	// 同步 workspace issue_counter，避免后续 AllocateIssueNumber 分配重复号。
	dbfx.Exec(t, `
		UPDATE workspace SET issue_counter = (
			SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1
		) WHERE id = $1`, testWorkspaceID)
	return id
}

func issueStatus(t *testing.T, issueID string) string {
	t.Helper()
	var status string
	idUUID, err := util.ParseUUID(issueID)
	if err != nil {
		t.Fatalf("parse issue id: %v", err)
	}
	row, err := testHandler.Queries.GetIssue(context.Background(), idUUID)
	if err != nil {
		t.Fatalf("GetIssue: %v", err)
	}
	status = row.Status
	return status
}

func TestAcceptanceVerdictPassMarksRequirementDone(t *testing.T) {
	proj := newAcceptanceProject(t, "pass")
	reqID := newAcceptanceRequirement(t, proj)

	req := newRequest(http.MethodPost, "/api/issues/"+reqID+"/acceptance/verdict",
		map[string]any{"verdict": "pass", "evidence": "全部验收点通过"})
	req = withURLParam(req, "id", reqID)
	testutil.Call(t, testHandler.RecordAcceptanceVerdict, req).Want(http.StatusOK)

	if got := issueStatus(t, reqID); got != "done" {
		t.Errorf("requirement status = %q, want done", got)
	}
}

func TestAcceptanceVerdictRejectsBadVerdict(t *testing.T) {
	proj := newAcceptanceProject(t, "bad")
	reqID := newAcceptanceRequirement(t, proj)

	req := newRequest(http.MethodPost, "/api/issues/"+reqID+"/acceptance/verdict",
		map[string]any{"verdict": "maybe"})
	req = withURLParam(req, "id", reqID)
	testutil.Call(t, testHandler.RecordAcceptanceVerdict, req).Want(http.StatusBadRequest)
}

func TestAcceptanceVerdictFailIncrementsRoundAndCreatesRepairTask(t *testing.T) {
	proj := newAcceptanceProject(t, "fail")
	reqID := newAcceptanceRequirement(t, proj)
	// 需求归属一个有 runtime 的 agent，修复子任务继承该 assignee 才能入队。
	var agentID string
	dbfx.QueryRow(t, `SELECT id FROM agent WHERE workspace_id = $1 AND runtime_id IS NOT NULL
	                  ORDER BY created_at ASC LIMIT 1`, testWorkspaceID).Scan(&agentID)
	dbfx.Exec(t, `UPDATE issue SET assignee_type = 'agent', assignee_id = $1 WHERE id = $2`, agentID, reqID)

	req := newRequest(http.MethodPost, "/api/issues/"+reqID+"/acceptance/verdict",
		map[string]any{"verdict": "fail", "evidence": "登录态在刷新后丢失"})
	req = withURLParam(req, "id", reqID)
	resp := testutil.Call(t, testHandler.RecordAcceptanceVerdict, req).Want(http.StatusOK)
	body := resp.Map()
	if body["acceptance_round"].(float64) != 1 {
		t.Errorf("acceptance_round = %v, want 1", body["acceptance_round"])
	}

	// 事实核验：需求 round=1、多了一个 stage3 修复子任务、该子任务已入队。
	var round int
	dbfx.QueryRow(t, `SELECT acceptance_round FROM issue WHERE id = $1`, reqID).Scan(&round)
	if round != 1 {
		t.Errorf("db acceptance_round = %d, want 1", round)
	}
	var repairCount, queuedCount int
	dbfx.QueryRow(t, `SELECT count(*) FROM issue WHERE parent_issue_id = $1 AND stage = 3`, reqID).Scan(&repairCount)
	if repairCount != 1 {
		t.Errorf("stage3 repair children = %d, want 1", repairCount)
	}
	dbfx.QueryRow(t, `
		SELECT count(*) FROM agent_task_queue q
		JOIN issue c ON c.id = q.issue_id
		WHERE c.parent_issue_id = $1 AND c.stage = 3`, reqID).Scan(&queuedCount)
	if queuedCount != 1 {
		t.Errorf("repair task queue rows = %d, want 1", queuedCount)
	}
}

func TestAcceptanceVerdictFailBeyondLimitIsTerminal(t *testing.T) {
	proj := newAcceptanceProject(t, "beyond")
	reqID := newAcceptanceRequirement(t, proj)
	var agentID string
	dbfx.QueryRow(t, `SELECT id FROM agent WHERE workspace_id = $1 AND runtime_id IS NOT NULL
	                  ORDER BY created_at ASC LIMIT 1`, testWorkspaceID).Scan(&agentID)
	dbfx.Exec(t, `UPDATE issue SET assignee_type = 'agent', assignee_id = $1 WHERE id = $2`, agentID, reqID)
	// 已经打回 3 轮（round=3），本次是第 4 次 → 越界终态。
	dbfx.Exec(t, `UPDATE issue SET acceptance_round = 3 WHERE id = $1`, reqID)

	req := newRequest(http.MethodPost, "/api/issues/"+reqID+"/acceptance/verdict",
		map[string]any{"verdict": "fail", "evidence": "第 4 次仍未过"})
	req = withURLParam(req, "id", reqID)
	resp := testutil.Call(t, testHandler.RecordAcceptanceVerdict, req).Want(http.StatusOK)
	body := resp.Map()
	if body["acceptance_round"].(float64) != 4 {
		t.Errorf("acceptance_round = %v, want 4", body["acceptance_round"])
	}
	if body["terminal"] != true {
		t.Errorf("terminal = %v, want true", body["terminal"])
	}

	// 越界不再建修复子任务；发一条 system 仲裁评论。
	var repairCount, commentCount int
	dbfx.QueryRow(t, `SELECT count(*) FROM issue WHERE parent_issue_id = $1 AND stage = 3`, reqID).Scan(&repairCount)
	if repairCount != 0 {
		t.Errorf("stage3 repair children = %d, want 0 (terminal, no more repair)", repairCount)
	}
	dbfx.QueryRow(t, `SELECT count(*) FROM comment WHERE issue_id = $1 AND author_type = 'system'`, reqID).Scan(&commentCount)
	if commentCount < 1 {
		t.Errorf("system arbitration comments = %d, want >= 1", commentCount)
	}
}

func TestStage3BarrierEnqueuesStage4Tester(t *testing.T) {
	ctx := context.Background()
	proj := newAcceptanceProject(t, "barrier")
	reqID := newAcceptanceRequirement(t, proj)
	var agentID string
	dbfx.QueryRow(t, `SELECT id FROM agent WHERE workspace_id = $1 AND runtime_id IS NOT NULL
	                  ORDER BY created_at ASC LIMIT 1`, testWorkspaceID).Scan(&agentID)
	// 需求 assignee = agent（barrier 关闭后 dispatchParentAssigneeTrigger 唤醒父需求的前提）。
	dbfx.Exec(t, `UPDATE issue SET assignee_type = 'agent', assignee_id = $1 WHERE id = $2`, agentID, reqID)

	// stage3 一个子任务（先 in_progress，后翻 done 触发 barrier）+ stage4 一个 todo tester 子任务。
	// 两者 assignee 同为有 runtime 的 agent，EnqueueTaskForIssue 才能成功入队。
	newStageChildAgent := func(stage int, status string) string {
		var id string
		dbfx.QueryRow(t, `
			INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number, project_id,
			                   parent_issue_id, stage, assignee_type, assignee_id)
			VALUES ($1, $2, $3, 'medium', 'member', $4,
			        (SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE workspace_id = $1), $5, $6, $7, 'agent', $8)
			RETURNING id`,
			testWorkspaceID, fmt.Sprintf("stage%d-%s", stage, status), status, testUserID, proj, reqID, stage, agentID).Scan(&id)
		return id
	}
	stage3 := newStageChildAgent(3, "in_progress")
	stage4 := newStageChildAgent(4, "todo")

	stage3UUID, err := util.ParseUUID(stage3)
	if err != nil {
		t.Fatalf("parse stage3 id: %v", err)
	}
	prev, err := testHandler.Queries.GetIssue(ctx, stage3UUID)
	if err != nil {
		t.Fatalf("load stage3 prev: %v", err)
	}
	dbfx.Exec(t, `UPDATE issue SET status = 'done' WHERE id = $1`, stage3)
	now, err := testHandler.Queries.GetIssue(ctx, stage3UUID)
	if err != nil {
		t.Fatalf("load stage3 done: %v", err)
	}
	// 同包测试可直接调私有方法；内部 ListChildIssues 判 closedStage=3 并入队 stage4。
	testHandler.notifyParentOfChildDone(ctx, prev, now)

	var queued int
	dbfx.QueryRow(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id = $1`, stage4).Scan(&queued)
	if queued != 1 {
		t.Errorf("stage4 tester queue rows = %d, want 1", queued)
	}
}

// TestUpdateAcceptanceCriteriaPersistsCheckedSet 覆盖 plan 20261025 §C-1 勾选回写：
// checked_criteria 作为纯追加键写进 acceptance_spec，不覆盖既有 assertions；子任务拒绝。
func TestUpdateAcceptanceCriteriaPersistsCheckedSet(t *testing.T) {
	proj := newAcceptanceProject(t, "criteria")
	reqID := newAcceptanceRequirement(t, proj)
	dbfx.Exec(t, `UPDATE issue SET acceptance_spec = '{"assertions":["合并后金额一致","优惠不重复计算"]}'::jsonb WHERE id = $1`, reqID)

	req := newRequest(http.MethodPost, "/api/issues/"+reqID+"/acceptance/criteria",
		map[string]any{"checked": []string{"合并后金额一致"}})
	req = withURLParam(req, "id", reqID)
	testutil.Call(t, testHandler.UpdateAcceptanceCriteria, req).Want(http.StatusOK)

	var checkedLen, assertLen int
	dbfx.QueryRow(t, `
		SELECT jsonb_array_length(COALESCE(acceptance_spec->'checked_criteria', '[]'::jsonb)),
		       jsonb_array_length(COALESCE(acceptance_spec->'assertions', '[]'::jsonb))
		FROM issue WHERE id = $1`, reqID).Scan(&checkedLen, &assertLen)
	if checkedLen != 1 {
		t.Errorf("checked_criteria len = %d, want 1", checkedLen)
	}
	// 纯追加键不得动 assertions（单一验收事实源不变式）。
	if assertLen != 2 {
		t.Errorf("assertions 被覆盖: len = %d, want 2", assertLen)
	}

	// 回写全集两条。
	req2 := newRequest(http.MethodPost, "/api/issues/"+reqID+"/acceptance/criteria",
		map[string]any{"checked": []string{"合并后金额一致", "优惠不重复计算"}})
	req2 = withURLParam(req2, "id", reqID)
	testutil.Call(t, testHandler.UpdateAcceptanceCriteria, req2).Want(http.StatusOK)
	dbfx.QueryRow(t,
		`SELECT jsonb_array_length(acceptance_spec->'checked_criteria') FROM issue WHERE id = $1`, reqID,
	).Scan(&checkedLen)
	if checkedLen != 2 {
		t.Errorf("checked_criteria len = %d, want 2", checkedLen)
	}

	// 子任务不承载验收语义 → 409。
	var childID string
	dbfx.QueryRow(t, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number, project_id, parent_issue_id, stage)
		VALUES ($1, '子任务-验收', 'todo', 'medium', 'member', $2,
		        (SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE workspace_id = $1), $3, $4, 3)
		RETURNING id`,
		testWorkspaceID, testUserID, proj, reqID).Scan(&childID)
	req3 := newRequest(http.MethodPost, "/api/issues/"+childID+"/acceptance/criteria",
		map[string]any{"checked": []string{}})
	req3 = withURLParam(req3, "id", childID)
	testutil.Call(t, testHandler.UpdateAcceptanceCriteria, req3).Want(http.StatusConflict)
}
