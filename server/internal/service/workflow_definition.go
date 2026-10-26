// CoCo 嵌套 authoring schema（coco.workflow.template）适配器（plan 20261024 §2，Agent-W）。
//
// 铁律：运行时引擎只认扁平 WorkflowNode（Instance/StageRun/GateRun + 468/469
// 已验证），本文件负责「authoring → 引擎」的编译，不改引擎。CoCo 原文整体存
// workflow_template.definition JSONB，展平产物写 workflow_template.nodes。
//
// 展平语义（与引擎对齐）：引擎按 node.stage 升序把节点物化成 stage_run（seq=下标
// +1）并线性推进；loop 回环由 GateRun 的 round CAS 机制承担，不靠图回边——所以展平
// 出的图必须是线性无环（gate 作为 human 节点接在 iteration 末尾即可）。
package service

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// CocoWorkflowTemplateKind 是 CoCo authoring 文档的 kind 判别值。
const CocoWorkflowTemplateKind = "coco.workflow.template"

// WorkflowDefinition 是 workflow_template.definition JSONB 的 CoCo 嵌套形态。
type WorkflowDefinition struct {
	SchemaVersion int               `json:"schemaVersion"`
	Kind          string            `json:"kind"`
	Name          string            `json:"name"`
	Description   string            `json:"description"`
	Nodes         []DefinitionNode  `json:"nodes"`
	RoleNames     map[string]string `json:"roleNames,omitempty"`
}

// DefinitionNode 是嵌套树节点。kind ∈ stage|iteration|parallel|branch。
// stage 为叶子（执行单元）；iteration/parallel/branch 为容器，children 承载子节点。
type DefinitionNode struct {
	Kind     string             `json:"kind"`
	ID       string             `json:"id"`
	Name     string             `json:"name"`
	Mode     string             `json:"mode,omitempty"`   // auto | human_loop
	RoleID   string             `json:"roleId,omitempty"` // 执行智能体（映射 WorkflowNode.AgentRef）
	Prompt   string             `json:"prompt,omitempty"`
	Children []DefinitionNode   `json:"children,omitempty"`
	Gate     *DefinitionGate    `json:"gate,omitempty"`
	Inputs   []DefinitionInput  `json:"inputs,omitempty"`
	Outputs  []DefinitionOutput `json:"outputs,omitempty"`
	// 阶段目标管理（plan 101 C4）与输入/输出模板（C3）：authoring 层携带，原样存 definition。
	Goal      string `json:"goal,omitempty"`
	Criteria  string `json:"criteria,omitempty"`
	InputTpl  string `json:"inputTpl,omitempty"`
	OutputTpl string `json:"outputTpl,omitempty"`
}

// DefinitionGate 是 iteration 的人工审批门（loop 继续 / exit 退出）。
type DefinitionGate struct {
	ID        string `json:"id"`
	Mode      string `json:"mode,omitempty"`
	LoopLabel string `json:"loopLabel,omitempty"`
	ExitLabel string `json:"exitLabel,omitempty"`
}

// DefinitionInput 引用上游 stage 的产物（fromStageId 必须指向树内某 stage id）。
// AssetRole/Required（plan 101 C5）：required 且非 out 的输入 = 执行前必检项，
// 展平时回写 WorkflowNode.GateDocTypes 供运行时准入门禁消费。
type DefinitionInput struct {
	FromStageID string `json:"fromStageId,omitempty"`
	OutputID    string `json:"outputId,omitempty"`
	OutputName  string `json:"outputName,omitempty"`
	AssetRole   string `json:"assetRole,omitempty"` // in | out
	Required    bool   `json:"required,omitempty"`  // 执行前必检
}

// DefinitionOutput 是 stage 产出的交付物。
type DefinitionOutput struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Type        string `json:"type,omitempty"`
	Description string `json:"description,omitempty"`
}

