package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// 迭代（Sprint）模块 handler 测试（CoCo 对标 plan 20261024 §02）。
// 覆盖：创建校验 / 项目内重名 409 / 日期倒挂 400 / planned→active→completed
// CAS 状态机（非法迁移 409）/ 仅 planned 可删 / issue 纳入/移出与批量越权 /
// /api/issues?sprint_id 过滤 / 进度派生聚合。范式对齐 project_module_test.go：
// 直接调 handler，httptest 记录响应。

// createSprintViaHandler POST 创建迭代，断言 201 并返回响应体。
func createSprintViaHandler(t *testing.T, projectID string, body map[string]any) SprintResponse {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/sprints", body)
	req = withURLParam(req, "id", projectID)
	testHandler.CreateSprint(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateSprint(%v): expected 201, got %d: %s", body, w.Code, w.Body.String())
	}
	var created SprintResponse
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatalf("decode CreateSprint: %v", err)
	}
	return created
}

// sprintTransitionViaHandler 调用 start/complete/reopen 之一并返回状态码。
func sprintTransitionViaHandler(t *testing.T, handler http.HandlerFunc, action, projectID, sprintID string) (int, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/sprints/"+sprintID+"/"+action, nil)
	req = withURLParams(req, "id", projectID, "sprintId", sprintID)
	handler(w, req)
	return w.Code, w.Body.String()
}

func decodeSprint(t *testing.T, body string) SprintResponse {
	t.Helper()
	var s SprintResponse
	if err := json.Unmarshal([]byte(body), &s); err != nil {
		t.Fatalf("decode sprint: %v", err)
	}
	return s
}

