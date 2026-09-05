package handler

import (
	"context"
	"crypto/sha1" //nolint:gosec // git blob object ids are SHA-1 by definition, not a security choice
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 申报就绪度（migration 458）：三档契约 must / conditional / aux。
// 列名以 migration 为准：item_name / item_key / rule_expr / rule_result /
// blocking / status / artifact_id / source_path / checked_at。
// API 契约对齐 packages/core/types/filing.ts：
//   - item status: DB missing/partial/ready = API 一致
//   - item label:  DB item_name → API label
//   - export type: DB full/diagnostic = API 一致
// spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §5.4

// isValidFilingStatus checks whether the status is within the DB CHECK
// constraint (missing / partial / ready) — identical to the API enum.
func isValidFilingStatus(s string) bool {
	return s == "missing" || s == "partial" || s == "ready"
}

func isValidFilingTrack(t string) bool {
	return t == "software_copyright" || t == "patent"
}

func isValidFilingTier(t string) bool {
	return t == "must" || t == "conditional" || t == "aux"
}

// FilingItemResponse mirrors the TS `FilingItem`.
type FilingItemResponse struct {
	ID          string         `json:"id"`
	ProjectID   string         `json:"project_id"`
	WorkspaceID string         `json:"workspace_id"`
	Tier        string         `json:"tier"`
	Track       string         `json:"track"`
	Label       string         `json:"label"`
	Description string         `json:"description"`
	ArtifactID  *string        `json:"artifact_id"`
	Status      string         `json:"status"`
	SortOrder   int32          `json:"sort_order"`
	RuleResult  map[string]any `json:"rule_result,omitempty"`
	SourcePath  string         `json:"source_path,omitempty"`
	RuleKind    string         `json:"rule_kind,omitempty"`
	CreatedAt   string         `json:"created_at"`
	UpdatedAt   string         `json:"updated_at"`
}

// filingItemRow is the scan target for a filing_item row.
type filingItemRow struct {
	ID          pgtype.UUID
	WorkspaceID pgtype.UUID
	ProjectID   pgtype.UUID
	Track       string
	Tier        string
	ItemName    string
	ItemKey     string
	RuleExpr    []byte
	RuleResult  []byte // revived dead column (458:15)
	Blocking    bool
	Status      string
	ArtifactID  pgtype.UUID
	SourcePath  pgtype.Text // revived dead column (458:21) — no writer yet, always NULL
	CheckedAt   pgtype.Timestamptz
	CreatedAt   pgtype.Timestamptz
	UpdatedAt   pgtype.Timestamptz
}

// filingItemColumns includes the revived dead columns rule_result and
// source_path (migration 458 lines 15, 21). source_path has no writer yet —
// it is returned as-is (NULL → empty string in the API response) and will be
// populated when the CLI reports the archive-relative path of the bound file.
const filingItemColumns = `id, workspace_id, project_id, track, tier, item_name, item_key,
	rule_expr, rule_result, blocking, status, artifact_id, source_path, checked_at, created_at, updated_at`

// ruleExprMeta is the JSON shape stored in filing_item.rule_expr for
// seed-generated items. It carries the human-readable description and
// explicit sort order that the API surfaces.
type ruleExprMeta struct {
	Description string `json:"description"`
	SortOrder   int32  `json:"sort_order"`
}

func filingItemToResponse(row filingItemRow) FilingItemResponse {
	var meta ruleExprMeta
	if len(row.RuleExpr) > 0 {
		_ = json.Unmarshal(row.RuleExpr, &meta)
	}
	// Parse rule_kind from the DSL extension.
	dsl := parseRuleExpr(row.RuleExpr)
	// Parse rule_result (revived dead column).
	var ruleResult map[string]any
	if len(row.RuleResult) > 0 && string(row.RuleResult) != "{}" && string(row.RuleResult) != "null" {
		_ = json.Unmarshal(row.RuleResult, &ruleResult)
	}
	// source_path: revived dead column — no writer exists yet, so it is always
	// NULL. Return empty string rather than fabricating a path.
	sourcePath := ""
	if row.SourcePath.Valid {
		sourcePath = row.SourcePath.String
	}
	return FilingItemResponse{
		ID:          uuidToString(row.ID),
		ProjectID:   uuidToString(row.ProjectID),
		WorkspaceID: uuidToString(row.WorkspaceID),
		Tier:        row.Tier,
		Track:       row.Track,
		Label:       row.ItemName,
		Description: meta.Description,
		ArtifactID:  util.UUIDToPtr(row.ArtifactID),
		Status:      row.Status,
		SortOrder:   meta.SortOrder,
		RuleResult:  ruleResult,
		SourcePath:  sourcePath,
		RuleKind:    dsl.Kind,
		CreatedAt:   timestampToString(row.CreatedAt),
		UpdatedAt:   timestampToString(row.UpdatedAt),
	}
}

// listFilingItems loads the project's filing items with optional track/tier
// filters (both validated against the CHECK enums).
func (h *Handler) listFilingItems(w http.ResponseWriter, r *http.Request, project db.Project, track, tier string) ([]filingItemRow, bool) {
	sql := `SELECT ` + filingItemColumns + ` FROM filing_item WHERE project_id = $1`
	args := []any{project.ID}
	if track != "" {
		if !isValidFilingTrack(track) {
			writeError(w, http.StatusBadRequest, "track must be software_copyright or patent")
			return nil, false
		}
		args = append(args, track)
		sql += ` AND track = $2`
	}
	if tier != "" {
		if !isValidFilingTier(tier) {
			writeError(w, http.StatusBadRequest, "tier must be must, conditional or aux")
			return nil, false
		}
		args = append(args, tier)
		sql += ` AND tier = $` + strconv.Itoa(len(args))
	}
	sql += ` ORDER BY tier, item_name`

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list filing items")
		return nil, false
	}
	defer rows.Close()

	items := []filingItemRow{}
	for rows.Next() {
		var row filingItemRow
		if err := rows.Scan(
			&row.ID, &row.WorkspaceID, &row.ProjectID, &row.Track, &row.Tier, &row.ItemName, &row.ItemKey,
			&row.RuleExpr, &row.RuleResult, &row.Blocking, &row.Status, &row.ArtifactID, &row.SourcePath,
			&row.CheckedAt, &row.CreatedAt, &row.UpdatedAt,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan filing item")
			return nil, false
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list filing items")
		return nil, false
	}
	return items, true
}

// FilingReadinessTrackResponse is one track's aggregate (TS `FilingReadiness`).
type FilingReadinessTrackResponse struct {
	Track         string               `json:"track"`
	TotalItems    int64                `json:"total_items"`
	ReadyCount    int64                `json:"ready_count"`
	MustReady     int64                `json:"must_ready"`
	MustTotal     int64                `json:"must_total"`
	BlockingCount int64                `json:"blocking_count"`
	Items         []FilingItemResponse `json:"items"`
	// anno③: blocking items with P0/P1/P2 priority.
	BlockingItems []FilingBlockingItem `json:"blocking_items"`
}

// FilingBlockingItem is one blocking item with its computed priority (anno③).
// P0 = must + no artifact (complete absence, hardest blocker)
// P1 = must + artifact bound but rule failed/pending (material exists but non-conformant)
// P2 = conditional/aux missing or rule-failed (does not block acceptance)
type FilingBlockingItem struct {
	ItemID   string `json:"item_id"`
	Label    string `json:"label"`
	Tier     string `json:"tier"`
	Priority string `json:"priority"`
	Status   string `json:"status"`
	Reason   string `json:"reason"`
}

// ---------------------------------------------------------------------------
// ensureFilingItems: lazy seed — populate the standard checklist on first read.
// ---------------------------------------------------------------------------

type filingSeedItem struct {
	Track       string
	Tier        string
	ItemName    string
	ItemKey     string
	Description string
	SortOrder   int32
}

var filingSeedData = []filingSeedItem{
	// software_copyright track（软著）
	{"software_copyright", "must", "源程序代码", "source_code", "前30页+后30页，每页不少于50行", 1},
	{"software_copyright", "must", "软件说明书", "software_manual", "用户手册或操作说明，含功能截图", 2},
	{"software_copyright", "must", "测试报告", "test_report", "覆盖主要功能路径的测试记录", 3},
	{"software_copyright", "conditional", "需求规格说明书", "requirement_spec", "若为委托开发需提供", 4},
	{"software_copyright", "conditional", "设计说明书", "design_doc", "概要设计+详细设计", 5},
	{"software_copyright", "aux", "代码统计报告", "code_stats_report", "行数、模块数、语言分布", 6},
	// patent track（专利）
	{"patent", "must", "技术交底书", "tech_disclosure", "含技术领域、背景技术、发明内容、附图说明、具体实施方式", 1},
	{"patent", "must", "权利要求书草稿", "claims_draft", "独立权利要求+从属权利要求", 2},
	{"patent", "must", "说明书附图", "spec_drawings", "流程图、架构图、时序图", 3},
	{"patent", "conditional", "检索报告", "search_report", "现有技术检索与对比分析", 4},
	{"patent", "aux", "原型终稿", "prototype_final", "产品原型截图或HTML快照", 5},
	{"patent", "aux", "独创性说明", "originality_statement", "与现有技术的区别点阐述", 6},
}

// ensureFilingItems checks whether filing_item rows exist for the project;
// if none, it inserts the standard checklist (both tracks). Safe to call on
// every request — the UNIQUE(project_id, track, item_key) constraint with ON
// CONFLICT DO NOTHING makes it idempotent.
func (h *Handler) ensureFilingItems(ctx context.Context, project db.Project) error {
	var count int64
	if err := h.DB.QueryRow(ctx,
		`SELECT COUNT(*) FROM filing_item WHERE project_id = $1`, project.ID,
	).Scan(&count); err != nil {
		return fmt.Errorf("ensureFilingItems: count: %w", err)
	}
	if count > 0 {
		return nil
	}

	for _, seed := range filingSeedData {
		ruleExpr, _ := json.Marshal(ruleExprMeta{
			Description: seed.Description,
			SortOrder:   seed.SortOrder,
		})
		blocking := seed.Tier == "must"
		_, err := h.DB.Exec(ctx, `
			INSERT INTO filing_item (workspace_id, project_id, track, tier, item_name, item_key, rule_expr, blocking, status)
			VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'missing')
			ON CONFLICT (project_id, track, item_key) DO NOTHING`,
			project.WorkspaceID, project.ID, seed.Track, seed.Tier,
			seed.ItemName, seed.ItemKey, string(ruleExpr), blocking,
		)
		if err != nil {
			return fmt.Errorf("ensureFilingItems: insert %s/%s: %w", seed.Track, seed.ItemKey, err)
		}
	}
	return nil
}

// GetFilingReadiness implements GET /api/projects/{id}/filing/readiness:
// per-track must/conditional/aux aggregation plus the blocking summary that
// gates package export. A project without filing items (sync not run yet)
// gets a structured empty aggregate for both tracks.
func (h *Handler) GetFilingReadiness(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if err := h.ensureFilingItems(r.Context(), project); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to seed filing items")
		return
	}
	items, ok := h.listFilingItems(w, r, project, "", "")
	if !ok {
		return
	}

	tracks := []FilingReadinessTrackResponse{
		{Track: "software_copyright", Items: []FilingItemResponse{}, BlockingItems: []FilingBlockingItem{}},
		{Track: "patent", Items: []FilingItemResponse{}, BlockingItems: []FilingBlockingItem{}},
	}
	byTrack := map[string]*FilingReadinessTrackResponse{
		"software_copyright": &tracks[0],
		"patent":             &tracks[1],
	}
	for _, row := range items {
		agg := byTrack[row.Track]
		if agg == nil {
			continue
		}
		agg.TotalItems++
		if row.Status == "ready" {
			agg.ReadyCount++
		}
		// anno②: completeness ring counts MUST items only.
		if row.Tier == "must" {
			agg.MustTotal++
			if row.Status == "ready" {
				agg.MustReady++
			}
		}
		// blocking = not ready AND either flagged blocking or must-tier
		// (缺则不予受理).
		if row.Status != "ready" && (row.Blocking || row.Tier == "must") {
			agg.BlockingCount++
			// anno③: compute P0/P1/P2 priority for the blocking panel.
			priority := computeFilingPriority(row.Tier, row.Status, row.ArtifactID.Valid)
			reason := ""
			if !row.ArtifactID.Valid {
				reason = "no artifact bound"
			} else {
				reason = "rule evaluation failed or pending"
			}
			agg.BlockingItems = append(agg.BlockingItems, FilingBlockingItem{
				ItemID:   uuidToString(row.ID),
				Label:    row.ItemName,
				Tier:     row.Tier,
				Priority: priority,
				Status:   row.Status,
				Reason:   reason,
			})
		}
		agg.Items = append(agg.Items, filingItemToResponse(row))
	}

	// Sort blocking items by priority (P0 first, then P1, then P2).
	for i := range tracks {
		sort.SliceStable(tracks[i].BlockingItems, func(a, b int) bool {
			return tracks[i].BlockingItems[a].Priority < tracks[i].BlockingItems[b].Priority
		})
	}

	var totalBlocking int64
	canExport := true
	for i := range tracks {
		totalBlocking += tracks[i].BlockingCount
		if tracks[i].MustTotal > 0 && tracks[i].MustReady < tracks[i].MustTotal {
			canExport = false
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tracks":            tracks,
		"can_export_filing": canExport,
		"blocking_count":    totalBlocking,
	})
}

