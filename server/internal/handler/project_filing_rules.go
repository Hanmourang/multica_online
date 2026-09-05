package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/storage"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ---------------------------------------------------------------------------
// Rule expression DSL (kind-dispatched)
// ---------------------------------------------------------------------------
// rule_expr JSONB shape:
//   - Legacy (no kind): {"description":"...","sort_order":N}
//     → treated as "no machine rule, artifact_presence skeleton only"
//   - DSL (has kind): {"kind":"heading_sequence", "headings":[...], ...}
//     → dispatched to the matching evaluator
//
// Each evaluator returns a RuleEvalResult that is persisted in both
// filing_check_run.detail and filing_item.rule_result.

// RuleEvalResult is the structured output of a rule evaluator.
type RuleEvalResult struct {
	Kind        string        `json:"kind"`
	Verdict     string        `json:"verdict"`     // "pass" | "fail" | "warning" | "pending_cli"
	Explanation string        `json:"explanation"` // human-readable why
	Expected    any           `json:"expected,omitempty"`
	Actual      any           `json:"actual,omitempty"`
	Failures    []RuleFailure `json:"failures,omitempty"`
	PendingCLI  bool          `json:"pending_cli,omitempty"`
	CheckType   string        `json:"check_type"`
}

// RuleFailure describes one specific rule violation.
type RuleFailure struct {
	Rule     string `json:"rule"`
	Expected string `json:"expected"`
	Actual   string `json:"actual"`
	Reason   string `json:"reason"`
}

// ruleExprDSL is the full union of all rule kinds. The `Kind` field dispatches.
type ruleExprDSL struct {
	// Legacy metadata (always present for backward compat)
	Description string `json:"description"`
	SortOrder   int32  `json:"sort_order"`

	// DSL dispatch
	Kind string `json:"kind,omitempty"`

	// heading_sequence fields
	Headings []string `json:"headings,omitempty"`
	Ordered  bool     `json:"ordered,omitempty"`

	// max_chars fields
	Limit          int      `json:"limit,omitempty"`
	ForbidPatterns []string `json:"forbid_patterns,omitempty"`

	// claim_graph fields
	MinIndependent   int  `json:"min_independent,omitempty"`
	MinDependent     int  `json:"min_dependent,omitempty"`
	NoCycles         bool `json:"no_cycles,omitempty"`
	NoMultiFromMulti bool `json:"no_multi_from_multi,omitempty"`

	// version_consistency fields
	NamePattern    string `json:"name_pattern,omitempty"`
	VersionPattern string `json:"version_pattern,omitempty"`
	CompareWith    string `json:"compare_with,omitempty"` // item_key of the other document

	// pdf_layout fields (pending CLI)
	MinPages        int  `json:"min_pages,omitempty"`
	MinLinesPerPage int  `json:"min_lines_per_page,omitempty"`
	HeaderMatch     bool `json:"header_match,omitempty"`
}

// hasMachineRule returns true if the rule_expr contains a machine-evaluable kind.
func (d *ruleExprDSL) hasMachineRule() bool {
	return d.Kind != ""
}

// parseRuleExpr unmarshals the JSONB rule_expr into the DSL struct.
// Returns nil-safe defaults for legacy rows without a kind.
func parseRuleExpr(raw []byte) ruleExprDSL {
	var dsl ruleExprDSL
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &dsl)
	}
	return dsl
}

// ---------------------------------------------------------------------------
// Attachment content reader (reuses the same storage path as file.go:1263-1318)
// ---------------------------------------------------------------------------

