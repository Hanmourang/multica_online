package handler

import (
	"fmt"
	"testing"
)

// ---------------------------------------------------------------------------
// Rule engine evaluator unit tests.
// Each kind covers: pass / fail / content-unavailable / no-rule (legacy).
// ---------------------------------------------------------------------------

func TestEvaluateHeadingSequence_Pass(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:     "heading_sequence",
		Headings: []string{"技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"},
		Ordered:  true,
	}
	content := `# 说明书
## 技术领域
本发明涉及计算机技术领域。
## 背景技术
现有技术存在以下问题...
## 发明内容
本发明的目的是...
## 附图说明
图1是系统架构图。
## 具体实施方式
下面结合附图详细说明。
`
	result := evaluateRule(dsl, content, nil)
	if result.Verdict != "pass" {
		t.Errorf("expected pass, got %q: %s", result.Verdict, result.Explanation)
	}
	if result.CheckType != "heading_sequence" {
		t.Errorf("expected check_type heading_sequence, got %q", result.CheckType)
	}
}

func TestEvaluateHeadingSequence_FailMissing(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:     "heading_sequence",
		Headings: []string{"技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"},
		Ordered:  true,
	}
	// Missing "附图说明"
	content := `# 说明书
## 技术领域
本发明涉及计算机技术领域。
## 背景技术
现有技术存在以下问题...
## 发明内容
本发明的目的是...
## 具体实施方式
下面结合附图详细说明。
`
	result := evaluateRule(dsl, content, nil)
	if result.Verdict != "fail" {
		t.Errorf("expected fail, got %q", result.Verdict)
	}
	if len(result.Failures) == 0 {
		t.Error("expected at least one failure")
	}
	// Should report the missing heading.
	found := false
	for _, f := range result.Failures {
		if f.Rule == "heading_present" {
			found = true
		}
	}
	if !found {
		t.Error("expected a heading_present failure")
	}
}

func TestEvaluateHeadingSequence_FailOrder(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:     "heading_sequence",
		Headings: []string{"技术领域", "背景技术", "发明内容"},
		Ordered:  true,
	}
	// All present but wrong order: 发明内容 before 背景技术
	content := `## 技术领域
...
## 发明内容
...
## 背景技术
...
`
	result := evaluateRule(dsl, content, nil)
	if result.Verdict != "fail" {
		t.Errorf("expected fail for wrong order, got %q", result.Verdict)
	}
	foundOrderFailure := false
	for _, f := range result.Failures {
		if f.Rule == "heading_order" {
			foundOrderFailure = true
		}
	}
	if !foundOrderFailure {
		t.Error("expected a heading_order failure")
	}
}

func TestEvaluateHeadingSequence_ContentUnavailable(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:     "heading_sequence",
		Headings: []string{"技术领域"},
		Ordered:  true,
	}
	err := fmt.Errorf("attachment type not readable as text (content_type=application/pdf, filename=doc.pdf): PDF and binary formats require CLI-side parsing")
	result := evaluateRule(dsl, "", err)
	if result.Verdict != "pending_cli" {
		t.Errorf("expected pending_cli for PDF, got %q", result.Verdict)
	}
	if !result.PendingCLI {
		t.Error("expected PendingCLI=true")
	}
}

func TestEvaluateHeadingSequence_NoRule(t *testing.T) {
	// Legacy rule_expr with no kind — should not reach evaluateRule in practice,
	// but if it does with empty kind, it returns "unknown_kind" warning.
	dsl := ruleExprDSL{
		Description: "前30页+后30页，每页不少于50行",
		SortOrder:   1,
	}
	result := evaluateRule(dsl, "some content", nil)
	if result.Verdict != "warning" {
		t.Errorf("expected warning for no kind, got %q", result.Verdict)
	}
	if result.CheckType != "unknown_kind" {
		t.Errorf("expected unknown_kind, got %q", result.CheckType)
	}
}

// ---------------------------------------------------------------------------
// max_chars
// ---------------------------------------------------------------------------

func TestEvaluateMaxChars_Pass(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:           "max_chars",
		Limit:          300,
		ForbidPatterns: []string{"最好", "第一", "领先"},
	}
	content := "本发明提供一种基于深度学习的代码质量评估方法，通过对源代码进行静态分析和动态测试，综合评估代码的复杂度、可读性和可维护性。"
	result := evaluateRule(dsl, content, nil)
	if result.Verdict != "pass" {
		t.Errorf("expected pass, got %q: %s", result.Verdict, result.Explanation)
	}
}