// StageSpec 是随阶段一并**物化进 stage_run.spec** 的执行期元数据（plan 20261025 §B1）。
//
// 之前的缺口：authoring 层的 goal/criteria/inputTpl/outputTpl 只活在 definition 里，
// Flatten 不携带 → 引擎看不到，导致「能存不能跑」。本结构把这四个字段编译进扁平节点，
// 实例创建时快照落库，运行期（prompt 渲染 / 流程把控视图 / 门禁佐证）只读快照、
// 不回读模板，保证 template_version 一致性。
//
// 全空时调用方须置 nil（见 stageSpecOf），让旧模板的 nodes JSON 形状逐字不变。
type StageSpec struct {
	Goal      string `json:"goal,omitempty"`
	Criteria  string `json:"criteria,omitempty"`
	InputTpl  string `json:"inputTpl,omitempty"`
	OutputTpl string `json:"outputTpl,omitempty"`
	// LoopLabel / ExitLabel 只对 gate 节点有意义（plan 20261025 §B4）：把模板自定义的
	// 「再来一轮 / 结束迭代」按钮文案随快照带运行，前端裁决面板直接用，不必从 prompt 反推。
	LoopLabel string `json:"loopLabel,omitempty"`
	ExitLabel string `json:"exitLabel,omitempty"`
}

// stageSpecOf 从 authoring stage 抽出执行期 spec；全空返回 nil。
func stageSpecOf(n DefinitionNode) *StageSpec {
	if n.Goal == "" && n.Criteria == "" && n.InputTpl == "" && n.OutputTpl == "" {
		return nil
	}
	return &StageSpec{Goal: n.Goal, Criteria: n.Criteria, InputTpl: n.InputTpl, OutputTpl: n.OutputTpl}
}

// IsCocoDefinition 探测 raw 是否为 CoCo 嵌套 authoring 文档（区别于扁平 nodes 数组）：
// 顶层是 object，且 kind==coco.workflow.template 或 schemaVersion>0。
func IsCocoDefinition(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	var probe struct {
		Kind          string `json:"kind"`
		SchemaVersion int    `json:"schemaVersion"`
	}
	if err := json.Unmarshal(trimmed, &probe); err != nil {
		return false
	}
	return probe.Kind == CocoWorkflowTemplateKind || probe.SchemaVersion > 0
}

// ParseWorkflowDefinition 反序列化 CoCo 嵌套文档。
func ParseWorkflowDefinition(raw []byte) (*WorkflowDefinition, error) {
	var def WorkflowDefinition
	if err := json.Unmarshal(raw, &def); err != nil {
		return nil, fmt.Errorf("invalid definition json: %w", err)
	}
	return &def, nil
}

// ValidateWorkflowDefinition 是模板写入的结构闸门（raw 为 CoCo 嵌套 JSON）：
//   - schemaVersion 正整数、kind 合法；
//   - 递归收集 id：非空、全局唯一（含 gate id）；
//   - kind ∈ {stage,iteration,parallel,branch}；mode（若给）∈ {auto,human_loop}；
//   - gate 只允许挂在 iteration，且 id 非空（结构上至多一个）；
//   - inputs[].fromStageId 必须引用树内某 stage 的 id；
//   - 展平后复用 ValidateWorkflowNodes（节点数 1..50、mode、无环、next 引用）。
func ValidateWorkflowDefinition(raw []byte) error {
	def, err := ParseWorkflowDefinition(raw)
	if err != nil {
		return err
	}
	return def.Validate()
}

// Validate 在已解析的文档上跑结构校验。
func (d *WorkflowDefinition) Validate() error {
	if d.SchemaVersion <= 0 {
		return fmt.Errorf("schemaVersion must be a positive integer")
	}
	if d.Kind != "" && d.Kind != CocoWorkflowTemplateKind {
		return fmt.Errorf("kind must be %q, got %q", CocoWorkflowTemplateKind, d.Kind)
	}
	if len(d.Nodes) == 0 {
		return fmt.Errorf("definition must contain at least one node")
	}
	ids := make(map[string]bool)
	stageIDs := make(map[string]bool)
	if err := d.collectAndCheck(d.Nodes, ids, stageIDs); err != nil {
		return err
	}
	if err := d.checkRefs(d.Nodes, stageIDs); err != nil {
		return err
	}
	flat, err := d.Flatten()
	if err != nil {
		return err
	}
	raw2, merr := json.Marshal(flat)
	if merr != nil {
		return fmt.Errorf("flatten result not marshalable: %w", merr)
	}
	return ValidateWorkflowNodes(raw2)
}

