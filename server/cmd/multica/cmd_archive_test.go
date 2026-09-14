package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 路径契约解析（projects_mgmt/CONTRACT.md §1 规则表逐行锁死）与扫描/版本/frontmatter。

func TestParseArchiveRelPath_ContractRules(t *testing.T) {
	cases := []struct {
		rel      string
		scope    string
		stage    int32 // 0 = NULL
		key      string
		projKey  string
		wantErr  bool
	}{
		{"projects/dsh_desktop/overview/research/x.md", "project", 0, "", "dsh_desktop", false},
		{"projects/dsh_desktop/PROJECT.md", "project", 0, "", "dsh_desktop", false},
		{"projects/dsh_desktop/requirements/REQ-20260811-02/s2-plan/plan.md", "requirement", 2, "REQ-20260811-02", "dsh_desktop", false},
		{"projects/dsh_desktop/requirements/REQ-20260811-02/s4-acceptance/report-r2.md", "requirement", 4, "REQ-20260811-02", "dsh_desktop", false},
		{"projects/multica/filing/software-copyright/材料.pdf", "project", 0, "", "multica", false},
		{"_shared/sop/SOP.md", "shared", 0, "", "", false},
		{"change_logs/multica/daily_logs/20260907-x.md", "project", 0, "", "multica", false},
		{"projects/multica/change_logs/daily_logs/20260907-x.md", "project", 0, "", "multica", false},
		{"change_logs/qoder_backup/plans/old.md", "", 0, "", "", true},
		// 违规：stage 越界（原型画面 2 ④：s5 拒绝入库）
		{"projects/p/requirements/REQ-20260811-02/s5-review/x.md", "", 0, "", "", true},
		// 违规：非法 requirement_key
		{"projects/p/requirements/FOO-1/s1-prototype/x.md", "", 0, "", "", true},
		// 违规：未知 overview 类别
		{"projects/p/overview/marketing/x.md", "", 0, "", "", true},
		// 违规：_attic 硬跳过
		{"_attic/old.zip", "", 0, "", "", true},
		// 违规：一级目录不在契约内
		{"random/dir/x.md", "", 0, "", "", true},
	}
	for _, c := range cases {
		p, err := parseArchiveRelPath(c.rel)
		if c.wantErr {
			if err == nil {
				t.Errorf("%s: want contract violation, got %+v", c.rel, p)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: unexpected error %v", c.rel, err)
			continue
		}
		if p.Scope != c.scope || p.ProjectKey != c.projKey || p.RequirementKey != c.key {
			t.Errorf("%s: got scope=%s key=%s proj=%s", c.rel, p.Scope, p.RequirementKey, p.ProjectKey)
		}
		if c.stage == 0 && p.Stage != nil {
			t.Errorf("%s: want stage NULL, got %d", c.rel, *p.Stage)
		}
		if c.stage != 0 && (p.Stage == nil || *p.Stage != c.stage) {
			t.Errorf("%s: want stage %d, got %v", c.rel, c.stage, p.Stage)
		}
	}
}

func TestDocTypeFromName(t *testing.T) {
	cases := []struct {
		rel  string
		want string
	}{
		{"projects/p/requirements/REQ-20260811-02/s2-plan/plan.md", "plan"},
		{"projects/p/requirements/REQ-20260811-02/s2-plan/decomposition.md", "decomposition"},
		{"projects/p/requirements/REQ-20260811-02/s3-execution/test-plan.md", "test-plan"},
		{"projects/p/requirements/REQ-20260811-02/s4-acceptance/report-r2.md", "report"},
		{"projects/p/requirements/REQ-20260811-02/s1-prototype/prototype-v3.html", "prototype"},
		{"projects/p/overview/architecture/系统架构.md", "architecture"},
		{"projects/p/filing/patent/交底书.pdf", "filing-patent"},
		{"change_logs/multica/daily_logs/20260907-master-plan交付.md", "change-log"},
		{"change_logs/qoder-plans/团队模块系统性优化.md", "work-plan"},
	}
	for _, c := range cases {
		p, err := parseArchiveRelPath(c.rel)
		if err != nil {
			t.Fatalf("%s: %v", c.rel, err)
		}
		if got := docTypeFromName(p); got != c.want {
			t.Errorf("%s: want doc_type %q, got %q", c.rel, c.want, got)
		}
	}
}

func TestVersionFromName(t *testing.T) {
	if got := versionFromName("v2"); got != 2 {
		t.Errorf("v2 -> %d", got)
	}
	if got := versionFromName("report-r3"); got != 3 {
		t.Errorf("report-r3 -> %d", got)
	}
	if got := versionFromName("plan"); got != 1 {
		t.Errorf("plan -> %d", got)
	}
}

func TestGitBlobSHA_MatchesGitHashObject(t *testing.T) {
	// git hash-object 对 "hello\n" 的众所周知结果。
	if got := gitBlobSHA([]byte("hello\n")); got != "ce013625030ba8dba906f756967f9e9ca394464a" {
		t.Fatalf("git blob sha mismatch: %s", got)
	}
}

func TestParseFrontmatter(t *testing.T) {
	dir := t.TempDir()
	withFM := filepath.Join(dir, "with.md")
	os.WriteFile(withFM, []byte("---\nmultica_issue_id: abc-123\ndoc_type: plan\n---\n# body\n"), 0o644)
	fm := parseFrontmatter(withFM)
	if fm.IssueID != "abc-123" || fm.DocType != "plan" {
		t.Fatalf("frontmatter: got (%q, %q)", fm.IssueID, fm.DocType)
	}
	os.WriteFile(withFM, []byte("---\ndoc_type: product-design\ndoc_class: prd\n---\n"), 0o644)
	if got := parseFrontmatter(withFM).DocClass; got != "prd" {
		t.Fatalf("doc_class: %q", got)
	}
	os.WriteFile(withFM, []byte("---\ndoc_type: architecture\ndoc_module: deepseek-harness\n---\n"), 0o644)
	if got := parseFrontmatter(withFM).DocModule; got != "deepseek-harness" {
		t.Fatalf("doc_module: %q", got)
	}
	without := filepath.Join(dir, "plain.md")
	os.WriteFile(without, []byte("# no frontmatter\n"), 0o644)
	if fm := parseFrontmatter(without); fm.IssueID != "" || fm.DocType != "" {
		t.Fatalf("plain file must yield empty frontmatter: %+v", fm)
	}
}

func TestScanArchiveFiles_SkipsContractExclusions(t *testing.T) {
	root := t.TempDir()
	keep := filepath.Join(root, "projects", "p", "overview", "research")
	os.MkdirAll(keep, 0o755)
	os.WriteFile(filepath.Join(keep, "x.md"), []byte("x"), 0o644)
	for _, skip := range []string{"_attic", "node_modules", filepath.Join("projects", "p", "assets")} {
		d := filepath.Join(root, skip)
		os.MkdirAll(d, 0o755)
		os.WriteFile(filepath.Join(d, "y.md"), []byte("y"), 0o644)
	}
	os.WriteFile(filepath.Join(keep, "big.zip"), []byte("z"), 0o644)

	files, err := scanArchiveFiles(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || filepath.Base(files[0]) != "x.md" {
		t.Fatalf("want only x.md, got %v", files)
	}
}

func TestArchiveRelPath_PrefixesSiblingChangeLogs(t *testing.T) {
	archiveRoot := "/tmp/projects_mgmt"
	logsRoot := "/tmp/change_logs"
	rel, ok := archiveRelPath(archiveRoot, logsRoot, "/tmp/change_logs/multica/daily_logs/x.md")
	if !ok || rel != "change_logs/multica/daily_logs/x.md" {
		t.Fatalf("sibling rel: ok=%v rel=%q", ok, rel)
	}
	rel, ok = archiveRelPath("/tmp/change_logs", "/tmp/change_logs", "/tmp/change_logs/multica/daily_logs/x.md")
	if !ok || rel != "change_logs/multica/daily_logs/x.md" {
		t.Fatalf("root-is-logs rel: ok=%v rel=%q", ok, rel)
	}
}

func TestScopeFilterAllowed(t *testing.T) {
	filter := []byte(`{"include":["projects/p/requirements/"],"exclude":["projects/p/requirements/REQ-20260101-01/"]}`)
	if !scopeFilterAllowed(filter, "projects/p/requirements/REQ-20260811-02/s2-plan/plan.md") {
		t.Error("included path rejected")
	}
	if scopeFilterAllowed(filter, "projects/p/requirements/REQ-20260101-01/x.md") {
		t.Error("excluded path allowed")
	}
	if scopeFilterAllowed(filter, "projects/p/overview/research/x.md") {
		t.Error("path outside include list allowed")
	}
	if !scopeFilterAllowed(nil, "anything.md") {
		t.Error("nil filter must allow everything")
	}
}
