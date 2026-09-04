package handler

import "github.com/jackc/pgx/v5/pgtype"

// supportedLanguageOrEmpty returns the user's stored language preference when
// it is one of the locales the product ships (the same set auth.go's
// supportedLanguages validates on write); NULL, empty, legacy, or arbitrary
// values all read as "no preference" so the daemon emits no language rule
// instead of an invented one.
func supportedLanguageOrEmpty(lang pgtype.Text) string {
	if !lang.Valid {
		return ""
	}
	if _, ok := supportedLanguages[lang.String]; ok {
		return lang.String
	}
	return ""
}

// resolveReplyLanguage picks the language the agent must answer in for one
// claimed task: the human initiator's preference when this run has an
// attributable initiator who set one (the agent is answering THEM), else the
// runtime owner's preference (on-assign / autopilot / quick-create runs, or
// an initiator with no preference set). Both inputs are expected to have
// passed supportedLanguageOrEmpty; "" resolves to "" and no rule is emitted.
func resolveReplyLanguage(initiator, owner string) string {
	if initiator != "" {
		return initiator
	}
	return owner
}
