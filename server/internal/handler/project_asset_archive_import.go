package handler

// 项目档案 → 资产批量导入（资产管理「从档案同步」）。
//
// 背景：474 打通了 资产 → 档案 的自动映射与 档案 → 候选 的浏览面，但项目既有档案
// 文档不会自动出现在资产清单里（首次进入资产管理仍为空）。本文件提供一次性批量
// 导入端点：把 project_artifact（source<>'asset' 的最新版档案行）导入为知识类资产
// binding（source='archive'，external_ref 持 artifact_id）。
//
// 防乒乓：导入出的 binding 因 external_ref.artifact_id 非空，被 planAssetArchive
// 的防循环门挡住，不会再反向生成档案行。
// 幂等：同一 artifact_id 已有项目级 binding 即跳过；asset_name 冲突时降级用
// rel_path（档案内唯一）保证批量内不撞 partial unique。

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// archiveImportDoc 是一条待导入档案行的最小形态。
type archiveImportDoc struct {
	id           string
	relPath      string
	docType      string
	docClass     pgtype.Text
	docModule    pgtype.Text
	stage        pgtype.Int4
	attachmentID pgtype.UUID
	sizeBytes    int64
}

// planArchiveImportName 决定导入资产的展示名：优先文件名，批内/库内冲突时退到
// rel_path（DISTINCT ON rel_path 保证唯一）。
func planArchiveImportName(relPath string, taken map[string]bool) (string, bool) {
	name := filepath.Base(relPath)
	if name == "" || name == "." || name == "/" {
		name = relPath
	}
	if !taken[name] {
		return name, true
	}
	if !taken[relPath] {
		return relPath, true
	}
	return "", false
}

// archiveImportTags 把档案的 doc_class / doc_module / doc_type 归并为资产标签
// （非空去重，全空则 NULL）。
func archiveImportTags(d archiveImportDoc) []string {
	seen := map[string]bool{}
	tags := []string{}
	for _, t := range []pgtype.Text{d.docClass, d.docModule, {String: d.docType, Valid: true}} {
		v := strings.TrimSpace(t.String)
		if !t.Valid || v == "" || seen[v] {
			continue
		}
		seen[v] = true
		tags = append(tags, v)
	}
	if len(tags) == 0 {
		return nil
	}
	return tags
}

