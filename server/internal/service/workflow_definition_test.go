package service

import (
	"strings"
	"testing"
)

// plan 20261024 §2：CoCo 嵌套 authoring schema 适配器单测。
// golden fixture 覆盖全部 kind（stage/iteration+gate/parallel/branch）、
// fromStageId 跨层引用、human_loop→human 映射、roleNames。断言校验通过 +
// 展平 stage 数/顺序/mode/gate 位置/线性 next。

const cocoGolden = `{
  "schemaVersion": 2,
  "kind": "coco.workflow.template",
  "name": "需求交付流",
  "description": "对标 CoCo 的迭代+并行门控模板",
  "nodes": [
    {
      "kind": "iteration",
      "id": "iter-req",
      "name": "需求澄清",
      "children": [
        { "kind": "stage", "id": "st-analyze", "name": "需求分析", "mode": "auto", "roleId": "role-pm",
          "prompt": "分析需求产出 PRD",
          "outputs": [ { "id": "out-prd", "name": "PRD", "type": "doc", "description": "需求文档" } ] },
        { "kind": "stage", "id": "st-review", "name": "需求评审", "mode": "human_loop", "roleId": "role-lead",
          "inputs": [ { "fromStageId": "st-analyze", "outputId": "out-prd", "outputName": "PRD" } ] }
      ],
      "gate": { "id": "gate-req", "mode": "human_loop", "loopLabel": "继续澄清", "exitLabel": "确认通过" }
    },
    {
      "kind": "parallel",
      "id": "par-dev",
      "name": "并行研发",
      "children": [
        { "kind": "branch", "id": "br-fe", "name": "前端", "children": [
          { "kind": "stage", "id": "st-fe", "name": "前端实现", "mode": "auto", "roleId": "role-fe",
            "inputs": [ { "fromStageId": "st-analyze", "outputId": "out-prd" } ] }
        ] },
        { "kind": "branch", "id": "br-be", "name": "后端", "children": [
          { "kind": "stage", "id": "st-be", "name": "后端实现", "mode": "auto", "roleId": "role-be" }
        ] }
      ]
    },
    { "kind": "stage", "id": "st-ship", "name": "发布", "mode": "human_loop", "roleId": "role-lead" }
  ],
  "roleNames": { "role-pm": "产品经理", "role-lead": "技术负责人", "role-fe": "前端工程师", "role-be": "后端工程师" }
}`

func TestIsCocoDefinitionDetectsNestedSchema(t *testing.T) {
	if !IsCocoDefinition([]byte(cocoGolden)) {
		t.Fatal("expected golden fixture to be detected as a CoCo definition")
	}
	// 扁平 nodes 数组 / 空 / 非 object 都不算。
	if IsCocoDefinition([]byte(`[{"id":"a"}]`)) {
		t.Error("flat nodes array must not be treated as CoCo definition")
	}
	if IsCocoDefinition([]byte(`{}`)) {
		t.Error("empty object without kind/schemaVersion must not be treated as CoCo definition")
	}
	if IsCocoDefinition([]byte(`{"schemaVersion":2}`)) == false {
		t.Error("schemaVersion>0 alone must be treated as CoCo definition")
	}
}

func TestValidateWorkflowDefinitionAcceptsGolden(t *testing.T) {
	if err := ValidateWorkflowDefinition([]byte(cocoGolden)); err != nil {
		t.Fatalf("golden fixture should validate, got %v", err)
	}
}

func TestFlattenWorkflowDefinitionGoldenShape(t *testing.T) {
	def, err := ParseWorkflowDefinition([]byte(cocoGolden))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	flat, err := FlattenWorkflowDefinition(def)
	if err != nil {
		t.Fatalf("flatten: %v", err)
	}

	wantIDs := []string{"st-analyze", "st-review", "gate-req", "st-fe", "st-be", "st-ship"}
	if len(flat) != len(wantIDs) {
		t.Fatalf("flatten count = %d, want %d (%+v)", len(flat), len(wantIDs), flatIDs(flat))
	}
	for i, id := range wantIDs {
		if flat[i].ID != id {
			t.Fatalf("order mismatch at %d: got %q want %q (all=%v)", i, flat[i].ID, id, flatIDs(flat))
		}
		if flat[i].Stage != i+1 {
			t.Errorf("node %q stage = %d, want %d", flat[i].ID, flat[i].Stage, i+1)
		}
		wantNext := []string{}
		if i+1 < len(flat) {
			wantNext = []string{wantIDs[i+1]}
		}
		if strings.Join(flat[i].Next, ",") != strings.Join(wantNext, ",") {
			t.Errorf("node %q next = %v, want %v", flat[i].ID, flat[i].Next, wantNext)
		}
	}

	// mode 映射：human_loop→human，auto→auto，gate→human。
	wantModes := map[string]string{
		"st-analyze": "auto", "st-review": "human", "gate-req": "human",
		"st-fe": "auto", "st-be": "auto", "st-ship": "human",
	}
	for _, n := range flat {
		if want, ok := wantModes[n.ID]; ok && n.Mode != want {
			t.Errorf("node %q mode = %q, want %q", n.ID, n.Mode, want)
		}
	}

	// agent_ref 来自 roleId；gate 节点无 roleId。
	for _, n := range flat {
		if n.ID == "gate-req" {
			if n.AgentRef != "" {
				t.Errorf("gate node should carry no agent_ref, got %q", n.AgentRef)
			}
			continue
		}
		if n.AgentRef == "" {
			t.Errorf("stage node %q lost agent_ref", n.ID)
		}
	}

	// inputs/outputs 透传：st-analyze 有 1 个 output，st-review/st-fe 各 1 个 input。
	byID := map[string]WorkflowNode{}
	for _, n := range flat {
		byID[n.ID] = n
	}
	if got := len(byID["st-analyze"].Outputs); got != 1 {
		t.Errorf("st-analyze outputs = %d, want 1", got)
	}
	if got := len(byID["st-review"].Inputs); got != 1 {
		t.Errorf("st-review inputs = %d, want 1", got)
	}
	if got := len(byID["st-fe"].Inputs); got != 1 {
		t.Errorf("st-fe inputs = %d, want 1", got)
	}
}

