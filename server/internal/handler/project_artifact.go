package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// 档案条目（project_artifact, migration 455）：Git 是唯一事实源，DB 只存
// 指针（rel_path + blob_sha）与元数据。列名以 migration 为准：
// scope/stage/doc_type/version/rel_path/requirement_key/blob_sha/attachment_id/
// size_bytes/source/synced_at/deleted_at。API 契约对齐
// packages/core/types/artifact.ts（snake_case 字段）。
// spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §5.1

// ProjectArtifactResponse is the JSON shape of a project_artifact row,
// mirroring the TS `ProjectArtifact` contract.
type ProjectArtifactResponse struct {
	ID             string  `json:"id"`
	WorkspaceID    string  `json:"workspace_id"`
	ProjectID      string  `json:"project_id"`
	ResourceID     string  `json:"resource_id"`
	IssueID        *string `json:"issue_id"`
	TaskID         *string `json:"task_id"`
	Scope          string  `json:"scope"`
	Stage          *int32  `json:"stage"`
	DocType        string  `json:"doc_type"`
	Version        int32   `json:"version"`
	RelPath        string  `json:"rel_path"`
	RequirementKey *string `json:"requirement_key"`
	DocClass       *string `json:"doc_class,omitempty"`
	DocModule      *string `json:"doc_module,omitempty"`
	BlobSha        string  `json:"blob_sha"`
	AttachmentID   *string `json:"attachment_id"`
	SizeBytes      int64   `json:"size_bytes"`
	Source         string  `json:"source"`
	SyncedAt       string  `json:"synced_at"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
	// AssetBindingID / AssetRole 是解析后的「档案 ↔ 资产」关联，供交付物 TAB
	// 区分产出物与输入物（nil = 该档案没有关联任何资产）。两类关联不可互换：
	// 原生入档看 project_artifact.asset_binding_id，archive-import 只能回退
	// project_asset_binding.external_ref.artifact_id（migration 474 契约）。
	AssetBindingID *string `json:"asset_binding_id,omitempty"`
	AssetRole      *string `json:"asset_role,omitempty"`
}

// projectArtifactRow is the scan target for a full project_artifact row.
type projectArtifactRow struct {
	ID             pgtype.UUID
	WorkspaceID    pgtype.UUID
	ProjectID      pgtype.UUID
	ResourceID     pgtype.UUID
	IssueID        pgtype.UUID
	TaskID         pgtype.UUID
	Scope          string
	Stage          pgtype.Int4
	DocType        string
	Version        int32
	RelPath        string
	RequirementKey pgtype.Text
	DocClass       pgtype.Text
	DocModule      pgtype.Text
	BlobSha        string
	AttachmentID   pgtype.UUID
	SizeBytes      int64
	Source         string
	SyncedAt       pgtype.Timestamptz
	CreatedAt      pgtype.Timestamptz
	UpdatedAt      pgtype.Timestamptz
	// AssetBindingID 是资产原生档案的反向持链（migration 474）；仅内部用于
	// 双向联动判定，不进 API 响应（前端另有两类关联解析兼容档案导入行）。
	AssetBindingID pgtype.UUID
}

const projectArtifactColumns = `id, workspace_id, project_id, resource_id, issue_id, task_id,
	scope, stage, doc_type, version, rel_path, requirement_key, blob_sha, attachment_id,
	size_bytes, source, synced_at, created_at, updated_at, doc_class, doc_module, asset_binding_id`

func scanProjectArtifactRow(scan func(dest ...any) error) (projectArtifactRow, error) {
	var row projectArtifactRow
	err := scan(
		&row.ID, &row.WorkspaceID, &row.ProjectID, &row.ResourceID, &row.IssueID, &row.TaskID,
		&row.Scope, &row.Stage, &row.DocType, &row.Version, &row.RelPath, &row.RequirementKey,
		&row.BlobSha, &row.AttachmentID, &row.SizeBytes, &row.Source, &row.SyncedAt,
		&row.CreatedAt, &row.UpdatedAt, &row.DocClass, &row.DocModule, &row.AssetBindingID,
	)
	return row, err
}

func projectArtifactToResponse(row projectArtifactRow) ProjectArtifactResponse {
	return ProjectArtifactResponse{
		ID:             uuidToString(row.ID),
		WorkspaceID:    uuidToString(row.WorkspaceID),
		ProjectID:      uuidToString(row.ProjectID),
		ResourceID:     uuidToString(row.ResourceID),
		IssueID:        util.UUIDToPtr(row.IssueID),
		TaskID:         util.UUIDToPtr(row.TaskID),
		Scope:          row.Scope,
		Stage:          util.Int4ToPtr(row.Stage),
		DocType:        row.DocType,
		Version:        row.Version,
		RelPath:        row.RelPath,
		RequirementKey: textToPtr(row.RequirementKey),
		DocClass:       textToPtr(row.DocClass),
		DocModule:      textToPtr(row.DocModule),
		BlobSha:        row.BlobSha,
		AttachmentID:   util.UUIDToPtr(row.AttachmentID),
		SizeBytes:      row.SizeBytes,
		Source:         row.Source,
		SyncedAt:       timestampToString(row.SyncedAt),
		CreatedAt:      timestampToString(row.CreatedAt),
		UpdatedAt:      timestampToString(row.UpdatedAt),
	}
}

// lookupArchiveResourceID reads project.archive_resource_id. The column
// postdates the sqlc snapshot, so this is a direct query.
func (h *Handler) lookupArchiveResourceID(ctx context.Context, projectID pgtype.UUID) (pgtype.UUID, error) {
	var archiveResourceID pgtype.UUID
	err := h.DB.QueryRow(ctx,
		`SELECT archive_resource_id FROM project WHERE id = $1`, projectID,
	).Scan(&archiveResourceID)
	return archiveResourceID, err
}

// loadArchiveResourceID is the read-path resolver. Returns ok=false
// (with the HTTP response already written) when no archive resource is
// attached yet — sync/graph/filing must not invent a bind.
func (h *Handler) loadArchiveResourceID(w http.ResponseWriter, r *http.Request, project db.Project) (pgtype.UUID, bool) {
	archiveResourceID, err := h.lookupArchiveResourceID(r.Context(), project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load project archive resource")
		return pgtype.UUID{}, false
	}
	if !archiveResourceID.Valid {
		writeErrorCode(w, http.StatusNotFound, "archive_resource_missing", "project has no archive resource configured")
		return pgtype.UUID{}, false
	}
	return archiveResourceID, true
}

// loadOrBindOptionalArchiveResourceID is the write-path resolver for manual
// artifact create. If the project already has archive_resource_id, it is used
// as-is; if it is empty, the first local_directory resource is bound and
// persisted — scanning a folder into this project is an explicit bind intent.
// An unbound project is not an error: the artifact is stored with
// resource_id = NULL, exactly like syncAssetToArchive's best-effort bind
// (migration 474 dropped that column's NOT NULL). Listing and content only key
// on project_id, so a NULL-resource row still renders. Sync still uses
// loadArchiveResourceID so an unbound project cannot fake a folder sync.
func (h *Handler) loadOrBindOptionalArchiveResourceID(w http.ResponseWriter, r *http.Request, project db.Project) (pgtype.UUID, bool) {
	archiveResourceID, err := h.lookupArchiveResourceID(r.Context(), project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load project archive resource")
		return pgtype.UUID{}, false
	}
	if archiveResourceID.Valid {
		return archiveResourceID, true
	}
	bound, found, bindErr := h.bindFirstLocalDirectoryArchive(r.Context(), project.ID)
	if bindErr != nil {
		writeError(w, http.StatusInternalServerError, "failed to bind project archive resource")
		return pgtype.UUID{}, false
	}
	if !found {
		return pgtype.UUID{}, true
	}
	return bound, true
}

func (h *Handler) bindFirstLocalDirectoryArchive(ctx context.Context, projectID pgtype.UUID) (pgtype.UUID, bool, error) {
	rows, err := h.Queries.ListProjectResources(ctx, projectID)
	if err != nil {
		return pgtype.UUID{}, false, err
	}
	for _, row := range rows {
		if row.ResourceType != "local_directory" {
			continue
		}
		if err := h.writeArchiveResourceID(ctx, projectID, row.ID); err != nil {
			return pgtype.UUID{}, false, err
		}
		return row.ID, true, nil
	}
	return pgtype.UUID{}, false, nil
}

// ArtifactSyncItemRequest mirrors the TS `ArtifactSyncItem` (snake_case).
type ArtifactSyncItemRequest struct {
	RelPath        string  `json:"rel_path"`
	BlobSha        string  `json:"blob_sha"`
	Scope          string  `json:"scope"`
	Stage          *int32  `json:"stage"`
	DocType        string  `json:"doc_type"`
	Version        int32   `json:"version"`
	RequirementKey *string `json:"requirement_key"`
	IssueID        *string `json:"issue_id"`
	DocClass       *string `json:"doc_class"`
	DocModule      *string `json:"doc_module"`
	SizeBytes      int64   `json:"size_bytes"`
	AttachmentID   *string `json:"attachment_id"`
}

// ArtifactSyncPayload mirrors the TS `ArtifactSyncPayload`.
type ArtifactSyncPayload struct {
	Artifacts     []ArtifactSyncItemRequest `json:"artifacts"`
	GraphSnapshot *GraphSyncPayload         `json:"graph_snapshot"`
	// AllowEmptyManifest is the explicit purge confirmation. An empty manifest
	// is inert by default (see SyncProjectArtifacts); only a caller that sets
	// this flag may soft-delete rows it did not list. It never lifts the
	// source='manual' exemption — a purge removes synced pointers, not human
	// decisions (prototype anno④「写回优先于改库」/ anno⑤).
	AllowEmptyManifest bool `json:"allow_empty_manifest"`
}

// Skip reasons reported in ArtifactSyncResult.SkipReason when the manifest
// diff's soft-delete step was suppressed. Exported as plain JSON strings so the
// CLI and the Web console can branch on them without parsing prose.
const (
	// artifactSyncSkipEmptyManifest: the manifest was `[]` and the caller did
	// not confirm a purge.
	artifactSyncSkipEmptyManifest = "empty_manifest"
	// artifactSyncSkipNoValidItems: the manifest had items but every one was
	// rejected by validation, so nothing proves which paths still exist.
	artifactSyncSkipNoValidItems = "no_valid_items"
)

// ArtifactSyncResult mirrors the TS `ArtifactSyncResult`.
type ArtifactSyncResult struct {
	CreatedCount int64 `json:"created_count"`
	UpdatedCount int64 `json:"updated_count"`
	DeletedCount int64 `json:"deleted_count"`
	// PreservedManual counts the rows whose human result this sync refused to
	// touch: manifest rows that kept their manual issue_id on conflict, plus
	// live manual rows absent from the manifest that were exempted from the
	// soft-delete. Lets the CLI/UI report protection instead of guessing.
	PreservedManual int64 `json:"preserved_manual"`
	// SkippedSoftDelete is true when the diff's delete step did not run at all;
	// SkipReason says why (empty_manifest / no_valid_items). DeletedCount is
	// then always 0 — a caller must never read 0 as "nothing was missing".
	SkippedSoftDelete bool                     `json:"skipped_soft_delete"`
	SkipReason        string                   `json:"skip_reason,omitempty"`
	Errors            []ArtifactSyncErrorEntry `json:"errors"`
}

type ArtifactSyncErrorEntry struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

func isValidArtifactScope(s string) bool {
	return s == "shared" || s == "project" || s == "requirement"
}

// SyncProjectArtifacts implements POST /api/projects/{id}/artifacts/sync:
// full-manifest diff inside one transaction — upsert rows that hit
// UNIQUE(resource_id, rel_path, version), soft-delete rows absent from the
// manifest, and optionally import a graph snapshot submitted in the same
// batch. Re-running with the same manifest is idempotent.
//
// Two invariants guard the diff against silent data loss (prototype
// docs/superpowers/specs/2026-09-05-project-archive-prototype.html anno④/anno⑤):
//
//  1. An EMPTY manifest is a no-op, never a purge. `artifacts: []` means the
//     caller had nothing to assert — the Web console has no filesystem access
//     and a half-wired CLI pipeline can emit an empty list — so deleting every
//     row would turn one button click into total archive loss. Purging requires
//     the explicit `allow_empty_manifest: true` confirmation.
//  2. source='manual' rows keep their issue_id and survive the soft-delete.
//     A manual binding is a human override of the path contract; a later sync
//     cannot tell "human corrected this" from "the path is wrong", so the
//     contract always loses. The row count is reported as preserved_manual.
func (h *Handler) SyncProjectArtifacts(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	archiveResourceID, ok := h.loadArchiveResourceID(w, r, project)
	if !ok {
		return
	}
	var req ArtifactSyncPayload
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// The `artifacts` key itself is required; its emptiness is not an error.
	// encoding/json distinguishes the two: an absent key leaves the slice nil,
	// while `[]` decodes to an empty NON-nil slice (decode.go's `i == 0` branch
	// runs MakeSlice). So nil = the caller forgot the manifest (400), and `[]` =
	// a legitimate empty manifest, handled below as an inert no-op.
	if req.Artifacts == nil {
		writeError(w, http.StatusBadRequest, "artifacts is required")
		return
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx)

	result := ArtifactSyncResult{Errors: []ArtifactSyncErrorEntry{}}
	seenPaths := make([]string, 0, len(req.Artifacts))
	seen := make(map[string]bool, len(req.Artifacts))

	for _, item := range req.Artifacts {
		item.RelPath = strings.TrimSpace(item.RelPath)
		item.BlobSha = strings.TrimSpace(item.BlobSha)
		item.DocType = strings.TrimSpace(item.DocType)
		if item.RelPath == "" || item.BlobSha == "" || item.DocType == "" {
			result.Errors = append(result.Errors, ArtifactSyncErrorEntry{Path: item.RelPath, Reason: "rel_path, blob_sha and doc_type are required"})
			continue
		}
		if !isValidArtifactScope(item.Scope) {
			result.Errors = append(result.Errors, ArtifactSyncErrorEntry{Path: item.RelPath, Reason: "scope must be one of shared/project/requirement"})
			continue
		}
		if item.Stage != nil && (*item.Stage < 1 || *item.Stage > 5) {
			result.Errors = append(result.Errors, ArtifactSyncErrorEntry{Path: item.RelPath, Reason: "stage must be within 1..5"})
			continue
		}
		if item.Version < 1 {
			result.Errors = append(result.Errors, ArtifactSyncErrorEntry{Path: item.RelPath, Reason: "version must be >= 1"})
			continue
		}
		// issue_id is optional but must be a valid UUID when present; an
		// FK-violating placeholder would abort the whole manifest otherwise.
		var issueID pgtype.UUID
		if item.IssueID != nil && *item.IssueID != "" {
			parsed, err := util.ParseUUID(*item.IssueID)
			if err != nil {
				result.Errors = append(result.Errors, ArtifactSyncErrorEntry{Path: item.RelPath, Reason: "issue_id is not a valid UUID"})
				continue
			}
			issueID = parsed
		}
		var attachmentID pgtype.UUID
		if item.AttachmentID != nil && *item.AttachmentID != "" {
			parsed, err := util.ParseUUID(*item.AttachmentID)
			if err != nil {
				result.Errors = append(result.Errors, ArtifactSyncErrorEntry{Path: item.RelPath, Reason: "attachment_id is not a valid UUID"})
				continue
			}
			attachmentID = parsed
		}

		inserted, manualKept, err := upsertProjectArtifact(ctx, tx, project, archiveResourceID, item, issueID, attachmentID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to sync artifact "+item.RelPath)
			return
		}
		if inserted {
			result.CreatedCount++
		} else {
			result.UpdatedCount++
		}
		if manualKept {
			result.PreservedManual++
		}
		if !seen[item.RelPath] {
			seen[item.RelPath] = true
			seenPaths = append(seenPaths, item.RelPath)
		}
	}

	// 链路⑨（design §3.2 invariant 2 / §7 row 2）：issue_prototype_version →
	// project_artifact 单向投影。
	//
	// It runs BEFORE the manifest diff's soft-delete step and feeds its
	// rel_paths into seenPaths, because prototype HTML lives in the business
	// repo (docs/prototypes/) rather than in the archive directory the CLI
	// scans — a manifest that legitimately omits those paths would otherwise
	// delete the projection on every sync. Failure is non-fatal on purpose:
	// the projection is a derived view, and losing it must never fail the
	// CLI's authoritative manifest sync.
	projectedPaths, projectedCreated, projErr := projectPrototypeVersionsInTx(ctx, tx, project, archiveResourceID)
	if projErr != nil {
		slog.Warn("archive: prototype projection degraded, manifest sync continues",
			"project_id", uuidToString(project.ID),
			"error", projErr,
		)
	}
	// Shield the projected paths even when the projection errored part-way:
	// the rows it did upsert are already in this tx and would commit, so
	// letting the manifest diff soft-delete them would only churn (delete this
	// sync, resurrect the next).
	for _, path := range projectedPaths {
		if !seen[path] {
			seen[path] = true
			seenPaths = append(seenPaths, path)
		}
	}
	if projErr == nil && len(projectedPaths) > 0 {
		slog.Info("archive: prototype projection reconciled",
			"project_id", uuidToString(project.ID),
			"projected", len(projectedPaths),
			"created", projectedCreated,
		)
	}

	// Soft-delete rows that dropped out of the manifest — unless the manifest
	// proved nothing, in which case deleting would be guessing (see the handler
	// doc: an empty or wholly-rejected manifest is a no-op, and a purge needs
	// the explicit allow_empty_manifest confirmation).
	accepted := result.CreatedCount + result.UpdatedCount
	if reason := softDeleteSkipReason(len(req.Artifacts), accepted, req.AllowEmptyManifest); reason != "" {
		result.SkippedSoftDelete = true
		result.SkipReason = reason
		slog.Warn("archive: soft-delete skipped, manifest proved nothing",
			"project_id", uuidToString(project.ID),
			"reason", reason,
			"manifest_items", len(req.Artifacts),
			"accepted", accepted,
			"allow_empty_manifest", req.AllowEmptyManifest,
		)
	} else {
		deleted, manualExempt, err := softDeleteAbsentArtifacts(ctx, tx, archiveResourceID, seenPaths)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to soft-delete absent artifacts")
			return
		}
		result.DeletedCount = deleted
		result.PreservedManual += manualExempt
	}

	// Same-batch graph snapshot (git_sha de-dup; retention 5, see §4.2).
	if req.GraphSnapshot != nil {
		if _, _, _, err := syncGraphSnapshotInTx(ctx, tx, project, archiveResourceID, *req.GraphSnapshot); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to sync graph snapshot")
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit artifact sync")
		return
	}
	// TODO(project-archive): publish a workspace event once protocol gains an
	// EventProjectArtifactsSynced constant; the CLI is the only caller today.
	writeJSON(w, http.StatusOK, result)
}

// softDeleteSkipReason decides whether the manifest diff may soft-delete at
// all. "" means the manifest is authoritative enough to diff against.
//
// allowEmptyManifest only lifts the empty-manifest rule: a caller that sent
// items and had every one rejected is not asking for a purge, it is hitting a
// validation bug, and turning that bug into total archive loss is exactly the
// failure this guard exists to prevent.
func softDeleteSkipReason(manifestItems int, accepted int64, allowEmptyManifest bool) string {
	if manifestItems == 0 {
		if allowEmptyManifest {
			return ""
		}
		return artifactSyncSkipEmptyManifest
	}
	if accepted == 0 {
		return artifactSyncSkipNoValidItems
	}
	return ""
}

// softDeleteAbsentArtifacts marks every live row of the archive resource that
// the manifest did not mention as deleted, and reports how many rows it
// touched plus how many source='manual' rows it deliberately exempted.
//
// Both counts come from ONE statement so they read the same snapshot: the
// data-modifying CTE and the counting CTE of a single query see the same row
// versions, and their predicates are disjoint (source <> 'manual' vs
// source = 'manual'), so the exempt count is unaffected by the update.
func softDeleteAbsentArtifacts(ctx context.Context, tx pgx.Tx, archiveResourceID pgtype.UUID, seenPaths []string) (deleted int64, manualExempt int64, err error) {
	err = tx.QueryRow(ctx, `
		WITH shielded AS (
			UPDATE project_artifact
			SET deleted_at = now(), updated_at = now()
			WHERE resource_id = $1 AND deleted_at IS NULL
			  AND source <> 'manual'
			  AND source <> 'asset' AND asset_binding_id IS NULL
			  AND NOT (rel_path = ANY($2))
			RETURNING 1
		), manual_kept AS (
			SELECT count(*) AS n
			FROM project_artifact
			WHERE resource_id = $1 AND deleted_at IS NULL
			  AND (source = 'manual' OR source = 'asset' OR asset_binding_id IS NOT NULL)
			  AND NOT (rel_path = ANY($2))
		)
		SELECT (SELECT count(*) FROM shielded), (SELECT n FROM manual_kept)`,
		archiveResourceID, seenPaths).Scan(&deleted, &manualExempt)
	return deleted, manualExempt, err
}

// upsertProjectArtifact inserts a manifest row or, on
// UNIQUE(resource_id, rel_path, version) conflict, refreshes its pointer
// metadata and resurrects it if previously soft-deleted. Returns inserted=true
// for a fresh row (PostgreSQL `xmax = 0` trick) and manualKept=true when the
// row it hit was a human override whose issue_id this call refused to rewrite.
//
// issue_id is the only classification column the manifest is allowed to move,
// and only while the row is machine-owned: scope / stage / doc_type / source
// are already absent from the SET list, and a source='manual' row keeps its
// binding (prototype anno⑤ — without this the next sync silently undoes the
// override and the audit trail still claims a human made it).
func upsertProjectArtifact(ctx context.Context, tx pgx.Tx, project db.Project, archiveResourceID pgtype.UUID, item ArtifactSyncItemRequest, issueID, attachmentID pgtype.UUID) (inserted bool, manualKept bool, err error) {
	err = tx.QueryRow(ctx, `
		INSERT INTO project_artifact (
			workspace_id, project_id, resource_id, issue_id, scope, stage, doc_type,
			version, rel_path, requirement_key, blob_sha, attachment_id, size_bytes,
			source, synced_at, doc_class, doc_module
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7,
			$8, $9, $10, $11, $12, $13,
			'sync', now(), $14, $15
		)
		ON CONFLICT (resource_id, rel_path, version) DO UPDATE SET
			issue_id = CASE WHEN project_artifact.source = 'manual'
				THEN project_artifact.issue_id
				ELSE EXCLUDED.issue_id END,
			blob_sha = EXCLUDED.blob_sha,
			attachment_id = EXCLUDED.attachment_id,
			size_bytes = EXCLUDED.size_bytes,
			doc_class = EXCLUDED.doc_class,
			doc_module = CASE
				WHEN EXCLUDED.doc_module IS NOT NULL THEN EXCLUDED.doc_module
				WHEN project_artifact.doc_module IS NOT NULL THEN project_artifact.doc_module
				ELSE NULL END,
			synced_at = now(),
			updated_at = now(),
			deleted_at = NULL
		RETURNING (xmax = 0), (source = 'manual')`,
		project.WorkspaceID, project.ID, archiveResourceID, issueID, item.Scope,
		util.PtrToInt4(item.Stage), item.DocType, item.Version, item.RelPath,
		util.PtrToText(item.RequirementKey), item.BlobSha, attachmentID, item.SizeBytes,
		util.PtrToText(docClassPtr(item.DocClass, item.DocType, item.RelPath)),
		util.PtrToText(normalizeDocModulePtr(item.DocModule)),
	).Scan(&inserted, &manualKept)
	return inserted, manualKept, err
}

// artifactAssetLink 是档案行解析出的资产关联（bindingID + 对象角色；role 空串 = 未标）。
type artifactAssetLink struct {
	bindingID string
	role      string
}

// resolveArtifactAssetLinks 批量解析项目内档案 → 资产关联。两类关联不可互换
// （migration 474 契约）：原生资产入档只在 project_artifact.asset_binding_id
// 上，archive-import 只把 artifact_id 存在 binding.external_ref 里，因此前者
// 优先、后者回退。交付物口径只依赖这份映射，解析失败不让列表整体 500——
// 最坏情况是该行退化成「未关联资产」，与历史行为一致。
func (h *Handler) resolveArtifactAssetLinks(ctx context.Context, projectID pgtype.UUID) map[string]artifactAssetLink {
	links := map[string]artifactAssetLink{}
	rows, err := h.DB.Query(ctx, `
		SELECT artifact_id, binding_id, role FROM (
			SELECT a.id::text AS artifact_id, b.id::text AS binding_id, COALESCE(b.asset_role, '') AS role, 0 AS pri
			FROM project_artifact a
			JOIN project_asset_binding b ON b.id = a.asset_binding_id
			WHERE a.project_id = $1 AND a.deleted_at IS NULL
			UNION ALL
			SELECT b.external_ref->>'artifact_id', b.id::text, COALESCE(b.asset_role, ''), 1
			FROM project_asset_binding b
			WHERE b.project_id = $1
			  AND b.external_ref->>'artifact_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		) linked
		ORDER BY pri`, projectID)
	if err != nil {
		slog.Warn("list artifacts: resolve asset links failed",
			"project_id", uuidToString(projectID), "error", err)
		return links
	}
	defer rows.Close()
	for rows.Next() {
		var artifactID, bindingID, role string
		if scanErr := rows.Scan(&artifactID, &bindingID, &role); scanErr != nil {
			slog.Warn("list artifacts: scan asset link failed",
				"project_id", uuidToString(projectID), "error", scanErr)
			return links
		}
		if _, exists := links[artifactID]; exists {
			continue // 原生关联优先，UNION ALL 里回退行不覆盖
		}
		links[artifactID] = artifactAssetLink{bindingID: bindingID, role: role}
	}
	return links
}

// ListProjectArtifacts implements GET /api/projects/{id}/artifacts with
// optional scope / stage / doc_type / issue_id filters. Soft-deleted rows are
// always excluded.
func (h *Handler) ListProjectArtifacts(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}

	query := r.URL.Query()
	scope := strings.TrimSpace(query.Get("scope"))
	if scope != "" && !isValidArtifactScope(scope) {
		writeError(w, http.StatusBadRequest, "scope must be one of shared/project/requirement")
		return
	}
	var stage *int32
	if stageStr := query.Get("stage"); stageStr != "" {
		parsed, err := strconv.Atoi(stageStr)
		if err != nil || parsed < 1 || parsed > 5 {
			writeError(w, http.StatusBadRequest, "stage must be an integer within 1..5")
			return
		}
		s := int32(parsed)
		stage = &s
	}
	docType := strings.TrimSpace(query.Get("doc_type"))
	docClass := strings.ToLower(strings.TrimSpace(query.Get("doc_class")))
	if docClass != "" && !knownDocClasses[docClass] && docClass != "planning" {
		writeError(w, http.StatusBadRequest, "doc_class must be one of prd/mrd/brd/roadmap/planning")
		return
	}
	q := strings.TrimSpace(query.Get("q"))
	issueIDStr := strings.TrimSpace(query.Get("issue_id"))
	var issueID pgtype.UUID
	if issueIDStr != "" {
		parsed, err := util.ParseUUID(issueIDStr)
		if err != nil {
			writeError(w, http.StatusBadRequest, "issue_id is not a valid UUID")
			return
		}
		issueID = parsed
	}

	sql := `SELECT ` + projectArtifactColumns + `
		FROM project_artifact
		WHERE project_id = $1 AND deleted_at IS NULL`
	args := []any{project.ID}
	if scope != "" {
		args = append(args, scope)
		sql += ` AND scope = $` + strconv.Itoa(len(args))
	}
	if stage != nil {
		args = append(args, *stage)
		sql += ` AND stage = $` + strconv.Itoa(len(args))
	}
	if docType != "" {
		args = append(args, docType)
		sql += ` AND doc_type = $` + strconv.Itoa(len(args))
	}
	if docClass == "planning" {
		sql += ` AND (
			doc_class IN ('prd','mrd','brd','roadmap')
			OR doc_type IN ('research','product-design','work-plan')
			OR rel_path LIKE '%/overview/research/%'
			OR rel_path LIKE '%/overview/product-design/%'
			OR rel_path LIKE '%/change_logs/%/plans/%'
		)`
	} else if docClass != "" {
		args = append(args, docClass)
		sql += ` AND doc_class = $` + strconv.Itoa(len(args))
	}
	if q != "" {
		args = append(args, "%"+q+"%")
		n := strconv.Itoa(len(args))
		sql += ` AND (
			rel_path ILIKE $` + n + `
			OR doc_type ILIKE $` + n + `
			OR COALESCE(doc_class, '') ILIKE $` + n + `
			OR COALESCE(doc_module, '') ILIKE $` + n + `
			OR COALESCE(requirement_key, '') ILIKE $` + n + `
		)`
	}
	if issueID.Valid {
		args = append(args, issueID)
		sql += ` AND issue_id = $` + strconv.Itoa(len(args))
	}
	sql += ` ORDER BY created_at DESC, id`

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project artifacts")
		return
	}
	defer rows.Close()

	artifacts := []ProjectArtifactResponse{}
	for rows.Next() {
		row, err := scanProjectArtifactRow(rows.Scan)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan project artifact")
			return
		}
		artifacts = append(artifacts, projectArtifactToResponse(row))
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project artifacts")
		return
	}
	// 交付物口径所需的资产关联：只补响应字段，不改变列表本身（档案 TAB 仍要
	// 看到输入物）。前端据此把对象≠产物的档案挡在交付物 TAB 之外。
	links := h.resolveArtifactAssetLinks(r.Context(), project.ID)
	for i := range artifacts {
		link, ok := links[artifacts[i].ID]
		if !ok {
			continue
		}
		bindingID, role := link.bindingID, link.role
		artifacts[i].AssetBindingID = &bindingID
		if role != "" {
			artifacts[i].AssetRole = &role
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"artifacts": artifacts, "total": len(artifacts)})
}

// loadProjectArtifact resolves one artifact within the given project.
func (h *Handler) loadProjectArtifact(w http.ResponseWriter, r *http.Request, project db.Project) (projectArtifactRow, bool) {
	artifactUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "artifactId"), "artifact id")
	if !ok {
		return projectArtifactRow{}, false
	}
	row, err := scanProjectArtifactRow(func(dest ...any) error {
		return h.DB.QueryRow(r.Context(),
			`SELECT `+projectArtifactColumns+` FROM project_artifact WHERE id = $1`,
			artifactUUID,
		).Scan(dest...)
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "project artifact not found")
		return projectArtifactRow{}, false
	}
	if row.ProjectID != project.ID {
		writeError(w, http.StatusNotFound, "project artifact not found")
		return projectArtifactRow{}, false
	}
	return row, true
}

// GetProjectArtifact implements GET /api/projects/{id}/artifacts/{artifactId}.
func (h *Handler) GetProjectArtifact(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	row, ok := h.loadProjectArtifact(w, r, project)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, projectArtifactToResponse(row))
}

// GetArtifactContent implements GET /api/projects/{id}/artifacts/{artifactId}/content.
// Skeleton: streaming through the attachment proxy (signed URLs, binary
// ranges) is deferred; the endpoint returns the artifact metadata plus the
// attachment URL when a rendered snapshot exists, and content_unavailable
// otherwise so the client can fall back to git.
func (h *Handler) GetArtifactContent(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	row, ok := h.loadProjectArtifact(w, r, project)
	if !ok {
		return
	}
	resp := map[string]any{
		"artifact":            projectArtifactToResponse(row),
		"content_unavailable": true,
	}
	if row.AttachmentID.Valid {
		var attachmentURL string
		err := h.DB.QueryRow(r.Context(),
			`SELECT url FROM attachment WHERE id = $1 AND workspace_id = $2`,
			row.AttachmentID, project.WorkspaceID,
		).Scan(&attachmentURL)
		if err == nil && attachmentURL != "" {
			resp["content_unavailable"] = false
			resp["attachment_url"] = attachmentURL
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// ArchiveDeliverableRequest is the body for POST .../artifacts/{artifactId}/archive.
//
// Two modes (spec 2026-09-05-project-archive-design.md §5.1, prototype f6):
//   - Mode A — reclassify: artifact_id (body, else the {artifactId} URL param)
//     resolves to an existing row in THIS project → UPDATE
//     scope/stage/doc_type/issue_id (omitted stage/issue_id keep their value).
//   - Mode B — new archive row: artifact_id empty/invalid/foreign/missing and
//     resource_id + rel_path + doc_type present → INSERT a fresh row with
//     source='agent'. This is the「交付物 → 新建档案」path.
type ArchiveDeliverableRequest struct {
	ArtifactID     *string `json:"artifact_id"`
	ResourceID     *string `json:"resource_id"`
	RelPath        string  `json:"rel_path"`
	Scope          string  `json:"scope"`
	Stage          *int32  `json:"stage"`
	DocType        string  `json:"doc_type"`
	IssueID        *string `json:"issue_id"`
	RequirementKey *string `json:"requirement_key"`
	BlobSha        string  `json:"blob_sha"`
	SizeBytes      int64   `json:"size_bytes"`
}

// ArchiveDeliverableResponse is the uniform response for the archive action:
// the affected artifact id plus which mode ran ("created" | "reclassified").
type ArchiveDeliverableResponse struct {
	ArtifactID string `json:"artifact_id"`
	Action     string `json:"action"`
}

// ArchiveDeliverable implements POST /api/projects/{id}/artifacts/{artifactId}/archive.
// See ArchiveDeliverableRequest for the two modes. In the full design the CLI
// writes the file into the archive directory and uploads a rendered snapshot;
// the server-side skeleton validates the request and records the new
// classification (source='agent'), leaving the CLI round-trip as a TODO.
func (h *Handler) ArchiveDeliverable(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	var req ArchiveDeliverableRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Scope = strings.TrimSpace(req.Scope)
	req.DocType = strings.TrimSpace(req.DocType)
	req.RelPath = strings.TrimSpace(req.RelPath)
	req.BlobSha = strings.TrimSpace(req.BlobSha)
	if !isValidArtifactScope(req.Scope) {
		writeError(w, http.StatusBadRequest, "scope must be one of shared/project/requirement")
		return
	}
	if req.DocType == "" {
		writeError(w, http.StatusBadRequest, "doc_type is required")
		return
	}
	if req.Stage != nil && (*req.Stage < 1 || *req.Stage > 5) {
		writeError(w, http.StatusBadRequest, "stage must be within 1..5")
		return
	}
	var reqIssueID pgtype.UUID
	if req.IssueID != nil && strings.TrimSpace(*req.IssueID) != "" {
		parsed, err := util.ParseUUID(strings.TrimSpace(*req.IssueID))
		if err != nil {
			writeError(w, http.StatusBadRequest, "issue_id is not a valid UUID")
			return
		}
		reqIssueID = parsed
	}

	// Resolve the target artifact id: the body wins, else the {artifactId} URL
	// param. Mode A needs a row that exists in THIS project; anything else
	// (empty / invalid / foreign / missing) falls through to Mode B.
	artifactIDStr := ""
	if req.ArtifactID != nil {
		artifactIDStr = strings.TrimSpace(*req.ArtifactID)
	}
	if artifactIDStr == "" {
		artifactIDStr = strings.TrimSpace(chi.URLParam(r, "artifactId"))
	}
	if artifactIDStr != "" {
		if artifactUUID, parseErr := util.ParseUUID(artifactIDStr); parseErr == nil {
			row, loadErr := scanProjectArtifactRow(func(dest ...any) error {
				return h.DB.QueryRow(r.Context(),
					`SELECT `+projectArtifactColumns+` FROM project_artifact WHERE id = $1`,
					artifactUUID,
				).Scan(dest...)
			})
			if loadErr == nil && row.ProjectID == project.ID {
				// Mode A — reclassify the existing row. 资产关联行走五阶段统一
				// 映射并保留来源徽标，lifecycle 回写与档案 UPDATE 同事务。
				stage := row.Stage
				if req.Stage != nil {
					stage = util.PtrToInt4(req.Stage)
				}
				issueID := row.IssueID
				if reqIssueID.Valid {
					issueID = reqIssueID
				}
				nativeLinked := row.AssetBindingID.Valid || row.Source == "asset"
				var extIDs []pgtype.UUID
				if !nativeLinked {
					ids, extErr := findExternalBindingIDsForArtifact(r.Context(), h.DB, row.ID)
					if extErr != nil {
						writeError(w, http.StatusInternalServerError, "failed to resolve asset link")
						return
					}
					extIDs = ids
				}
				linkedModeA := nativeLinked || len(extIDs) > 0
				docType := req.DocType
				if linkedModeA {
					if p, ok := placementForArchiveStage(stage); ok {
						// stage 单侧提交时按统一映射补 doc_type，防货架分叉。
						docType = p.DocType
					}
					if _, ok := lifecycleForArchivePlacement(stage, docType); !ok {
						writeError(w, http.StatusBadRequest, "stage and doc_type do not form a valid asset shelf combination")
						return
					}
				}
				// TODO(project-archive): enqueue the CLI write that copies the
				// file into the archive directory (scope/stage/doc_type layout)
				// and uploads the rendered attachment before this
				// reclassification becomes user-visible.
				tx, txErr := h.TxStarter.Begin(r.Context())
				if txErr != nil {
					writeError(w, http.StatusInternalServerError, "failed to archive deliverable")
					return
				}
				defer tx.Rollback(r.Context()) //nolint:errcheck
				updateSQL := `
					UPDATE project_artifact
					SET scope = $3, stage = $4, doc_type = $5, issue_id = $6,
					    synced_at = now(), updated_at = now(), deleted_at = NULL`
				if !linkedModeA {
					updateSQL += ", source = 'agent'"
				}
				if next := shelfRelPathForMove(row.RelPath, row.DocType, docType); next != "" {
					updateSQL += ", rel_path = '" + strings.ReplaceAll(next, "'", "''") + "'"
				}
				updateSQL += `
					WHERE id = $1 AND workspace_id = $2
					RETURNING ` + projectArtifactColumns
				updated, err := scanProjectArtifactRow(func(dest ...any) error {
					return tx.QueryRow(r.Context(), updateSQL,
						row.ID, project.WorkspaceID, req.Scope, stage, docType, issueID,
					).Scan(dest...)
				})
				if err != nil {
					writeError(w, http.StatusInternalServerError, "failed to archive deliverable")
					return
				}
				if linkedModeA {
					lifecycle, _ := lifecycleForArchivePlacement(stage, docType)
					bindingIDs := extIDs
					if nativeLinked {
						bindingIDs = []pgtype.UUID{row.AssetBindingID}
					}
					for _, bindingID := range bindingIDs {
						if !bindingID.Valid {
							continue
						}
						if err := applyLinkedAssetLifecycle(r.Context(), tx, bindingID, project.WorkspaceID, lifecycle); err != nil {
							writeError(w, http.StatusInternalServerError, "failed to sync asset lifecycle")
							return
						}
					}
					if err := tx.Commit(r.Context()); err != nil {
						writeError(w, http.StatusInternalServerError, "failed to archive deliverable")
						return
					}
					for _, bindingID := range bindingIDs {
						if !bindingID.Valid {
							continue
						}
						h.publish(protocol.EventAssetUpdated, uuidToString(project.WorkspaceID), "member", "", map[string]any{
							"binding_id": uuidToString(bindingID), "project_id": uuidToString(project.ID),
						})
					}
				} else if err := tx.Commit(r.Context()); err != nil {
					writeError(w, http.StatusInternalServerError, "failed to archive deliverable")
					return
				}
				// TODO(project-archive): publish EventProjectArtifactArchived
				// once the protocol constant exists.
				writeJSON(w, http.StatusOK, ArchiveDeliverableResponse{
					ArtifactID: uuidToString(updated.ID),
					Action:     "reclassified",
				})
				return
			}
		}
	}

	// Mode B — create a new archive row from the deliverable card. The INSERT
	// carries workspace_id (NOT NULL) alongside the spec's column set; blob_sha
	// defaults to "" and is refreshed by the next CLI sync, which upserts on
	// UNIQUE(resource_id, rel_path, version).
	if req.ResourceID == nil || strings.TrimSpace(*req.ResourceID) == "" {
		writeError(w, http.StatusBadRequest, "resource_id is required to create a new archive artifact")
		return
	}
	resourceID, err := util.ParseUUID(strings.TrimSpace(*req.ResourceID))
	if err != nil {
		writeError(w, http.StatusBadRequest, "resource_id is not a valid UUID")
		return
	}
	if req.RelPath == "" {
		writeError(w, http.StatusBadRequest, "rel_path is required to create a new archive artifact")
		return
	}
	created, err := scanProjectArtifactRow(func(dest ...any) error {
		return h.DB.QueryRow(r.Context(), `
			INSERT INTO project_artifact (
				workspace_id, project_id, resource_id, issue_id, scope, stage, doc_type,
				version, rel_path, requirement_key, blob_sha, size_bytes, source, synced_at
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7,
				1, $8, $9, $10, $11, 'agent', now()
			)
			RETURNING `+projectArtifactColumns,
			project.WorkspaceID, project.ID, resourceID, reqIssueID, req.Scope,
			util.PtrToInt4(req.Stage), req.DocType, req.RelPath,
			util.PtrToText(req.RequirementKey), req.BlobSha, req.SizeBytes,
		).Scan(dest...)
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "an archive artifact already exists for this path and version")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to create archive artifact")
		return
	}
	// TODO(project-archive): publish EventProjectArtifactArchived once the
	// protocol constant exists.
	writeJSON(w, http.StatusOK, ArchiveDeliverableResponse{
		ArtifactID: uuidToString(created.ID),
		Action:     "created",
	})
}

// GetArtifactMatrix implements GET /api/projects/{id}/artifacts/matrix:
// artifact counts aggregated by issue_id × stage, driving the archive matrix
// view (画面 2/3). Unbound artifacts aggregate under issue_id = null.
func (h *Handler) GetArtifactMatrix(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT issue_id, stage, COUNT(*)::bigint
		FROM project_artifact
		WHERE project_id = $1 AND deleted_at IS NULL
		GROUP BY issue_id, stage
		ORDER BY issue_id NULLS LAST, stage NULLS LAST`,
		project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate artifact matrix")
		return
	}
	defer rows.Close()

	type matrixCell struct {
		IssueID *string `json:"issue_id"`
		Stage   *int32  `json:"stage"`
		Count   int64   `json:"count"`
	}
	cells := []matrixCell{}
	for rows.Next() {
		var cell matrixCell
		var issueID pgtype.UUID
		var stage pgtype.Int4
		if err := rows.Scan(&issueID, &stage, &cell.Count); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan artifact matrix")
			return
		}
		cell.IssueID = util.UUIDToPtr(issueID)
		cell.Stage = util.Int4ToPtr(stage)
		cells = append(cells, cell)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate artifact matrix")
		return
	}
	var total int64
	for _, c := range cells {
		total += c.Count
	}
	writeJSON(w, http.StatusOK, map[string]any{"matrix": cells, "total": total})
}

