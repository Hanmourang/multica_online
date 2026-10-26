package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/featureflag"
)

// 阶段 spec 快照 / 模板 dry-run / 资产准入门禁的 handler×PG 集成测试
// （plan 20261025 §9.3 B-1、B-3、C7）。范式对齐 workflow_handler_test.go：
// 直调 handler + dbfx fixture，真实库跑通 blocked → 补齐资产 → 解除 → 产物落地。

func workflowTestFlags(assetGate, stageSpec bool) *featureflag.Service {
	provider := featureflag.NewStaticProvider()
	provider.Set(featureflags.WorkflowAssetGate, featureflag.Rule{Default: assetGate})
	provider.Set(featureflags.WorkflowStageSpec, featureflag.Rule{Default: stageSpec})
	return featureflag.NewService(provider)
}

// withWorkflowServiceFlags 把 flag 同时打到 handler 与 WorkflowService 上——
// service 侧门禁读的是 svc.FeatureFlags，只改 handler 会静默失效。
func withWorkflowServiceFlags(t *testing.T, assetGate, stageSpec bool) {
	t.Helper()
	ensureWorkflowServiceForTest(t)
	flags := workflowTestFlags(assetGate, stageSpec)
	svc := testHandler.WorkflowService
	origHandler, origSvc := testHandler.FeatureFlags, svc.FeatureFlags
	testHandler.FeatureFlags = flags
	svc.FeatureFlags = flags
	t.Cleanup(func() {
		testHandler.FeatureFlags = origHandler
		svc.FeatureFlags = origSvc
	})
}

// workflowStageByNode 从 detail.stages 里按 node_id 取 stage map。
func workflowStageByNode(t *testing.T, detail map[string]any, nodeID string) map[string]any {
	t.Helper()
	for _, raw := range detail["stages"].([]any) {
		st := raw.(map[string]any)
		if st["node_id"] == nodeID {
			return st
		}
	}
	t.Fatalf("node %s not found in %+v", nodeID, detail["stages"])
	return nil
}

// cocoSpecBearingDefinition 带 goal/criteria/inputTpl/outputTpl 与 gate 标签的最小嵌套文档：
// iteration(s1 human_loop, s2 auto) + gate。
func cocoSpecBearingDefinition() map[string]any {
	return map[string]any{
		"schemaVersion": 2, "kind": "coco.workflow.template", "name": "spec 快照流",
		"nodes": []any{
			map[string]any{
				"kind": "iteration", "id": "it1", "name": "交付环",
				"gate": map[string]any{"id": "g1", "loopLabel": "退回修改", "exitLabel": "通过上线"},
				"children": []any{
					map[string]any{
						"kind": "stage", "id": "s1", "name": "编写方案", "mode": "human_loop", "roleId": "agent-x",
						"goal": "产出可评审方案", "criteria": "覆盖三个验收点", "outputTpl": "markdown 方案",
						"inputs": []any{}, "outputs": []any{map[string]any{"id": "o1", "name": "plan", "type": "markdown"}},
					},
					map[string]any{
						"kind": "stage", "id": "s2", "name": "自动复核", "mode": "auto",
						"inputTpl": "对照 ${inputs.plan}",
						"inputs":   []any{map[string]any{"fromStageId": "s1", "outputId": "o1", "outputName": "plan"}},
						"outputs":  []any{},
					},
				},
			},
		},
	}
}

