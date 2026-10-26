package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// CoCo 工作流模块 handler×PG 集成测试（plan 20261024 §10 V）：导入分支编译、
// 工作区级画廊聚合、强制门控唯一约束。范式对齐 workflow_handler_test.go——直接
// 调 handler，newRequest 带 testWorkspace/testUser 头，dbfx 提供 project fixture。

// cocoDefinitionWithGate 是一份合法的最小 CoCo 嵌套文档：iteration(s1→s2)+gate。
// 展平后应为 3 个引擎节点（s1 human、s2 auto、gate human）。
func cocoDefinitionWithGate(name string) map[string]any {
	return map[string]any{
		"schemaVersion": 2,
		"kind":          "coco.workflow.template",
		"name":          name,
		"description":   "desc",
		"nodes": []any{
			map[string]any{
				"kind": "iteration",
				"id":   "it1",
				"name": "评审环",
				"gate": map[string]any{"id": "g1", "loopLabel": "退回", "exitLabel": "通过"},
				"children": []any{
					map[string]any{"kind": "stage", "id": "s1", "name": "编写", "mode": "human_loop", "roleId": "agent-x", "prompt": "p", "inputs": []any{}, "outputs": []any{}},
					map[string]any{"kind": "stage", "id": "s2", "name": "复核", "mode": "auto", "inputs": []any{map[string]any{"fromStageId": "s1"}}, "outputs": []any{}},
				},
			},
		},
	}
}

func workflowCreateRaw(t *testing.T, projectID string, body map[string]any) (int, map[string]any, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/workflow/templates", body)
	req = withURLParam(req, "id", projectID)
	testHandler.CreateWorkflowTemplate(w, req)
	out := map[string]any{}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out, w.Body.String()
}

func workflowPublish(t *testing.T, projectID, tplID string) int {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectID+"/workflow/templates/"+tplID+"/publish", nil)
	req = withURLParams(req, "id", projectID, "tid", tplID)
	testHandler.PublishWorkflowTemplate(w, req)
	return w.Code
}

func workflowSetEnforceRaw(t *testing.T, tplID string, enforce bool) (int, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("PUT", "/api/workflow/templates/"+tplID+"/enforce", map[string]any{"enforce": enforce})
	req = withURLParam(req, "tid", tplID)
	testHandler.SetWorkflowTemplateEnforce(w, req)
	return w.Code, w.Body.String()
}

func workflowListRaw(t *testing.T, query string) (int, map[string]any, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("GET", "/api/workflow/templates"+query, nil)
	testHandler.ListWorkspaceWorkflowTemplates(w, req)
	out := map[string]any{}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out, w.Body.String()
}