// issueBelongsToProject reports whether the given issue exists and is scoped
// to the given project. Guards artifact→issue bindings so a requirement from
// another project can never be attached (the FK only checks existence).
func (h *Handler) issueBelongsToProject(ctx context.Context, issueID, projectID pgtype.UUID) (bool, error) {
	var exists bool
	err := h.DB.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM issue WHERE id = $1 AND project_id = $2)`,
		issueID, projectID,
	).Scan(&exists)
	return exists, err
}

// PatchProjectArtifactRequest is the body for PATCH .../artifacts/{artifactId}.
// Only non-nil fields are written; non-linked writes stamp source='manual',
// asset-linked rows keep their provenance (五阶段对齐 plan §4.3).
type PatchProjectArtifactRequest struct {
	Scope          *string `json:"scope"`
	Stage          *int32  `json:"stage"`
	IssueID        *string `json:"issue_id"`
	DocType        *string `json:"doc_type"`
	RelPath        *string `json:"rel_path"`
	RequirementKey *string `json:"requirement_key"`
	DocClass       *string `json:"doc_class"`
	DocModule      *string `json:"doc_module"`
	Content        *string `json:"content"`
}

// PatchProjectArtifact implements PATCH /api/projects/{id}/artifacts/{artifactId}:
// partial reclassification of one artifact (scope / stage / doc_type / issue
// binding). Omitted fields keep their value; an empty issue_id string unbinds.
// 资产关联行（asset_binding_id 或 external_ref.artifact_id 两类）的 stage/doc_type
// 由服务端按五阶段唯一映射双向校正，档案 UPDATE 与资产 lifecycle 回写在同一
// 事务内提交或回滚；非关联行维持原动态 SET + source='manual' 规则。
func (h *Handler) PatchProjectArtifact(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	row, ok := h.loadProjectArtifact(w, r, project)
	if !ok {
		return
	}
	var req PatchProjectArtifactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// 联动判定必须在事务内锁行后进行，避免并发 PATCH 基于过期值写分叉。
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update project artifact")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var linked projectArtifactRow
	lockErr := tx.QueryRow(ctx,
		`SELECT `+projectArtifactColumns+` FROM project_artifact WHERE id = $1 FOR UPDATE`,
		row.ID).Scan(
		&linked.ID, &linked.WorkspaceID, &linked.ProjectID, &linked.ResourceID,
		&linked.IssueID, &linked.TaskID, &linked.Scope, &linked.Stage, &linked.DocType,
		&linked.Version, &linked.RelPath, &linked.RequirementKey, &linked.BlobSha,
		&linked.AttachmentID, &linked.SizeBytes, &linked.Source, &linked.SyncedAt,
		&linked.CreatedAt, &linked.UpdatedAt, &linked.DocClass, &linked.DocModule,
		&linked.AssetBindingID,
	)
	if lockErr != nil {
		writeError(w, http.StatusInternalServerError, "failed to lock project artifact")
		return
	}
	row = linked

	// stage 校验全入口放开到 1..5（五阶段对齐 plan §4.5）。
	if req.Stage != nil && (*req.Stage < 1 || *req.Stage > 5) {
		writeError(w, http.StatusBadRequest, "stage must be within 1..5")
		return
	}

	// 两类关联服务端统一解析：资产原生行以 asset_binding_id 持链为准（source
	// 兜底历史数据）；档案导入行经 external_ref.artifact_id 反查 binding 集合。
	var externalBindingIDs []pgtype.UUID
	if row.AssetBindingID.Valid {
		externalBindingIDs = []pgtype.UUID{row.AssetBindingID}
	}
	if extIDs, err := findExternalBindingIDsForArtifact(ctx, tx, row.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve asset link")
		return
	} else {
		// 历史 source='asset' 但无 asset_binding_id 持链的行兼容兜底：
		// external_ref 反查到的 binding 同样纳入联动集合（去重简单拼接即可，
		// 两类链同时存在时指向同一 binding 的 UPDATE 幂等）。
		externalBindingIDs = append(externalBindingIDs, extIDs...)
	}
	nativeLinked := row.AssetBindingID.Valid || row.Source == "asset"
	var extPtr *pgtype.UUID
	if len(externalBindingIDs) > 0 {
		extPtr = &externalBindingIDs[0]
	}

	placement := normalizeLinkedArtifactPlacement(row, extPtr, &req, map[bool]string{true: "asset"}[nativeLinked])
	if placement.Err != "" {
		writeError(w, http.StatusBadRequest, placement.Err)
		return
	}

	args := make([]any, 0, 12)
	setClauses := make([]string, 0, 12)
	add := func(fragment string, values ...any) {
		args = append(args, values...)
		setClauses = append(setClauses, fragment)
	}
	if req.Scope != nil {
		scope := strings.TrimSpace(*req.Scope)
		if !isValidArtifactScope(scope) {
			writeError(w, http.StatusBadRequest, "scope must be one of shared/project/requirement")
			return
		}
		add("scope = $"+strconv.Itoa(len(args)+1), scope)
	}
	switch {
	case placement.ClearStage != nil && *placement.ClearStage:
		add("stage = NULL")
	case placement.Stage != nil:
		add("stage = $"+strconv.Itoa(len(args)+1), *placement.Stage)
	case req.Stage != nil:
		add("stage = $"+strconv.Itoa(len(args)+1), *req.Stage)
	}
	switch {
	case placement.DocType != nil:
		docType := strings.TrimSpace(*placement.DocType)
		if docType == "" {
			writeError(w, http.StatusBadRequest, "doc_type must not be empty")
			return
		}
		add("doc_type = $"+strconv.Itoa(len(args)+1), docType)
	case req.DocType != nil:
		docType := strings.TrimSpace(*req.DocType)
		if docType == "" {
			writeError(w, http.StatusBadRequest, "doc_type must not be empty")
			return
		}
		add("doc_type = $"+strconv.Itoa(len(args)+1), docType)
	}
	if req.RelPath != nil {
		relPath := strings.TrimSpace(*req.RelPath)
		if relPath == "" {
			writeError(w, http.StatusBadRequest, "rel_path must not be empty")
			return
		}
		add("rel_path = $"+strconv.Itoa(len(args)+1), relPath)
	} else if placement.DocType != nil {
		// 关联行仅改阶段时按货架前缀条件挪动路径（防与资产同步乒乓）。
		if next := shelfRelPathForMove(row.RelPath, row.DocType, strings.TrimSpace(*placement.DocType)); next != "" {
			add("rel_path = $"+strconv.Itoa(len(args)+1), next)
		}
	}
	if req.RequirementKey != nil {
		key := strings.TrimSpace(*req.RequirementKey)
		if key == "" {
			add("requirement_key = NULL")
		} else {
			add("requirement_key = $"+strconv.Itoa(len(args)+1), key)
		}
	}
	if req.DocClass != nil {
		class := normalizeDocClass(*req.DocClass, row.DocType, row.RelPath)
		if class == "" {
			add("doc_class = NULL")
		} else {
			add("doc_class = $"+strconv.Itoa(len(args)+1), class)
		}
	}
	if req.DocModule != nil {
		module := normalizeDocModule(*req.DocModule)
		if module == "" {
			add("doc_module = NULL")
		} else {
			add("doc_module = $"+strconv.Itoa(len(args)+1), module)
		}
	}
	if req.Content != nil {
		content := []byte(*req.Content)
		add("blob_sha = $"+strconv.Itoa(len(args)+1), gitBlobSHA(content))
		add("size_bytes = $"+strconv.Itoa(len(args)+1), int64(len(content)))
	}
	if req.IssueID != nil {
		issueIDStr := strings.TrimSpace(*req.IssueID)
		if issueIDStr == "" {
			add("issue_id = NULL")
		} else {
			issueID, err := util.ParseUUID(issueIDStr)
			if err != nil {
				writeError(w, http.StatusBadRequest, "issue_id is not a valid UUID")
				return
			}
			belongs, err := h.issueBelongsToProject(ctx, issueID, project.ID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to validate issue")
				return
			}
			if !belongs {
				writeError(w, http.StatusBadRequest, "issue does not belong to this project")
				return
			}
			add("issue_id = $"+strconv.Itoa(len(args)+1), issueID)
		}
	}

	if len(setClauses) == 0 {
		// Nothing to change — echo the current row.
		writeJSON(w, http.StatusOK, projectArtifactToResponse(row))
		return
	}

	moduleOnly := req.DocModule != nil &&
		req.Scope == nil && req.Stage == nil && req.IssueID == nil &&
		req.DocType == nil && req.RelPath == nil && req.RequirementKey == nil &&
		req.DocClass == nil && req.Content == nil
	// 来源规则（plan §4.3）：资产原生关联行保留 'asset'；档案导入关联行与
	// 非关联行沿用原规则（moduleOnly 不改 source，其余写 'manual'）。
	if !moduleOnly && !placement.PreserveAssetSource {
		add("source = 'manual'")
	}
	add("updated_at = now()")
	args = append(args, row.ID, project.WorkspaceID)
	sql := `UPDATE project_artifact SET ` + strings.Join(setClauses, ", ") +
		` WHERE id = $` + strconv.Itoa(len(args)-1) +
		` AND workspace_id = $` + strconv.Itoa(len(args)) +
		` RETURNING ` + projectArtifactColumns
	updated, err := scanProjectArtifactRow(func(dest ...any) error {
		return tx.QueryRow(ctx, sql, args...).Scan(dest...)
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update project artifact")
		return
	}

	// 反向 lifecycle 回写与档案 UPDATE 同事务：任一失败整体回滚，不广播。
	if placement.NeedsLifecycleUpdate {
		lifecycle := ""
		if placement.Lifecycle != nil {
			lifecycle = *placement.Lifecycle
		}
		for _, bindingID := range externalBindingIDs {
			if !bindingID.Valid {
				continue
			}
			if err := applyLinkedAssetLifecycle(ctx, tx, bindingID, project.WorkspaceID, lifecycle); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to sync asset lifecycle")
				return
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update project artifact")
		return
	}

	if placement.NeedsLifecycleUpdate {
		for _, bindingID := range externalBindingIDs {
			if !bindingID.Valid {
				continue
			}
			h.publish(protocol.EventAssetUpdated, uuidToString(project.WorkspaceID), "member", userID,
				map[string]any{"binding_id": uuidToString(bindingID), "project_id": uuidToString(project.ID)})
		}
	}
	writeJSON(w, http.StatusOK, projectArtifactToResponse(updated))
}

// ListUnboundArtifacts implements GET /api/projects/{id}/artifacts/unbound:
// requirement-scope artifacts whose issue binding is still null — the存量回填
// (backfill) queue. Returns a bare JSON array to match the client contract
// listUnboundArtifacts(): Promise<ProjectArtifact[]>, newest sync first.
func (h *Handler) ListUnboundArtifacts(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT `+projectArtifactColumns+`
		FROM project_artifact
		WHERE project_id = $1 AND deleted_at IS NULL
		  AND scope = 'requirement' AND issue_id IS NULL
		ORDER BY synced_at DESC`,
		project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list unbound artifacts")
		return
	}
	defer rows.Close()

	artifacts := []ProjectArtifactResponse{}
	for rows.Next() {
		row, err := scanProjectArtifactRow(rows.Scan)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan project artifact")
			return
		}
		artifacts = append(artifacts, projectArtifactToResponse(row))
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list unbound artifacts")
		return
	}
	writeJSON(w, http.StatusOK, artifacts)
}