// ListFilingItems implements GET /api/projects/{id}/filing/items with
// optional track / tier filters.
func (h *Handler) ListFilingItems(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if err := h.ensureFilingItems(r.Context(), project); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to seed filing items")
		return
	}
	items, ok := h.listFilingItems(w, r, project,
		strings.TrimSpace(r.URL.Query().Get("track")),
		strings.TrimSpace(r.URL.Query().Get("tier")))
	if !ok {
		return
	}
	resp := make([]FilingItemResponse, len(items))
	for i, row := range items {
		resp[i] = filingItemToResponse(row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": resp, "total": len(resp)})
}

// RunFilingCheck implements POST /api/projects/{id}/filing/check: recompute
// every filing item's status from its artifact binding AND machine-verifiable
// rules (rule_expr DSL), then record a filing_check_run per item, all inside
// one transaction.
//
// Rule dispatch:
//   - Legacy rule_expr (no "kind"): artifact_presence skeleton — bound → pass,
//     unbound must → fail, unbound conditional/aux → warning.
//   - DSL rule_expr (has "kind"): read the bound attachment content via the
//     same storage path as GetAttachmentContent (file.go:1263-1318), then
//     dispatch to the matching evaluator. Results are persisted in BOTH
//     filing_check_run.detail AND filing_item.rule_result (revived dead column).
//   - PDF/binary attachments: honest degradation — check_type =
//     "pdf_layout_pending_cli", verdict = "pending_cli" in detail. The three
//     PDF columns (page_count, lines_per_page, header_consistency) stay NULL.
//     CLI must parse PDFs locally and report via a future endpoint.
//
// Suggested CLI upload contract (for future implementation):
//
//	POST /api/projects/{id}/filing/check/pdf-metrics
//	Body: { "filing_item_id": "uuid", "page_count": 68, "lines_per_page": 34,
//	        "header_text": "...", "header_consistent": true }
//	This would UPDATE filing_check_run SET page_count=$2, lines_per_page=$3,
//	header_consistency=$4 and re-evaluate the item status.
func (h *Handler) RunFilingCheck(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}

	ctx := r.Context()

	// Idempotent rule upgrade: merge DSL fields into legacy rule_expr rows.
	if err := h.upgradeFilingItemRules(ctx, project.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to upgrade filing rules")
		return
	}

	items, ok := h.listFilingItems(w, r, project, "", "")
	if !ok {
		return
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx)

	type checkOutcome struct {
		Item     FilingItemResponse `json:"item"`
		Verdict  string             `json:"verdict"`
		Priority string             `json:"priority"` // P0/P1/P2 (anno③)
	}
	outcomes := []checkOutcome{}
	var passCount, failCount int64

	for _, row := range items {
		newStatus := "missing"
		verdict := "warning"
		checkType := "artifact_presence"
		var detailJSON string
		var ruleResultJSON string

		dsl := parseRuleExpr(row.RuleExpr)

		if row.ArtifactID.Valid {
			// Verify the artifact actually exists and is not soft-deleted.
			var exists bool
			err := tx.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM project_artifact WHERE id = $1 AND deleted_at IS NULL)`,
				row.ArtifactID).Scan(&exists)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to verify artifact existence")
				return
			}
			if !exists {
				newStatus = "missing"
				verdict = "fail"
				detailJSON = `{"artifact_bound":false,"reason":"artifact deleted or not found"}`
			} else if dsl.hasMachineRule() {
				// Machine-verifiable rule: read content and evaluate.
				content, contentErr := h.readAttachmentContent(ctx, row.ArtifactID)
				evalResult := evaluateRule(dsl, content, contentErr)
				checkType = evalResult.CheckType
				verdict = evalResult.Verdict

				// Map verdict to status.
				switch verdict {
				case "pass":
					newStatus = "ready"
				case "fail":
					newStatus = "partial" // rule failed but artifact exists
				case "pending_cli":
					newStatus = "partial" // cannot determine yet
				default: // warning
					newStatus = "partial"
				}

				detailBytes, _ := json.Marshal(evalResult)
				detailJSON = string(detailBytes)
				ruleResultJSON = string(detailBytes)
			} else {
				// Legacy skeleton: artifact bound + exists → pass.
				newStatus = "ready"
				verdict = "pass"
				detailJSON = `{"artifact_bound":true}`
			}
		} else if row.Tier == "must" {
			newStatus = "missing"
			verdict = "fail"
			detailJSON = `{"artifact_bound":false,"reason":"must-tier item has no artifact"}`
		} else {
			newStatus = "missing"
			verdict = "warning"
			detailJSON = `{"artifact_bound":false}`
		}

		// blocking: a must-tier item that is not ready blocks the filing package.
		isBlocking := row.Tier == "must" && newStatus != "ready"

		// Compute priority (anno③: P0/P1/P2).
		// P0: must + no artifact at all (complete absence)
		// P1: must + artifact bound but rule failed or pending
		// P2: conditional/aux missing or rule-failed
		priority := computeFilingPriority(row.Tier, newStatus, row.ArtifactID.Valid)

		// Update filing_item with status + rule_result (revived dead column).
		if ruleResultJSON != "" {
			if _, err := tx.Exec(ctx, `
				UPDATE filing_item
				SET status = $3, blocking = $4, rule_result = $5::jsonb, checked_at = now(), updated_at = now()
				WHERE id = $1 AND project_id = $2`,
				row.ID, project.ID, newStatus, isBlocking, ruleResultJSON,
			); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to update filing item")
				return
			}
		} else {
			if _, err := tx.Exec(ctx, `
				UPDATE filing_item
				SET status = $3, blocking = $4, checked_at = now(), updated_at = now()
				WHERE id = $1 AND project_id = $2`,
				row.ID, project.ID, newStatus, isBlocking,
			); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to update filing item")
				return
			}
		}

		// Every check leaves a run row — the audit trail is the point of
		// filing_check_run (§4.4). PDF columns (page_count, lines_per_page,
		// header_consistency) stay NULL — they require CLI-side PDF parsing.
		if _, err := tx.Exec(ctx, `
			INSERT INTO filing_check_run (workspace_id, filing_item_id, check_type, verdict, detail)
			VALUES ($1, $2, $3, $4, $5::jsonb)`,
			project.WorkspaceID, row.ID, checkType, verdict, detailJSON,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to record filing check run")
			return
		}
		if verdict == "pass" {
			passCount++
		}
		if verdict == "fail" {
			failCount++
		}
		row.Status = newStatus
		row.Blocking = isBlocking
		if ruleResultJSON != "" {
			row.RuleResult = []byte(ruleResultJSON)
		}
		outcomes = append(outcomes, checkOutcome{
			Item:     filingItemToResponse(row),
			Verdict:  verdict,
			Priority: priority,
		})
	}

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit filing check")
		return
	}
	// TODO(project-archive): publish EventFilingChecked once the protocol
	// constant exists.
	writeJSON(w, http.StatusOK, map[string]any{
		"checked_count": len(outcomes),
		"pass_count":    passCount,
		"fail_count":    failCount,
		"items":         outcomes,
	})
}

// computeFilingPriority derives the P0/P1/P2 blocking priority (anno③).
// Judged from the prototype semantics:
//   - P0: must-tier item with NO artifact bound — complete absence, hardest blocker.
//   - P1: must-tier item with artifact bound but rule evaluation failed or pending
//     (partial status) — material exists but does not meet requirements.
//   - P2: conditional or aux item that is missing or rule-failed — does not block
//     acceptance but degrades package completeness.
func computeFilingPriority(tier, status string, hasArtifact bool) string {
	if status == "ready" {
		return "" // not blocking
	}
	switch tier {
	case "must":
		if !hasArtifact {
			return "P0"
		}
		return "P1"
	default: // conditional, aux
		return "P2"
	}
}

func boolJSONString(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// FilingExportRequest is the body for POST /api/projects/{id}/filing/export.
type FilingExportRequest struct {
	// Track scopes the package; empty = all tracks.
	Track string `json:"track"`
	// ArtifactIDs is the ticked export checklist (原型 f12 标注 5：包按档位
	// 分目录，勾选决定哪些档案进包). must-tier items are always ticked on the
	// client, so an empty list means "the caller did not send a selection" and
	// the package falls back to every bound artifact.
	//
	// filing_export_log (migration 458) has no artifact_ids column, so the
	// selection is persisted inside readiness_snapshot — adding a column would
	// need a migration, which is explicitly out of scope for this change.
	ArtifactIDs []string `json:"artifact_ids"`
}

// ExportFilingPackage implements POST /api/projects/{id}/filing/export.
// must 项未齐 → the server downgrades to a diagnostic package (export_type
// = diagnostic) and explains why; otherwise a full filing package. Either
// way a filing_export_log row records the readiness snapshot at export time.
// The actual zip assembly / download URL is the CLI's job — the handler
// persists the intent and returns the package structure description.
func (h *Handler) ExportFilingPackage(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req FilingExportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Track = strings.TrimSpace(req.Track)
	if req.Track != "" && !isValidFilingTrack(req.Track) {
		writeError(w, http.StatusBadRequest, "track must be software_copyright or patent")
		return
	}
	// The checklist selection is persisted verbatim, so a malformed id would
	// land in the audit trail as garbage — reject it up front. Duplicates are
	// collapsed: ticking the same artifact twice is not an error, it is one
	// artifact in the package.
	selectedArtifactIDs := make([]string, 0, len(req.ArtifactIDs))
	seenArtifactIDs := make(map[string]bool, len(req.ArtifactIDs))
	for _, raw := range req.ArtifactIDs {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, err := util.ParseUUID(id); err != nil {
			writeError(w, http.StatusBadRequest, "artifact_ids must contain valid UUIDs")
			return
		}
		if seenArtifactIDs[id] {
			continue
		}
		seenArtifactIDs[id] = true
		selectedArtifactIDs = append(selectedArtifactIDs, id)
	}
	items, ok := h.listFilingItems(w, r, project, req.Track, "")
	if !ok {
		return
	}

	// Downgrade rule: any unmet must item forces the diagnostic package.
	var missingMust []string
	for _, row := range items {
		if row.Tier == "must" && row.Status != "ready" {
			missingMust = append(missingMust, row.ItemKey)
		}
	}
	dbExportType := "full"
	apiExportType := "full"
	reason := ""
	if len(missingMust) > 0 {
		dbExportType = "diagnostic"
		apiExportType = "diagnostic"
		reason = "must items not ready: " + strings.Join(missingMust, ", ")
	}

	// readiness_snapshot: compact aggregate persisted with the export log so
	// the log stands alone without joining filing_item history.
	readyCount := 0
	for _, row := range items {
		if row.Status == "ready" {
			readyCount++
		}
	}
	snapshot, _ := json.Marshal(map[string]any{
		"track":        req.Track,
		"total_items":  len(items),
		"ready_count":  readyCount,
		"missing_must": missingMust,
		"artifact_ids": selectedArtifactIDs,
		"selected_all": len(selectedArtifactIDs) == 0,
	})
	userUUID, err := util.ParseUUID(userID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	var exportLogID pgtype.UUID
	if err := h.DB.QueryRow(r.Context(), `
		INSERT INTO filing_export_log (workspace_id, project_id, export_type, readiness_snapshot, exported_by_type, exported_by_id)
		VALUES ($1, $2, $3, $4::jsonb, 'member', $5)
		RETURNING id`,
		project.WorkspaceID, project.ID, dbExportType, string(snapshot), userUUID,
	).Scan(&exportLogID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record filing export")
		return
	}

	structure := "filing-package/\n" +
		"  READINESS.md\n" +
		"  A-must/\n" +
		"  B-conditional/\n" +
		"  C-aux/\n"
	if apiExportType == "diagnostic" {
		structure = "diagnostic-package/\n" +
			"  READINESS.md\n" +
			"  missing-must.txt\n" +
			"  A-must/\n" +
			"  B-conditional/\n" +
			"  C-aux/\n"
	}
	// TODO(project-archive): delegate the actual package assembly to the CLI
	// (git archive + snapshot rendering) and return a download_url.
	writeJSON(w, http.StatusOK, map[string]any{
		"success":       true,
		"export_type":   apiExportType,
		"export_log_id": uuidToString(exportLogID),
		"reason":        reason,
		"structure":     structure,
		"artifact_ids":  selectedArtifactIDs,
	})
}

// ---------------------------------------------------------------------------
// 跨项目对比（原型 f12 标注 4）
// ---------------------------------------------------------------------------

// CrossProjectReadinessRow is one project × track must-tier aggregate.
//
// The comparison bar counts MUST items only (标注 4：申报期挑必备件已齐的项
// 目先报) — aux / conditional readiness never decides whether a filing can be
// submitted, so it is deliberately kept out of the percentage.
type CrossProjectReadinessRow struct {
	ProjectID    string  `json:"project_id"`
	ProjectTitle string  `json:"project_title"`
	Track        string  `json:"track"`
	MustReady    int64   `json:"must_ready"`
	MustTotal    int64   `json:"must_total"`
	ReadinessPct float64 `json:"readiness_pct"`
}

// filingReadinessPct renders ready/total as a percentage with one decimal, so
// the CSS bar width and the numeric label share one source of truth instead of
// the client re-deriving it.
func filingReadinessPct(ready, total int64) float64 {
	if total <= 0 {
		return 0
	}
	return math.Round(float64(ready)/float64(total)*1000) / 10
}

// GetFilingCrossProject implements GET /api/projects/{id}/filing/cross-project:
// must-tier readiness for every project in the workspace, one row per
// project × track, most-ready first. Returns a bare JSON array to match the
// spec's `CrossProjectReadinessDTO[]`.
//
// Only projects that already carry filing_item rows appear. Seeding the whole
// workspace on a read would be unbounded write amplification (12 rows per
// project), so the checklist stays lazy — a project joins the comparison the
// first time its own readiness tab is opened. The requested project IS seeded
// here so it can never be missing from its own comparison.
func (h *Handler) GetFilingCrossProject(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if err := h.ensureFilingItems(r.Context(), project); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to seed filing items")
		return
	}

	rows, err := h.DB.Query(r.Context(), `
		SELECT p.id, p.title, fi.track,
		       COUNT(*) FILTER (WHERE fi.tier = 'must' AND fi.status = 'ready')::bigint,
		       COUNT(*) FILTER (WHERE fi.tier = 'must')::bigint
		FROM project p
		JOIN filing_item fi ON fi.project_id = p.id
		WHERE p.workspace_id = $1
		GROUP BY p.id, p.title, fi.track`,
		project.WorkspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate cross-project readiness")
		return
	}
	// pgx single-connection rule: drain and close before the next statement.
	comparison := []CrossProjectReadinessRow{}
	for rows.Next() {
		var (
			projectID pgtype.UUID
			title     string
			track     string
			mustReady int64
			mustTotal int64
		)
		if err := rows.Scan(&projectID, &title, &track, &mustReady, &mustTotal); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan cross-project readiness")
			return
		}
		comparison = append(comparison, CrossProjectReadinessRow{
			ProjectID:    uuidToString(projectID),
			ProjectTitle: title,
			Track:        track,
			MustReady:    mustReady,
			MustTotal:    mustTotal,
			ReadinessPct: filingReadinessPct(mustReady, mustTotal),
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		writeError(w, http.StatusInternalServerError, "failed to aggregate cross-project readiness")
		return
	}
	rows.Close()

	// Sort in Go rather than SQL: the ordering key is a ratio, and doing the
	// division in SQL needs a GREATEST() guard for the empty-track case.
	sort.SliceStable(comparison, func(i, j int) bool {
		if comparison[i].ReadinessPct != comparison[j].ReadinessPct {
			return comparison[i].ReadinessPct > comparison[j].ReadinessPct
		}
		if comparison[i].ProjectTitle != comparison[j].ProjectTitle {
			return comparison[i].ProjectTitle < comparison[j].ProjectTitle
		}
		return comparison[i].Track < comparison[j].Track
	})
	writeJSON(w, http.StatusOK, comparison)
}

// ---------------------------------------------------------------------------
// READINESS.md 回写（design §5.4 POST /projects/{id}/filing/writeback）
// ---------------------------------------------------------------------------

const (
	// filingReadinessRelPath is the fixed archive-relative path of the
	// generated summary (原型 f12 导出包根目录下的 READINESS.md). One path per
	// project is what makes the writeback idempotent.
	filingReadinessRelPath = "filing/READINESS.md"
	// filingReadinessDocType classifies the generated row.
	//
	// project_artifact.doc_type is `TEXT NOT NULL` with NO CHECK enum
	// (migration 455 line 14) — unlike scope / source / stage, which are all
	// constrained. So 'readiness' is a legal value and no migration is needed;
	// nothing had to be approximated with an existing doc_type.
	filingReadinessDocType = "readiness"
)

// gitBlobSHA computes the git object id of a byte slice
// (sha1("blob <len>\0" + content)). Using the real git id — not an arbitrary
// digest — means the next CLI sync of the same file upserts onto this row via
// UNIQUE(resource_id, rel_path, version) with a matching blob_sha instead of
// looking like a content change.
func gitBlobSHA(content []byte) string {
	header := "blob " + strconv.Itoa(len(content)) + "\x00"
	digest := sha1.Sum([]byte(header + string(content))) //nolint:gosec // git object id, not a security digest
	return hex.EncodeToString(digest[:])
}

func filingTierRank(tier string) int {
	switch tier {
	case "must":
		return 0
	case "conditional":
		return 1
	default:
		return 2
	}
}

// markdownTableCell escapes the two characters that would break a pipe table.
func markdownTableCell(s string) string {
	s = strings.ReplaceAll(s, "|", "\\|")
	return strings.ReplaceAll(s, "\n", " ")
}

// renderFilingReadinessMarkdown builds the READINESS.md body: project name,
// both tracks' must readiness ratio, the blocking item list and the generation
// timestamp (原型 f12：`READINESS.md # 必备 3/9 · 阻塞 6`).
//
// Structural copy is English on purpose — this file is a git artifact read by
// filing agents and reviewers, not UI copy, so it must not change with the
// caller's locale. Item names come from the DB seeds and stay verbatim.
func renderFilingReadinessMarkdown(projectTitle string, items []filingItemRow, generatedAt time.Time) string {
	ordered := make([]filingItemRow, len(items))
	copy(ordered, items)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].Track != ordered[j].Track {
			return ordered[i].Track < ordered[j].Track
		}
		if ti, tj := filingTierRank(ordered[i].Tier), filingTierRank(ordered[j].Tier); ti != tj {
			return ti < tj
		}
		var mi, mj ruleExprMeta
		if len(ordered[i].RuleExpr) > 0 {
			_ = json.Unmarshal(ordered[i].RuleExpr, &mi)
		}
		if len(ordered[j].RuleExpr) > 0 {
			_ = json.Unmarshal(ordered[j].RuleExpr, &mj)
		}
		if mi.SortOrder != mj.SortOrder {
			return mi.SortOrder < mj.SortOrder
		}
		return ordered[i].ItemName < ordered[j].ItemName
	})

	type trackAgg struct {
		mustReady int64
		mustTotal int64
	}
	agg := map[string]*trackAgg{
		"software_copyright": {},
		"patent":             {},
	}
	blocking := []filingItemRow{}
	var totalMustReady, totalMustTotal int64
	for _, row := range ordered {
		a := agg[row.Track]
		if a == nil {
			continue
		}
		if row.Tier == "must" {
			a.mustTotal++
			totalMustTotal++
			if row.Status == "ready" {
				a.mustReady++
				totalMustReady++
			} else {
				blocking = append(blocking, row)
			}
		}
	}

	var b strings.Builder
	b.WriteString("# Filing readiness \u00b7 " + projectTitle + "\n\n")
	b.WriteString("- Generated at: " + generatedAt.UTC().Format(time.RFC3339) + "\n")
	b.WriteString("- Must readiness (software_copyright): " +
		strconv.FormatInt(agg["software_copyright"].mustReady, 10) + "/" +
		strconv.FormatInt(agg["software_copyright"].mustTotal, 10) + "\n")
	b.WriteString("- Must readiness (patent): " +
		strconv.FormatInt(agg["patent"].mustReady, 10) + "/" +
		strconv.FormatInt(agg["patent"].mustTotal, 10) + "\n")
	b.WriteString("- Must readiness (overall): " +
		strconv.FormatInt(totalMustReady, 10) + "/" +
		strconv.FormatInt(totalMustTotal, 10) + " (" +
		strconv.FormatFloat(filingReadinessPct(totalMustReady, totalMustTotal), 'f', -1, 64) + "%)\n")
	if totalMustTotal > 0 && totalMustReady < totalMustTotal {
		b.WriteString("- Export gate: BLOCKED \u2014 must items are missing, only a diagnostic package can be exported\n")
	} else {
		b.WriteString("- Export gate: READY\n")
	}

	b.WriteString("\n## Blocking items\n\n")
	if len(blocking) == 0 {
		b.WriteString("_None \u2014 every must-tier item is ready._\n")
	} else {
		b.WriteString("| # | Track | Item | Status | Artifact |\n")
		b.WriteString("| --- | --- | --- | --- | --- |\n")
		for i, row := range blocking {
			artifact := "\u2014"
			if row.ArtifactID.Valid {
				artifact = uuidToString(row.ArtifactID)
			}
			b.WriteString("| " + strconv.Itoa(i+1) +
				" | " + markdownTableCell(row.Track) +
				" | " + markdownTableCell(row.ItemName) +
				" | " + markdownTableCell(row.Status) +
				" | " + markdownTableCell(artifact) + " |\n")
		}
	}

	b.WriteString("\n## Checklist\n")
	currentTrack := ""
	for _, row := range ordered {
		if row.Track != currentTrack {
			currentTrack = row.Track
			b.WriteString("\n### " + currentTrack + "\n\n")
			b.WriteString("| Tier | Item | Status | Blocking | Artifact |\n")
			b.WriteString("| --- | --- | --- | --- | --- |\n")
		}
		artifact := "\u2014"
		if row.ArtifactID.Valid {
			artifact = uuidToString(row.ArtifactID)
		}
		b.WriteString("| " + markdownTableCell(row.Tier) +
			" | " + markdownTableCell(row.ItemName) +
			" | " + markdownTableCell(row.Status) +
			" | " + boolJSONString(row.Blocking) +
			" | " + markdownTableCell(artifact) + " |\n")
	}
	return b.String()
}