// TestWorkflowStageSpecSnapshot：definition 的 spec 必须编译进 stage_run 快照并从
// 实例详情回显（§B-1 验收：新实例带 spec，门禁标签随 gate 节点快照回显）。
func TestWorkflowStageSpecSnapshot(t *testing.T) {
	withWorkflowServiceFlags(t, false, true)
	projectID := dbfx.Project(t, "Workflow spec snapshot project")

	code, tpl, body := workflowCreateRaw(t, projectID, map[string]any{"definition": cocoSpecBearingDefinition()})
	if code != http.StatusOK {
		t.Fatalf("create template: expected 200, got %d: %s", code, body)
	}
	tplID := tpl["id"].(string)
	if code := workflowPublish(t, projectID, tplID); code != http.StatusOK {
		t.Fatalf("publish: expected 200, got %d", code)
	}
	code, created, body := workflowCreateInstanceRaw(t, projectID, tplID)
	if code != http.StatusOK {
		t.Fatalf("create instance: expected 200, got %d: %s", code, body)
	}
	detail := workflowInstanceDetail(t, created["id"].(string))

	s1 := workflowStageByNode(t, detail, "s1")
	spec1, _ := s1["spec"].(map[string]any)
	if spec1 == nil {
		t.Fatalf("s1 spec must be snapshotted, got %v", s1["spec"])
	}
	if spec1["goal"] != "产出可评审方案" || spec1["criteria"] != "覆盖三个验收点" ||
		spec1["outputTpl"] != "markdown 方案" {
		t.Fatalf("s1 spec fields mismatched: %+v", spec1)
	}
	// 上游产物声明也要进快照（产物面板 / 准入判定都读它）。
	if outs, _ := s1["outputs"].([]any); len(outs) != 1 {
		t.Fatalf("s1 outputs must carry the declared artifact, got %v", s1["outputs"])
	}

	spec2, _ := workflowStageByNode(t, detail, "s2")["spec"].(map[string]any)
	if spec2 == nil || spec2["inputTpl"] != "对照 ${inputs.plan}" {
		t.Fatalf("s2 spec.inputTpl mismatched: %+v", workflowStageByNode(t, detail, "s2")["spec"])
	}

	// §B4：门禁的 loop/exit 标签随 gate 节点快照回显，UI 才能显示「退回修改/通过上线」。
	gateSpec, _ := workflowStageByNode(t, detail, "g1")["spec"].(map[string]any)
	if gateSpec == nil || gateSpec["loopLabel"] != "退回修改" || gateSpec["exitLabel"] != "通过上线" {
		t.Fatalf("gate labels must reach the snapshot, got %+v", workflowStageByNode(t, detail, "g1")["spec"])
	}
}

// TestWorkflowTemplateDryRunZeroSideEffects：§C7 —— dry-run 只回渲染结果，
// 绝不创建实例/阶段/评论；未解析占位符如实回显；旧扁平模板也能渲染。
func TestWorkflowTemplateDryRunZeroSideEffects(t *testing.T) {
	withWorkflowServiceFlags(t, false, true)
	projectID := dbfx.Project(t, "Workflow dry-run project")
	issueID := dbfx.Issue(t, "dry-run 需求", testutil.Cols{"project_id": projectID})

	code, tpl, body := workflowCreateRaw(t, projectID, map[string]any{"definition": cocoSpecBearingDefinition()})
	if code != http.StatusOK {
		t.Fatalf("create template: expected 200, got %d: %s", code, body)
	}
	tplID := tpl["id"].(string)

	beforeInst := dbfx.Count(t, `SELECT count(*) FROM workflow_instance WHERE project_id = $1`, projectID)
	beforeStage := dbfx.Count(t, `SELECT count(*) FROM workflow_stage_run s
        JOIN workflow_instance w ON w.id = s.instance_id WHERE w.project_id = $1`, projectID)
	beforeComment := dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id = $1`, issueID)

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/workflow/templates/"+tplID+"/dry-run", map[string]any{
		"node_id":  "s2",
		"workitem": map[string]string{"title": "登录改版", "goal": "提升转化"},
	})
	req = withURLParam(req, "tid", tplID)
	testHandler.DryRunWorkflowTemplate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("dry-run: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	out := decodeJSONMap(t, w.Body.String())
	if out["node_id"] != "s2" || out["mode"] != "auto" {
		t.Fatalf("dry-run node identity mismatched: %+v", out)
	}
	prompt, _ := out["prompt"].(string)
	if !strings.Contains(prompt, "## 输入资产") || !strings.Contains(prompt, "对照 stage_run:s1#o1") {
		t.Fatalf("prompt must render the upstream pointer, got %q", prompt)
	}
	if got, _ := out["node_count"].(float64); got != 3 {
		t.Fatalf("node_count = %v, want 3 flattened engine nodes", out["node_count"])
	}

	// 零副作用：实例/阶段/评论行数一律不变。
	if got := dbfx.Count(t, `SELECT count(*) FROM workflow_instance WHERE project_id = $1`, projectID); got != beforeInst {
		t.Fatalf("dry-run must not create instances: %d -> %d", beforeInst, got)
	}
	if got := dbfx.Count(t, `SELECT count(*) FROM workflow_stage_run s
        JOIN workflow_instance w ON w.id = s.instance_id WHERE w.project_id = $1`, projectID); got != beforeStage {
		t.Fatalf("dry-run must not create stage runs: %d -> %d", beforeStage, got)
	}
	if got := dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id = $1`, issueID); got != beforeComment {
		t.Fatalf("dry-run must not create comments: %d -> %d", beforeComment, got)
	}

	// 未知节点 → 404。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/workflow/templates/"+tplID+"/dry-run", map[string]any{"node_id": "nope"})
	req = withURLParam(req, "tid", tplID)
	testHandler.DryRunWorkflowTemplate(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown node: expected 404, got %d: %s", w.Code, w.Body.String())
	}

	// 无 definition 的旧扁平模板：回退 nodes 列渲染，缺省取首节点。
	legacyID := workflowCreateTemplate(t, projectID, map[string]any{
		"name":  "旧扁平模板",
		"nodes": workflowTwoHumanNodes(),
	})["id"].(string)
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/workflow/templates/"+legacyID+"/dry-run", nil)
	req = withURLParam(req, "tid", legacyID)
	testHandler.DryRunWorkflowTemplate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("legacy nodes dry-run: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if got := decodeJSONMap(t, w.Body.String()); got["node_id"] != "n1" {
		t.Fatalf("legacy dry-run should pick the first node, got %+v", got)
	}
}