// TestSprintLifecycle：创建校验 → 重名冲突 → 状态机 CAS → 仅 planned 可删。
func TestSprintLifecycle(t *testing.T) {
	projectID := dbfx.Project(t, "Sprint lifecycle project")

	// 名称必填 → 400。
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/sprints", map[string]any{"name": "   "})
	req = withURLParam(req, "id", projectID)
	testHandler.CreateSprint(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("blank name: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// capacity <= 0 → 400。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+projectID+"/sprints", map[string]any{"name": "容量非法", "capacity": 0})
	req = withURLParam(req, "id", projectID)
	testHandler.CreateSprint(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("zero capacity: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// 日期格式错误 → 400。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+projectID+"/sprints", map[string]any{"name": "日期格式", "start_date": "2026-13-45"})
	req = withURLParam(req, "id", projectID)
	testHandler.CreateSprint(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad date: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// end < start → 400。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+projectID+"/sprints", map[string]any{
		"name": "日期倒挂", "start_date": "2026-11-15", "end_date": "2026-11-01",
	})
	req = withURLParam(req, "id", projectID)
	testHandler.CreateSprint(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("end before start: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// 正常创建：planned + 字段透传。
	created := createSprintViaHandler(t, projectID, map[string]any{
		"name": "Sprint 01", "goal": "P99 30min → 5min",
		"start_date": "2026-11-01", "end_date": "2026-11-14", "capacity": 12,
	})
	if created.Status != "planned" || created.Name != "Sprint 01" {
		t.Fatalf("created = %+v, want planned / Sprint 01", created)
	}
	if created.StartDate == nil || *created.StartDate != "2026-11-01" {
		t.Errorf("start_date = %v, want 2026-11-01", created.StartDate)
	}
	if created.Capacity == nil || *created.Capacity != 12 {
		t.Errorf("capacity = %v, want 12", created.Capacity)
	}

	// 项目内重名 → 409 sprint_name_exists。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+projectID+"/sprints", map[string]any{"name": "Sprint 01"})
	req = withURLParam(req, "id", projectID)
	testHandler.CreateSprint(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate sprint name: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 非法迁移：planned 直接 complete / reopen → 409。
	if code, body := sprintTransitionViaHandler(t, testHandler.CompleteSprint, "complete", projectID, created.ID); code != http.StatusConflict {
		t.Fatalf("planned→complete: expected 409, got %d: %s", code, body)
	}
	if code, body := sprintTransitionViaHandler(t, testHandler.ReopenSprint, "reopen", projectID, created.ID); code != http.StatusConflict {
		t.Fatalf("planned→reopen: expected 409, got %d: %s", code, body)
	}

	// planned→active→completed 正链。
	code, body := sprintTransitionViaHandler(t, testHandler.StartSprint, "start", projectID, created.ID)
	if code != http.StatusOK {
		t.Fatalf("start: expected 200, got %d: %s", code, body)
	}
	if s := decodeSprint(t, body); s.Status != "active" || s.StartedAt == nil {
		t.Fatalf("after start = %+v, want active with started_at", s)
	}
	// 重复 start（CAS 未命中）→ 409。
	if code, body := sprintTransitionViaHandler(t, testHandler.StartSprint, "start", projectID, created.ID); code != http.StatusConflict {
		t.Fatalf("double start: expected 409, got %d: %s", code, body)
	}
	// active 可 start 后仍可改名（PATCH 不受状态机限制），但不可删除。
	w = httptest.NewRecorder()
	req = newRequest("DELETE", "/api/projects/"+projectID+"/sprints/"+created.ID, nil)
	req = withURLParams(req, "id", projectID, "sprintId", created.ID)
	testHandler.DeleteSprint(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("delete active: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	code, body = sprintTransitionViaHandler(t, testHandler.CompleteSprint, "complete", projectID, created.ID)
	if code != http.StatusOK {
		t.Fatalf("complete: expected 200, got %d: %s", code, body)
	}
	if s := decodeSprint(t, body); s.Status != "completed" || s.CompletedAt == nil {
		t.Fatalf("after complete = %+v, want completed with completed_at", s)
	}
	// completed 再 start → 409。
	if code, body := sprintTransitionViaHandler(t, testHandler.StartSprint, "start", projectID, created.ID); code != http.StatusConflict {
		t.Fatalf("completed→start: expected 409, got %d: %s", code, body)
	}
	// completed→active reopen。
	code, body = sprintTransitionViaHandler(t, testHandler.ReopenSprint, "reopen", projectID, created.ID)
	if code != http.StatusOK {
		t.Fatalf("reopen: expected 200, got %d: %s", code, body)
	}
	if s := decodeSprint(t, body); s.Status != "active" {
		t.Fatalf("after reopen = %q, want active", s.Status)
	}

	// PATCH 改名 + 与既有迭代重名 → 409。
	other := createSprintViaHandler(t, projectID, map[string]any{"name": "Sprint 02"})
	w = httptest.NewRecorder()
	req = newRequest("PATCH", "/api/projects/"+projectID+"/sprints/"+other.ID, map[string]any{"name": "Sprint 01"})
	req = withURLParams(req, "id", projectID, "sprintId", other.ID)
	testHandler.UpdateSprint(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("rename to existing: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 列表 status 过滤：planned 只剩 Sprint 02。
	w = httptest.NewRecorder()
	req = newRequest("GET", "/api/projects/"+projectID+"/sprints?status=planned", nil)
	req = withURLParam(req, "id", projectID)
	testHandler.ListSprints(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ListSprints: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var list struct {
		Sprints []SprintResponse `json:"sprints"`
		Total   int              `json:"total"`
	}
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if list.Total != 1 || list.Sprints[0].Name != "Sprint 02" {
		t.Fatalf("planned list = %+v, want only Sprint 02", list.Sprints)
	}

	// planned 可删；删除后列表为空。
	w = httptest.NewRecorder()
	req = newRequest("DELETE", "/api/projects/"+projectID+"/sprints/"+other.ID, nil)
	req = withURLParams(req, "id", projectID, "sprintId", other.ID)
	testHandler.DeleteSprint(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("delete planned: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// 跨项目 {id}/{sprintId} 错配 → 404（不泄露存在性）。
	foreignProjectID := dbfx.Project(t, "Sprint foreign project")
	w = httptest.NewRecorder()
	req = newRequest("GET", "/api/projects/"+foreignProjectID+"/sprints/"+created.ID, nil)
	req = withURLParams(req, "id", foreignProjectID, "sprintId", created.ID)
	testHandler.GetSprint(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("cross-project sprint: expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

// TestSprintIssueMembership：纳入/移出 + 批量越权整单拒绝 + sprint_id 列表过滤 + 进度聚合。
func TestSprintIssueMembership(t *testing.T) {
	projectID := dbfx.Project(t, "Sprint membership project")
	sprint := createSprintViaHandler(t, projectID, map[string]any{"name": "Sprint 03"})

	issueA := dbfx.Issue(t, "纳入A", testutil.Cols{"project_id": projectID})
	issueB := dbfx.Issue(t, "纳入B", testutil.Cols{"project_id": projectID, "status": "done"})

	// issue_ids 为空 → 400。
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/sprints/"+sprint.ID+"/issues", map[string]any{"issue_ids": []string{}})
	req = withURLParams(req, "id", projectID, "sprintId", sprint.ID)
	testHandler.AssignSprintIssues(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty issue_ids: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// 批量中混入跨 workspace issue → 整单 404，且事务回滚不留部分纳入。
	foreignWS := dbfx.Workspace(t, "Sprint foreign ws", "sprint-foreign-ws")
	foreignIssue := dbfx.Issue(t, "外租issue", testutil.Cols{"workspace_id": foreignWS})
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+projectID+"/sprints/"+sprint.ID+"/issues",
		map[string]any{"issue_ids": []string{issueA, foreignIssue}})
	req = withURLParams(req, "id", projectID, "sprintId", sprint.ID)
	testHandler.AssignSprintIssues(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("cross-workspace batch: expected 404, got %d: %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	req = newRequest("GET", "/api/projects/"+projectID+"/sprints/"+sprint.ID+"/progress", nil)
	req = withURLParams(req, "id", projectID, "sprintId", sprint.ID)
	testHandler.GetSprintProgress(w, req)
	var before struct {
		DoneCount      int `json:"done_count"`
		CancelledCount int `json:"cancelled_count"`
		TotalCount     int `json:"total_count"`
	}
	if err := json.NewDecoder(w.Body).Decode(&before); err != nil {
		t.Fatalf("decode progress before: %v", err)
	}
	if before.TotalCount != 0 {
		t.Fatalf("rejected batch left %d members behind, want 0", before.TotalCount)
	}

	// 正常纳入 A、B。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+projectID+"/sprints/"+sprint.ID+"/issues",
		map[string]any{"issue_ids": []string{issueA, issueB}})
	req = withURLParams(req, "id", projectID, "sprintId", sprint.ID)
	testHandler.AssignSprintIssues(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("assign: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// /api/issues?sprint_id 过滤只返回成员。
	w = httptest.NewRecorder()
	req = newRequest("GET", "/api/issues?workspace_id="+testWorkspaceID+"&sprint_id="+sprint.ID, nil)
	testHandler.ListIssues(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list by sprint: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var issueList struct {
		Issues []IssueResponse `json:"issues"`
		Total  int             `json:"total"`
	}
	if err := json.NewDecoder(w.Body).Decode(&issueList); err != nil {
		t.Fatalf("decode issue list: %v", err)
	}
	if issueList.Total != 2 {
		t.Fatalf("sprint issues = %d, want 2", issueList.Total)
	}
	for _, i := range issueList.Issues {
		if i.SprintID == nil || *i.SprintID != sprint.ID {
			t.Errorf("issue %s sprint_id = %v, want %s", i.ID, i.SprintID, sprint.ID)
		}
	}

	// 进度派生：2 总 / 1 done。
	w = httptest.NewRecorder()
	req = newRequest("GET", "/api/projects/"+projectID+"/sprints/"+sprint.ID+"/progress", nil)
	req = withURLParams(req, "id", projectID, "sprintId", sprint.ID)
	testHandler.GetSprintProgress(w, req)
	var progress struct {
		DoneCount      int `json:"done_count"`
		CancelledCount int `json:"cancelled_count"`
		TotalCount     int `json:"total_count"`
	}
	if err := json.NewDecoder(w.Body).Decode(&progress); err != nil {
		t.Fatalf("decode progress: %v", err)
	}
	if progress.TotalCount != 2 || progress.DoneCount != 1 || progress.CancelledCount != 0 {
		t.Fatalf("progress = %+v, want total=2 done=1 cancelled=0", progress)
	}

	// 列表聚合口径：迭代侧边栏卡片的进度环直接读 issue_count/done_count，
	// 不必逐迭代调 /progress（N+1）。两条 must 与 /progress 一致。
	w = httptest.NewRecorder()
	req = newRequest("GET", "/api/projects/"+projectID+"/sprints", nil)
	req = withURLParam(req, "id", projectID)
	testHandler.ListSprints(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ListSprints counts: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var withCounts struct {
		Sprints []SprintResponse `json:"sprints"`
	}
	if err := json.NewDecoder(w.Body).Decode(&withCounts); err != nil {
		t.Fatalf("decode list with counts: %v", err)
	}
	if len(withCounts.Sprints) != 1 {
		t.Fatalf("sprints = %d, want 1", len(withCounts.Sprints))
	}
	if got := withCounts.Sprints[0]; got.IssueCount != 2 || got.DoneCount != 1 {
		t.Fatalf("list counts = issue %d/done %d, want issue 2/done 1", got.IssueCount, got.DoneCount)
	}

	// 移出 A，B 保留。
	w = httptest.NewRecorder()
	req = newRequest("DELETE", "/api/projects/"+projectID+"/sprints/"+sprint.ID+"/issues",
		map[string]any{"issue_ids": []string{issueA}})
	req = withURLParams(req, "id", projectID, "sprintId", sprint.ID)
	testHandler.RemoveSprintIssues(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("remove: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	req = newRequest("GET", "/api/projects/"+projectID+"/sprints/"+sprint.ID+"/progress", nil)
	req = withURLParams(req, "id", projectID, "sprintId", sprint.ID)
	testHandler.GetSprintProgress(w, req)
	if err := json.NewDecoder(w.Body).Decode(&progress); err != nil {
		t.Fatalf("decode progress after remove: %v", err)
	}
	if progress.TotalCount != 1 {
		t.Fatalf("progress after remove = %+v, want total=1", progress)
	}

	// completed 后纳入 → 409 sprint_completed；移出仍允许（纠错性）。
	if code, body := sprintTransitionViaHandler(t, testHandler.StartSprint, "start", projectID, sprint.ID); code != http.StatusOK {
		t.Fatalf("start: expected 200, got %d: %s", code, body)
	}
	if code, body := sprintTransitionViaHandler(t, testHandler.CompleteSprint, "complete", projectID, sprint.ID); code != http.StatusOK {
		t.Fatalf("complete: expected 200, got %d: %s", code, body)
	}
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+projectID+"/sprints/"+sprint.ID+"/issues",
		map[string]any{"issue_ids": []string{issueA}})
	req = withURLParams(req, "id", projectID, "sprintId", sprint.ID)
	testHandler.AssignSprintIssues(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("assign to completed: expected 409, got %d: %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	req = newRequest("DELETE", "/api/projects/"+projectID+"/sprints/"+sprint.ID+"/issues",
		map[string]any{"issue_ids": []string{issueB}})
	req = withURLParams(req, "id", projectID, "sprintId", sprint.ID)
	testHandler.RemoveSprintIssues(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("remove from completed: expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// TestSprintIssueWritePath：issue 写路径的迭代反向挂接（Create/Update 接受
// sprint_id，CoCo 对标 02 §F）。覆盖：PATCH 挂/清迭代、跨项目 404（不泄露
// 语义）、completed 409（冻结 scope）、换项目自动清空不变式、创建时直接
// 归入与两类拒绝。
func TestSprintIssueWritePath(t *testing.T) {
	projectID := dbfx.Project(t, "Sprint write path project")
	otherProjectID := dbfx.Project(t, "Sprint write path other project")

	active := createSprintViaHandler(t, projectID, map[string]any{"name": "Sprint W-active"})
	if code, body := sprintTransitionViaHandler(t, testHandler.StartSprint, "start", projectID, active.ID); code != http.StatusOK {
		t.Fatalf("start W-active: expected 200, got %d: %s", code, body)
	}
	otherPlanned := createSprintViaHandler(t, otherProjectID, map[string]any{"name": "Sprint W-foreign"})
	frozen := createSprintViaHandler(t, projectID, map[string]any{"name": "Sprint W-frozen"})
	if code, body := sprintTransitionViaHandler(t, testHandler.StartSprint, "start", projectID, frozen.ID); code != http.StatusOK {
		t.Fatalf("start W-frozen: expected 200, got %d: %s", code, body)
	}
	if code, body := sprintTransitionViaHandler(t, testHandler.CompleteSprint, "complete", projectID, frozen.ID); code != http.StatusOK {
		t.Fatalf("complete W-frozen: expected 200, got %d: %s", code, body)
	}

	type sprintShape struct {
		SprintID *string `json:"sprint_id"`
	}
	// 所有 issue 统一走 handler 创建：dbfx.Issue 直插库用 MAX(number)+1 但不
	// 推进 workspace 号器，与 handler 路径的 AllocateIssueNumber 会撞
	// uq_issue_workspace_number。
	create := func(body map[string]any) (*httptest.ResponseRecorder, IssueResponse) {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, body)
		testHandler.CreateIssue(w, req)
		var created IssueResponse
		if w.Code == http.StatusCreated {
			if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
				t.Fatalf("decode create response: %v", err)
			}
			t.Cleanup(func() {
				dw := httptest.NewRecorder()
				dreq := newRequest("DELETE", "/api/issues/"+created.ID, nil)
				dreq = withURLParam(dreq, "id", created.ID)
				testHandler.DeleteIssue(dw, dreq)
			})
		}
		return w, created
	}

	cw, mainIssue := create(map[string]any{"title": "迭代写路径 issue", "project_id": projectID})
	if cw.Code != http.StatusCreated {
		t.Fatalf("create main issue: expected 201, got %d: %s", cw.Code, cw.Body.String())
	}
	issueID := mainIssue.ID

	patch := func(body map[string]any) (*httptest.ResponseRecorder, sprintShape) {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("PATCH", "/api/issues/"+issueID, body)
		req = withURLParams(req, "id", issueID)
		testHandler.UpdateIssue(w, req)
		var resp sprintShape
		if w.Code == http.StatusOK {
			if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
				t.Fatalf("decode patch response: %v", err)
			}
		}
		return w, resp
	}

	// 1) PATCH 挂进本项目 active 迭代 → 200 且响应携带。
	w, resp := patch(map[string]any{"sprint_id": active.ID})
	if w.Code != http.StatusOK {
		t.Fatalf("attach active: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if resp.SprintID == nil || *resp.SprintID != active.ID {
		t.Fatalf("sprint_id = %v, want %s", resp.SprintID, active.ID)
	}

	// 2) 挂跨项目迭代 → 404（不存在/项目错配统一语义，不泄露存在性）。
	if w, _ := patch(map[string]any{"sprint_id": otherPlanned.ID}); w.Code != http.StatusNotFound {
		t.Fatalf("cross-project attach: expected 404, got %d: %s", w.Code, w.Body.String())
	}

	// 3) 挂 completed 迭代 → 409（与成员批量接口 AssignSprintIssues 同拒）。
	if w, _ := patch(map[string]any{"sprint_id": frozen.ID}); w.Code != http.StatusConflict {
		t.Fatalf("completed attach: expected 409, got %d: %s", w.Code, w.Body.String())
	}
	// 两次失败写不得影响现值：迭代归属仍为 active。
	if resp.SprintID == nil || *resp.SprintID != active.ID {
		t.Fatalf("sprint_id after rejected writes = %v, want %s", resp.SprintID, active.ID)
	}

	// 4) 显式 null 移出迭代（回 backlog）。
	w, resp = patch(map[string]any{"sprint_id": nil})
	if w.Code != http.StatusOK {
		t.Fatalf("clear sprint: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if resp.SprintID != nil {
		t.Fatalf("sprint_id after explicit null = %v, want nil", *resp.SprintID)
	}

	// 5) 换项目而未显式处理迭代：迭代是项目作用域，自动清空（与模块同款
	// 不变式）；若不清空，异项目 issue 会残留在原项目迭代的 JOIN 里。
	if w, _ = patch(map[string]any{"sprint_id": active.ID}); w.Code != http.StatusOK {
		t.Fatalf("re-attach: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	w, resp = patch(map[string]any{"project_id": otherProjectID})
	if w.Code != http.StatusOK {
		t.Fatalf("move project: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if resp.SprintID != nil {
		t.Fatalf("sprint_id after project move = %v, want auto-cleared nil", *resp.SprintID)
	}

	// 6) 创建时直接归入本项目迭代 → 201 且携带。
	w, created := create(map[string]any{"title": "建即入迭代", "project_id": projectID, "sprint_id": active.ID})
	if w.Code != http.StatusCreated {
		t.Fatalf("create with sprint: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	if created.SprintID == nil || *created.SprintID != active.ID {
		t.Fatalf("created sprint_id = %v, want %s", created.SprintID, active.ID)
	}

	// 6a) 创建时跨项目迭代 → 404；校验与创建同事务，不会先扣号再失败。
	if w, _ := create(map[string]any{"title": "跨项目迭代创建", "project_id": otherProjectID, "sprint_id": active.ID}); w.Code != http.StatusNotFound {
		t.Fatalf("create cross-project sprint: expected 404, got %d: %s", w.Code, w.Body.String())
	}
	// 6b) 创建时归入 completed 迭代 → 409。
	if w, _ := create(map[string]any{"title": "冻结迭代创建", "project_id": projectID, "sprint_id": frozen.ID}); w.Code != http.StatusConflict {
		t.Fatalf("create into completed sprint: expected 409, got %d: %s", w.Code, w.Body.String())
	}
	// 6c) 无项目带迭代 → 404（「无项目即无迭代」不变式）。
	if w, _ := create(map[string]any{"title": "无项目挂迭代", "sprint_id": active.ID}); w.Code != http.StatusNotFound {
		t.Fatalf("create sprint without project: expected 404, got %d: %s", w.Code, w.Body.String())
	}
}
