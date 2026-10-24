package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
)

// 工作流模块 handler×PG 集成测试（CoCo 对标 plan 20261024 §01 V2/V6/V7）。
// 范式对齐 sprint_test.go：直接调 handler，httptest 记录响应；dbfx 提供
// workspace/project fixture。覆盖：模板校验与发布门、实例五层状态机
// （human stage → waiting gate → exit 推进 → done）、CAS 双写冲突 409、
// loop 超限仲裁（round 超 WorkflowGateLoopLimit → 实例收敛 failed）。

func ensureWorkflowServiceForTest(t *testing.T) {
	t.Helper()
	if testHandler.WorkflowService == nil {
		testHandler.WorkflowService = service.NewWorkflowService(
			testHandler.Queries, testPool, testHandler.TaskService, testHandler.Bus, nil,
		)
	}
}

// workflowCreateTemplate POST 模板并断言 200，返回响应 map。
func workflowCreateTemplate(t *testing.T, projectID string, body map[string]any) map[string]any {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/workflow/templates", body)
	req = withURLParam(req, "id", projectID)
	testHandler.CreateWorkflowTemplate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("CreateWorkflowTemplate: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode template: %v", err)
	}
	return out
}

// workflowCreateInstance POST 实例（成功断言 200 返回实例 map；否则返回状态码供调用方断言）。
func workflowCreateInstanceRaw(t *testing.T, projectID, templateID string) (int, map[string]any, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/workflow-instances", map[string]any{
		"template_id": templateID,
	})
	req = withURLParam(req, "id", projectID)
	testHandler.CreateProjectWorkflowInstance(w, req)
	out := map[string]any{}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out, w.Body.String()
}

func workflowInstanceDetail(t *testing.T, instanceID string) map[string]any {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("GET", "/api/workflow-instances/"+instanceID, nil)
	req = withURLParam(req, "iid", instanceID)
	testHandler.GetWorkflowInstanceDetail(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GetWorkflowInstanceDetail: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	return out
}

// workflowStageBySeq 从 detail.stages 里取指定 seq 的 stage map。
func workflowStageBySeq(t *testing.T, detail map[string]any, seq float64) map[string]any {
	t.Helper()
	for _, raw := range detail["stages"].([]any) {
		st := raw.(map[string]any)
		if st["seq"] == seq {
			return st
		}
	}
	t.Fatalf("stage seq %v not found in %+v", seq, detail["stages"])
	return nil
}

// workflowWaitingGate 取 detail.gates 中 state=waiting 的门。
func workflowWaitingGate(t *testing.T, detail map[string]any) map[string]any {
	t.Helper()
	for _, raw := range detail["gates"].([]any) {
		g := raw.(map[string]any)
		if g["state"] == "waiting" {
			return g
		}
	}
	t.Fatalf("no waiting gate in %+v", detail["gates"])
	return nil
}

func workflowTwoHumanNodes() []map[string]any {
	return []map[string]any{
		{"id": "n1", "name": "评审一", "mode": "human", "stage": 1, "next": []string{"n2"}, "gate_doc_types": []string{}},
		{"id": "n2", "name": "评审二", "mode": "human", "stage": 2, "next": []string{}, "gate_doc_types": []string{}},
	}
}

// TestWorkflowTemplateGates：名称/节点校验 → draft 不可开实例 → publish 后可开。
func TestWorkflowTemplateGates(t *testing.T) {
	ensureWorkflowServiceForTest(t)
	projectID := dbfx.Project(t, "Workflow template gates project")

	// 空 name → 400。
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/workflow/templates", map[string]any{"name": "", "nodes": workflowTwoHumanNodes()})
	req = withURLParam(req, "id", projectID)
	testHandler.CreateWorkflowTemplate(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("blank name: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// 有环节点 → 400（ValidateWorkflowNodes 全链在 handler 生效）。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+projectID+"/workflow/templates", map[string]any{
		"name": "有环模板",
		"nodes": []map[string]any{
			{"id": "a", "name": "A", "mode": "auto", "stage": 1, "next": []string{"b"}},
			{"id": "b", "name": "B", "mode": "auto", "stage": 2, "next": []string{"a"}},
		},
	})
	req = withURLParam(req, "id", projectID)
	testHandler.CreateWorkflowTemplate(w, req)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "cycle") {
		t.Fatalf("cyclic nodes: expected 400 cycle, got %d: %s", w.Code, w.Body.String())
	}

	// draft 模板创建实例 → 409 template_not_published。
	tpl := workflowCreateTemplate(t, projectID, map[string]any{"name": "双评审", "nodes": workflowTwoHumanNodes()})
	if tpl["status"] != "draft" {
		t.Fatalf("template status = %v, want draft", tpl["status"])
	}
	tplID := tpl["id"].(string)
	if code, _, body := workflowCreateInstanceRaw(t, projectID, tplID); code != http.StatusConflict || !strings.Contains(body, "template_not_published") {
		t.Fatalf("draft instance: expected 409 template_not_published, got %d: %s", code, body)
	}

	// publish 后实例可创建。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+projectID+"/workflow/templates/"+tplID+"/publish", nil)
	req = withURLParams(req, "id", projectID, "tid", tplID)
	testHandler.PublishWorkflowTemplate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("publish: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if pub := decodeJSONMap(t, w.Body.String()); pub["status"] != "published" {
		t.Fatalf("after publish status = %v", pub["status"])
	}
	code, created, body := workflowCreateInstanceRaw(t, projectID, tplID)
	if code != http.StatusOK {
		t.Fatalf("create instance after publish: expected 200, got %d: %s", code, body)
	}
	if created["status"] != "running" {
		t.Fatalf("instance status = %v, want running (human 首节点同步派发)", created["status"])
	}
}

