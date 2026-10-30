package main

import (
	"strings"
	"testing"
)

// 「这一版和上一版差在哪」的结论全靠这几个纯函数，所以它们的口径必须钉死：
// 抽错锚点 → 对账把功能点判成空位；行 diff 漏行 → 总结少报改动。
func TestExtractPrototypeAnchors(t *testing.T) {
	html := `<div data-fp="fp.chat.group" data-title="群设置">…</div>
<section data-fp="fp.chat.group">…</section>
<button class="x" data-fp="fp.chat.mute" data-title="免打扰">…</button>
<div data-fp="">ignored</div>`

	got := extractPrototypeAnchors(html)
	if len(got) != 2 {
		t.Fatalf("anchors = %#v, want 2 codes", got)
	}
	if got["fp.chat.group"].Count != 2 {
		t.Fatalf("fp.chat.group count = %d, want 2", got["fp.chat.group"].Count)
	}
	// 同一 code 出现多次时保留第一个非空 title：后面那次通常只是个跳转按钮。
	if got["fp.chat.group"].Title != "群设置" {
		t.Fatalf("fp.chat.group title = %q, want 群设置", got["fp.chat.group"].Title)
	}
	if got["fp.chat.mute"].Title != "免打扰" {
		t.Fatalf("fp.chat.mute title = %q, want 免打扰", got["fp.chat.mute"].Title)
	}
	if _, ok := got[""]; ok {
		t.Fatalf("empty data-fp must be ignored")
	}
}

func TestParsePrototypeDocSkipsScriptsAndTemplateTitles(t *testing.T) {
	html := `<html><head><title>会话列表</title>
<style>.a{color:red}</style></head>
<body>
<h1>会话列表</h1>
<h2>${section.title}</h2>
<h2>{{ heading }}</h2>
<h2>群设置</h2>
<h2>群设置</h2>
<script>var tpl = "<h3>不该出现的区块</h3>";</script>
<!-- <h3>注释里的区块</h3> -->
<div data-fp="fp.chat.group" data-title="群设置">x</div>
</body></html>`

	doc := parsePrototypeDoc(html)
	if doc.Title != "会话列表" {
		t.Fatalf("title = %q, want 会话列表", doc.Title)
	}
	want := []string{"会话列表", "群设置"}
	if len(doc.Sections) != len(want) {
		t.Fatalf("sections = %v, want %v", doc.Sections, want)
	}
	for index, title := range want {
		if doc.Sections[index] != title {
			t.Fatalf("sections = %v, want %v", doc.Sections, want)
		}
	}
	if doc.Anchors["fp.chat.group"] != "群设置" {
		t.Fatalf("anchors = %#v, want fp.chat.group → 群设置", doc.Anchors)
	}
	for _, line := range doc.Lines {
		if strings.Contains(line, "不该出现的区块") || strings.Contains(line, "注释里的区块") {
			t.Fatalf("script/comment content leaked into text lines: %q", line)
		}
	}
}

func TestDiffPrototypeLines(t *testing.T) {
	left := []string{"a", "b", "c"}
	right := []string{"a", "x", "c", "d"}

	lines := diffPrototypeLines(left, right)
	var added, removed, same int
	for _, line := range lines {
		switch line.Kind {
		case "added":
			added++
		case "removed":
			removed++
		case "same":
			same++
		}
	}
	if added != 2 || removed != 1 || same != 2 {
		t.Fatalf("added=%d removed=%d same=%d, want 2/1/2 (%#v)", added, removed, same, lines)
	}
	// 行号必须能回指原文：agent 会拿它去引用具体位置。
	for _, line := range lines {
		if line.Kind == "removed" && line.LeftNo == 0 {
			t.Fatalf("removed line without a left number: %#v", line)
		}
		if line.Kind == "added" && line.RightNo == 0 {
			t.Fatalf("added line without a right number: %#v", line)
		}
	}
}

func TestDiffPrototypeLinesCapsHugeInputs(t *testing.T) {
	left := make([]string, prototypeDiffMaxLines+50)
	for index := range left {
		left[index] = "same"
	}
	right := append([]string{}, left...)
	right = append(right, "tail")

	lines := diffPrototypeLines(left, right)
	if len(lines) == 0 {
		t.Fatalf("capped diff must still return lines")
	}
	// 超出上限的部分被截断，不会 panic，也不会把 2 万行全吐给模型。
	if len(lines) > 2*prototypeDiffMaxLines {
		t.Fatalf("diff produced %d lines, want <= %d", len(lines), 2*prototypeDiffMaxLines)
	}
}

