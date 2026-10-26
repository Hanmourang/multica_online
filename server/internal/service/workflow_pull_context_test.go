package service

import (
	"strings"
	"testing"
)

func TestComposePullPointerEmptyBase(t *testing.T) {
	got := composePullPointer("", "issue-1", "proj-1", "stage-1", []string{"prototype", "spec"})
	if !strings.HasPrefix(got, "<stage-context") {
		t.Fatalf("empty base should start at pointer block, got %q", got)
	}
	for _, want := range []string{"issue_id: issue-1", "project_id: proj-1", "stage_id: stage-1", "required_assets: [prototype, spec]", "assets_get_content"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in:\n%s", want, got)
		}
	}
	if !strings.HasSuffix(got, "</stage-context>") {
		t.Fatalf("must end with closing tag, got %q", got)
	}
}

func TestComposePullPointerPreservesBaseAndOmitsEmptyLines(t *testing.T) {
	got := composePullPointer("do the thing\n\n", "i1", "", "s1", nil)
	// base 尾随换行被规整为单空行分隔。
	if !strings.HasPrefix(got, "do the thing\n\n<stage-context") {
		t.Fatalf("base not preserved with separator:\n%s", got)
	}
	// projectID 空 → 省略行；required 空 → 省略 checklist。
	if strings.Contains(got, "project_id:") {
		t.Fatalf("empty project id must be omitted:\n%s", got)
	}
	if strings.Contains(got, "required_assets:") {
		t.Fatalf("empty required must be omitted:\n%s", got)
	}
}

func TestComposePullPointerDeterministic(t *testing.T) {
	a := composePullPointer("p", "i", "pr", "s", []string{"x", "y"})
	b := composePullPointer("p", "i", "pr", "s", []string{"x", "y"})
	if a != b {
		t.Fatalf("output must be byte-stable for snapshot/regression")
	}
}

func TestDefaultStagePromptMatchesLegacyText(t *testing.T) {
	got := defaultStagePrompt("分析", "inst-9")
	want := "[workflow] 执行阶段「分析」（实例 inst-9）。"
	if got != want {
		t.Fatalf("legacy prompt text drift: got %q want %q", got, want)
	}
}