// readAttachmentContent reads the text content of an attachment bound to a
// filing item. It follows the same pattern as GetAttachmentContent in file.go:
// load the attachment row → check isTextPreviewable → Storage.GetReader →
// LimitReader(2MB). Returns (content, error) where error is non-nil for
// unreadable/non-text/too-large attachments.
func (h *Handler) readAttachmentContent(ctx context.Context, artifactID pgtype.UUID) (string, error) {
	if !artifactID.Valid {
		return "", fmt.Errorf("no artifact bound")
	}
	// Find the attachment(s) for this artifact via project_artifact → attachment link.
	// project_artifact has an attachment_id column (nullable).
	var attachmentID pgtype.UUID
	err := h.DB.QueryRow(ctx,
		`SELECT attachment_id FROM project_artifact WHERE id = $1 AND deleted_at IS NULL`,
		artifactID).Scan(&attachmentID)
	if err != nil {
		return "", fmt.Errorf("artifact not found or deleted: %w", err)
	}
	if !attachmentID.Valid {
		return "", fmt.Errorf("artifact has no attachment")
	}

	// Load the attachment row.
	var att db.Attachment
	err = h.DB.QueryRow(ctx,
		`SELECT id, url, content_type, filename FROM attachment WHERE id = $1`,
		attachmentID).Scan(&att.ID, &att.Url, &att.ContentType, &att.Filename)
	if err != nil {
		return "", fmt.Errorf("attachment not found: %w", err)
	}

	// PDF is not text-previewable — the whitelist in file.go excludes it (415).
	if !isTextPreviewable(att.ContentType, att.Filename) {
		return "", fmt.Errorf("attachment type not readable as text (content_type=%s, filename=%s): PDF and binary formats require CLI-side parsing",
			att.ContentType, att.Filename)
	}

	if h.Storage == nil {
		return "", fmt.Errorf("storage not configured")
	}

	key := h.Storage.KeyFromURL(att.Url)
	reader, err := h.Storage.GetReader(ctx, key)
	if err != nil {
		return "", fmt.Errorf("failed to open attachment from storage: %w", err)
	}
	defer reader.Close()

	body, err := io.ReadAll(io.LimitReader(reader, maxPreviewTextSize+1))
	if err != nil {
		return "", fmt.Errorf("failed to read attachment body: %w", err)
	}
	if len(body) > maxPreviewTextSize {
		return "", fmt.Errorf("attachment exceeds 2MB text preview limit")
	}

	return string(body), nil
}

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------

// evaluateRule dispatches the rule based on kind and returns the structured result.
// content is the attachment text (may be empty if unreadable); contentErr explains why.
func evaluateRule(dsl ruleExprDSL, content string, contentErr error) RuleEvalResult {
	if contentErr != nil {
		// Content is unreadable — cannot evaluate text rules.
		if isPDFOrBinaryError(contentErr) {
			return RuleEvalResult{
				Kind:        dsl.Kind,
				Verdict:     "pending_cli",
				Explanation: "Attachment is PDF or binary — page-level rules (page count, lines per page, header consistency) require CLI-side PDF parsing. Server cannot evaluate.",
				PendingCLI:  true,
				CheckType:   "pdf_layout_pending_cli",
				Failures: []RuleFailure{{
					Rule:     "content_readable",
					Expected: "text-previewable attachment",
					Actual:   contentErr.Error(),
					Reason:   "PDF/binary not in text preview whitelist",
				}},
			}
		}
		return RuleEvalResult{
			Kind:        dsl.Kind,
			Verdict:     "warning",
			Explanation: fmt.Sprintf("Cannot read attachment content: %s", contentErr.Error()),
			CheckType:   "content_unavailable",
			Failures: []RuleFailure{{
				Rule:     "content_readable",
				Expected: "readable text attachment",
				Actual:   contentErr.Error(),
				Reason:   "attachment content could not be loaded",
			}},
		}
	}

	switch dsl.Kind {
	case "heading_sequence":
		return evaluateHeadingSequence(dsl, content)
	case "max_chars":
		return evaluateMaxChars(dsl, content)
	case "claim_graph":
		return evaluateClaimGraph(dsl, content)
	case "version_consistency":
		return evaluateVersionConsistency(dsl, content)
	default:
		return RuleEvalResult{
			Kind:        dsl.Kind,
			Verdict:     "warning",
			Explanation: fmt.Sprintf("Unknown rule kind %q — no evaluator registered", dsl.Kind),
			CheckType:   "unknown_kind",
		}
	}
}

func isPDFOrBinaryError(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "PDF") || strings.Contains(msg, "not readable as text") ||
		strings.Contains(msg, "binary")
}

// ---------------------------------------------------------------------------
// heading_sequence: 说明书五段式标题齐备且有序
// ---------------------------------------------------------------------------
// Prototype :3235 — "缺『附图说明』段 · 段序错误"
// Checks that all required headings appear in the content and (if ordered=true)
// appear in the specified sequence.

