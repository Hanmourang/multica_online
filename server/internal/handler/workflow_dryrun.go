// 工作流模板「测试运行」预览 handler（plan 20261025 §C7，第一代=零副作用渲染预览）。
//
// 边界（务必看清）：本端点**只读模板、只回渲染结果**——不创建实例、不建 stage_run、
// 不写 comment、不入队 task。真正"单阶段试跑"需要 dry-run 派发通道，按计划 §9.5 单列，
// 不在本轮范围。之所以敢叫"测试运行"第一版：用户最痛的是"配了目标/模板不知道最终
// prompt 长什么样"，渲染同源即可闭环这一诉求。
package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/multica-ai/multica/server/internal/service"
)

// dryRunWorkflowTemplateRequest 可选指定要预览哪个节点与 mock 需求上下文。
// node_id 为空时取第一个 auto 节点（无 auto 则取首节点）；workitem 提供
// ${workitem.<key>} 的测试值（内置 id/title/number/goal 可被覆盖）。
type dryRunWorkflowTemplateRequest struct {
	NodeID   string            `json:"node_id"`
	Workitem map[string]string `json:"workitem"`
}

// DryRunWorkflowTemplate POST /api/workflow/templates/{tid}/dry-run
// 编译模板（definition 优先，回退旧扁平 nodes）→ 选节点 → 用与 dispatchStage **同一个**
// composeSpecPrompt 渲染正文，返回 prompt + 未解析占位符清单。
func (h *Handler) DryRunWorkflowTemplate(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	tpl, ok := h.loadWorkflowTemplate(w, r, workspaceID, chi.URLParam(r, "tid"))
	if !ok {
		return
	}
	var body dryRunWorkflowTemplateRequest
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}
	nodes, err := compileWorkflowTemplateNodes(tpl.Definition, tpl.Nodes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	node, found := pickDryRunNode(nodes, body.NodeID)
	if !found {
		writeError(w, http.StatusNotFound, "workflow node not found")
		return
	}
	workitem := map[string]string{
		"id":     "dry-run-workitem",
		"title":  "（测试预览）需求标题",
		"number": "0",
		"goal":   "",
	}
	for k, v := range body.Workitem {
		workitem[k] = v
	}
	prompt, warnings := service.RenderNodePrompt(node, service.RenderInputs{
		ProjectID: uuidToString(tpl.ProjectID),
		Inputs:    service.InputsFromRawNodes(node.Inputs),
		Workitem:  workitem,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"node_id":    node.ID,
		"node_name":  node.Name,
		"mode":       node.Mode,
		"agent_ref":  node.AgentRef,
		"prompt":     prompt,
		"warnings":   warnings,
		"spec":       node.Spec,
		"node_count": len(nodes),
	})
}

// compileWorkflowTemplateNodes 取模板的引擎扁平节点：CoCo definition 优先
// （authoring 是唯一事实源，spec 由 Flatten 编译而来），否则回退旧 nodes 列。
func compileWorkflowTemplateNodes(definition, nodesRaw []byte) ([]service.WorkflowNode, error) {
	if service.IsCocoDefinition(definition) {
		def, err := service.ParseWorkflowDefinition(definition)
		if err != nil {
			return nil, err
		}
		return service.FlattenWorkflowDefinition(def)
	}
	return service.ParseWorkflowNodes(nodesRaw)
}

// pickDryRunNode 按 id 精确取节点；id 为空时取第一个 auto 节点，再退回首节点。
func pickDryRunNode(nodes []service.WorkflowNode, nodeID string) (service.WorkflowNode, bool) {
	if len(nodes) == 0 {
		return service.WorkflowNode{}, false
	}
	if nodeID != "" {
		for _, n := range nodes {
			if n.ID == nodeID {
				return n, true
			}
		}
		return service.WorkflowNode{}, false
	}
	for _, n := range nodes {
		if n.Mode == "auto" {
			return n, true
		}
	}
	return nodes[0], true
}
