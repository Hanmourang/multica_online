package prototypeimport

import (
	"reflect"
	"testing"
)

// 「从原型导入」先看 data-fp：编号就是原型自己声明的那个，reconcile 按 code 精
// 确匹配，改写或丢掉编号都会让对账全变空位。脚本里的模板字符串不是锚点。
func TestCandidatesPrefersAnchors(t *testing.T) {
	html := `<html><body>
<nav><a href="#a">会话</a><a href="#b">设置</a></nav>
<section data-fp="FP-01" data-title="群列表">…</section>
<section data-fp="fp.graph.list" data-title="图谱列表">…</section>
<script>const tpl = '<div data-fp="' + code + '">';</script>
</body></html>`

	got := Candidates(html)
	want := []Candidate{
		{Code: "FP-01", Title: "群列表"},
		{Code: "fp.graph.list", Title: "图谱列表"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("want %+v, got %+v", want, got)
	}
}

// 没有锚点才退到区块标题：h1 是页面大标题，h2 是分组，h3 是条目。
func TestCandidatesFallsBackToHeadings(t *testing.T) {
	html := `<h1>产品功能概览</h1>
<h2>会话</h2>
<h3>群列表</h3>
<h3>群<span>设置</span></h3>
<h2>通知</h2>
<h3>聚合规则</h3>`

	got := Candidates(html)
	want := []Candidate{
		{Title: "会话", Section: true},
		{Title: "群列表", Group: "会话"},
		{Title: "群设置", Group: "会话"},
		{Title: "通知", Section: true},
		{Title: "聚合规则", Group: "通知"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("want %+v, got %+v", want, got)
	}
}

// 导航顺序要保序且去重：它被拿去补 brief.flow（A → B → C）。
func TestNavFlowKeepsOrder(t *testing.T) {
	html := `<nav><a href="#1"><b>概览</b></a><a href="#2">概览</a><a href="#3">设置</a></nav>
<div><a href="#4">页脚不算流程</a></div>`
	got := NavFlow(html)
	want := []string{"概览", "设置"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}
}

// 新编号接在已有最大尾号后面，且与前端 formatFeatureCode 同形（FP-01 / FP-101）。
func TestSequenceAndCodeFormat(t *testing.T) {
	cases := []struct {
		codes []string
		last  int
		next  string
	}{
		{codes: nil, last: 0, next: "FP-01"},
		{codes: []string{"FP-01", "FP-03"}, last: 3, next: "FP-04"},
		{codes: []string{"fp.graph.list", "FP-101"}, last: 101, next: "FP-102"},
	}
	for _, tc := range cases {
		if got := Sequence(tc.codes); got != tc.last {
			t.Fatalf("codes %v: want last %d, got %d", tc.codes, tc.last, got)
		}
		if got := FormatCode(tc.last + 1); got != tc.next {
			t.Fatalf("codes %v: want next %s, got %s", tc.codes, tc.next, got)
		}
	}
}

// 已在 spec 里的编号与标题都要跳过：同一份原型跑两次不能新增任何功能点，
// 否则 agent 重试一次就把清单翻倍。
func TestMergeSkipsKnownCodesAndTitles(t *testing.T) {
	existing := []any{
		map[string]any{"code": "FP-01", "title": "群列表", "kind": "core", "priority": "P0"},
		map[string]any{"code": "FP-02", "title": "群设置"},
	}
	candidates := []Candidate{
		{Code: "FP-01", Title: "群列表"},   // 编号与标题都在
		{Code: "FP-02", Title: "群设置改名"}, // 编号在，标题不在
		{Title: "通知", Group: "设置"},      // 无锚点：续号
		{Title: "群列表", Group: "会话"},     // 标题已在
		{Title: "会话", Section: true},    // h2 只是分组
	}
	added, skipped := Merge(existing, candidates)
	want := []map[string]any{
		{"code": "FP-03", "title": "通知", "kind": "core", "group": "设置"},
	}
	if !reflect.DeepEqual(added, want) {
		t.Fatalf("added: want %+v, got %+v", want, added)
	}
	if len(skipped) != 3 {
		t.Fatalf("want 3 skipped rows (code, code, title), got %d: %+v", len(skipped), skipped)
	}
}

// 未知字段（例如 priority）留在原有行里，本函数只读 code / title。
func TestMergeKeepsUnknownFields(t *testing.T) {
	existing := []any{map[string]any{"code": "FP-01", "title": "群列表", "priority": "P0"}}
	added, _ := Merge(existing, []Candidate{{Code: "FP-01", Title: "群列表"}})
	if len(added) != 0 {
		t.Fatalf("want nothing added, got %+v", added)
	}
	if existing[0].(map[string]any)["priority"] != "P0" {
		t.Fatalf("merge must not rewrite existing rows")
	}
}

// brief.scope / brief.flow 只补空着的字段：导入不该覆盖人写过的说明。
func TestBriefFieldsOnlyFillsBlankKeys(t *testing.T) {
	sections := []string{"会话", "通知"}
	flow := []string{"概览", "设置"}
	got := BriefFields(sections, flow, map[string]string{"brief.scope": "已经写好的范围"})
	if _, ok := got["brief.scope"]; ok {
		t.Fatalf("brief.scope has content, must not be overwritten: %+v", got)
	}
	if got["brief.flow"] != "概览 → 设置" {
		t.Fatalf("want flow joined by arrows, got %v", got["brief.flow"])
	}

	// 只有单一区块 / 单一导航时不补：那不是范围也不是流程。
	if fields := BriefFields([]string{"唯一区块"}, []string{"唯一入口"}, map[string]string{}); len(fields) != 0 {
		t.Fatalf("single section/flow must not produce fields, got %+v", fields)
	}
}

// 锚点缓存要与 handler 侧 service.ProtoAnchor 同形：code → {count, title}。
func TestAnchorsCountsRepeats(t *testing.T) {
	html := `<div data-fp="FP-01" data-title="群列表"></div><div data-fp="FP-01"></div>`
	got := Anchors(html)
	if got["FP-01"].Count != 2 || got["FP-01"].Title != "群列表" {
		t.Fatalf("want count 2 + title 群列表, got %+v", got["FP-01"])
	}
}