func evaluateHeadingSequence(dsl ruleExprDSL, content string) RuleEvalResult {
	if len(dsl.Headings) == 0 {
		return RuleEvalResult{
			Kind:        "heading_sequence",
			Verdict:     "warning",
			Explanation: "No headings specified in rule — cannot evaluate",
			CheckType:   "heading_sequence",
		}
	}

	// Find positions of each heading in the content (case-insensitive search).
	matches := make([]headingMatchResult, len(dsl.Headings))
	lowerContent := strings.ToLower(content)
	for i, h := range dsl.Headings {
		lowerH := strings.ToLower(h)
		idx := strings.Index(lowerContent, lowerH)
		matches[i] = headingMatchResult{heading: h, found: idx >= 0, position: idx}
	}

	var failures []RuleFailure
	missingHeadings := []string{}
	for _, m := range matches {
		if !m.found {
			missingHeadings = append(missingHeadings, m.heading)
			failures = append(failures, RuleFailure{
				Rule:     "heading_present",
				Expected: fmt.Sprintf("heading %q must appear in document", m.heading),
				Actual:   "not found",
				Reason:   fmt.Sprintf("required section %q is missing", m.heading),
			})
		}
	}

	// Check ordering if required and all headings are present.
	orderCorrect := true
	if dsl.Ordered && len(missingHeadings) == 0 {
		for i := 1; i < len(matches); i++ {
			if matches[i].position < matches[i-1].position {
				orderCorrect = false
				failures = append(failures, RuleFailure{
					Rule:     "heading_order",
					Expected: fmt.Sprintf("%q must appear before %q", matches[i-1].heading, matches[i].heading),
					Actual: fmt.Sprintf("%q found at offset %d, %q at offset %d (reversed)",
						matches[i-1].heading, matches[i-1].position, matches[i].heading, matches[i].position),
					Reason: "section order is incorrect",
				})
			}
		}
	}

	verdict := "pass"
	explanation := fmt.Sprintf("All %d required headings found", len(dsl.Headings))
	if dsl.Ordered {
		explanation += " in correct order"
	}
	if len(failures) > 0 {
		verdict = "fail"
		parts := []string{}
		if len(missingHeadings) > 0 {
			parts = append(parts, fmt.Sprintf("missing: [%s]", strings.Join(missingHeadings, ", ")))
		}
		if !orderCorrect {
			parts = append(parts, "section order incorrect")
		}
		explanation = strings.Join(parts, " · ")
	}

	return RuleEvalResult{
		Kind:        "heading_sequence",
		Verdict:     verdict,
		Explanation: explanation,
		Expected:    dsl.Headings,
		Actual:      buildActualHeadings(matches),
		Failures:    failures,
		CheckType:   "heading_sequence",
	}
}

func buildActualHeadings(matches []headingMatchResult) []map[string]any {
	result := make([]map[string]any, len(matches))
	for i, m := range matches {
		result[i] = map[string]any{
			"heading":  m.heading,
			"found":    m.found,
			"position": m.position,
		}
	}
	return result
}

// headingMatchResult is the exported-ish struct for buildActualHeadings.
type headingMatchResult struct {
	heading  string
	found    bool
	position int
}

// ---------------------------------------------------------------------------
// max_chars: 摘要 ≤300 字且不得含商业性宣传用语
// ---------------------------------------------------------------------------
// Prototype :3253 — "字数 ≤ 300 · 不得含商业性宣传用语"

