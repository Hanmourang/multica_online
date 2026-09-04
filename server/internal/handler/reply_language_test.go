package handler

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

// TestSupportedLanguageOrEmpty pins the claim-time validation of a user's
// stored language preference: only the locales the product ships (the same
// set GetMe/PatchMe round-trip) may reach the daemon; NULL, empty, legacy,
// or arbitrary strings all read as "no preference" so the agent prompt
// carries no language rule instead of an invented one.
func TestSupportedLanguageOrEmpty(t *testing.T) {
	for _, lang := range []string{"en", "zh-Hans", "ko", "ja"} {
		if got := supportedLanguageOrEmpty(pgtype.Text{String: lang, Valid: true}); got != lang {
			t.Errorf("supportedLanguageOrEmpty(%q) = %q, want %q", lang, got, lang)
		}
	}
	for _, tc := range []struct {
		name string
		in   pgtype.Text
	}{
		{"null", pgtype.Text{}},
		{"empty", pgtype.Text{String: "", Valid: true}},
		{"unsupported", pgtype.Text{String: "fr", Valid: true}},
		{"case variant", pgtype.Text{String: "ZH-HANS", Valid: true}},
		{"padded", pgtype.Text{String: " en ", Valid: true}},
	} {
		if got := supportedLanguageOrEmpty(tc.in); got != "" {
			t.Errorf("supportedLanguageOrEmpty(%s) = %q, want empty", tc.name, got)
		}
	}
}

// TestResolveReplyLanguage pins the precedence: the person the agent is
// answering (this run's human initiator) sets the reply language; the
// runtime owner's preference is the fallback for runs with no attributable
// initiator (on-assign, autopilot, quick-create) or an initiator who never
// set one.
func TestResolveReplyLanguage(t *testing.T) {
	if got := resolveReplyLanguage("zh-Hans", "en"); got != "zh-Hans" {
		t.Errorf("initiator preference must win over owner: got %q", got)
	}
	if got := resolveReplyLanguage("", "zh-Hans"); got != "zh-Hans" {
		t.Errorf("owner preference is the fallback: got %q", got)
	}
	if got := resolveReplyLanguage("", ""); got != "" {
		t.Errorf("no preference anywhere resolves empty: got %q", got)
	}
}