// FilingWritebackResponse is the answer to POST .../filing/writeback. The spec
// (§5.4) names it `{ commitSha: string }`; `commit_sha` stays empty because the
// server never touches the filesystem (design decision 3: Git is the only
// source of truth and the CLI owns writes). The row written here is the DB
// pointer the CLI's next sync reconciles against.
type FilingWritebackResponse struct {
	Success     bool   `json:"success"`
	ArtifactID  string `json:"artifact_id"`
	RelPath     string `json:"rel_path"`
	DocType     string `json:"doc_type"`
	Action      string `json:"action"`
	BlobSha     string `json:"blob_sha"`
	SizeBytes   int64  `json:"size_bytes"`
	GeneratedAt string `json:"generated_at"`
	CommitSha   string `json:"commit_sha"`
}

// WritebackFilingReadiness implements POST /api/projects/{id}/filing/writeback:
// render the current readiness as markdown and persist it as a project_artifact
// row at filing/READINESS.md.
//
// Idempotent: UNIQUE(resource_id, rel_path, version) + ON CONFLICT DO UPDATE
// means repeated writebacks refresh the same row (and resurrect it if a sync
// soft-deleted it) instead of piling up versions.
func (h *Handler) WritebackFilingReadiness(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	if err := h.ensureFilingItems(r.Context(), project); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to seed filing items")
		return
	}
	items, ok := h.listFilingItems(w, r, project, "", "")
	if !ok {
		return
	}
	// resource_id is NOT NULL on project_artifact, so a project without an
	// archive directory has nowhere to put the file.
	archiveResourceID, ok := h.loadArchiveResourceID(w, r, project)
	if !ok {
		return
	}

	generatedAt := time.Now()
	content := renderFilingReadinessMarkdown(project.Title, items, generatedAt)
	blobSha := gitBlobSHA([]byte(content))

	// workspace_id is NOT NULL (the Wave 1 pitfall) and must come from the
	// project row — the artifact is not workspace-inferable from the resource.
	var (
		artifactID pgtype.UUID
		inserted   bool
	)
	err := h.DB.QueryRow(r.Context(), `
		INSERT INTO project_artifact (
			workspace_id, project_id, resource_id, scope, doc_type, version,
			rel_path, blob_sha, size_bytes, source, synced_at
		) VALUES ($1, $2, $3, 'project', $4, 1, $5, $6, $7, 'server', now())
		ON CONFLICT (resource_id, rel_path, version) DO UPDATE SET
			scope = 'project',
			doc_type = EXCLUDED.doc_type,
			blob_sha = EXCLUDED.blob_sha,
			size_bytes = EXCLUDED.size_bytes,
			source = 'server',
			synced_at = now(),
			updated_at = now(),
			deleted_at = NULL
		RETURNING id, (xmax = 0)`,
		project.WorkspaceID, project.ID, archiveResourceID,
		filingReadinessDocType, filingReadinessRelPath, blobSha, int64(len(content)),
	).Scan(&artifactID, &inserted)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to write back READINESS.md")
		return
	}
	action := "updated"
	if inserted {
		action = "created"
	}
	// TODO(project-archive): the CLI owns the git write — it must materialise
	// filing/READINESS.md in the archive directory and commit it, then return
	// the commit sha. Until then commit_sha is empty rather than fabricated.
	writeJSON(w, http.StatusOK, FilingWritebackResponse{
		Success:     true,
		ArtifactID:  uuidToString(artifactID),
		RelPath:     filingReadinessRelPath,
		DocType:     filingReadinessDocType,
		Action:      action,
		BlobSha:     blobSha,
		SizeBytes:   int64(len(content)),
		GeneratedAt: generatedAt.UTC().Format(time.RFC3339),
		CommitSha:   "",
	})
}