func evaluateMaxChars(dsl ruleExprDSL, content string) RuleEvalResult {
	if dsl.Limit <= 0 {
		return RuleEvalResult{
			Kind:        "max_chars",
			Verdict:     "warning",
			Explanation: "No character limit specified in rule",
			CheckType:   "max_chars",
		}
	}

	// Count characters (runes, not bytes) — Chinese text is multi-byte.
	charCount := utf8.RuneCountInString(content)
	// Trim whitespace for a fair count.
	trimmed := strings.TrimSpace(content)
	charCount = utf8.RuneCountInString(trimmed)

	var failures []RuleFailure

	if charCount > dsl.Limit {
		failures = append(failures, RuleFailure{
			Rule:     "max_chars",
			Expected: fmt.Sprintf("≤ %d characters", dsl.Limit),
			Actual:   fmt.Sprintf("%d characters", charCount),
			Reason:   fmt.Sprintf("exceeds limit by %d characters", charCount-dsl.Limit),
		})
	}

	// Check forbidden patterns (商业性宣传用语).
	foundForbid := []string{}
	for _, pattern := range dsl.ForbidPatterns {
		re, err := regexp.Compile(pattern)
		if err != nil {
			// Fall back to literal substring match if regex is invalid.
			if strings.Contains(trimmed, pattern) {
				foundForbid = append(foundForbid, pattern)
			}
			continue
		}
		if re.MatchString(trimmed) {
			foundForbid = append(foundForbid, pattern)
		}
	}
	for _, f := range foundForbid {
		failures = append(failures, RuleFailure{
			Rule:     "forbid_pattern",
			Expected: fmt.Sprintf("must not contain %q", f),
			Actual:   fmt.Sprintf("found match for %q", f),
			Reason:   "commercial/promotional language detected",
		})
	}

	verdict := "pass"
	explanation := fmt.Sprintf("%d/%d characters", charCount, dsl.Limit)
	if len(foundForbid) > 0 {
		explanation += fmt.Sprintf(" · forbidden patterns found: [%s]", strings.Join(foundForbid, ", "))
	}
	if len(failures) > 0 {
		verdict = "fail"
	}

	return RuleEvalResult{
		Kind:        "max_chars",
		Verdict:     verdict,
		Explanation: explanation,
		Expected:    map[string]any{"limit": dsl.Limit, "forbid_patterns": dsl.ForbidPatterns},
		Actual:      map[string]any{"char_count": charCount, "found_forbidden": foundForbid},
		Failures:    failures,
		CheckType:   "max_chars",
	}
}

// ---------------------------------------------------------------------------
// claim_graph: 独立/从属权利要求计数、引用关系无环、无多项引多项
// ---------------------------------------------------------------------------
// Prototype :3244 — "独立权利要求 1 项 · 从属 16 项 · 引用关系无环 · 无多项引多项"

// claimPattern matches lines like "1." or "权利要求1" at the start of a claim.
var claimLinePattern = regexp.MustCompile(`(?m)^\s*(\d+)[.、．]\s*(.+)`)

// dependentRefPattern matches "根据权利要求N" or "如权利要求N所述" references.
var dependentRefPattern = regexp.MustCompile(`(?:根据权利要求|如权利要求|按照权利要求)\s*(\d+(?:[、,，和]\s*\d+)*)`)

func evaluateClaimGraph(dsl ruleExprDSL, content string) RuleEvalResult {
	// Parse claims from the content.
	type claim struct {
		number      int
		text        string
		isDependent bool
		refs        []int // referenced claim numbers
	}

	lines := claimLinePattern.FindAllStringSubmatch(content, -1)
	claims := make([]claim, 0, len(lines))
	for _, m := range lines {
		num := 0
		fmt.Sscanf(m[1], "%d", &num)
		if num == 0 {
			continue
		}
		text := m[2]
		refs := []int{}
		refMatches := dependentRefPattern.FindAllStringSubmatch(text, -1)
		for _, rm := range refMatches {
			// Parse comma-separated numbers.
			parts := regexp.MustCompile(`\d+`).FindAllString(rm[1], -1)
			for _, p := range parts {
				var ref int
				fmt.Sscanf(p, "%d", &ref)
				if ref > 0 {
					refs = append(refs, ref)
				}
			}
		}
		claims = append(claims, claim{
			number:      num,
			text:        text,
			isDependent: len(refs) > 0,
			refs:        refs,
		})
	}

	independent := 0
	dependent := 0
	for _, c := range claims {
		if c.isDependent {
			dependent++
		} else {
			independent++
		}
	}

	var failures []RuleFailure

	// Check minimum counts.
	if dsl.MinIndependent > 0 && independent < dsl.MinIndependent {
		failures = append(failures, RuleFailure{
			Rule:     "min_independent_claims",
			Expected: fmt.Sprintf("≥ %d independent claims", dsl.MinIndependent),
			Actual:   fmt.Sprintf("%d independent claims", independent),
			Reason:   "insufficient independent claims",
		})
	}
	if dsl.MinDependent > 0 && dependent < dsl.MinDependent {
		failures = append(failures, RuleFailure{
			Rule:     "min_dependent_claims",
			Expected: fmt.Sprintf("≥ %d dependent claims", dsl.MinDependent),
			Actual:   fmt.Sprintf("%d dependent claims", dependent),
			Reason:   "insufficient dependent claims",
		})
	}

	// Build claim nodes for graph analysis.
	nodes := make([]claimNode, len(claims))
	for i, c := range claims {
		nodes[i] = claimNode{number: c.number, refs: c.refs, isDependent: c.isDependent}
	}

	// Check for cycles in the reference graph.
	hasCycle := false
	if dsl.NoCycles && len(nodes) > 0 {
		hasCycle = detectClaimCycles(nodes)
		if hasCycle {
			failures = append(failures, RuleFailure{
				Rule:     "no_cycles",
				Expected: "claim reference graph must be acyclic",
				Actual:   "cycle detected in claim references",
				Reason:   "circular dependency between claims",
			})
		}
	}

	// Check no multi-dependent referencing multi-dependent.
	multiFromMultiViolation := false
	if dsl.NoMultiFromMulti && len(nodes) > 0 {
		multiFromMultiViolation = detectMultiFromMulti(nodes)
		if multiFromMultiViolation {
			failures = append(failures, RuleFailure{
				Rule:     "no_multi_from_multi",
				Expected: "a multi-dependent claim must not reference another multi-dependent claim",
				Actual:   "multi-dependent claim references another multi-dependent claim",
				Reason:   "patent regulation prohibits multiple dependent claims citing multiple dependent claims",
			})
		}
	}

	verdict := "pass"
	explanation := fmt.Sprintf("independent: %d · dependent: %d · total: %d",
		independent, dependent, len(claims))
	if hasCycle {
		explanation += " · CYCLE DETECTED"
	}
	if multiFromMultiViolation {
		explanation += " · multi-from-multi violation"
	}
	if len(failures) > 0 {
		verdict = "fail"
	}

	return RuleEvalResult{
		Kind:        "claim_graph",
		Verdict:     verdict,
		Explanation: explanation,
		Expected: map[string]any{
			"min_independent":     dsl.MinIndependent,
			"min_dependent":       dsl.MinDependent,
			"no_cycles":           dsl.NoCycles,
			"no_multi_from_multi": dsl.NoMultiFromMulti,
		},
		Actual: map[string]any{
			"independent":      independent,
			"dependent":        dependent,
			"total":            len(claims),
			"has_cycle":        hasCycle,
			"multi_from_multi": multiFromMultiViolation,
		},
		Failures:  failures,
		CheckType: "claim_graph",
	}
}