// SyncAssetsFromArchive 处理 POST /api/projects/{id}/assets/sync-from-archive。
// 可选 body {"asset_category": "..."}，默认 knowledge_repo（知识类语义）。
func (h *Handler) SyncAssetsFromArchive(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	createdBy, ok := h.parseUserUUIDOrZero(userID)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}

	var req struct {
		AssetCategory string `json:"asset_category"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req) // body 可选，解析失败走默认值
	category := strings.TrimSpace(req.AssetCategory)
	if category == "" {
		category = "knowledge_repo"
	}
	if !validAssetCategories[category] {
		writeError(w, http.StatusBadRequest, "asset_category must be one of code_repository|application|package|knowledge_repo|knowledge_group|other")
		return
	}

	ctx := r.Context()
	docs, err := h.fetchArchiveDocsForImport(ctx, project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project artifacts")
		return
	}

	// 幂等基线：已导入过的 artifact_id 与占用中的资产名。
	alreadyImported, nameTaken, err := h.fetchArchiveImportedNames(ctx, project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list asset bindings")
		return
	}

	imported, skipped := 0, 0
	for _, d := range docs {
		if alreadyImported[d.id] {
			skipped++
			continue
		}
		name, usable := planArchiveImportName(d.relPath, nameTaken)
		if !usable {
			skipped++
			continue
		}
		if h.insertArchiveImportBinding(ctx, project, category, createdBy, d, name) {
			alreadyImported[d.id] = true
			nameTaken[name] = true
			imported++
		} else {
			skipped++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"imported": imported,
		"skipped":  skipped,
		"total":    len(docs),
	})
}

// fetchArchiveDocsForImport 取项目内未删除档案的最新版（排除资产同步行）。
func (h *Handler) fetchArchiveDocsForImport(ctx context.Context, projectID pgtype.UUID) ([]archiveImportDoc, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT DISTINCT ON (rel_path) id, rel_path, doc_type, doc_class, doc_module,
		       stage, attachment_id, size_bytes
		FROM project_artifact
		WHERE project_id = $1 AND deleted_at IS NULL AND source <> 'asset'
		ORDER BY rel_path, version DESC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	docs := []archiveImportDoc{}
	for rows.Next() {
		var (
			id      pgtype.UUID
			doc     archiveImportDoc
			attach  pgtype.UUID
			docType string
		)
		if err := rows.Scan(&id, &doc.relPath, &docType, &doc.docClass, &doc.docModule,
			&doc.stage, &attach, &doc.sizeBytes); err != nil {
			return nil, err
		}
		doc.id = uuidToString(id)
		doc.docType = docType
		doc.attachmentID = attach
		docs = append(docs, doc)
	}
	return docs, rows.Err()
}

// fetchArchiveImportedNames 汇总项目级 binding 的幂等基线：已引用的 artifact_id 集
// 与占用中的资产名集（external_ref 非 JSON 对象时容错跳过）。
func (h *Handler) fetchArchiveImportedNames(ctx context.Context, projectID pgtype.UUID) (map[string]bool, map[string]bool, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT asset_name, external_ref->>'artifact_id'
		FROM project_asset_binding
		WHERE project_id = $1 AND issue_id IS NULL`, projectID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	imported := map[string]bool{}
	names := map[string]bool{}
	for rows.Next() {
		var name string
		var artifactID *string
		if err := rows.Scan(&name, &artifactID); err != nil {
			return nil, nil, err
		}
		names[name] = true
		if artifactID != nil && *artifactID != "" {
			imported[*artifactID] = true
		}
	}
	return imported, names, rows.Err()
}

// insertArchiveImportBinding 落一条档案来源 binding；返回 false 表示冲突或故障
// （单条 best-effort，不中断批量）。external_ref 带 artifact_id → 不会反向再入档。
func (h *Handler) insertArchiveImportBinding(ctx context.Context, project db.Project, category string, createdBy pgtype.UUID, d archiveImportDoc, name string) bool {
	ref := map[string]any{"artifact_id": d.id, "rel_path": d.relPath}
	if d.attachmentID.Valid {
		ref["attachment_id"] = uuidToString(d.attachmentID)
	}
	if d.sizeBytes > 0 {
		ref["size_bytes"] = d.sizeBytes
	}
	refJSON, err := json.Marshal(ref)
	if err != nil {
		return false
	}
	var lifecycle pgtype.Text
	if d.stage.Valid && d.stage.Int32 >= 1 && d.stage.Int32 <= 4 {
		lifecycle = pgtype.Text{String: "S" + strconv.Itoa(int(d.stage.Int32)), Valid: true}
	}
	var subtype pgtype.Text
	if ext := strings.TrimPrefix(filepath.Ext(d.relPath), "."); ext != "" {
		subtype = pgtype.Text{String: strings.ToLower(ext), Valid: true}
	}
	_, err = h.DB.Exec(ctx, `INSERT INTO project_asset_binding
		(workspace_id, project_id, issue_id, asset_category, resource_id, external_ref,
		 asset_name, asset_subtype, source, recommended, recommend_reason,
		 lifecycle_stage, asset_role, tags, created_by_type, created_by_id)
	VALUES ($1,$2,NULL,$3,NULL,$4,$5,$6,'archive',false,NULL,$7,NULL,$8,'member',$9)
	ON CONFLICT DO NOTHING`,
		project.WorkspaceID, project.ID, category, refJSON, name, subtype,
		lifecycle, archiveImportTags(d), createdBy)
	if err != nil {
		slog.Warn("archive import binding failed", "artifact_id", d.id, "error", err)
		return false
	}
	return true
}
