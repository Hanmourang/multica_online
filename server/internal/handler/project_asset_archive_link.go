package handler

// 档案 → 资产的反向联动（五阶段对齐 plan §4.3）。
//
// 两类关联一律由服务端统一解析，调用方不得各自猜：
//   - 资产原生档案：project_artifact.asset_binding_id 持链；
//   - 档案导入资产：binding.external_ref.artifact_id 指向档案行
//     （历史可能存在多条，同事务全部同步，避免同文档资产互相矛盾）。
//
// 关联判断不看 source：档案 PATCH 旧实现会把行写成 source='manual'，
// 资产原生行必须保留 'asset' 来源徽标，导入行保留原 source。

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
)

// findExternalBindingIDsForArtifact 查档案导入关系：external_ref.artifact_id
// 指向该档案且未删除的 binding id 集合。
func findExternalBindingIDsForArtifact(ctx context.Context, store assetDB, artifactID pgtype.UUID) ([]pgtype.UUID, error) {
	rows, err := store.Query(ctx, `
		SELECT id FROM project_asset_binding
		WHERE external_ref->>'artifact_id' = $1::text
		  AND lifecycle_stage IS NOT NULL`, artifactID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []pgtype.UUID
	for rows.Next() {
		var id pgtype.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// applyLinkedAssetLifecycle 把档案 placement 反推的资产阶段写回 binding。
// lifecycle 为空串表示清空（未分阶保留区）。限定 workspace/project 防串租，
// 并校验影响行数，0 行视为数据漂移返回错误触发回滚。
func applyLinkedAssetLifecycle(ctx context.Context, tx pgx.Tx, bindingID, workspaceID pgtype.UUID, lifecycle string) error {
	var stage any
	if lifecycle != "" {
		stage = lifecycle
	}
	tag, err := tx.Exec(ctx, `
		UPDATE project_asset_binding
		SET lifecycle_stage = $3
		WHERE id = $1 AND workspace_id = $2`,
		bindingID, workspaceID, stage)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

// GetAssetLinkedArchive 处理 GET /api/projects/{id}/assets/{bindingId}/archive
// （五阶段对齐 plan §4.4）：返回该资产关联的未删除档案行，供预览复用同一
// artifact（不复制正文）。两类关联都解析：资产原生按 asset_binding_id 持链，
// 档案导入按 external_ref.artifact_id。无关联档案返回 404，前端据此降级到
// 原附件预览。仅内部使用，不进列表响应。
func (h *Handler) GetAssetLinkedArchive(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	bindingID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "bindingId"), "binding id")
	if !ok {
		return
	}
	ctx := r.Context()

	// 校验 binding 归属本项目 / workspace（防串租），并取导入关系的 artifact 坐标。
	var externalArtifactID string
	var bindingExists bool
	err := h.DB.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM project_asset_binding WHERE id = $1 AND workspace_id = $2 AND project_id = $3)`,
		bindingID, project.WorkspaceID, project.ID).Scan(&bindingExists)
	if err != nil || !bindingExists {
		writeError(w, http.StatusNotFound, "asset binding not found")
		return
	}
	_ = h.DB.QueryRow(ctx, `
		SELECT COALESCE(external_ref->>'artifact_id', '') FROM project_asset_binding WHERE id = $1`,
		bindingID).Scan(&externalArtifactID)

	// 优先取资产原生档案行（asset_binding_id 持链）。
	if row, found := h.findLinkedArtifact(ctx, `
		SELECT `+projectArtifactColumns+` FROM project_artifact
		WHERE asset_binding_id = $1 AND workspace_id = $2 AND project_id = $3 AND deleted_at IS NULL
		ORDER BY synced_at DESC LIMIT 1`, bindingID, project.WorkspaceID, project.ID); found {
		writeJSON(w, http.StatusOK, projectArtifactToResponse(row))
		return
	}
	// 其次取档案导入指向的原 artifact（external_ref.artifact_id）。
	if externalArtifactID != "" {
		if artUUID, parseErr := util.ParseUUID(externalArtifactID); parseErr == nil {
			if row, found := h.findLinkedArtifact(ctx, `
				SELECT `+projectArtifactColumns+` FROM project_artifact
				WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND deleted_at IS NULL
				ORDER BY synced_at DESC LIMIT 1`, artUUID, project.WorkspaceID, project.ID); found {
				writeJSON(w, http.StatusOK, projectArtifactToResponse(row))
				return
			}
		}
	}
	writeErrorCode(w, http.StatusNotFound, "archive_link_missing", "asset has no linked archive artifact")
}

// findLinkedArtifact 执行给定查询并扫描单个档案行；无行或扫描失败返回 found=false
// （预览降级为附件而非 500）。
func (h *Handler) findLinkedArtifact(ctx context.Context, query string, args ...any) (projectArtifactRow, bool) {
	row, err := scanProjectArtifactRow(func(dest ...any) error {
		return h.DB.QueryRow(ctx, query, args...).Scan(dest...)
	})
	if err != nil {
		return projectArtifactRow{}, false
	}
	return row, true
}