// claimNode is the internal graph node for cycle/multi-dep detection.
type claimNode struct {
	number      int
	refs        []int
	isDependent bool
}

func detectClaimCycles(nodes []claimNode) bool {
	graph := make(map[int][]int)
	for _, n := range nodes {
		graph[n.number] = n.refs
	}

	visited := make(map[int]int) // 0=unvisited, 1=in-stack, 2=done
	var dfs func(node int) bool
	dfs = func(node int) bool {
		if visited[node] == 1 {
			return true // cycle
		}
		if visited[node] == 2 {
			return false
		}
		visited[node] = 1
		for _, ref := range graph[node] {
			if dfs(ref) {
				return true
			}
		}
		visited[node] = 2
		return false
	}

	for _, n := range nodes {
		if visited[n.number] == 0 {
			if dfs(n.number) {
				return true
			}
		}
	}
	return false
}

func detectMultiFromMulti(nodes []claimNode) bool {
	multiDeps := make(map[int]bool)
	for _, n := range nodes {
		if len(n.refs) > 1 {
			multiDeps[n.number] = true
		}
	}
	for _, n := range nodes {
		if len(n.refs) > 1 {
			// This is a multi-dependent claim — check if it references another multi-dependent.
			for _, ref := range n.refs {
				if multiDeps[ref] {
					return true
				}
			}
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// version_consistency: 申请表与源程序的名称/版本号一致
// ---------------------------------------------------------------------------
// Prototype :3118 — "申请表 v2.1.0 ≠ 源程序页眉 v2.0，须完全一致"

var defaultVersionPattern = regexp.MustCompile(`v?(\d+\.\d+(?:\.\d+)?)`)

func evaluateVersionConsistency(dsl ruleExprDSL, content string) RuleEvalResult {
	// Extract version from the current document.
	versionRe := defaultVersionPattern
	if dsl.VersionPattern != "" {
		custom, err := regexp.Compile(dsl.VersionPattern)
		if err == nil {
			versionRe = custom
		}
	}

	nameRe := regexp.MustCompile(`(?m)^#\s+(.+)$`) // First H1 heading as document name.
	if dsl.NamePattern != "" {
		custom, err := regexp.Compile(dsl.NamePattern)
		if err == nil {
			nameRe = custom
		}
	}

	versionMatch := versionRe.FindString(content)
	nameMatches := nameRe.FindStringSubmatch(content)
	docName := ""
	if len(nameMatches) > 1 {
		docName = strings.TrimSpace(nameMatches[1])
	}

	var failures []RuleFailure
	verdict := "pass"

	if versionMatch == "" {
		failures = append(failures, RuleFailure{
			Rule:     "version_present",
			Expected: "document must contain a version identifier",
			Actual:   "no version found",
			Reason:   "cannot verify version consistency without a version string",
		})
		verdict = "fail"
	}

	explanation := fmt.Sprintf("version=%q, name=%q", versionMatch, docName)
	if dsl.CompareWith != "" {
		explanation += fmt.Sprintf(" (compare_with=%q — cross-document check deferred to full engine)", dsl.CompareWith)
	}

	return RuleEvalResult{
		Kind:        "version_consistency",
		Verdict:     verdict,
		Explanation: explanation,
		Expected: map[string]any{
			"name_pattern":    dsl.NamePattern,
			"version_pattern": dsl.VersionPattern,
			"compare_with":    dsl.CompareWith,
		},
		Actual: map[string]any{
			"found_version": versionMatch,
			"found_name":    docName,
		},
		Failures:  failures,
		CheckType: "version_consistency",
	}
}

// ---------------------------------------------------------------------------
// Seed data upgrade: idempotent rule_expr DSL补写
// ---------------------------------------------------------------------------

// filingSeedRuleUpgrades defines which item_keys get machine rules.
// The upgrade path uses a targeted UPDATE on rows whose rule_expr lacks a
// "kind" field — existing rows with only {description, sort_order} get the
// full DSL merged in without losing their metadata.
var filingSeedRuleUpgrades = map[string]ruleExprDSL{
	"software_manual": {
		Kind: "heading_sequence",
		Headings: []string{
			"技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式",
		},
		Ordered: true,
	},
	"claims_draft": {
		Kind:             "claim_graph",
		MinIndependent:   1,
		MinDependent:     1,
		NoCycles:         true,
		NoMultiFromMulti: true,
	},
	"source_code": {
		Kind:            "version_consistency",
		VersionPattern:  `v?\d+\.\d+(?:\.\d+)?`,
		NamePattern:     `(?m)^#\s+(.+)$`,
		CompareWith:     "software_manual",
		MinPages:        60,
		MinLinesPerPage: 50,
		HeaderMatch:     true,
	},
}

// upgradeFilingItemRules performs an idempotent补写: for each item_key in
// filingSeedRuleUpgrades, if the existing rule_expr has no "kind" field,
// merge the DSL fields into it (preserving description + sort_order).
// Safe to call on every RunFilingCheck — it only writes when kind is absent.
func (h *Handler) upgradeFilingItemRules(ctx context.Context, projectID pgtype.UUID) error {
	for itemKey, upgrade := range filingSeedRuleUpgrades {
		// Read current rule_expr for this item_key in this project.
		var (
			itemID  pgtype.UUID
			rawExpr []byte
		)
		err := h.DB.QueryRow(ctx,
			`SELECT id, rule_expr FROM filing_item WHERE project_id = $1 AND item_key = $2`,
			projectID, itemKey).Scan(&itemID, &rawExpr)
		if err != nil {
			// Item doesn't exist — skip (ensureFilingItems will create it).
			continue
		}

		var existing ruleExprDSL
		if len(rawExpr) > 0 {
			_ = json.Unmarshal(rawExpr, &existing)
		}
		if existing.Kind != "" {
			// Already upgraded — skip.
			continue
		}

		// Merge: keep description + sort_order from existing, add DSL fields.
		merged := upgrade
		merged.Description = existing.Description
		merged.SortOrder = existing.SortOrder

		mergedJSON, err := json.Marshal(merged)
		if err != nil {
			continue
		}
		_, err = h.DB.Exec(ctx,
			`UPDATE filing_item SET rule_expr = $1::jsonb, updated_at = now() WHERE id = $2`,
			string(mergedJSON), itemID)
		if err != nil {
			return fmt.Errorf("upgradeFilingItemRules: %s: %w", itemKey, err)
		}
	}
	return nil
}

// Ensure storage interface is used (compile-time check).
var _ storage.Storage = (storage.Storage)(nil)