func decodeJSONMap(t *testing.T, body string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}
	return out
}

// TestWorkflowInstanceLifecycle：五层状态机正链 + CAS 冲突 + 生命周期门。
func TestWorkflowInstanceLifecycle(t *testing.T) {
	ensureWorkflowServiceForTest(t)
	projectID := dbfx.Project(t, "Workflow lifecycle project")
	tpl := workflowCreateTemplate(t, projectID, map[string]any{"name": "生命周期", "nodes": workflowTwoHumanNodes()})
	tplID := tpl["id"].(string)

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/workflow/templates/"+tplID+"/publish", nil)
	req = withURLParams(req, "id", projectID, "tid", tplID)
	testHandler.PublishWorkflowTemplate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("publish: %d %s", w.Code, w.Body.String())
	}

	code, created, body := workflowCreateInstanceRaw(t, projectID, tplID)
	if code != http.StatusOK {
		t.Fatalf("create instance: expected 200, got %d: %s", code, body)
	}
	instanceID := created["id"].(string)

	// human 首节点：stage1 waiting_gate + 一个 round1 waiting 门；stage2 pending。
	detail := workflowInstanceDetail(t, instanceID)
	stage1 := workflowStageBySeq(t, detail, 1)
	stage2 := workflowStageBySeq(t, detail, 2)
	if stage1["state"] != "waiting_gate" || stage2["state"] != "pending" {
		t.Fatalf("after create: stage1=%v stage2=%v, want waiting_gate/pending", stage1["state"], stage2["state"])
	}
	gate := workflowWaitingGate(t, detail)
	if gate["round"].(float64) != 1 {
		t.Fatalf("first gate round = %v, want 1", gate["round"])
	}

	// running 可 pause；重复 pause（CAS 未命中 / 状态门）→ 409；paused 可 resume。
	transition := func(action string) (int, string) {
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/workflow-instances/"+instanceID+"/"+action, nil)
		req = withURLParam(req, "iid", instanceID)
		switch action {
		case "pause":
			testHandler.PauseWorkflowInstance(w, req)
		case "resume":
			testHandler.ResumeWorkflowInstance(w, req)
		default:
			t.Fatalf("unknown action %s", action)
		}
		return w.Code, w.Body.String()
	}
	if code, body := transition("pause"); code != http.StatusOK {
		t.Fatalf("pause: expected 200, got %d: %s", code, body)
	}
	if code, body := transition("pause"); code != http.StatusConflict {
		t.Fatalf("double pause: expected 409, got %d: %s", code, body)
	}
	if code, body := transition("resume"); code != http.StatusOK {
		t.Fatalf("resume: expected 200, got %d: %s", code, body)
	}

	// approve stage1（exit 门）→ stage1 done、stage2 顶上 waiting_gate。
	approve := func(stageID string) (int, string) {
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/workflow/stage-runs/"+stageID+"/approve", nil)
		req = withURLParam(req, "sid", stageID)
		testHandler.ApproveWorkflowStage(w, req)
		return w.Code, w.Body.String()
	}
	if code, body := approve(stage1["id"].(string)); code != http.StatusOK {
		t.Fatalf("approve stage1: expected 200, got %d: %s", code, body)
	}
	detail = workflowInstanceDetail(t, instanceID)
	if workflowStageBySeq(t, detail, 1)["state"] != "done" {
		t.Fatalf("stage1 after approve = %v, want done", workflowStageBySeq(t, detail, 1)["state"])
	}
	stage2 = workflowStageBySeq(t, detail, 2)
	if stage2["state"] != "waiting_gate" {
		t.Fatalf("stage2 after stage1 approve = %v, want waiting_gate", stage2["state"])
	}

	// 无 waiting 门的 stage 再 approve → 409 no_waiting_gate（stage2 的门已被 detail 认定）。
	if code, body := approve(stage1["id"].(string)); code != http.StatusConflict || !strings.Contains(body, "no_waiting_gate") {
		t.Fatalf("approve decided stage: expected 409 no_waiting_gate, got %d: %s", code, body)
	}

	// approve stage2 → 全 stage 终态，实例收尾 done。
	if code, body := approve(stage2["id"].(string)); code != http.StatusOK {
		t.Fatalf("approve stage2: expected 200, got %d: %s", code, body)
	}
	detail = workflowInstanceDetail(t, instanceID)
	if inst := detail["instance"].(map[string]any); inst["status"] != "done" {
		t.Fatalf("instance after final approve = %v, want done", inst["status"])
	}

	// 终态生命周期门：done 实例 pause → 409。
	if code, body := transition("pause"); code != http.StatusConflict {
		t.Fatalf("pause on done: expected 409, got %d: %s", code, body)
	}
}

