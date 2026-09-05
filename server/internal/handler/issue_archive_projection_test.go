package handler

import (
	"os"
	"regexp"
	"testing"
)

// TestRequirementStatusProjectionSingleSource guards the dual-source-of-truth
// disclosure in issue_archive.go: the derived-status CASE in
// loadDeliverablesProjection is a verbatim copy of the requirement_status
// projection in pkg/db/queries/issue.sql (ListIssues). WS4 added the 10th state
// (验收失败) and the rule-6 guard to issue.sql only; this test fails loudly if the
// two projections ever drift again.
//
// It extracts every `THEN '<literal>'` from both files (the projection is the
// only place either file emits Chinese status literals via THEN) and asserts the
// ordered lists are byte-identical, then asserts requirementStatusKeys maps every
// literal onto a stable ASCII enum (no literal silently falls through to
// "unknown").
func TestRequirementStatusProjectionSingleSource(t *testing.T) {
	thenRe := regexp.MustCompile(`THEN '([^']*)'`)

	extract := func(path string) []string {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		var out []string
		for _, m := range thenRe.FindAllStringSubmatch(string(raw), -1) {
			out = append(out, m[1])
		}
		return out
	}

	sqlLiterals := extract("../../pkg/db/queries/issue.sql")
	goLiterals := extract("issue_archive.go")

	if len(sqlLiterals) == 0 {
		t.Fatal("no THEN literals found in issue.sql — extraction regex broke")
	}
	if len(sqlLiterals) != len(goLiterals) {
		t.Fatalf("projection literal count diverged: issue.sql=%d issue_archive.go=%d\nsql=%v\ngo=%v",
			len(sqlLiterals), len(goLiterals), sqlLiterals, goLiterals)
	}
	for i := range sqlLiterals {
		if sqlLiterals[i] != goLiterals[i] {
			t.Fatalf("projection literal #%d diverged: issue.sql=%q issue_archive.go=%q\nsql=%v\ngo=%v",
				i, sqlLiterals[i], goLiterals[i], sqlLiterals, goLiterals)
		}
	}

	// Every emitted literal must map onto a stable ASCII enum — a literal missing
	// from requirementStatusKeys yields "unknown" and breaks the frontend contract.
	for _, lit := range sqlLiterals {
		if _, ok := requirementStatusKeys[lit]; !ok {
			t.Fatalf("projection literal %q has no requirementStatusKeys entry (would render as \"unknown\")", lit)
		}
	}

	// The 10th state contract: 验收失败 → acceptance_failed, stage 4, manual
	// arbitration. The frontend i18n key status_acceptance_failed depends on it.
	if requirementStatusKeys["验收失败"] != "acceptance_failed" {
		t.Fatalf("验收失败 statusKey = %q, want acceptance_failed", requirementStatusKeys["验收失败"])
	}
	if statusKeyCurrentStage["acceptance_failed"] != 4 {
		t.Fatalf("acceptance_failed current stage = %d, want 4", statusKeyCurrentStage["acceptance_failed"])
	}
	if statusKeyNextAction["acceptance_failed"] != "manual_arbitration" {
		t.Fatalf("acceptance_failed next action = %q, want manual_arbitration", statusKeyNextAction["acceptance_failed"])
	}
}