func TestValidateWorkflowDefinitionRejectsViolations(t *testing.T) {
	cases := map[string]struct {
		raw  string
		want string
	}{
		"unknown fromStageId": {
			raw:  `{"schemaVersion":2,"kind":"coco.workflow.template","nodes":[{"kind":"stage","id":"a","name":"A","mode":"auto","inputs":[{"fromStageId":"ghost"}]}]}`,
			want: "unknown fromStageId",
		},
		"gate on non-iteration": {
			raw:  `{"schemaVersion":2,"kind":"coco.workflow.template","nodes":[{"kind":"stage","id":"a","name":"A","mode":"auto","gate":{"id":"g1"}}]}`,
			want: "cannot carry a gate",
		},
		"duplicate id": {
			raw:  `{"schemaVersion":2,"kind":"coco.workflow.template","nodes":[{"kind":"stage","id":"a","name":"A","mode":"auto"},{"kind":"stage","id":"a","name":"A2","mode":"auto"}]}`,
			want: "duplicate node id",
		},
		"bad mode": {
			raw:  `{"schemaVersion":2,"kind":"coco.workflow.template","nodes":[{"kind":"stage","id":"a","name":"A","mode":"batch"}]}`,
			want: "auto or human_loop",
		},
		"bad kind": {
			raw:  `{"schemaVersion":2,"kind":"coco.workflow.template","nodes":[{"kind":"mystery","id":"a","name":"A"}]}`,
			want: "invalid kind",
		},
		"gate id collides with stage": {
			raw: `{"schemaVersion":2,"kind":"coco.workflow.template","nodes":[
				{"kind":"iteration","id":"it","name":"It","children":[{"kind":"stage","id":"s1","name":"S","mode":"auto"}],"gate":{"id":"s1"}}]}`,
			want: "duplicate node id",
		},
		"empty nodes": {
			raw:  `{"schemaVersion":2,"kind":"coco.workflow.template","nodes":[]}`,
			want: "at least one node",
		},
		"zero schemaVersion": {
			raw:  `{"schemaVersion":0,"kind":"coco.workflow.template","nodes":[{"kind":"stage","id":"a","name":"A","mode":"auto"}]}`,
			want: "schemaVersion",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			err := ValidateWorkflowDefinition([]byte(tc.raw))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want error containing %q, got %v", tc.want, err)
			}
		})
	}
}

// golden 展平后必须能直接喂给既有扁平校验器（复用底座铁律的回归护栏）。
func TestFlattenedGoldenPassesNodeValidator(t *testing.T) {
	def, _ := ParseWorkflowDefinition([]byte(cocoGolden))
	flat, err := FlattenWorkflowDefinition(def)
	if err != nil {
		t.Fatalf("flatten: %v", err)
	}
	if !workflowNodesAcyclic(flat) {
		t.Fatal("flattened golden graph must be acyclic")
	}
}

func flatIDs(nodes []WorkflowNode) []string {
	out := make([]string, len(nodes))
	for i, n := range nodes {
		out[i] = n.ID
	}
	return out
}

// plan 101 C5：required 且非 out 的输入必须回写 WorkflowNode.GateDocTypes，
// 供运行时资产准入门禁消费；out 自产物与非必检项不得进入清单。
func TestFlattenStagePopulatesGateDocTypesFromRequiredInputs(t *testing.T) {
	def := &WorkflowDefinition{
		SchemaVersion: 2,
		Kind:          CocoWorkflowTemplateKind,
		Name:          "准入回写",
		Nodes: []DefinitionNode{{
			Kind: "stage", ID: "s2", Name: "编码", Mode: "auto",
			Inputs: []DefinitionInput{
				{OutputName: "prototype", AssetRole: "in", Required: true},    // ✓ 必检
				{OutputName: "architecture", AssetRole: "in", Required: true}, // ✓ 必检
				{OutputName: "self-note", AssetRole: "out", Required: true},   // ✗ 自产物，排除
				{OutputID: "legacy-id", Required: true},                       // ✓ 无 OutputName 回退 OutputID
				{OutputName: "optional-doc", AssetRole: "in"},                 // ✗ 非 required，排除
			},
		}},
	}
	if err := def.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	flat, err := def.Flatten()
	if err != nil {
		t.Fatalf("flatten: %v", err)
	}
	if len(flat) != 1 {
		t.Fatalf("want 1 flat node, got %d", len(flat))
	}
	got := flat[0].GateDocTypes
	want := map[string]bool{"prototype": true, "architecture": true, "legacy-id": true}
	if len(got) != len(want) {
		t.Fatalf("gate_doc_types = %v, want exactly %v", got, want)
	}
	for _, g := range got {
		if !want[g] {
			t.Errorf("unexpected gate_doc_type %q", g)
		}
	}
}

// requiredGateDocTypes 对空/nil 输入返空切片（非 nil），保持与既有展平默认一致。
func TestRequiredGateDocTypesEmptyInputs(t *testing.T) {
	if got := requiredGateDocTypes(nil); len(got) != 0 {
		t.Errorf("nil inputs: want empty, got %v", got)
	}
	if got := requiredGateDocTypes([]DefinitionInput{{FromStageID: "s1"}}); len(got) != 0 {
		t.Errorf("no required: want empty, got %v", got)
	}
}