// TestWorkflowGateLoopLimit：loop 超限仲裁（§00 铁律）——round 超过
// WorkflowGateLoopLimit 后新门被取消、实例收敛 failed，而不是无限回炉。
func TestWorkflowGateLoopLimit(t *testing.T) {
	ensureWorkflowServiceForTest(t)
	projectID := dbfx.Project(t, "Workflow loop limit project")
	nodes := []map[string]any{
		{"id": "n1", "name": "单评审", "mode": "human", "stage": 1, "next": []string{}, "gate_doc_types": []string{}},
	}
	tpl := workflowCreateTemplate(t, projectID, map[string]any{"name": "单节点环", "nodes": nodes})
	tplID := tpl["id"].(string)

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/workflow/templates/"+tplID+"/publish", nil)
	req = withURLParams(req, "id", projectID, "tid", tplID)
	testHandler.PublishWorkflowTemplate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("publish: %d %s", w.Code, w.Body.String())
	}
	code, created, body := workflowCreateInstanceRaw(t, projectID, tplID)
	if code != http.StatusOK {
		t.Fatalf("create instance: %d %s", code, body)
	}
	instanceID := created["id"].(string)

	decideLoop := func(gateID string) (int, map[string]any, string) {
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/workflow/gate-runs/"+gateID+"/decide", map[string]any{"decision": "loop"})
		req = withURLParam(req, "gid", gateID)
		testHandler.DecideWorkflowGate(w, req)
		out := map[string]any{}
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out, w.Body.String()
	}

	gateID := workflowWaitingGate(t, workflowInstanceDetail(t, instanceID))["id"].(string)
	// round 1→2→3 都在限内：每次 loop 产出 round+1 的新 waiting 门。
	for wantRound := 2.0; wantRound <= float64(service.WorkflowGateLoopLimit+1); wantRound++ {
		code, out, body := decideLoop(gateID)
		if code != http.StatusOK {
			t.Fatalf("loop to round %v: expected 200, got %d: %s", wantRound, code, body)
		}
		newGate := out["gate"].(map[string]any)
		if newGate["round"].(float64) != wantRound {
			t.Fatalf("loop gate round = %v, want %v", newGate["round"], wantRound)
		}
		if wantRound <= float64(service.WorkflowGateLoopLimit) {
			if inst := out["instance"].(map[string]any); inst["status"] != "running" {
				t.Fatalf("within limit: instance status = %v, want running", inst["status"])
			}
		}
		gateID = newGate["id"].(string)
	}
	// 最后一次 loop 把 round 推到 limit+1：新门被取消、实例 failed（超限不再返回 waiting 门）。
	detail := workflowInstanceDetail(t, instanceID)
	if inst := detail["instance"].(map[string]any); inst["status"] != "failed" {
		t.Fatalf("after over-limit loop: instance = %v, want failed", inst["status"])
	}
}