// BindProjectArtifactRequest is the body for POST .../artifacts/{artifactId}/bind.
type BindProjectArtifactRequest struct {
	IssueID string `json:"issue_id"`
}

// BindProjectArtifact implements POST /api/projects/{id}/artifacts/{artifactId}/bind:
// attach an artifact to a requirement (issue) in the same project. Validates
// both the artifact and the issue, stamps source='manual', and returns the
// full updated artifact.
func (h *Handler) BindProjectArtifact(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	row, ok := h.loadProjectArtifact(w, r, project)
	if !ok {
		return
	}
	var req BindProjectArtifactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	issueIDStr := strings.TrimSpace(req.IssueID)
	if issueIDStr == "" {
		writeError(w, http.StatusBadRequest, "issue_id is required")
		return
	}
	issueID, err := util.ParseUUID(issueIDStr)
	if err != nil {
		writeError(w, http.StatusBadRequest, "issue_id is not a valid UUID")
		return
	}
	belongs, err := h.issueBelongsToProject(r.Context(), issueID, project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to validate issue")
		return
	}
	if !belongs {
		writeError(w, http.StatusBadRequest, "issue does not belong to this project")
		return
	}
	updated, err := scanProjectArtifactRow(func(dest ...any) error {
		return h.DB.QueryRow(r.Context(), `
			UPDATE project_artifact
			SET issue_id = $1, source = 'manual', updated_at = now()
			WHERE id = $2 AND workspace_id = $3
			RETURNING `+projectArtifactColumns,
			issueID, row.ID, project.WorkspaceID,
		).Scan(dest...)
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to bind artifact")
		return
	}
	writeJSON(w, http.StatusOK, projectArtifactToResponse(updated))
}

// ---------------------------------------------------------------------------
// 链路⑨：原型版本 → 档案资产投影
// ---------------------------------------------------------------------------

const (
	// prototypeProjectionStage is the requirement-calendar stage a prototype
	// belongs to: stage 1 = 原型（2026-09-04-requirement-calendar-design.md
	// §流水线：1=原型 / 2=plan+拆解 / 3=执行 / 4=验收）.
	prototypeProjectionStage = int32(1)
	// prototypeProjectionDocType classifies the projected rows.
	//
	// project_artifact.doc_type is `TEXT NOT NULL` with NO CHECK enum
	// (migration 455 line 14) — unlike scope / source / stage, which are all
	// constrained. 'prototype' is therefore a legal value and no migration is
	// needed; no existing doc_type had to be borrowed as an approximation.
	prototypeProjectionDocType = "prototype"
)

// prototypeProjectionRow is one issue_prototype_version row waiting to be
// projected.
type prototypeProjectionRow struct {
	IssueID  pgtype.UUID
	Version  int32
	HtmlPath string
}

// projectPrototypeVersionsInTx projects every issue_prototype_version row of
// the project's requirements into project_artifact.
//
// Design §3.2 invariant 2: 「`issue_prototype_version` 是原型的唯一权威，
// artifact 行是它的单向投影」, bridged by `html_path` → `artifact.rel_path`
// (§7 row 2). Concretely:
//
//   - ALL versions are projected, not just confirmed ones — `version` is part
//     of UNIQUE(resource_id, rel_path, version), so the archive keeps the same
//     history the authority table keeps and the sync consistency check
//     (versions ↔ artifacts) can compare counts.
//   - Idempotent: the upsert keys on (resource_id, rel_path, version) and only
//     refreshes classification + the issue binding + `deleted_at`. It never
//     touches blob_sha / size_bytes / attachment_id / source, because the CLI
//     owns the bytes — a later sync filling in the real blob sha is an update,
//     not a conflict.
//   - New rows are stamped source='server' (= 原型投影, design §4.1) with an
//     empty blob_sha, the same convention ArchiveDeliverable's Mode B uses.
//   - scope='requirement' + stage=1 + issue_id: the prototype is a
//     requirement-level stage-1 artifact, which is what puts it in the matrix's
//     原型 column.
//
// Write-path survey (the projection is NOT dead code): rows are created by
// `IssueService.GeneratePrototypeVersion` (server/internal/service/prototype.go)
// via the sqlc `CreatePrototypeVersion` query, reached from
// POST /api/issues/{id}/prototype/generate (handler/requirement_prototype.go).
// Status transitions come from SetPrototypeStatus / SupersedePendingPrototype-
// Versions in the same service. A project that never generated a prototype
// simply yields 0 rows, which is a legitimate no-op rather than a failure.
//
// Returns the rel_paths it reconciled (so the caller can shield them from the
// manifest soft-delete) and how many were freshly inserted.
func projectPrototypeVersionsInTx(ctx context.Context, tx pgx.Tx, project db.Project, archiveResourceID pgtype.UUID) ([]string, int, error) {
	if !archiveResourceID.Valid {
		// project_artifact.resource_id is NOT NULL — nowhere to project into.
		return nil, 0, nil
	}

	var pending []prototypeProjectionRow
	// pgx single-connection rule: the cursor must be fully drained AND closed
	// before the next statement runs on the same tx, hence the IIFE + defer.
	if err := func() error {
		rows, err := tx.Query(ctx, `
			SELECT ipv.issue_id, ipv.version, ipv.html_path
			FROM issue_prototype_version ipv
			JOIN issue i ON i.id = ipv.issue_id
			WHERE i.project_id = $1
			ORDER BY ipv.issue_id, ipv.version`, project.ID)
		if err != nil {
			return fmt.Errorf("query prototype versions: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var row prototypeProjectionRow
			if err := rows.Scan(&row.IssueID, &row.Version, &row.HtmlPath); err != nil {
				return fmt.Errorf("scan prototype version: %w", err)
			}
			pending = append(pending, row)
		}
		return rows.Err()
	}(); err != nil {
		return nil, 0, err
	}

	paths := make([]string, 0, len(pending))
	created := 0
	for _, row := range pending {
		relPath := strings.TrimSpace(row.HtmlPath)
		// html_path is NOT NULL in the schema, but an empty string would violate
		// the archive's path contract and collide with every other empty row on
		// the UNIQUE key — skip instead of writing garbage.
		if relPath == "" || !row.IssueID.Valid || row.Version < 1 {
			continue
		}
		var inserted bool
		if err := tx.QueryRow(ctx, `
			INSERT INTO project_artifact (
				workspace_id, project_id, resource_id, issue_id, scope, stage, doc_type,
				version, rel_path, blob_sha, size_bytes, source, synced_at
			) VALUES (
				$1, $2, $3, $4, 'requirement', $5, $6,
				$7, $8, '', 0, 'server', now()
			)
			ON CONFLICT (resource_id, rel_path, version) DO UPDATE SET
				issue_id = EXCLUDED.issue_id,
				scope = 'requirement',
				stage = EXCLUDED.stage,
				doc_type = EXCLUDED.doc_type,
				updated_at = now(),
				deleted_at = NULL
			RETURNING (xmax = 0)`,
			project.WorkspaceID, project.ID, archiveResourceID, row.IssueID,
			prototypeProjectionStage, prototypeProjectionDocType,
			row.Version, relPath,
		).Scan(&inserted); err != nil {
			return paths, created, fmt.Errorf("upsert prototype artifact %s v%d: %w", relPath, row.Version, err)
		}
		if inserted {
			created++
		}
		paths = append(paths, relPath)
	}
	return paths, created, nil
}

// CreateProjectArtifactRequest is the body for POST /artifacts (source=manual).
type CreateProjectArtifactRequest struct {
	Scope          string  `json:"scope"`
	Stage          *int32  `json:"stage"`
	DocType        string  `json:"doc_type"`
	RelPath        string  `json:"rel_path"`
	RequirementKey *string `json:"requirement_key"`
	IssueID        *string `json:"issue_id"`
	DocClass       *string `json:"doc_class"`
	DocModule      *string `json:"doc_module"`
	Content        string  `json:"content"`
	AttachmentID   *string `json:"attachment_id"`
	Version        int32   `json:"version"`
}

// CreateProjectArtifact inserts a source=manual artifact so the archive tab
// can add / fill documents without waiting for CLI sync. Soft-delete on the
// next empty-manifest sync will not remove it (manual exemption).
func (h *Handler) CreateProjectArtifact(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	// 手动建档案不再强制绑定档案根目录：原型上传的正文落附件，未绑定目录时
	// resource_id 为 NULL（迁移 474 允许），预览走 attachment_url。
	archiveResourceID, ok := h.loadOrBindOptionalArchiveResourceID(w, r, project)
	if !ok {
		return
	}
	var req CreateProjectArtifactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Scope = strings.TrimSpace(req.Scope)
	req.DocType = strings.TrimSpace(req.DocType)
	req.RelPath = strings.TrimSpace(req.RelPath)
	if req.Scope == "" || req.DocType == "" || req.RelPath == "" {
		writeError(w, http.StatusBadRequest, "scope, doc_type and rel_path are required")
		return
	}
	if !isValidArtifactScope(req.Scope) {
		writeError(w, http.StatusBadRequest, "scope must be one of shared/project/requirement")
		return
	}
	if req.Stage != nil && (*req.Stage < 1 || *req.Stage > 5) {
		writeError(w, http.StatusBadRequest, "stage must be within 1..5")
		return
	}
	if req.Version < 1 {
		req.Version = 1
	}
	var issueID pgtype.UUID
	if req.IssueID != nil && strings.TrimSpace(*req.IssueID) != "" {
		parsed, err := util.ParseUUID(strings.TrimSpace(*req.IssueID))
		if err != nil {
			writeError(w, http.StatusBadRequest, "issue_id is not a valid UUID")
			return
		}
		belongs, err := h.issueBelongsToProject(r.Context(), parsed, project.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to validate issue")
			return
		}
		if !belongs {
			writeError(w, http.StatusBadRequest, "issue does not belong to this project")
			return
		}
		issueID = parsed
	}
	var attachmentID pgtype.UUID
	if req.AttachmentID != nil && strings.TrimSpace(*req.AttachmentID) != "" {
		parsed, err := util.ParseUUID(strings.TrimSpace(*req.AttachmentID))
		if err != nil {
			writeError(w, http.StatusBadRequest, "attachment_id is not a valid UUID")
			return
		}
		attachmentID = parsed
	}
	content := []byte(req.Content)
	blobSha := gitBlobSHA(content)
	var requirementKey pgtype.Text
	if req.RequirementKey != nil && strings.TrimSpace(*req.RequirementKey) != "" {
		requirementKey = util.PtrToText(req.RequirementKey)
	}
	row, err := scanProjectArtifactRow(func(dest ...any) error {
		// resource_id 为 NULL 时 UNIQUE(resource_id, rel_path, version) 对 NULL 不生效
		// （NULL 互不相等），先按自然键收敛到同一条目，再回落到插入。
		if !archiveResourceID.Valid {
			err := h.DB.QueryRow(r.Context(), `
				UPDATE project_artifact SET
					scope = $2, stage = $3, doc_type = $4, issue_id = $5,
					requirement_key = $6, blob_sha = $7,
					attachment_id = COALESCE($8, attachment_id),
					size_bytes = $9, doc_class = $10, doc_module = $11,
					source = 'manual', synced_at = now(), updated_at = now(), deleted_at = NULL
				WHERE project_id = $1 AND resource_id IS NULL
					AND rel_path = $12 AND version = $13
				RETURNING `+projectArtifactColumns,
				project.ID, req.Scope, util.PtrToInt4(req.Stage), req.DocType, issueID,
				requirementKey, blobSha, attachmentID, int64(len(content)),
				util.PtrToText(docClassPtr(req.DocClass, req.DocType, req.RelPath)),
				util.PtrToText(normalizeDocModulePtr(req.DocModule)),
				req.RelPath, req.Version,
			).Scan(dest...)
			if err == nil {
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		return h.DB.QueryRow(r.Context(), `
			INSERT INTO project_artifact (
				workspace_id, project_id, resource_id, issue_id, scope, stage, doc_type,
				version, rel_path, requirement_key, blob_sha, attachment_id, size_bytes,
				source, synced_at, doc_class, doc_module
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7,
				$8, $9, $10, $11, $12, $13,
				'manual', now(), $14, $15
			)
			ON CONFLICT (resource_id, rel_path, version) DO UPDATE SET
				scope = EXCLUDED.scope,
				stage = EXCLUDED.stage,
				doc_type = EXCLUDED.doc_type,
				issue_id = EXCLUDED.issue_id,
				requirement_key = EXCLUDED.requirement_key,
				doc_class = EXCLUDED.doc_class,
				doc_module = EXCLUDED.doc_module,
				blob_sha = EXCLUDED.blob_sha,
				attachment_id = COALESCE(EXCLUDED.attachment_id, project_artifact.attachment_id),
				size_bytes = EXCLUDED.size_bytes,
				source = 'manual',
				synced_at = now(),
				updated_at = now(),
				deleted_at = NULL
			RETURNING `+projectArtifactColumns,
			project.WorkspaceID, project.ID, archiveResourceID, issueID, req.Scope,
			util.PtrToInt4(req.Stage), req.DocType, req.Version, req.RelPath,
			requirementKey, blobSha, attachmentID, int64(len(content)),
			util.PtrToText(docClassPtr(req.DocClass, req.DocType, req.RelPath)),
			util.PtrToText(normalizeDocModulePtr(req.DocModule)),
		).Scan(dest...)
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create project artifact")
		return
	}
	writeJSON(w, http.StatusCreated, projectArtifactToResponse(row))
}

// DeleteProjectArtifact soft-deletes one artifact (does not remove the git file).
func (h *Handler) DeleteProjectArtifact(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	row, ok := h.loadProjectArtifact(w, r, project)
	if !ok {
		return
	}
	// 资产关联档案不得单侧删除（plan §4.4）：删资产走 binding 软删联动，
	// 避免残余 binding 引用已删档案。
	if row.AssetBindingID.Valid || row.Source == "asset" {
		writeErrorCode(w, http.StatusConflict, "asset_linked", "artifact is linked to an asset binding; delete it through the asset side")
		return
	}
	if extIDs, err := findExternalBindingIDsForArtifact(r.Context(), h.DB, row.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve asset link")
		return
	} else if len(extIDs) > 0 {
		writeErrorCode(w, http.StatusConflict, "asset_linked", "artifact is imported as an asset; unlink the asset binding first")
		return
	}
	_, err := h.DB.Exec(r.Context(), `
		UPDATE project_artifact
		SET deleted_at = now(), updated_at = now(), source = 'manual'
		WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
		row.ID, project.WorkspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete project artifact")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
