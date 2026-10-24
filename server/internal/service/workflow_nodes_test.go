package service

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// plan 20261024 §01：模板 nodes 是状态机的静态契约，ValidateWorkflowNodes
// 是所有模板写入（Create/Update/Publish）与实例创建快照的唯一闸门。
// 本测试覆盖结构规则全分支：数量界、id 唯一、mode 白名单、next 引用、无环。

func nodesJSON(t *testing.T, nodes []WorkflowNode) []byte {
	t.Helper()
	raw, err := json.Marshal(nodes)
	if err != nil {
		t.Fatalf("marshal nodes: %v", err)
	}
	return raw
}

func TestValidateWorkflowNodesAcceptsValidShapes(t *testing.T) {
	cases := map[string][]WorkflowNode{
		"single human node": {
			{ID: "n1", Name: "评审", Mode: "human", Stage: 1, Next: []string{}, GateDocTypes: []string{"prd"}},
		},
		"linear auto to human": {
			{ID: "a", Name: "编码", Mode: "auto", Stage: 1, Next: []string{"b"}, GateDocTypes: []string{}},
			{ID: "b", Name: "验收", Mode: "human", Stage: 2, Next: []string{}, GateDocTypes: []string{}},
		},
		// 三色 DFS 必须放过菱形 DAG：a→b、a→c、b→d、c→d 不是环。
		"diamond dag": {
			{ID: "a", Mode: "auto", Next: []string{"b", "c"}},
			{ID: "b", Mode: "auto", Next: []string{"d"}},
			{ID: "c", Mode: "human", Next: []string{"d"}},
			{ID: "d", Mode: "human", Next: []string{}},
		},
	}
	for name, nodes := range cases {
		if err := ValidateWorkflowNodes(nodesJSON(t, nodes)); err != nil {
			t.Errorf("%s: expected valid, got %v", name, err)
		}
	}
}

func TestValidateWorkflowNodesRejectsStructuralViolations(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		if err := ValidateWorkflowNodes(nodesJSON(t, []WorkflowNode{})); err == nil {
			t.Fatal("expected error for empty nodes")
		}
	})
	t.Run("over 50", func(t *testing.T) {
		nodes := make([]WorkflowNode, WorkflowGateLoopLimit*0+51)
		for i := range nodes {
			nodes[i] = WorkflowNode{ID: fmt.Sprintf("n%d", i), Mode: "human", Stage: i + 1}
		}
		if err := ValidateWorkflowNodes(nodesJSON(t, nodes)); err == nil {
			t.Fatal("expected error for 51 nodes")
		}
	})
	t.Run("empty id", func(t *testing.T) {
		err := ValidateWorkflowNodes(nodesJSON(t, []WorkflowNode{{ID: "", Mode: "auto"}}))
		if err == nil || !strings.Contains(err.Error(), "id must not be empty") {
			t.Fatalf("expected empty-id error, got %v", err)
		}
	})
	t.Run("duplicate id", func(t *testing.T) {
		err := ValidateWorkflowNodes(nodesJSON(t, []WorkflowNode{
			{ID: "x", Mode: "auto"}, {ID: "x", Mode: "human"},
		}))
		if err == nil || !strings.Contains(err.Error(), "duplicate") {
			t.Fatalf("expected duplicate-id error, got %v", err)
		}
	})
	t.Run("bad mode", func(t *testing.T) {
		err := ValidateWorkflowNodes(nodesJSON(t, []WorkflowNode{{ID: "x", Mode: "batch"}}))
		if err == nil || !strings.Contains(err.Error(), "auto or human") {
			t.Fatalf("expected mode error, got %v", err)
		}
	})
	t.Run("dangling next", func(t *testing.T) {
		err := ValidateWorkflowNodes(nodesJSON(t, []WorkflowNode{
			{ID: "a", Mode: "auto", Next: []string{"ghost"}},
		}))
		if err == nil || !strings.Contains(err.Error(), "unknown next") {
			t.Fatalf("expected dangling-next error, got %v", err)
		}
	})
	t.Run("two node cycle", func(t *testing.T) {
		err := ValidateWorkflowNodes(nodesJSON(t, []WorkflowNode{
			{ID: "a", Mode: "auto", Next: []string{"b"}},
			{ID: "b", Mode: "auto", Next: []string{"a"}},
		}))
		if err == nil || !strings.Contains(err.Error(), "cycle") {
			t.Fatalf("expected cycle error, got %v", err)
		}
	})
	t.Run("self loop", func(t *testing.T) {
		err := ValidateWorkflowNodes(nodesJSON(t, []WorkflowNode{
			{ID: "a", Mode: "human", Next: []string{"a"}},
		}))
		if err == nil || !strings.Contains(err.Error(), "cycle") {
			t.Fatalf("expected self-loop error, got %v", err)
		}
	})
	t.Run("malformed json", func(t *testing.T) {
		if err := ValidateWorkflowNodes([]byte("{not json")); err == nil {
			t.Fatal("expected parse error")
		}
	})
}

func TestParseWorkflowNodesRoundTrip(t *testing.T) {
	raw := nodesJSON(t, []WorkflowNode{
		{ID: "a", Name: "分析", Mode: "auto", Stage: 1, Next: []string{"b"}, GateDocTypes: []string{"prd"}},
		{ID: "b", Name: "验收", Mode: "human", Stage: 2, Next: []string{}, GateDocTypes: []string{}},
	})
	nodes, err := ParseWorkflowNodes(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(nodes) != 2 || nodes[0].ID != "a" || nodes[1].Mode != "human" {
		t.Fatalf("round trip lost fields: %+v", nodes)
	}
}

// WorkflowGateLoopLimit 是 loop 超限保护的显式契约（§00：round 超过上限后
// loop 决策被拒绝、实例收敛 failed）。改默认值必须是有意识的产品决策。
func TestWorkflowGateLoopLimitContract(t *testing.T) {
	if WorkflowGateLoopLimit != 3 {
		t.Fatalf("WorkflowGateLoopLimit changed: %d", WorkflowGateLoopLimit)
	}
}