// TestWorkflowIssueReverseLookup 需求抽屉反查（计划 §G，对标 CoCo
// instancesByWorkitem）：带 issue_id 创建实例后 GET /api/issues/{id}/
// workflow-instances 可查到；无关 issue 互不串扰；不存在 issue → 404。
func TestWorkflowIssueReverseLookup(t *testing.T) {
	ensureWorkflowServiceForTest(t)
	projectID := dbfx.Project(t, "Workflow issue lookup project")

	tpl := workflowCreateTemplate(t, projectID, map[string]any{"name": "反查模板", "nodes": workflowTwoHumanNodes()})
	tplID := tpl["id"].(string)
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/workflow/templates/"+tplID+"/publish", nil)
	req = withURLParams(req, "id", projectID, "tid", tplID)
	testHandler.PublishWorkflowTemplate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("publish: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	issueID := dbfx.Issue(t, "工作流反查需求")
	otherIssueID := dbfx.Issue(t, "无关需求")

	// 抽屉发起同路径：创建实例带 issue_id → root_issue_id 桥接。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+projectID+"/workflow-instances", map[string]any{
		"template_id": tplID,
		"issue_id":    issueID,
	})
	req = withURLParam(req, "id", projectID)
	testHandler.CreateProjectWorkflowInstance(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create instance with issue: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	instID := decodeJSONMap(t, w.Body.String())["id"].(string)

	listByIssue := func(id string) (int, map[string]any, string) {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("GET", "/api/issues/"+id+"/workflow-instances", nil)
		req = withURLParam(req, "id", id)
		testHandler.ListIssueWorkflowInstances(w, req)
		out := map[string]any{}
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out, w.Body.String()
	}

	code, out, body := listByIssue(issueID)
	if code != http.StatusOK {
		t.Fatalf("reverse lookup: expected 200, got %d: %s", code, body)
	}
	rows, _ := out["instances"].([]any)
	if len(rows) != 1 {
		t.Fatalf("instances len = %v, want 1 (%s)", len(rows), body)
	}
	row0 := rows[0].(map[string]any)
	if row0["id"] != instID || row0["root_issue_id"] != issueID || row0["project_id"] != projectID {
		t.Fatalf("row identity = %v/%v/%v", row0["id"], row0["root_issue_id"], row0["project_id"])
	}
	if counts := out["status_counts"].(map[string]any); counts["running"] != float64(1) {
		t.Fatalf("status_counts = %v, want running=1", counts)
	}

	// 无关 issue 不被其他实例串扰；不存在 issue → 404。
	code, out, body = listByIssue(otherIssueID)
	rows, _ = out["instances"].([]any)
	if code != http.StatusOK || len(rows) != 0 {
		t.Fatalf("other issue: expected 200 empty, got %d %s", code, body)
	}
	if code, _, _ := listByIssue("00000000-0000-0000-0000-000000000000"); code != http.StatusNotFound {
		t.Fatalf("missing issue: expected 404, got %d", code)
	}
}