// ---------------------------------------------------------------------------
// PATCH /api/projects/{id}/filing/items/{itemId} — manual override (anno⑤ escape hatch)
// ---------------------------------------------------------------------------

// FilingItemPatchRequest is the body for PATCH /api/projects/{id}/filing/items/{itemId}.
// Allows manual correction of a filing item's status or artifact binding.
// The override_reason is REQUIRED (原型 :708/:842) — stored in rule_expr JSONB
// under "override_reason" since filing_item has no dedicated column yet.
// TODO(schema): add `override_reason TEXT` column to filing_item in a future
// migration; until then the reason lives inside the rule_expr JSONB.
type FilingItemPatchRequest struct {
	Status         *string `json:"status"`          // "missing" | "partial" | "ready"
	ArtifactID     *string `json:"artifact_id"`     // UUID or null to unbind
	OverrideReason string  `json:"override_reason"` // REQUIRED — why the manual override
}

// PatchFilingItem implements PATCH /api/projects/{id}/filing/items/{itemId}:
// manual override of a filing item's status/binding. This is the escape hatch
// (anno⑤: "override 是逃生门而非常态") for cases where the rule engine cannot
// determine readiness but a human reviewer can.
//
// The override reason is persisted inside rule_expr JSONB (field
// "override_reason") because filing_item has no dedicated column — adding one
// requires a migration which is explicitly out of scope for this task.
func (h *Handler) PatchFilingItem(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}

	itemIDStr := chi.URLParam(r, "itemId")
	itemUUID, err := util.ParseUUID(itemIDStr)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid item id")
		return
	}

	var req FilingItemPatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// override_reason is REQUIRED.
	req.OverrideReason = strings.TrimSpace(req.OverrideReason)
	if req.OverrideReason == "" {
		writeError(w, http.StatusBadRequest, "override_reason is required")
		return
	}

	// Validate status if provided.
	if req.Status != nil {
		if !isValidFilingStatus(*req.Status) {
			writeError(w, http.StatusBadRequest, "status must be missing, partial or ready")
			return
		}
	}

	// Validate artifact_id if provided.
	var newArtifactID pgtype.UUID
	unbindArtifact := false
	if req.ArtifactID != nil {
		if *req.ArtifactID == "" {
			unbindArtifact = true
		} else {
			parsed, err := util.ParseUUID(*req.ArtifactID)
			if err != nil {
				writeError(w, http.StatusBadRequest, "artifact_id must be a valid UUID or empty string to unbind")
				return
			}
			newArtifactID = parsed
		}
	}

	ctx := r.Context()

	// Load the existing item to verify ownership and read current rule_expr.
	var (
		existingRuleExpr []byte
		existingProject  pgtype.UUID
	)
	err = h.DB.QueryRow(ctx,
		`SELECT rule_expr, project_id FROM filing_item WHERE id = $1`,
		itemUUID).Scan(&existingRuleExpr, &existingProject)
	if err != nil {
		writeError(w, http.StatusNotFound, "filing item not found")
		return
	}
	if uuidToString(existingProject) != uuidToString(project.ID) {
		writeError(w, http.StatusNotFound, "filing item not found in this project")
		return
	}

	// Merge override_reason into rule_expr JSONB.
	var ruleExprMap map[string]any
	if len(existingRuleExpr) > 0 {
		_ = json.Unmarshal(existingRuleExpr, &ruleExprMap)
	}
	if ruleExprMap == nil {
		ruleExprMap = make(map[string]any)
	}
	ruleExprMap["override_reason"] = req.OverrideReason
	ruleExprMap["overridden_at"] = time.Now().UTC().Format(time.RFC3339)
	updatedRuleExpr, _ := json.Marshal(ruleExprMap)

	// Build the UPDATE statement dynamically based on what was provided.
	setClauses := []string{"rule_expr = $3::jsonb", "updated_at = now()"}
	args := []any{itemUUID, project.ID, string(updatedRuleExpr)}

	if req.Status != nil {
		args = append(args, *req.Status)
		setClauses = append(setClauses, fmt.Sprintf("status = $%d", len(args)))
		// Recompute blocking: must-tier + not ready = blocking.
		if *req.Status != "ready" {
			setClauses = append(setClauses, "blocking = (tier = 'must')")
		} else {
			setClauses = append(setClauses, "blocking = false")
		}
	}

	if unbindArtifact {
		setClauses = append(setClauses, "artifact_id = NULL")
	} else if newArtifactID.Valid {
		args = append(args, newArtifactID)
		setClauses = append(setClauses, fmt.Sprintf("artifact_id = $%d", len(args)))
	}

	sql := fmt.Sprintf(
		`UPDATE filing_item SET %s WHERE id = $1 AND project_id = $2 RETURNING %s`,
		strings.Join(setClauses, ", "), filingItemColumns,
	)

	var row filingItemRow
	err = h.DB.QueryRow(ctx, sql, args...).Scan(
		&row.ID, &row.WorkspaceID, &row.ProjectID, &row.Track, &row.Tier, &row.ItemName, &row.ItemKey,
		&row.RuleExpr, &row.RuleResult, &row.Blocking, &row.Status, &row.ArtifactID, &row.SourcePath,
		&row.CheckedAt, &row.CreatedAt, &row.UpdatedAt,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update filing item")
		return
	}

	// Record the override in filing_check_run for audit trail.
	overrideDetail, _ := json.Marshal(map[string]any{
		"override_reason": req.OverrideReason,
		"new_status":      req.Status,
		"manual":          true,
	})
	_, _ = h.DB.Exec(ctx, `
		INSERT INTO filing_check_run (workspace_id, filing_item_id, check_type, verdict, detail)
		VALUES ($1, $2, 'manual_override', 'pass', $3::jsonb)`,
		project.WorkspaceID, itemUUID, string(overrideDetail))

	writeJSON(w, http.StatusOK, filingItemToResponse(row))
}
