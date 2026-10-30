package main

import "testing"

// publish 的响应可能把版本号给成 float64 或字符串，两种都要认。
func TestModuleSpecVersionFrom(t *testing.T) {
	if value, ok := moduleSpecVersionFrom(map[string]any{"spec_version": float64(4)}); !ok || value != 4 {
		t.Fatalf("want 4 from float64, got %d (ok=%v)", value, ok)
	}
	if value, ok := moduleSpecVersionFrom(map[string]any{"spec_version": "7"}); !ok || value != 7 {
		t.Fatalf("want 7 from string, got %d (ok=%v)", value, ok)
	}
	if _, ok := moduleSpecVersionFrom(map[string]any{}); ok {
		t.Fatalf("missing spec_version must report not-found, not 0")
	}
}

// 表格模式的尾注有三种措辞：没写入 unchanged、草稿 draft、发布给出新版本号。
func TestSpecVersionLabel(t *testing.T) {
	cases := []struct {
		before, after int32
		changed       bool
		want          string
	}{
		{before: 3, after: 3, changed: false, want: "3 (unchanged)"},
		{before: 3, after: 3, changed: true, want: "3 (draft)"},
		{before: 3, after: 4, changed: true, want: "4"},
	}
	for _, tc := range cases {
		if got := specVersionLabel(tc.before, tc.after, tc.changed); got != tc.want {
			t.Fatalf("before %d after %d changed %v: want %q, got %q", tc.before, tc.after, tc.changed, tc.want, got)
		}
	}
}
