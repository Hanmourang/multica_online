package handler

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// Claim 依赖闸门（spec §4）：有前置的 issue，其任务必须等全部前置达到
// done（含自定义 done-category 状态）才可被领取。同时钉住 claim 载荷的
// 模块投影（module_id/module_name/avoid_conflict，取自 issue 实时值）。
func TestClaimBlockedByDependency(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	projectP := createModuleTestProject(t, "ClaimGate P "+suffix)
	modM := createModuleTestModule(t, projectP.ID, "内核")

	runtimeID := createClaimReclaimRuntime(t, ctx, "claim-gate "+suffix)
	agentID := dbfx.Agent(t, "claim-gate agent "+suffix, runtimeID)

	insertIssue := func(title, status string, avoidConflict bool) string {
		t.Helper()
		var id string
		if err := testPool.QueryRow(ctx, `
			INSERT INTO issue (
				workspace_id, title, status, priority, creator_type, creator_id,
				number, position, project_id, module_id, avoid_conflict
			)
			VALUES (
				$1, $2, $3, 'none', 'member', $4,
				(SELECT COALESCE(MAX(number), 82649) + 1 FROM issue WHERE workspace_id = $1),
				0, $5, $6, $7
			)
			RETURNING id
		`, testWorkspaceID, title+" "+suffix, status, testUserID, projectP.ID, modM.ID, avoidConflict).Scan(&id); err != nil {
			t.Fatalf("insert issue %q: %v", title, err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM issue_dependency WHERE issue_id = $1 OR depends_on_issue_id = $1`, id)
			testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, id)
		})
		return id
	}

	issueA := insertIssue("Gate A", "in_progress", false) // 前置
	issueB := insertIssue("Gate B", "todo", true)         // 依赖 A，勾选避免冲突

	dbfx.Exec(t, `
		INSERT INTO issue_dependency (issue_id, depends_on_issue_id, type)
		VALUES ($1, $2, 'blocked_by')
	`, issueB, issueA)

	type claimedTask struct {
		ID            string `json:"id"`
		ModuleID      string `json:"module_id"`
		ModuleName    string `json:"module_name"`
		AvoidConflict bool   `json:"avoid_conflict"`
	}
	claim := func(t *testing.T) *claimedTask {
		t.Helper()
		req := newDaemonTokenRequest("POST", "/api/daemon/runtimes/"+runtimeID+"/tasks/claim", nil,
			testWorkspaceID, "claim-gate-daemon")
		req = withURLParam(req, "runtimeId", runtimeID)
		w := testutil.Call(t, testHandler.ClaimTaskByRuntime, req).Want(http.StatusOK)
		var resp struct {
			Task *claimedTask `json:"task"`
		}
		w.JSON(&resp)
		return resp.Task
	}
	setIssueStatus := func(issueID, status string) {
		t.Helper()
		dbfx.Exec(t, `UPDATE issue SET status = $2 WHERE id = $1`, issueID, status)
	}

	// 1) 前置 in_progress：B 的任务入队但不可领取
	taskT1 := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueB})
	if got := claim(t); got != nil {
		t.Fatalf("dependency unmet: expected no claimable task, got %+v", got)
	}

	// 2) 前置转 done（内建状态）→ 领取成功，且载荷带模块投影
	setIssueStatus(issueA, "done")
	got := claim(t)
	if got == nil {
		t.Fatal("dependency met (built-in done): expected to claim B's task, got none")
	}
	if got.ID != taskT1 {
		t.Fatalf("claimed task = %s, want %s", got.ID, taskT1)
	}
	if got.ModuleID != modM.ID {
		t.Errorf("module_id = %q, want %q", got.ModuleID, modM.ID)
	}
	if got.ModuleName != "内核" {
		t.Errorf("module_name = %q, want %q", got.ModuleName, "内核")
	}
	if !got.AvoidConflict {
		t.Error("avoid_conflict = false, want true")
	}

	// 3) 自定义 done-category 状态同样放行：重置前置为 in_progress 后再次阻塞，
	//    再换成自定义 done 状态 'verified' 应可领取。
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed', completed_at = now() WHERE id = $1`, taskT1)
	dbfx.Exec(t, `
		INSERT INTO issue_status (workspace_id, key, name, description, category, color, position)
		VALUES ($1, 'verified', 'Verified', '', 'done', '#22c55e', 90)
		ON CONFLICT DO NOTHING
	`, testWorkspaceID)
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM issue_status WHERE workspace_id = $1 AND key = 'verified'`, testWorkspaceID)
	})

	setIssueStatus(issueA, "in_progress")
	taskT2 := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueB})
	if got := claim(t); got != nil {
		t.Fatalf("dependency unmet after reset: expected no claimable task, got %+v", got)
	}
	setIssueStatus(issueA, "verified")
	got = claim(t)
	if got == nil {
		t.Fatal("dependency met (custom done-category status): expected to claim B's task, got none")
	}
	if got.ID != taskT2 {
		t.Fatalf("claimed task = %s, want %s", got.ID, taskT2)
	}
}

// 模块投影是 claim 时的实时读：issue 换模块/取消勾选后，下一次 claim 立即反映，
// 不依赖任务行上的快照（任务行根本不存这些列）。
func TestClaimModuleProjectionIsLive(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	projectP := createModuleTestProject(t, "LiveProj P "+suffix)
	modM := createModuleTestModule(t, projectP.ID, "内核")
	modV2 := createModuleTestModule(t, projectP.ID, "Flow 编排")

	runtimeID := createClaimReclaimRuntime(t, ctx, "claim-live "+suffix)
	agentID := dbfx.Agent(t, "claim-live agent "+suffix, runtimeID)

	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (
			workspace_id, title, status, priority, creator_type, creator_id,
			number, position, project_id, module_id, avoid_conflict
		)
		VALUES (
			$1, $2, 'todo', 'none', 'member', $3,
			(SELECT COALESCE(MAX(number), 82649) + 1 FROM issue WHERE workspace_id = $1),
			0, $4, $5, true
		)
		RETURNING id
	`, testWorkspaceID, "LiveProj issue "+suffix, testUserID, projectP.ID, modM.ID).Scan(&issueID); err != nil {
		t.Fatalf("insert issue: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID) })

	// 先入队，再改 issue 的模块归属——claim 必须读到新值。
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID})
	dbfx.Exec(t, `UPDATE issue SET module_id = $2, avoid_conflict = false WHERE id = $1`, issueID, modV2.ID)

	req := newDaemonTokenRequest("POST", "/api/daemon/runtimes/"+runtimeID+"/tasks/claim", nil,
		testWorkspaceID, "claim-live-daemon")
	req = withURLParam(req, "runtimeId", runtimeID)
	w := testutil.Call(t, testHandler.ClaimTaskByRuntime, req).Want(http.StatusOK)
	var resp struct {
		Task *struct {
			ID            string `json:"id"`
			ModuleID      string `json:"module_id"`
			ModuleName    string `json:"module_name"`
			AvoidConflict bool   `json:"avoid_conflict"`
		} `json:"task"`
	}
	w.JSON(&resp)
	if resp.Task == nil || resp.Task.ID != taskID {
		t.Fatalf("expected to claim %s, got %+v", taskID, resp.Task)
	}
	if resp.Task.ModuleID != modV2.ID || resp.Task.ModuleName != "Flow 编排" {
		t.Errorf("live projection = (%q, %q), want (%q, %q)",
			resp.Task.ModuleID, resp.Task.ModuleName, modV2.ID, "Flow 编排")
	}
	if resp.Task.AvoidConflict {
		t.Error("avoid_conflict = true, want false after live update")
	}
}