func TestEvaluateMaxChars_FailLength(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:  "max_chars",
		Limit: 10,
	}
	content := "这是一段超过十个字的摘要内容用于测试字数限制规则"
	result := evaluateRule(dsl, content, nil)
	if result.Verdict != "fail" {
		t.Errorf("expected fail, got %q", result.Verdict)
	}
	if len(result.Failures) == 0 {
		t.Error("expected at least one failure")
	}
	if result.Failures[0].Rule != "max_chars" {
		t.Errorf("expected max_chars failure, got %q", result.Failures[0].Rule)
	}
}

func TestEvaluateMaxChars_FailForbidPattern(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:           "max_chars",
		Limit:          300,
		ForbidPatterns: []string{"最好", "第一", "领先"},
	}
	content := "本产品是市场上最好的解决方案，遥遥领先同行业第一名。"
	result := evaluateRule(dsl, content, nil)
	if result.Verdict != "fail" {
		t.Errorf("expected fail, got %q", result.Verdict)
	}
	forbidFailures := 0
	for _, f := range result.Failures {
		if f.Rule == "forbid_pattern" {
			forbidFailures++
		}
	}
	if forbidFailures < 2 {
		t.Errorf("expected at least 2 forbid_pattern failures, got %d", forbidFailures)
	}
}

func TestEvaluateMaxChars_ContentUnavailable(t *testing.T) {
	dsl := ruleExprDSL{Kind: "max_chars", Limit: 300}
	err := fmt.Errorf("storage not configured")
	result := evaluateRule(dsl, "", err)
	if result.Verdict != "warning" {
		t.Errorf("expected warning, got %q", result.Verdict)
	}
	if result.CheckType != "content_unavailable" {
		t.Errorf("expected content_unavailable, got %q", result.CheckType)
	}
}

// ---------------------------------------------------------------------------
// claim_graph
// ---------------------------------------------------------------------------

func TestEvaluateClaimGraph_Pass(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:             "claim_graph",
		MinIndependent:   1,
		MinDependent:     1,
		NoCycles:         true,
		NoMultiFromMulti: true,
	}
	content := `1. 一种代码质量评估方法，其特征在于包括以下步骤：
2. 根据权利要求1所述的方法，其特征在于所述步骤包括静态分析。
3. 根据权利要求1所述的方法，其特征在于所述步骤包括动态测试。
4. 根据权利要求2所述的方法，其特征在于所述静态分析使用AST解析。
`
	result := evaluateRule(dsl, content, nil)
	if result.Verdict != "pass" {
		t.Errorf("expected pass, got %q: %s", result.Verdict, result.Explanation)
	}
}

func TestEvaluateClaimGraph_FailNoClaims(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:           "claim_graph",
		MinIndependent: 1,
		MinDependent:   1,
		NoCycles:       true,
	}
	content := "这段文本没有任何权利要求格式的内容。"
	result := evaluateRule(dsl, content, nil)
	if result.Verdict != "fail" {
		t.Errorf("expected fail, got %q: %s", result.Verdict, result.Explanation)
	}
}

func TestEvaluateClaimGraph_FailCycle(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:           "claim_graph",
		MinIndependent: 1,
		NoCycles:       true,
	}
	// Claim 2 refs 3, claim 3 refs 2 → cycle
	content := `1. 一种方法。
2. 根据权利要求3所述的方法。
3. 根据权利要求2所述的方法。
`
	result := evaluateRule(dsl, content, nil)
	if result.Verdict != "fail" {
		t.Errorf("expected fail for cycle, got %q: %s", result.Verdict, result.Explanation)
	}
	foundCycle := false
	for _, f := range result.Failures {
		if f.Rule == "no_cycles" {
			foundCycle = true
		}
	}
	if !foundCycle {
		t.Error("expected a no_cycles failure")
	}
}

func TestEvaluateClaimGraph_ContentUnavailable(t *testing.T) {
	dsl := ruleExprDSL{Kind: "claim_graph", MinIndependent: 1}
	err := fmt.Errorf("attachment type not readable as text (content_type=application/pdf, filename=claims.pdf): PDF and binary formats require CLI-side parsing")
	result := evaluateRule(dsl, "", err)
	if result.Verdict != "pending_cli" {
		t.Errorf("expected pending_cli, got %q", result.Verdict)
	}
}

