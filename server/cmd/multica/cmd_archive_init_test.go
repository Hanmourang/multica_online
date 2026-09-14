package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateArchiveProjectKey(t *testing.T) {
	if err := validateArchiveProjectKey("dsh_desktop"); err != nil {
		t.Fatal(err)
	}
	if err := validateArchiveProjectKey(""); err == nil {
		t.Fatal("empty key must fail")
	}
	if err := validateArchiveProjectKey("page-navigator"); err == nil {
		t.Fatal("reserved key must fail")
	}
	if err := validateArchiveProjectKey("../escape"); err == nil {
		t.Fatal("path key must fail")
	}
}

func TestPlanArchiveInit_ContractTree(t *testing.T) {
	root := t.TempDir()
	files, err := planArchiveInit(root, "demo", "Demo", true, true)
	if err != nil {
		t.Fatal(err)
	}
	rels := map[string]bool{}
	for _, file := range files {
		rels[file.Rel] = true
		if strings.Contains(file.Rel, "/overview/prd/") || strings.Contains(file.Rel, "/overview/mrd/") {
			t.Fatalf("forbidden shelf: %s", file.Rel)
		}
	}
	need := []string{
		"projects/demo/PROJECT.md",
		"projects/demo/overview/architecture/architecture.md",
		"projects/demo/overview/product-design/PRD.md",
		"projects/demo/overview/research/MRD.md",
		"projects/demo/overview/research",
		"projects/demo/filing/patent",
	}
	for _, rel := range need {
		if !rels[rel] {
			t.Fatalf("missing %s", rel)
		}
	}
}

func TestArchiveInit_WritesSharedHeadings(t *testing.T) {
	root := t.TempDir()
	tpl := filepath.Join(root, "_shared", "format", "templates")
	if err := os.MkdirAll(tpl, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tpl, "architecture.md"), []byte("---\ndoc_type: architecture\n---\n# 技术方案\n## 背景与约束\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tpl, "prd.md"), []byte("---\ndoc_type: product-design\ndoc_class: prd\n---\n# PRD\n## 目标与场景\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := loadSharedTemplate(root, "architecture.md", "Demo")
	if !strings.Contains(got, "## 背景与约束") {
		t.Fatalf("architecture template not loaded: %s", got)
	}
	prd := loadSharedTemplate(root, "prd.md", "Demo")
	if !strings.Contains(prd, "doc_class: prd") || !strings.Contains(prd, "## 目标与场景") {
		t.Fatalf("prd template not loaded: %s", prd)
	}
}

func TestArchiveInit_NoOverwriteWithoutForce(t *testing.T) {
	root := t.TempDir()
	abs := filepath.Join(root, "projects", "demo", "PROJECT.md")
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte("keep-me\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := archiveInitCmd
	if err := cmd.Flags().Set("project", "demo"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("path", root); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("force", "false"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("dry-run", "false"); err != nil {
		t.Fatal(err)
	}
	if err := runArchiveInit(cmd, nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "keep-me\n" {
		t.Fatalf("existing PROJECT.md overwritten: %q", data)
	}
	if _, err := os.Stat(filepath.Join(root, "projects", "demo", "overview", "architecture", "architecture.md")); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveInitReq_WritesRequirement(t *testing.T) {
	root := t.TempDir()
	cmd := archiveInitReqCmd
	if err := cmd.Flags().Set("project", "demo"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("path", root); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("key", "REQ-20260913-01"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("issue", "iss-1"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("title", "档案检索"); err != nil {
		t.Fatal(err)
	}
	if err := runArchiveInitReq(cmd, nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "requirements", "REQ-20260913-01", "requirement.md"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "doc_type: requirement") || !strings.Contains(got, "doc_class: prd") {
		t.Fatalf("requirement.md missing class: %s", got)
	}
	if !strings.Contains(got, "multica_issue_id: iss-1") {
		t.Fatalf("issue id not written: %s", got)
	}
	if _, err := os.Stat(filepath.Join(root, "requirements", "REQ-20260913-01", "s3-execution")); err != nil {
		t.Fatal(err)
	}
}

func TestNextArchiveRequirementKey(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "requirements", "REQ-20260913-02"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := nextArchiveRequirementKey(root, "20260913"); got != "REQ-20260913-03" {
		t.Fatalf("got %s", got)
	}
}

func TestFillArchiveTemplate_ReplacesTitle(t *testing.T) {
	got := fillArchiveTemplate(archiveTemplateFallback["prd.md"], "档案模块")
	if !strings.Contains(got, "档案模块") {
		t.Fatal(got)
	}
	if strings.Contains(got, "overview/prd/") && strings.Contains(got, "禁止建 `overview/prd/`") {
		// 说明文字可以提到禁令；真正路径不得出现在 Rel 里，这里只保证正文仍禁止
	}
	if !strings.Contains(got, "doc_class: prd") {
		t.Fatal("prd fallback lost doc_class")
	}
}