// collectAndCheck 递归校验 id/kind/mode/gate 结构，并登记全部 id 与 stage id 集合。
func (d *WorkflowDefinition) collectAndCheck(nodes []DefinitionNode, ids, stageIDs map[string]bool) error {
	for _, n := range nodes {
		if n.ID == "" {
			return fmt.Errorf("node id must not be empty")
		}
		if ids[n.ID] {
			return fmt.Errorf("duplicate node id %q", n.ID)
		}
		ids[n.ID] = true
		switch n.Kind {
		case "stage", "iteration", "parallel", "branch":
		default:
			return fmt.Errorf("node %q has invalid kind %q", n.ID, n.Kind)
		}
		if n.Mode != "" && n.Mode != "auto" && n.Mode != "human_loop" {
			return fmt.Errorf("node %q mode must be auto or human_loop, got %q", n.ID, n.Mode)
		}
		if n.Kind == "stage" {
			stageIDs[n.ID] = true
		}
		if n.Gate != nil {
			if n.Kind != "iteration" {
				return fmt.Errorf("node %q of kind %q cannot carry a gate", n.ID, n.Kind)
			}
			if n.Gate.ID == "" {
				return fmt.Errorf("iteration %q gate must have an id", n.ID)
			}
			if ids[n.Gate.ID] {
				return fmt.Errorf("duplicate node id %q (gate of %q)", n.Gate.ID, n.ID)
			}
			ids[n.Gate.ID] = true
		}
		if len(n.Children) > 0 {
			if err := d.collectAndCheck(n.Children, ids, stageIDs); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkRefs 递归校验 inputs[].fromStageId 指向已知 stage。
func (d *WorkflowDefinition) checkRefs(nodes []DefinitionNode, stageIDs map[string]bool) error {
	for _, n := range nodes {
		for _, in := range n.Inputs {
			if in.FromStageID == "" {
				continue
			}
			if !stageIDs[in.FromStageID] {
				return fmt.Errorf("node %q input references unknown fromStageId %q", n.ID, in.FromStageID)
			}
		}
		if len(n.Children) > 0 {
			if err := d.checkRefs(n.Children, stageIDs); err != nil {
				return err
			}
		}
	}
	return nil
}

// FlattenWorkflowDefinition 树→线性引擎节点（plan §2）。
func FlattenWorkflowDefinition(def *WorkflowDefinition) ([]WorkflowNode, error) {
	return def.Flatten()
}

// Flatten 按深度优先展开成线性 WorkflowNode 序列，再统一编排 stage/next：
//   - stage：直映（human_loop→human，roleId→AgentRef，inputs/outputs 原样透传）；
//   - iteration：children 顺序展开，gate 作为 human 节点接在末尾（loop 由运行期承担）；
//   - parallel：各 branch 的 children 依次拼接（线性引擎降级：并行→顺序汇聚）；
//   - branch：展开其 children。
//
// 末尾把 stage 重编为 1..N，next=[后继 id]（最后一个 next 为空）→ 天然无环。
func (d *WorkflowDefinition) Flatten() ([]WorkflowNode, error) {
	var flat []WorkflowNode
	var walk func(nodes []DefinitionNode) error
	walk = func(nodes []DefinitionNode) error {
		for _, n := range nodes {
			switch n.Kind {
			case "stage":
				flat = append(flat, flattenStage(n))
			case "iteration":
				if err := walk(n.Children); err != nil {
					return err
				}
				if n.Gate != nil {
					flat = append(flat, flattenGate(n))
				}
			case "parallel", "branch":
				// parallel 的 children 是 branch；branch 的 children 是子节点。
				// 两者都只是把子节点按顺序并入线性流（汇聚语义）。
				if err := walk(n.Children); err != nil {
					return err
				}
			default:
				return fmt.Errorf("cannot flatten node %q of kind %q", n.ID, n.Kind)
			}
		}
		return nil
	}
	if err := walk(d.Nodes); err != nil {
		return nil, err
	}
	for i := range flat {
		flat[i].Stage = i + 1
		if i+1 < len(flat) {
			flat[i].Next = []string{flat[i+1].ID}
		} else {
			flat[i].Next = []string{}
		}
	}
	return flat, nil
}

// flattenStage 把一个 stage 映射成引擎扁平节点（不含 stage/next，由 Flatten 统一编排）。
func flattenStage(n DefinitionNode) WorkflowNode {
	mode := "auto"
	if n.Mode == "human_loop" {
		mode = "human"
	}
	prompt := n.Prompt
	return WorkflowNode{
		ID:           n.ID,
		Name:         n.Name,
		Mode:         mode,
		AgentRef:     n.RoleID,
		Prompt:       prompt,
		GateDocTypes: requiredGateDocTypes(n.Inputs),
		Next:         []string{},
		Inputs:       passthroughAny(n.Inputs),
		Outputs:      passthroughAny(n.Outputs),
		// 阶段目标/达成判定/输入输出模板编译进扁平节点，随实例快照落 stage_run.spec
		// （plan 20261025 §B1）。旧模板无这些字段时为 nil，nodes 形状不变。
		Spec: stageSpecOf(n),
	}
}

// requiredGateDocTypes 把 required 且非 out 的输入抽成执行前必检资产名清单
// （plan 101 C5：映射到引擎 WorkflowNode.GateDocTypes）。无则返回空切片。
func requiredGateDocTypes(inputs []DefinitionInput) []string {
	out := []string{}
	for _, in := range inputs {
		if !in.Required || in.AssetRole == "out" {
			continue
		}
		name := in.OutputName
		if name == "" {
			name = in.OutputID
		}
		if name != "" {
			out = append(out, name)
		}
	}
	return out
}

// flattenGate 把 iteration 的门映射成一个 human 节点，接在该 iteration 展开末尾。
func flattenGate(iter DefinitionNode) WorkflowNode {
	g := iter.Gate
	name := g.ID
	if iter.Name != "" {
		name = iter.Name + " · 审批门"
	}
	prompt := g.LoopLabel
	if g.ExitLabel != "" {
		if prompt != "" {
			prompt += " / "
		}
		prompt += g.ExitLabel
	}
	return WorkflowNode{
		ID:           g.ID,
		Name:         name,
		Mode:         "human",
		Prompt:       prompt,
		GateDocTypes: []string{},
		Next:         []string{},
		// 门标签随快照携带，供裁决面板按钮文案使用（§B4）；两个标签都空时置 nil。
		Spec: gateSpecOf(g),
	}
}

// gateSpecOf 把 iteration 门的自定义按钮文案编成执行期快照；全空返回 nil（零回归）。
func gateSpecOf(g *DefinitionGate) *StageSpec {
	if g == nil || (g.LoopLabel == "" && g.ExitLabel == "") {
		return nil
	}
	return &StageSpec{LoopLabel: g.LoopLabel, ExitLabel: g.ExitLabel}
}

// passthroughAny 把带 json tag 的切片原样转成 []any（保留 CoCo 键名，供引擎/前端读回）。
// 空切片返回 nil，交给 jsonNullIfEmpty 落库为 NULL。
func passthroughAny(v any) []any {
	b, err := json.Marshal(v)
	if err != nil || bytes.Equal(b, []byte("null")) || bytes.Equal(b, []byte("[]")) {
		return nil
	}
	var out []any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil
	}
	return out
}
