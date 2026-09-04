package execenv

import (
	"strings"
	"testing"
)

// TestBuildReplyLanguageBlock pins the per-turn language rule: a supported
// preference renders one block naming the language in its OWN native name
// (the anchor the model keys on), covering both the visible reply and the
// model's reasoning, and forbidding language mixing unless the user
// explicitly asks. Code / commands / paths keep their original form.
func TestBuildReplyLanguageBlock(t *testing.T) {
	cases := []struct {
		lang       string
		nativeName string
	}{
		{"zh-Hans", "中文（简体）"},
		{"en", "English"},
		{"ko", "한국어"},
		{"ja", "日本語"},
	}
	for _, tc := range cases {
		out := BuildReplyLanguageBlock(tc.lang)
		if out == "" {
			t.Fatalf("BuildReplyLanguageBlock(%q) returned empty", tc.lang)
		}
		for _, anchor := range []string{
			"## Reply Language",
			tc.nativeName,
			// The user-visible complaint driving this block: reasoning and
			// replies drifting to English under a Chinese UI preference.
			"thinking",
			// No second language may leak in on its own.
			"unless the user explicitly asks",
			// Identifiers stay verbatim.
			"original form",
		} {
			if !strings.Contains(out, anchor) {
				t.Errorf("BuildReplyLanguageBlock(%q) missing anchor %q\n--- output ---\n%s", tc.lang, anchor, out)
			}
		}
	}
}

// TestBuildReplyLanguageBlockUnsetOrUnknown: no preference ("") and any
// value outside the shipped locale set must render nothing at all — the
// block exists only to enforce a configured preference, never to guess one.
func TestBuildReplyLanguageBlockUnsetOrUnknown(t *testing.T) {
	for _, lang := range []string{"", "fr", "zh-Hant", "english", "ZH-HANS", " en "} {
		if out := BuildReplyLanguageBlock(lang); out != "" {
			t.Errorf("BuildReplyLanguageBlock(%q) = %q, want empty", lang, out)
		}
	}
}
