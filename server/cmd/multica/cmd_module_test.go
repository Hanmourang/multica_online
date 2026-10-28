package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 原型 html_path 是本仓相对路径，两种真实形态都出现过：`requirements/...`
// 相对档案根，`change_logs/...` 相对档案根的父目录（workspace）。这里把两条
// 都钉住——当年 agent 就是自己拼路径拼错了才一直读不到原型。
func TestResolveModulePrototypePathHandlesBothRelativeShapes(t *testing.T) {
	home := t.TempDir()
	archiveRoot := filepath.Join(home, "Documents", "workspace", "projects_mgmt")
	changeLogs := filepath.Join(home, "Documents", "workspace", "change_logs")
	t.Setenv("HOME", home)
	t.Setenv("MULTICA_ARCHIVE_ROOT", archiveRoot)

	requirementFile := filepath.Join(archiveRoot, "requirements", "REQ-图谱邻域", "s1-prototype", "prototype.html")
	changeLogFile := filepath.Join(changeLogs, "multica", "plans", "plan-a", "index.html")
	for _, path := range []string{requirementFile, changeLogFile} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, []byte("<html></html>"), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	for _, tc := range []struct {
		name string
		rel  string
		want string
	}{
		{name: "requirements relative to archive root", rel: "requirements/REQ-图谱邻域/s1-prototype/prototype.html", want: requirementFile},
		{name: "change_logs relative to workspace dir", rel: "change_logs/multica/plans/plan-a/index.html", want: changeLogFile},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, candidates := resolveModulePrototypePath(tc.rel)
			if got != tc.want {
				t.Fatalf("resolved %q = %q, want %q\ncandidates:\n  %v", tc.rel, got, tc.want, candidates)
			}
		})
	}
}

// 路径来自数据库，`..` 不能让解析器跳出它被拼接的根目录。
func TestModulePrototypePathCandidatesStayInsideRoots(t *testing.T) {
	home := t.TempDir()
	archiveRoot := filepath.Join(home, "Documents", "workspace", "projects_mgmt")
	if err := os.MkdirAll(archiveRoot, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Setenv("HOME", home)
	t.Setenv("MULTICA_ARCHIVE_ROOT", archiveRoot)

	got, candidates := resolveModulePrototypePath("../../../etc/passwd")
	if got != "" {
		t.Fatalf("escaping path resolved to %q", got)
	}
	for _, candidate := range candidates {
		rel, ok := relInside(archiveRoot, candidate)
		if ok {
			t.Fatalf("candidate %q escaped archive root as %q", candidate, rel)
		}
	}
}

// 用户说「这个模块的原型图」指的是已确认那版，不是编号更大的 pending 草稿。
func TestPickModulePrototypeVersionPrefersConfirmed(t *testing.T) {
	versions := []modulePrototypeVersion{
		{ID: "v3", Version: 3, Status: "pending", HtmlPath: "change_logs/x/index.html"},
		{ID: "v2", Version: 2, Status: "confirmed", HtmlPath: "change_logs/y/index.html"},
		{ID: "v1", Version: 1, Status: "superseded", HtmlPath: "requirements/old.html"},
	}

	got := pickModulePrototypeVersion(versions, 0)
	if got == nil || got.ID != "v2" {
		t.Fatalf("default pick = %+v, want the confirmed v2", got)
	}

	got = pickModulePrototypeVersion(versions, 3)
	if got == nil || got.ID != "v3" {
		t.Fatalf("explicit --version 3 = %+v, want v3", got)
	}

	if got := pickModulePrototypeVersion(versions, 9); got != nil {
		t.Fatalf("missing --version 9 resolved to %+v, want nil", got)
	}
}

// 没有确认版时退化成最新版，否则 agent 会拿到 nil 而不是一个可读的文件。
func TestPickModulePrototypeVersionFallsBackToNewest(t *testing.T) {
	versions := []modulePrototypeVersion{
		{ID: "v2", Version: 2, Status: "pending", HtmlPath: "a.html"},
		{ID: "v1", Version: 1, Status: "superseded", HtmlPath: "b.html"},
	}
	got := pickModulePrototypeVersion(versions, 0)
	if got == nil || got.ID != "v2" {
		t.Fatalf("default pick = %+v, want v2", got)
	}
}