func TestCollapsePrototypeDiff(t *testing.T) {
	lines := diffPrototypeLines(
		[]string{"line1", "line2", "line3", "line4", "line5"},
		[]string{"line1", "line2", "changed", "line4", "line5"},
	)
	hunks := collapsePrototypeDiff(lines, 1)
	if len(hunks) == 0 {
		t.Fatalf("a changed line must produce at least one hunk")
	}
	var sawChange bool
	for _, hunk := range hunks {
		for _, line := range hunk.Lines {
			if line.Kind != "same" {
				sawChange = true
			}
		}
	}
	if !sawChange {
		t.Fatalf("hunks contain no changed line: %#v", hunks)
	}
	// context=0 时只留变更行，不把整页相同内容当结论塞回去。
	tight := collapsePrototypeDiff(lines, 0)
	total := 0
	for _, hunk := range tight {
		total += len(hunk.Lines)
	}
	if total == 0 {
		t.Fatalf("context=0 must keep the changed lines")
	}
	if got := collapsePrototypeDiff([]prototypeDiffLine{{Kind: "same", Text: "x"}}, 2); got != nil {
		t.Fatalf("no change must collapse to no hunk, got %#v", got)
	}
}

func TestComparePrototypeDocsAndHeadline(t *testing.T) {
	from := parsePrototypeDoc(`<html><head><title>A</title></head><body>
<h1>会话</h1><h2>搜索</h2>
<div data-fp="fp.chat.group" data-title="群设置">x</div>
<p>old</p></body></html>`)
	to := parsePrototypeDoc(`<html><head><title>A</title></head><body>
<h1>会话</h1><h2>群设置</h2>
<div data-fp="fp.chat.group" data-title="群设置项">x</div>
<div data-fp="fp.chat.mute" data-title="免打扰">y</div>
<p>new</p></body></html>`)

	result := comparePrototypeDocs(from, to, "会话", prototypeVersionRef{Version: 2}, prototypeVersionRef{Version: 3})
	if len(result.SectionsAdded) != 1 || result.SectionsAdded[0] != "群设置" {
		t.Fatalf("sections_added = %v, want [群设置]", result.SectionsAdded)
	}
	if len(result.SectionsRemoved) != 1 || result.SectionsRemoved[0] != "搜索" {
		t.Fatalf("sections_removed = %v, want [搜索]", result.SectionsRemoved)
	}
	if len(result.AnchorsAdded) != 1 || result.AnchorsAdded[0] != "fp.chat.mute" {
		t.Fatalf("anchors_added = %v, want [fp.chat.mute]", result.AnchorsAdded)
	}
	if len(result.AnchorsRetitled) != 1 || result.AnchorsRetitled[0].To != "群设置项" {
		t.Fatalf("anchors_retitled = %v, want one rename to 群设置项", result.AnchorsRetitled)
	}
	if result.LinesAdded == 0 || result.LinesRemoved == 0 {
		t.Fatalf("lines added/removed = %d/%d, want both > 0", result.LinesAdded, result.LinesRemoved)
	}
	if result.From.Version != 2 || result.To.Version != 3 {
		t.Fatalf("version refs = %d → %d, want 2 → 3", result.From.Version, result.To.Version)
	}
	// 摘要必须点名版本差量，而不是「有变化」。
	for _, want := range []string{"新增 1 个区块", "删除 1 个区块", "新增 1 个功能点锚点", "1 个锚点改标题", "正文"} {
		if !strings.Contains(result.Headline, want) {
			t.Fatalf("headline %q missing %q", result.Headline, want)
		}
	}
}

func TestModulePrototypeVersionArg(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int
	}{
		{"3", 3},
		{"v3", 3},
		{" V7 ", 7},
	} {
		got, err := modulePrototypeVersionArg(tc.in)
		if err != nil || got != tc.want {
			t.Fatalf("modulePrototypeVersionArg(%q) = %d, %v; want %d", tc.in, got, err, tc.want)
		}
	}
	for _, bad := range []string{"", "v", "0", "-1", "three"} {
		if _, err := modulePrototypeVersionArg(bad); err == nil {
			t.Fatalf("modulePrototypeVersionArg(%q) should fail", bad)
		}
	}
}