// cocoAdmissionDefinition：单个 auto 阶段，必检外部资产 architecture + 声明产物 prototype。
func cocoAdmissionDefinition(agentID string) map[string]any {
	return map[string]any{
		"schemaVersion": 2, "kind": "coco.workflow.template", "name": "准入门禁流",
		"nodes": []any{
			map[string]any{
				"kind": "iteration", "id": "it1", "name": "交付环",
				"gate": map[string]any{"id": "g1"},
				"children": []any{
					map[string]any{
						"kind": "stage", "id": "s1", "name": "架构落地", "mode": "auto", "roleId": agentID,
						"prompt": "基于架构文档产出实现", "goal": "补齐架构依赖",
						"inputs": []any{map[string]any{
							"fromStageId": "", "outputName": "architecture", "required": true, "assetRole": "in",
						}},
						"outputs": []any{map[string]any{"id": "o1", "name": "prototype", "type": "html"}},
					},
				},
			},
		},
	}
}

// TestWorkflowAssetGateBlocksLandsAndReevaluates：§B-3 全链——
// 缺件 auto 阶段被 blocked 且详情给出 admission_missing；资产补齐后绑定写路径复评
// 自动解除并派发；阶段完成后声明产物落地成项目资产绑定（幂等）。
func TestWorkflowAssetGateBlocksLandsAndReevaluates(t *testing.T) {
	withWorkflowServiceFlags(t, true, true)
	projectID := dbfx.Project(t, "Workflow asset gate project")
	agentID := createHandlerTestAgent(t, "asset-gate-agent", []byte(`{}`))
	issueID := dbfx.Issue(t, "准入门禁需求", testutil.Cols{"project_id": projectID})

	code, tpl, body := workflowCreateRaw(t, projectID, map[string]any{"definition": cocoAdmissionDefinition(agentID)})
	if code != http.StatusOK {
		t.Fatalf("create template: expected 200, got %d: %s", code, body)
	}
	tplID := tpl["id"].(string)
	if code := workflowPublish(t, projectID, tplID); code != http.StatusOK {
		t.Fatalf("publish: expected 200, got %d", code)
	}

	createInstance := func(templateID string) string {
		t.Helper()
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/projects/"+projectID+"/workflow-instances", map[string]any{
			"template_id": templateID, "issue_id": issueID,
		})
		req = withURLParam(req, "id", projectID)
		testHandler.CreateProjectWorkflowInstance(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("create instance %s: expected 200, got %d: %s", templateID, w.Code, w.Body.String())
		}
		return decodeJSONMap(t, w.Body.String())["id"].(string)
	}
	instID := createInstance(tplID)

	detail := workflowInstanceDetail(t, instID)
	s1 := workflowStageByNode(t, detail, "s1")
	if s1["state"] != "blocked" {
		t.Fatalf("stage must be blocked by missing external asset, got %v", s1["state"])
	}
	missing, _ := s1["admission_missing"].([]any)
	if len(missing) != 1 || missing[0] != "architecture" {
		t.Fatalf("admission_missing = %v, want [architecture]", s1["admission_missing"])
	}
	// 缺件阶段不得越过向后推进：后续 gate 尚未生成。
	if gates, _ := detail["gates"].([]any); len(gates) != 0 {
		t.Fatalf("blocked stage must halt progression, gates=%v", detail["gates"])
	}

	// 手动重新校验：仍缺件时保持 blocked（200 而非 500，UI 可安全轮询）。
	stageID := s1["id"].(string)
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/workflow/stage-runs/"+stageID+"/recheck", nil)
	req = withURLParam(req, "sid", stageID)
	testHandler.RecheckWorkflowStageAdmission(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("recheck while missing: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if still := decodeJSONMap(t, w.Body.String())["state"]; still != "blocked" {
		t.Fatalf("recheck must keep it blocked while the asset is missing, got %v", still)
	}

	// 补齐资产：绑定写路径钩子立即复评 → blocked→pending→派发 running。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+projectID+"/assets", map[string]any{
		"asset_category": "knowledge_repo", "asset_name": "architecture",
	})
	req = withURLParam(req, "id", projectID)
	testHandler.BindProjectAsset(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("bind asset: expected 201, got %d: %s", w.Code, w.Body.String())
	}

	after := workflowStageByNode(t, workflowInstanceDetail(t, instID), "s1")
	if after["state"] != "running" {
		t.Fatalf("asset bound → stage must dispatch, got %v (task_id=%v)", after["state"], after["task_id"])
	}
	if after["task_id"] == nil {
		t.Fatalf("dispatched stage must carry its task")
	}
	// §B2：stage spec 开启后，派发的 prompt 评论里必须带「## 阶段目标」。
	if n := dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id = $1
        AND content LIKE '%## 阶段目标%' AND content LIKE '%补齐架构依赖%'`, issueID); n == 0 {
		t.Fatalf("dispatched prompt must carry the rendered stage spec")
	}

	// 任务终态成功 → 阶段 done + 声明产物落地成 workflow 来源的项目资产绑定（§B3b）。
	taskID, perr := util.ParseUUID(after["task_id"].(string))
	if perr != nil {
		t.Fatalf("parse task id: %v", perr)
	}
	ctx := context.Background()
	if err := testHandler.WorkflowService.OnTaskDone(ctx, taskID, true); err != nil {
		t.Fatalf("OnTaskDone: %v", err)
	}
	countLanding := func() int {
		return dbfx.Count(t, `SELECT count(*) FROM project_asset_binding
            WHERE project_id = $1 AND asset_name = 'prototype' AND source = 'workflow' AND asset_role = 'output'`,
			projectID)
	}
	if n := countLanding(); n != 1 {
		t.Fatalf("declared output must land exactly once, got %d rows", n)
	}
	// 幂等：重复终态不得产生第二行（并发终态/复评复用的护栏）。
	if err := testHandler.WorkflowService.OnTaskDone(ctx, taskID, true); err != nil {
		t.Fatalf("OnTaskDone repeat: %v", err)
	}
	if n := countLanding(); n != 1 {
		t.Fatalf("output landing must be idempotent, got %d rows", n)
	}

	// 终态阶段重新校验 → 409（状态机约束优先于人工重试）。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/workflow/stage-runs/"+stageID+"/recheck", nil)
	req = withURLParam(req, "sid", stageID)
	testHandler.RecheckWorkflowStageAdmission(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("recheck on done stage: expected 409, got %d: %s", w.Code, w.Body.String())
	}

	// 门禁关闭 → 同样的模板照改造前语义直接派发（既不 blocked，也不因门禁而失败）。
	// 换一条全新需求：避开同 agent+同 issue 的 pending task 唯一约束（fixture 复用所致）。
	withWorkflowServiceFlags(t, false, false)
	offIssueID := dbfx.Issue(t, "准入门禁需求（门禁关闭）", testutil.Cols{"project_id": projectID})
	wOff := httptest.NewRecorder()
	reqOff := newRequest("POST", "/api/projects/"+projectID+"/workflow-instances", map[string]any{
		"template_id": tplID, "issue_id": offIssueID,
	})
	reqOff = withURLParam(reqOff, "id", projectID)
	testHandler.CreateProjectWorkflowInstance(wOff, reqOff)
	if wOff.Code != http.StatusOK {
		t.Fatalf("create instance (gate off): expected 200, got %d: %s", wOff.Code, wOff.Body.String())
	}
	instOff := decodeJSONMap(t, wOff.Body.String())["id"].(string)
	if st := workflowStageByNode(t, workflowInstanceDetail(t, instOff), "s1"); st["state"] != "running" {
		t.Fatalf("gate off must dispatch exactly as before the change, got %v", st["state"])
	}
}