// ---------------------------------------------------------------------------
// version_consistency
// ---------------------------------------------------------------------------

func TestEvaluateVersionConsistency_Pass(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:           "version_consistency",
		VersionPattern: `v?\d+\.\d+(?:\.\d+)?`,
		NamePattern:    `(?m)^#\s+(.+)$`,
	}
	content := `# Multica 项目管理平台
版本: v2.1.0
本文档描述了系统的整体架构。
`
	result := evaluateRule(dsl, content, nil)
	if result.Verdict != "pass" {
		t.Errorf("expected pass, got %q: %s", result.Verdict, result.Explanation)
	}
}

func TestEvaluateVersionConsistency_FailNoVersion(t *testing.T) {
	dsl := ruleExprDSL{
		Kind:           "version_consistency",
		VersionPattern: `v?\d+\.\d+(?:\.\d+)?`,
	}
	content := `# 说明书
本文档没有版本号。
`
	result := evaluateRule(dsl, content, nil)
	if result.Verdict != "fail" {
		t.Errorf("expected fail, got %q", result.Verdict)
	}
	if len(result.Failures) == 0 {
		t.Error("expected at least one failure")
	}
	if result.Failures[0].Rule != "version_present" {
		t.Errorf("expected version_present failure, got %q", result.Failures[0].Rule)
	}
}

func TestEvaluateVersionConsistency_ContentUnavailable(t *testing.T) {
	dsl := ruleExprDSL{Kind: "version_consistency"}
	err := fmt.Errorf("attachment exceeds 2MB text preview limit")
	result := evaluateRule(dsl, "", err)
	if result.Verdict != "warning" {
		t.Errorf("expected warning, got %q", result.Verdict)
	}
}

// ---------------------------------------------------------------------------
// parseRuleExpr backward compatibility
// ---------------------------------------------------------------------------

func TestParseRuleExpr_LegacyCompat(t *testing.T) {
	// Legacy seed data: only description + sort_order, no kind.
	raw := []byte(`{"description":"前30页+后30页，每页不少于50行","sort_order":1}`)
	dsl := parseRuleExpr(raw)
	if dsl.hasMachineRule() {
		t.Error("legacy rule_expr should not have a machine rule")
	}
	if dsl.Description != "前30页+后30页，每页不少于50行" {
		t.Errorf("description mismatch: %q", dsl.Description)
	}
	if dsl.SortOrder != 1 {
		t.Errorf("sort_order mismatch: %d", dsl.SortOrder)
	}
}

func TestParseRuleExpr_WithKind(t *testing.T) {
	raw := []byte(`{"description":"五段式","sort_order":2,"kind":"heading_sequence","headings":["技术领域","背景技术"],"ordered":true}`)
	dsl := parseRuleExpr(raw)
	if !dsl.hasMachineRule() {
		t.Error("DSL with kind should have a machine rule")
	}
	if dsl.Kind != "heading_sequence" {
		t.Errorf("kind mismatch: %q", dsl.Kind)
	}
	if len(dsl.Headings) != 2 {
		t.Errorf("headings length mismatch: %d", len(dsl.Headings))
	}
	if dsl.Description != "五段式" {
		t.Errorf("description should be preserved: %q", dsl.Description)
	}
}

func TestParseRuleExpr_Empty(t *testing.T) {
	dsl := parseRuleExpr(nil)
	if dsl.hasMachineRule() {
		t.Error("nil rule_expr should not have a machine rule")
	}
	dsl2 := parseRuleExpr([]byte(`{}`))
	if dsl2.hasMachineRule() {
		t.Error("empty object should not have a machine rule")
	}
}

// ---------------------------------------------------------------------------
// computeFilingPriority (anno③)
// ---------------------------------------------------------------------------

func TestComputeFilingPriority(t *testing.T) {
	tests := []struct {
		tier        string
		status      string
		hasArtifact bool
		want        string
	}{
		{"must", "missing", false, "P0"},
		{"must", "partial", true, "P1"},
		{"must", "ready", true, ""},
		{"conditional", "missing", false, "P2"},
		{"aux", "partial", true, "P2"},
		{"conditional", "ready", true, ""},
	}
	for _, tt := range tests {
		got := computeFilingPriority(tt.tier, tt.status, tt.hasArtifact)
		if got != tt.want {
			t.Errorf("computeFilingPriority(%q, %q, %v) = %q, want %q",
				tt.tier, tt.status, tt.hasArtifact, got, tt.want)
		}
	}
}
