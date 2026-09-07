package handler

import (
	"context"
	"fmt"
	"testing"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 需求派生状态投影（spec: 2026-09-04-requirement-calendar-design.md §6 的 9 条规则）。
// ListIssues 投影 requirement_status / stage_progress / start_at；不落列，永远与事实一致。
// 每个 case 用独立 project 隔离 fixture，直接插行构造 stage 子任务与队列等待态。
func TestRequirementStatusProjection(t *testing.T) {
	ctx := context.Background()

	wsUUID, err := util.ParseUUID(testWorkspaceID)
	if err != nil {
		t.Fatalf("parse workspace id: %v", err)
	}

	// 每个 case 一个独立 project，ListIssues 按 project_id 过滤，互不干扰。
	newProject := func(t *testing.T, name string) string {
		t.Helper()
		var id string
		dbfx.QueryRow(t, `INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id`,
			testWorkspaceID, "req-projection-"+name).Scan(&id)
		t.Cleanup(func() {
			testPool.Exec(context.Background(),
				`DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE project_id = $1)`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE project_id = $1`, id)
			testPool.Exec(context.Background(), `DELETE FROM project WHERE id = $1`, id)
		})
		return id
	}

	// 顶层需求：parent NULL；confirmed/triggered 控制 decomposition_confirmed_at/triggered_at。
	newRequirement := func(t *testing.T, projectID, status string, confirmed, triggered bool) string {
		t.Helper()
		var id string
		dbfx.QueryRow(t, `
			INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number, project_id,
			                   start_at, decomposition_confirmed_at, triggered_at)
			VALUES ($1, $2, $3, 'medium', 'member', $4,
			        (SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE workspace_id = $1), $5,
			        now(), CASE WHEN $6 THEN now() END, CASE WHEN $7 THEN now() END)
			RETURNING id`,
			testWorkspaceID, "需求-"+status, status, testUserID, projectID, confirmed, triggered).Scan(&id)
		return id
	}

	newStageChild := func(t *testing.T, projectID, parentID string, stage int, status string) string {
		t.Helper()
		var id string
		dbfx.QueryRow(t, `
			INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number, project_id,
			                   parent_issue_id, stage)
			VALUES ($1, $2, $3, 'medium', 'member', $4,
			        (SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE workspace_id = $1), $5, $6, $7)
			RETURNING id`,
			testWorkspaceID, fmt.Sprintf("stage%d-%s", stage, status), status, testUserID, projectID, parentID, stage).Scan(&id)
		return id
	}

	markWaitingModuleLock := func(t *testing.T, issueID string) {
		t.Helper()
		var agentID string
		dbfx.QueryRow(t, `SELECT id FROM agent WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1`,
			testWorkspaceID).Scan(&agentID)
		dbfx.Exec(t, `
			INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority)
			VALUES ($1, $2, $3, 'waiting_module_lock', 5)`,
			agentID, testRuntimeID, issueID)
	}

	markRunning := func(t *testing.T, issueID string) {
		t.Helper()
		var agentID string
		dbfx.QueryRow(t, `SELECT id FROM agent WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1`,
			testWorkspaceID).Scan(&agentID)
		dbfx.Exec(t, `
			INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority)
			VALUES ($1, $2, $3, 'running', 5)`,
			agentID, testRuntimeID, issueID)
	}

	projectStatus := func(t *testing.T, projectID string) db.ListIssuesRow {
		t.Helper()
		projUUID, err := util.ParseUUID(projectID)
		if err != nil {
			t.Fatalf("parse project id: %v", err)
		}
		rows, err := testHandler.Queries.ListIssues(ctx, db.ListIssuesParams{
			WorkspaceID: wsUUID,
			ProjectID:   projUUID,
			Limit:       50,
			Offset:      0,
		})
		if err != nil {
			t.Fatalf("ListIssues: %v", err)
		}
		for _, row := range rows {
			if !row.ParentIssueID.Valid {
				return row
			}
		}
		t.Fatalf("requirement row not found in project %s", projectID)
		return db.ListIssuesRow{}
	}

	t.Run("规则1 自身done→已完成", func(t *testing.T) {
		proj := newProject(t, "done")
		newRequirement(t, proj, "done", true, true)
		row := projectStatus(t, proj)
		if row.RequirementStatus != "已完成" {
			t.Errorf("requirement_status = %q, want 已完成", row.RequirementStatus)
		}
	})

	t.Run("规则1 自身cancelled→已取消", func(t *testing.T) {
		proj := newProject(t, "cancelled")
		newRequirement(t, proj, "cancelled", true, true)
		row := projectStatus(t, proj)
		if row.RequirementStatus != "已取消" {
			t.Errorf("requirement_status = %q, want 已取消", row.RequirementStatus)
		}
	})

	t.Run("规则2 stage1子任务未终态→原型待确认", func(t *testing.T) {
		proj := newProject(t, "proto")
		reqID := newRequirement(t, proj, "todo", false, false)
		newStageChild(t, proj, reqID, 1, "in_progress")
		row := projectStatus(t, proj)
		if row.RequirementStatus != "原型待确认" {
			t.Errorf("requirement_status = %q, want 原型待确认", row.RequirementStatus)
		}
	})

	t.Run("规则3 未确认且存在stage2→拆解待确认", func(t *testing.T) {
		proj := newProject(t, "decomp")
		reqID := newRequirement(t, proj, "todo", false, false)
		newStageChild(t, proj, reqID, 2, "todo")
		row := projectStatus(t, proj)
		if row.RequirementStatus != "拆解待确认" {
			t.Errorf("requirement_status = %q, want 拆解待确认", row.RequirementStatus)
		}
	})

	t.Run("规则4 未确认无子任务→未拆解", func(t *testing.T) {
		proj := newProject(t, "raw")
		newRequirement(t, proj, "todo", false, false)
		row := projectStatus(t, proj)
		if row.RequirementStatus != "未拆解" {
			t.Errorf("requirement_status = %q, want 未拆解", row.RequirementStatus)
		}
	})

	t.Run("规则5 已确认未触发→待触发", func(t *testing.T) {
		proj := newProject(t, "pending")
		reqID := newRequirement(t, proj, "todo", true, false)
		newStageChild(t, proj, reqID, 3, "todo")
		row := projectStatus(t, proj)
		if row.RequirementStatus != "待触发" {
			t.Errorf("requirement_status = %q, want 待触发", row.RequirementStatus)
		}
	})

	t.Run("规则6 子孙等待模块锁→等待模块释放", func(t *testing.T) {
		proj := newProject(t, "waitlock")
		reqID := newRequirement(t, proj, "todo", true, true)
		childID := newStageChild(t, proj, reqID, 3, "in_progress")
		markWaitingModuleLock(t, childID)
		row := projectStatus(t, proj)
		if row.RequirementStatus != "等待模块释放" {
			t.Errorf("requirement_status = %q, want 等待模块释放", row.RequirementStatus)
		}
	})

	t.Run("规则7 stage3未全终态→执行中且进度NM", func(t *testing.T) {
		proj := newProject(t, "exec")
		reqID := newRequirement(t, proj, "todo", true, true)
		newStageChild(t, proj, reqID, 3, "done")
		newStageChild(t, proj, reqID, 3, "done")
		newStageChild(t, proj, reqID, 3, "todo")
		newStageChild(t, proj, reqID, 3, "in_progress")
		newStageChild(t, proj, reqID, 3, "todo")
		row := projectStatus(t, proj)
		if row.RequirementStatus != "执行中" {
			t.Errorf("requirement_status = %q, want 执行中", row.RequirementStatus)
		}
		if row.StageProgress != "2/5" {
			t.Errorf("stage_progress = %q, want 2/5", row.StageProgress)
		}
	})

	t.Run("规则8 stage3全终态且stage4未终态→验收中", func(t *testing.T) {
		proj := newProject(t, "accept")
		reqID := newRequirement(t, proj, "todo", true, true)
		newStageChild(t, proj, reqID, 3, "done")
		newStageChild(t, proj, reqID, 3, "cancelled")
		newStageChild(t, proj, reqID, 4, "in_progress")
		row := projectStatus(t, proj)
		if row.RequirementStatus != "验收中" {
			t.Errorf("requirement_status = %q, want 验收中", row.RequirementStatus)
		}
	})

	t.Run("规则9 全部终态→已完成（兜底）", func(t *testing.T) {
		proj := newProject(t, "allterminal")
		reqID := newRequirement(t, proj, "todo", true, true)
		newStageChild(t, proj, reqID, 3, "done")
		newStageChild(t, proj, reqID, 4, "done")
		row := projectStatus(t, proj)
		if row.RequirementStatus != "已完成" {
			t.Errorf("requirement_status = %q, want 已完成", row.RequirementStatus)
		}
	})

	t.Run("规则10 acceptance_round>3→验收失败", func(t *testing.T) {
		proj := newProject(t, "accfail")
		reqID := newRequirement(t, proj, "todo", true, true)
		newStageChild(t, proj, reqID, 3, "done")
		newStageChild(t, proj, reqID, 4, "done")
		// 4 轮打回后仍未过：acceptance_round 累加到 4（>3）判验收失败终态。
		dbfx.Exec(t, `UPDATE issue SET acceptance_round = 4 WHERE id = $1`, reqID)
		row := projectStatus(t, proj)
		if row.RequirementStatus != "验收失败" {
			t.Errorf("requirement_status = %q, want 验收失败", row.RequirementStatus)
		}
	})

	t.Run("规则10 acceptance_round=3 未越界→不判验收失败", func(t *testing.T) {
		proj := newProject(t, "acc3")
		reqID := newRequirement(t, proj, "todo", true, true)
		newStageChild(t, proj, reqID, 3, "todo")
		dbfx.Exec(t, `UPDATE issue SET acceptance_round = 3 WHERE id = $1`, reqID)
		row := projectStatus(t, proj)
		if row.RequirementStatus != "执行中" {
			t.Errorf("requirement_status = %q, want 执行中（round=3 仍在修复）", row.RequirementStatus)
		}
	})

	t.Run("规则6修正 有stage3正在跑→执行中而非等待模块释放", func(t *testing.T) {
		proj := newProject(t, "waitlock-running")
		reqID := newRequirement(t, proj, "todo", true, true)
		running := newStageChild(t, proj, reqID, 3, "in_progress")
		waiting := newStageChild(t, proj, reqID, 3, "in_progress")
		markRunning(t, running)           // 有一个 stage3 正在跑：需求仍在推进
		markWaitingModuleLock(t, waiting) // 另一个在等锁：不应盖过「执行中」
		row := projectStatus(t, proj)
		if row.RequirementStatus != "执行中" {
			t.Errorf("requirement_status = %q, want 执行中（父状态优先于子计数）", row.RequirementStatus)
		}
	})
}