// TestTemplateImportCocoSchema：POST 携 CoCo 嵌套 definition → 服务端校验 + 展平
// 编译出引擎 nodes，回显 definition / stage_flow；非法 definition → 400；JSON 保存
// （PUT definition）改名生效。
func TestTemplateImportCocoSchema(t *testing.T) {
	ensureWorkflowServiceForTest(t)
	projectID := dbfx.Project(t, "CoCo import project")

	// 空白 definition 的非法导入 → 400（nodes 为空）。
	bad := cocoDefinitionWithGate("非法")
	bad["nodes"] = []any{}
	if code, _, body := workflowCreateRaw(t, projectID, map[string]any{"definition": bad}); code != http.StatusBadRequest {
		t.Fatalf("empty nodes import: expected 400, got %d: %s", code, body)
	}

	code, tpl, body := workflowCreateRaw(t, projectID, map[string]any{"definition": cocoDefinitionWithGate("评审流")})
	if code != http.StatusOK {
		t.Fatalf("coco import: expected 200, got %d: %s", code, body)
	}
	if tpl["name"] != "评审流" {
		t.Fatalf("name = %v, want coco 名称回填", tpl["name"])
	}
	if tpl["status"] != "draft" {
		t.Fatalf("status = %v, want draft", tpl["status"])
	}
	if def, ok := tpl["definition"].(map[string]any); !ok || def["kind"] != "coco.workflow.template" {
		t.Fatalf("definition not echoed as coco doc: %v", tpl["definition"])
	}
	flow, _ := tpl["stage_flow"].([]any)
	if len(flow) != 3 {
		t.Fatalf("stage_flow len = %d, want 3 (s1/s2/gate): %s", len(flow), body)
	}
	if flow[0].(map[string]any)["mode"] != "human" {
		t.Fatalf("stage_flow[0].mode = %v, want human", flow[0].(map[string]any)["mode"])
	}

	// JSON 保存（PUT definition）：改名 → 服务端重新校验 + 展平。
	tplID := tpl["id"].(string)
	updated := cocoDefinitionWithGate("评审流 v2")
	w := httptest.NewRecorder()
	req := newRequest("PUT", "/api/workflow/templates/"+tplID+"/definition", map[string]any{"definition": updated})
	req = withURLParam(req, "tid", tplID)
	testHandler.UpdateWorkflowTemplateDefinition(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("update definition: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if got := decodeJSONMap(t, w.Body.String()); got["name"] != "评审流 v2" {
		t.Fatalf("after update name = %v, want 评审流 v2", got["name"])
	}

	// 展平后的 nodes 是合法引擎图：publish 不因节点校验失败。
	if code := workflowPublish(t, projectID, tplID); code != http.StatusOK {
		t.Fatalf("publish imported template: expected 200, got %d", code)
	}
}

// TestWorkspaceTemplateGallery：跨项目聚合 + status_counts + status / scope 过滤
// + archived tab + stage_flow / enforce 字段。
func TestWorkspaceTemplateGallery(t *testing.T) {
	ensureWorkflowServiceForTest(t)
	projectA := dbfx.Project(t, "Gallery project A")
	projectB := dbfx.Project(t, "Gallery project B")

	_, pubA, _ := workflowCreateRaw(t, projectA, map[string]any{"definition": cocoDefinitionWithGate("画廊 A")})
	publishID := pubA["id"].(string)
	if code := workflowPublish(t, projectA, publishID); code != http.StatusOK {
		t.Fatalf("publish A: %d", code)
	}
	_, draftB, _ := workflowCreateRaw(t, projectB, map[string]any{"definition": cocoDefinitionWithGate("画廊 B")})
	draftID := draftB["id"].(string)

	// 基线：本测试至少产出一 published + 一 draft（同工作区可能有历史行，故断下界）。
	code, out, body := workflowListRaw(t, "")
	if code != http.StatusOK {
		t.Fatalf("gallery all: expected 200, got %d: %s", code, body)
	}
	counts := out["status_counts"].(map[string]any)
	if counts["published"].(float64) < 1 || counts["draft"].(float64) < 1 {
		t.Fatalf("status_counts = %v, want published>=1 draft>=1", counts)
	}
	// 过滤 status=draft：结果里不得混入 published 模板。
	if _, draftOut, _ := workflowListRaw(t, "?status=draft"); true {
		for _, raw := range draftOut["templates"].([]any) {
			if tpl := raw.(map[string]any); tpl["status"] != "draft" {
				t.Fatalf("draft filter leaked status=%v", tpl["status"])
			}
		}
	}
	// project_id 过滤命中且仅命中目标项目模板。
	_, aOut, _ := workflowListRaw(t, "?project_id="+projectA)
	for _, raw := range aOut["templates"].([]any) {
		if tpl := raw.(map[string]any); tpl["project_id"] != projectA {
			t.Fatalf("project filter leaked project_id=%v", tpl["project_id"])
		}
	}

	// 归档 draftB → archived tab 命中，all 不再含它。
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+projectB+"/workflow/templates/"+draftID+"/archive", nil)
	req = withURLParams(req, "id", projectB, "tid", draftID)
	testHandler.ArchiveWorkflowTemplate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("archive B: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	_, archOut, _ := workflowListRaw(t, "?status=archived")
	found := false
	for _, raw := range archOut["templates"].([]any) {
		if tpl := raw.(map[string]any); tpl["id"] == draftID {
			found = true
		}
	}
	if !found {
		t.Fatalf("archived tab missing archived template %s", draftID)
	}
}

// TestSetEnforceUnique：enforce 仅 published + 项目专属可置 true；同项目第二个置
// true 撞部分唯一索引 → 409；取消后可再启用；draft / 官方模板不满足前置。
func TestSetEnforceUnique(t *testing.T) {
	ensureWorkflowServiceForTest(t)
	projectID := dbfx.Project(t, "Enforce project")

	_, tpl1, _ := workflowCreateRaw(t, projectID, map[string]any{"definition": cocoDefinitionWithGate("强制一")})
	id1 := tpl1["id"].(string)
	_, tpl2, _ := workflowCreateRaw(t, projectID, map[string]any{"definition": cocoDefinitionWithGate("强制二")})
	id2 := tpl2["id"].(string)

	// draft 不能 enforce → 409 template_not_published。
	if code, body := workflowSetEnforceRaw(t, id1, true); code != http.StatusConflict || !strings.Contains(body, "template_not_published") {
		t.Fatalf("enforce draft: expected 409 template_not_published, got %d: %s", code, body)
	}

	if code := workflowPublish(t, projectID, id1); code != http.StatusOK {
		t.Fatalf("publish 1: %d", code)
	}
	if code, body := workflowSetEnforceRaw(t, id1, true); code != http.StatusOK {
		t.Fatalf("enforce published: expected 200, got %d: %s", code, body)
	}
	if out := decodeJSONMap(t, bodyAfterEnforce(t, id1)); !out["enforce"].(bool) {
		t.Fatalf("after enforce true, enforce flag = %v", out["enforce"])
	}

	// 第二个 published 模板置 true → 唯一约束 409。
	if code := workflowPublish(t, projectID, id2); code != http.StatusOK {
		t.Fatalf("publish 2: %d", code)
	}
	if code, body := workflowSetEnforceRaw(t, id2, true); code != http.StatusConflict || !strings.Contains(body, "workflow_enforce_conflict") {
		t.Fatalf("second enforce: expected 409 workflow_enforce_conflict, got %d: %s", code, body)
	}

	// 取消第一个 → 200，第二个可启用。
	if code, body := workflowSetEnforceRaw(t, id1, false); code != http.StatusOK {
		t.Fatalf("unenforce 1: expected 200, got %d: %s", code, body)
	}
	if code, body := workflowSetEnforceRaw(t, id2, true); code != http.StatusOK {
		t.Fatalf("enforce 2 after unenforce 1: expected 200, got %d: %s", code, body)
	}
}

// bodyAfterEnforce 读取当前模板行（走工作区画廊过滤到该 id），供断言 enforce 落库。
func bodyAfterEnforce(t *testing.T, tplID string) string {
	t.Helper()
	code, out, body := workflowListRaw(t, "")
	if code != http.StatusOK {
		t.Fatalf("gallery for enforce read: %d %s", code, body)
	}
	for _, raw := range out["templates"].([]any) {
		if tpl := raw.(map[string]any); tpl["id"] == tplID {
			b, _ := json.Marshal(tpl)
			return string(b)
		}
	}
	t.Fatalf("template %s not found in gallery", tplID)
	return ""
}
