package execenv

import (
	"fmt"
	"strings"
)

// replyLanguageNativeNames maps each shipped locale (mirrors
// SUPPORTED_LOCALES in packages/core/i18n/types.ts and supportedLanguages in
// handler/auth.go) to the language's OWN native name — the token the model
// keys on most reliably when told which language to speak.
var replyLanguageNativeNames = map[string]string{
	"en":      "English",
	"zh-Hans": "中文（简体）",
	"ko":      "한국어",
	"ja":      "日本語",
}

// BuildReplyLanguageBlock renders the per-turn language rule for the
// resolved reply language (the human initiator's preference, else the
// runtime owner's; see handler.resolveReplyLanguage). Returns "" when no
// supported preference resolved, so old servers and preference-less users
// get byte-identical prompts to before.
//
// It lives in the per-turn user message, not the runtime brief: the
// initiator — and therefore the language owed to them — can change from one
// run to the next on a resumed session, and the brief is the prompt-cache
// prefix (MUL-5377). Repeating the rule every turn also makes a preference
// change take effect on the very next turn instead of never.
//
// The rule covers reasoning as well as the visible reply: a Chinese UI
// preference with English scaffolding otherwise produces English thinking
// and English answers. The explicit-ask escape is deliberately narrow — it
// fires only when the user asks for another language in their own message,
// which is a new instruction, not a preference change.
func BuildReplyLanguageBlock(language string) string {
	nativeName, ok := replyLanguageNativeNames[language]
	if !ok {
		return ""
	}
	var b strings.Builder
	b.WriteString("## Reply Language\n\n")
	fmt.Fprintf(&b, "The user you are communicating with has configured their language preference as %s. Use %s for the ENTIRE conversation — your thinking, your replies, and any issue titles, descriptions, or comments you author. Do not mix in a second language unless the user explicitly asks for it in their own message. Code, commands, file paths, and technical identifiers stay in their original form.\n\n", nativeName, nativeName)
	return b.String()
}
