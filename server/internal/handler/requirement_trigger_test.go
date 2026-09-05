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

	"github.com/multica-ai/multica/server/internal/scheduler"
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
		// acceptance_spec 写非空 JSON：默认列值 '{}' 会被预检视为「未填写」
		// → acceptance_spec_missing，手动触发路径会 409。这里给每个 stage3
		// 子任务都填一个最小验收规格，让预检能过；service 层 sweep 不读
		// 该列，不影响 TestRequirementTriggerSweep 的前半断言。
		if err := testPool.QueryRow(ctx, `
                        INSERT INTO issue (
                                workspace_id, title, status, priority, creator_type, creator_id,
                                number, position, parent_issue_id, stage, assignee_type, assignee_id,
                                acceptance_spec
                        )
                        VALUES ($1, $2, 'todo', 'medium', 'member', $3, $4, 100, $5, $6,
                                'agent', $7, '{"criteria":["smoke"]}'::jsonb)
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

		// sweep 已迁到 scheduler 层（带触发前置预检的 RequirementTriggerService.Sweep）；
		// service.IssueService.SweepRequirementTriggers 死代码已删除。这里就地构造
		// 与 handler 生产路径同一份 service（h.Queries + h.TaskService）跑一轮。
		svc := scheduler.NewRequirementTriggerService(testHandler.Queries, testHandler.TaskService)
		summary, err := svc.Sweep(ctx)
		if err != nil {
			t.Fatalf("Sweep: %v", err)
		}
		if summary.Triggered != 1 {
			t.Fatalf("expected 1 requirement triggered, got %d (summary=%+v)", summary.Triggered, summary)
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
		summary, err = svc.Sweep(ctx)
		if err != nil {
			t.Fatalf("second sweep: %v", err)
		}
		if summary.Triggered != 0 {
			t.Fatalf("second sweep should trigger nothing, got %d (summary=%+v)", summary.Triggered, summary)
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
		// 响应体契约（WS6 前端已按此并行编码）：
		//   {"triggered": bool, "enqueued": number, "issue_id": string}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response body: %v (raw=%s)", err, w.Body.String())
		}
		if triggered, _ := body["triggered"].(bool); !triggered {
			t.Fatalf("expected triggered=true, got body=%v", body)
		}
		// json.Unmarshal 把所有数字解成 float64；子任务只有一个 → enqueued=1。
		if enq, _ := body["enqueued"].(float64); enq != 1 {
			t.Fatalf("expected enqueued=1, got body=%v", body)
		}
		if idStr, _ := body["issue_id"].(string); idStr != reqB {
			t.Fatalf("expected issue_id=%s, got body=%v", reqB, body)
		}
		if triggeredAt(t, reqB) == nil {
			t.Fatal("manual trigger should set triggered_at")
		}
		if got := queuedCount(t, child); got != 1 {
			t.Fatalf("manual trigger should enqueue the stage-3 child, got %d", got)
		}

		// 已触发再调 → 409 already_triggered（MarkRequirementTriggered 返回 0 行）。
		w2 := httptest.NewRecorder()
		req2 := newRequest("POST", "/api/issues/"+reqB+"/trigger", nil)
		req2 = withURLParam(req2, "id", reqB)
		testHandler.TriggerRequirement(w2, req2)
		if w2.Code != http.StatusConflict {
			t.Fatalf("re-trigger: expected 409, got %d: %s", w2.Code, w2.Body.String())
		}
		if !strings.Contains(w2.Body.String(), "already_triggered") {
			t.Fatalf("re-trigger body should carry the stable reason 'already_triggered', got %s", w2.Body.String())
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
		if !strings.Contains(w.Body.String(), "decomposition_not_confirmed") {
			t.Fatalf("unconfirmed body should carry the stable preflight reason, got %s", w.Body.String())
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

	// module_window_busy 预检（plan §WS2 Task 2.3 / 开放问题#10）：接线
	// ModuleBusyForOtherRoot 真实查询后，同模块跨 root 组互斥、同组并行。
	// 对齐 WS3 ModuleLocker v2（daemon/module_locker.go）语义。
	t.Run("module window busy blocks cross-root and frees same-root", func(t *testing.T) {
		agentID := testAgentID(t)

		// 同模块互斥的载体：project + project_module。
		var projectID string
		if err := testPool.QueryRow(ctx,
			`INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id`,
			testWorkspaceID, "Module Window "+suffix).Scan(&projectID); err != nil {
			t.Fatalf("insert project: %v", err)
		}
		var moduleID string
		if err := testPool.QueryRow(ctx,
			`INSERT INTO project_module (project_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`,
			projectID, testWorkspaceID, "mod-"+suffix).Scan(&moduleID); err != nil {
			t.Fatalf("insert project_module: %v", err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM project_module WHERE id = $1`, moduleID)
			testPool.Exec(context.Background(), `DELETE FROM project WHERE id = $1`, projectID)
		})

		nextNumber := func() int {
			var number int
			if err := testPool.QueryRow(ctx, `
				UPDATE workspace SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number),0) FROM issue WHERE workspace_id=$1))+1
				WHERE id=$1 RETURNING issue_counter`, testWorkspaceID).Scan(&number); err != nil {
				t.Fatalf("next issue number: %v", err)
			}
			return number
		}

		// insertRoot 建顶层可触发需求，显式写 module_id + root_requirement_id=自身
		//（server 创建路径回填 root；测试走裸 SQL 必须手动设，否则
		// ModuleBusyForOtherRoot 的 IS NOT NULL 过滤会漏判）。
		insertRoot := func(title string) string {
			var id string
			if err := testPool.QueryRow(ctx, `
				INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number, position,
					auto_trigger, start_at, decomposition_confirmed_at, module_id)
				VALUES ($1,$2,'todo','medium','member',$3,$4,100,true,$5,now(),$6)
				RETURNING id`, testWorkspaceID, title+" "+suffix, testUserID, nextNumber(), past, moduleID).Scan(&id); err != nil {
				t.Fatalf("insert root requirement: %v", err)
			}
			if _, err := testPool.Exec(ctx, `UPDATE issue SET root_requirement_id = id WHERE id = $1`, id); err != nil {
				t.Fatalf("set root_requirement_id: %v", err)
			}
			t.Cleanup(func() {
				testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE parent_issue_id=$1 OR id=$1)`, id)
				testPool.Exec(context.Background(), `DELETE FROM issue WHERE id=$1 OR parent_issue_id=$1`, id)
			})
			return id
		}

		// insertChild 建 stage3 子任务，写 acceptance_spec（过预检）+ root_requirement_id=rootID
		//（子任务归属其父需求组，跨组互斥按 root 比较）。
		insertChild := func(parentID, rootID, title string) string {
			var id string
			if err := testPool.QueryRow(ctx, `
				INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number, position,
					parent_issue_id, stage, assignee_type, assignee_id, acceptance_spec, module_id, root_requirement_id)
				VALUES ($1,$2,'todo','medium','member',$3,$4,100,$5,$6,'agent',$7,'{"criteria":["smoke"]}'::jsonb,$8,$9)
				RETURNING id`, testWorkspaceID, title, testUserID, nextNumber(), parentID, 3, agentID, moduleID, rootID).Scan(&id); err != nil {
				t.Fatalf("insert group child: %v", err)
			}
			return id
		}

		// X 组：塑一个 running 任务占用模块（模拟 WS3 已持有该模块的其它 root 组）。
		reqX := insertRoot("Window X")
		childX := insertChild(reqX, reqX, "X-T1")
		var taskX string
		if err := testPool.QueryRow(ctx, `
			INSERT INTO agent_task_queue (agent_id, runtime_id, status, priority, issue_id, started_at)
			VALUES ($1,(SELECT runtime_id FROM agent WHERE id=$1),'running',0,$2,now())
			RETURNING id`, agentID, childX).Scan(&taskX); err != nil {
			t.Fatalf("insert running task: %v", err)
		}
		t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id=$1`, taskX) })

		// Y 组：同模块、不同 root。触发应被 module_window_busy 挡下（命中）。
		reqY := insertRoot("Window Y")
		insertChild(reqY, reqY, "Y-T1")

		wY := httptest.NewRecorder()
		rY := withURLParam(newRequest("POST", "/api/issues/"+reqY+"/trigger", nil), "id", reqY)
		testHandler.TriggerRequirement(wY, rY)
		if wY.Code != http.StatusConflict {
			t.Fatalf("cross-root trigger: expected 409 module_window_busy, got %d: %s", wY.Code, wY.Body.String())
		}
		if !strings.Contains(wY.Body.String(), "module_window_busy") {
			t.Fatalf("cross-root trigger body should carry 'module_window_busy', got %s", wY.Body.String())
		}
		if triggeredAt(t, reqY) != nil {
			t.Fatal("Y must not be triggered while another root group occupies the module")
		}

		// X 组自身：running 任务属于同一 root（X），同组并行不阻 → 放行。
		wX := httptest.NewRecorder()
		rX := withURLParam(newRequest("POST", "/api/issues/"+reqX+"/trigger", nil), "id", reqX)
		testHandler.TriggerRequirement(wX, rX)
		if wX.Code != http.StatusOK {
			t.Fatalf("same-root trigger: expected 200 (window free for own group), got %d: %s", wX.Code, wX.Body.String())
		}
		if triggeredAt(t, reqX) == nil {
			t.Fatal("X (same root group as the running task) should trigger — same-group parallel allowed")
		}

		// 释放 X 组的 running 任务后，Y 应放行（互斥窗口腾出）。
		if _, err := testPool.Exec(ctx, `UPDATE agent_task_queue SET status='completed' WHERE id=$1`, taskX); err != nil {
			t.Fatalf("complete running task: %v", err)
		}
		wY2 := httptest.NewRecorder()
		rY2 := withURLParam(newRequest("POST", "/api/issues/"+reqY+"/trigger", nil), "id", reqY)
		testHandler.TriggerRequirement(wY2, rY2)
		if wY2.Code != http.StatusOK {
			t.Fatalf("after window release: expected 200, got %d: %s", wY2.Code, wY2.Body.String())
		}
		if triggeredAt(t, reqY) == nil {
			t.Fatal("Y should trigger once the other root group's task completes")
		}
	})
}

// TestTriggerRequirementValidatesBody 是无 DB 依赖的最小验证：非法 UUID
// 走 loadIssueForUser 的 400/404 分支，不 panic、不 5xx。完整 DB 路径由
// TestRequirementTriggerSweep 覆盖。
func TestTriggerRequirementValidatesBody(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodPost, "/api/issues/not-a-uuid/trigger", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("handler panicked on invalid id: %v", r)
			}
		}()
		h.TriggerRequirement(w, req)
	}()
	if w.Code < 400 || w.Code >= 500 {
		t.Fatalf("expected 4xx for invalid issue id, got %d (body=%s)", w.Code, w.Body.String())
	}
}
