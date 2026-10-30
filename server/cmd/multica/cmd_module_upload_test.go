package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// rel_path 是档案行与版本行唯一能精确对上的键：界面、CLI、MCP 三个入口必须算出
// 逐字相同的字符串。这里把界面的 prototypeRelPath 规则钉住——禁写字符转连字符、
// 空白转连字符、连字符合并、保留中文、扩展名小写、空模块名退化为 module。
//
// 漂移一次就会得到「版本行写了 A、档案行写了 B」，Web 端预览和 prototype read
// 都只能靠降级匹配猜，猜不到就变成一句「文件读不到」。
func TestPrototypeRelPathMatchesWebUIRules(t *testing.T) {
	for _, tc := range []struct {
		name    string
		module  string
		file    string
		version int
		want    string
	}{
		{
			name:    "chinese kept, spaces and upper-case extension normalised",
			module:  "1.0 AI 助手（首页）",
			file:    "v2.HTML",
			version: 2,
			want:    "prototypes/1.0-AI-助手（首页）/prototype-v2.html",
		},
		{
			name:    "dash runs collapse and edges are trimmed",
			module:  "  --首页--  ",
			file:    "a.htm",
			version: 1,
			want:    "prototypes/首页/prototype-v1.htm",
		},
		{
			name:    "empty module name degrades to module",
			module:  "   ",
			file:    "x.html",
			version: 0,
			want:    "prototypes/module/prototype-v1.html",
		},
		{
			name:    "path separators and reserved characters become dashes",
			module:  `a/b:c*d?e"f<g>h|i`,
			file:    "x.html",
			version: 1,
			want:    "prototypes/a-b-c-d-e-f-g-h-i/prototype-v1.html",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := prototypeRelPathFor(tc.module, tc.version, tc.file); got != tc.want {
				t.Fatalf("rel_path = %q, want %q", got, tc.want)
			}
		})
	}
}

// upload 的正文来源只有三种，且互斥；选错必须当场说清楚，而不是发一个空 body
// 让服务端 400。
func TestReadPrototypeUploadSources(t *testing.T) {
	newCmd := func(t *testing.T, file, inline string) *cobra.Command {
		t.Helper()
		cmd := &cobra.Command{}
		cmd.Flags().String("file", "", "")
		cmd.Flags().String("html", "", "")
		if file != "" {
			if err := cmd.Flags().Set("file", file); err != nil {
				t.Fatalf("set --file: %v", err)
			}
		}
		if inline != "" {
			if err := cmd.Flags().Set("html", inline); err != nil {
				t.Fatalf("set --html: %v", err)
			}
		}
		return cmd
	}

	t.Run("inline html", func(t *testing.T) {
		data, name, err := readPrototypeUpload(newCmd(t, "", "<html><body/></html>"))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(data) != "<html><body/></html>" || name != "prototype.html" {
			t.Fatalf("got %q / %q", data, name)
		}
	})

	t.Run("file on disk", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "v9.html")
		if err := os.WriteFile(path, []byte("<html>v9</html>"), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		data, name, err := readPrototypeUpload(newCmd(t, path, ""))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !strings.Contains(string(data), "v9") || name != "v9.html" {
			t.Fatalf("got %q / %q", data, name)
		}
	})

	t.Run("both sources refused", func(t *testing.T) {
		_, _, err := readPrototypeUpload(newCmd(t, "./v9.html", "<html/>"))
		if err == nil || !strings.Contains(err.Error(), "not both") {
			t.Fatalf("want a not-both error, got %v", err)
		}
	})

	t.Run("no source refused", func(t *testing.T) {
		_, _, err := readPrototypeUpload(newCmd(t, "", ""))
		if err == nil || !strings.Contains(err.Error(), "needs the prototype bytes") {
			t.Fatalf("want a bytes-required error, got %v", err)
		}
	})
}
