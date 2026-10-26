package handler

// 存量资产批量补齐（一次性运维端点，幂等只填空）：
//
// 背景①：sync-from-archive 导入的档案行全部是「本地目录索引」——
// project_artifact.attachment_id 为 NULL（没有内容快照），预览对话框既拿不到
// 快照也读不到磁盘，于是 245 篇文档预览空白。dev api 进程跑在宿主机上，可以
// 直接读档案资源 local_path 下的原文，本文件把字节上传为附件并回填
// attachment_id，让预览走「快照优先」链路（web / 桌面端一致可用）。
//
// 背景②：导入时档案 stage 大多为空导致资产阶段/角色徽标全灰。按标签、文件名、
// rel_path 关键词规则推断 S1-S4 与 input/output，仅补空值、绝不覆盖已有打标。

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ---------------------------------------------------------------------------
// 阶段 / 角色规则推断（纯函数，可单测）
// ---------------------------------------------------------------------------

type assetStageRule struct {
	stage    string
	keywords []string
}

// 顺序即优先级（plan §4.6）：先判最具体的复盘 / 迭代，再原型 / 规划，最后
// 技术方案。去除旧「验收 / test-plan 等同问题复盘」推断，避免误伤；S5 只
// 在明确命中 iteration/迭代 时才推断，需求类文档不因泛词被误标为迭代。
var assetStageRules = []assetStageRule{
	{"S4", []string{"retrospective", "复盘", "postmortem"}},
	{"S5", []string{"iteration", "迭代"}},
	{"S2", []string{"prototype", "原型", "mockup"}},
	{"S1", []string{"research", "调研", "roadmap", "plan", "规划", "mrd", "brd", "prd"}},
	{"S3", []string{"design", "architecture", "架构", "技术方案"}},
}

var assetRoleInputKeywords = []string{"mrd", "prd", "brd", "requirement", "需求", "调研", "research", "test-plan", "评估"}

// inferAssetStageRole 依据标签集合 + 资产名 + 相对路径的关键词推断阶段与角色。
// 文档类资产默认 output（项目产出物），命中上游输入词才为 input；无阶段词命中
// 返回空串（保持未标注，不误标）。
func inferAssetStageRole(tags []string, name, relPath string) (string, string) {
	joined := strings.ToLower(strings.Join(append(append([]string{}, tags...), name, relPath), " "))
	stage := ""
	for _, rule := range assetStageRules {
		for _, kw := range rule.keywords {
			if strings.Contains(joined, kw) {
				stage = rule.stage
				break
			}
		}
		if stage != "" {
			break
		}
	}
	role := "output"
	for _, kw := range assetRoleInputKeywords {
		if strings.Contains(joined, kw) {
			role = "input"
			break
		}
	}
	return stage, role
}

// ---------------------------------------------------------------------------
// POST /api/projects/{id}/assets/enrich-metadata
// ---------------------------------------------------------------------------

// EnrichAssetMetadata 对项目级档案来源 binding 补齐 stage / role（只填空值）。
func (h *Handler) EnrichAssetMetadata(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	userID := requestUserID(r)
	ctx := r.Context()

	rows, err := h.DB.Query(ctx, `
		SELECT id, asset_name, COALESCE(external_ref->>'rel_path', ''), COALESCE(tags, '{}')
		FROM project_asset_binding
		WHERE project_id = $1 AND issue_id IS NULL
		  AND (lifecycle_stage IS NULL OR lifecycle_stage = '' OR asset_role IS NULL OR asset_role = '')`,
		project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list asset bindings")
		return
	}
	type metaRow struct {
		id      string
		name    string
		relPath string
		tags    []string
	}
	var pending []metaRow
	for rows.Next() {
		var (
			id   string
			m    metaRow
			tags []string
		)
		if err := rows.Scan(&id, &m.name, &m.relPath, &tags); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan asset binding")
			return
		}
		m.id = id
		m.tags = tags
		pending = append(pending, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to iterate asset bindings")
		return
	}

	stageFilled, roleFilled := 0, 0
	// 五阶段对齐 plan §4.2：实际发生阶段变化的行在同一事务内回写档案，
	// 不再留下旧货架；只填空、不覆盖人工打标（COALESCE 现值优先）。
	tx, txErr := h.TxStarter.Begin(ctx)
	if txErr != nil {
		writeError(w, http.StatusInternalServerError, "failed to enrich asset metadata")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	for _, m := range pending {
		stage, role := inferAssetStageRole(m.tags, m.name, m.relPath)
		if stage == "" && role == "" {
			continue
		}
		bid, err := util.ParseUUID(m.id)
		if err != nil {
			continue
		}
		var out assetBindingRow
		rowErr := tx.QueryRow(ctx, `
			UPDATE project_asset_binding
			SET lifecycle_stage = COALESCE(NULLIF(lifecycle_stage, ''), $2),
			    asset_role      = COALESCE(NULLIF(asset_role, ''), $3)
			WHERE id = $1
			RETURNING `+assetBindingColumns,
			bid, nilIfEmpty(stage), nilIfEmpty(role)).Scan(
			&out.id, &out.workspaceID, &out.projectID, &out.issueID, &out.assetCategory,
			&out.resourceID, &out.externalRef, &out.assetName, &out.assetSubtype, &out.source,
			&out.recommended, &out.recommendReason, &out.lifecycleStage, &out.assetRole, &out.tags,
			&out.createdByType, &out.createdByID, &out.createdAt,
		)
		if rowErr != nil {
			continue
		}
		// 阶段真正被补上（原为空、本次推断出非空）才联动档案；纯角色补齐
		// 不改货架，避免无谓改写。
		if stage != "" {
			if syncErr := h.syncAssetToArchive(ctx, tx, out); syncErr != nil {
				writeError(w, http.StatusInternalServerError, "failed to sync asset into archive")
				return
			}
			stageFilled++
		}
		if role != "" {
			roleFilled++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit asset enrichment")
		return
	}
	if stageFilled > 0 {
		h.publish(protocol.EventAssetUpdated, uuidToString(project.WorkspaceID), "member", userID,
			map[string]any{"project_id": uuidToString(project.ID), "count": stageFilled})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"scanned":      len(pending),
		"stage_filled": stageFilled,
		"role_filled":  roleFilled,
	})
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ---------------------------------------------------------------------------
// POST /api/projects/{id}/artifacts/backfill-snapshots
// ---------------------------------------------------------------------------

const snapshotBackfillMaxBytes = 8 * 1024 * 1024

// locateBackfillFile 在多候选根 × 去前缀候选路径中定位档案原文；均未命中时
// 在各根下按唯一同名文件兜底（目录仓库迁移/改名会丢首段前缀或整个根）。
// 返回绝对路径与命中的根内相对路径（供 attachment 文件名保真）。
func locateBackfillFile(roots []string, relPath string) (string, bool) {
	candidates := relPathCandidates(relPath)
	for _, root := range roots {
		rootClean := filepath.Clean(root)
		for _, cand := range candidates {
			abs := safeJoin(rootClean, cand)
			if abs == "" {
				continue
			}
			if info, err := os.Stat(abs); err == nil && !info.IsDir() {
				return abs, true
			}
		}
	}
	// 同名兜底：遍历各根（深度有限、跳过依赖/隐藏目录），唯一命中才采纳。
	base := filepath.Base(filepath.FromSlash(relPath))
	for _, root := range roots {
		var found string
		ambiguous := false
		walkRoot := filepath.Clean(root)
		_ = filepath.WalkDir(walkRoot, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil //nolint:merr // 单个不可读条目不影响整体搜索
			}
			rel, relErr := filepath.Rel(walkRoot, p)
			if relErr == nil && rel != "." {
				depth := strings.Count(rel, string(filepath.Separator)) + 1
				if depth > 5 {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
			}
			if d.IsDir() && (d.Name()[0] == '.' || d.Name() == "node_modules" || d.Name() == "dist" || d.Name() == "build") {
				return filepath.SkipDir
			}
			if !d.IsDir() && d.Name() == base {
				if found != "" {
					ambiguous = true
					return filepath.SkipAll
				}
				found = p
			}
			return nil
		})
		if found != "" && !ambiguous {
			return found, true
		}
	}
	return "", false
}

// relPathCandidates 原路径 + 依次去掉前 1-3 段目录的候选（覆盖顶层目录改名/剔除）。
func relPathCandidates(relPath string) []string {
	out := []string{relPath}
	cur := relPath
	for i := 0; i < 3; i++ {
		idx := strings.Index(cur, "/")
		if idx < 0 {
			break
		}
		cur = cur[idx+1:]
		out = append(out, cur)
	}
	return out
}

// safeJoin 拼接并防目录穿越；越界返回空串。
func safeJoin(rootClean, relPath string) string {
	abs := filepath.Clean(filepath.Join(rootClean, filepath.FromSlash(relPath)))
	if abs != rootClean && !strings.HasPrefix(abs, rootClean+string(filepath.Separator)) {
		return ""
	}
	return abs
}

// BackfillArtifactSnapshots 为无快照的档案行读取档案根本地原文，落附件并回填
// attachment_id。档案资源必须是 local_directory；文件缺失/超限/读取失败逐条
// 跳过并计数，不中断批量。
func (h *Handler) BackfillArtifactSnapshots(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if h.Storage == nil {
		writeError(w, http.StatusServiceUnavailable, "file storage not configured")
		return
	}
	archiveResourceID, ok := h.loadArchiveResourceID(w, r, project)
	if !ok {
		return
	}

	ctx := r.Context()
	var rootPath string
	err := h.DB.QueryRow(ctx,
		`SELECT COALESCE(resource_ref->>'local_path', '') FROM project_resource WHERE id = $1`,
		archiveResourceID).Scan(&rootPath)
	if err != nil || strings.TrimSpace(rootPath) == "" {
		writeErrorCode(w, http.StatusNotFound, "archive_local_path_missing", "archive resource is not a readable local directory")
		return
	}
	roots := []string{filepath.Clean(rootPath)}
	// 可选 body：额外候选根（契约式 projects_mgmt/projects/<key> 等第二落点）。
	var req struct {
		ExtraRoots []string `json:"extra_roots"`
	}
	if r.ContentLength > 0 {
		if decErr := json.NewDecoder(r.Body).Decode(&req); decErr == nil {
			for _, extra := range req.ExtraRoots {
				if cleaned, statErr := filepath.Abs(strings.TrimSpace(extra)); statErr == nil {
					roots = append(roots, cleaned)
				}
			}
		}
	}
	rootClean := filepath.Clean(rootPath)

	rows, err := h.DB.Query(ctx, `
		SELECT id, rel_path
		FROM project_artifact
		WHERE project_id = $1 AND deleted_at IS NULL AND source <> 'asset' AND attachment_id IS NULL
		ORDER BY rel_path`, project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project artifacts")
		return
	}
	type docRow struct {
		id      string
		relPath string
	}
	var docs []docRow
	for rows.Next() {
		var d docRow
		if err := rows.Scan(&d.id, &d.relPath); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan project artifact")
			return
		}
		docs = append(docs, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to iterate project artifacts")
		return
	}

	workspaceID := uuidToString(project.WorkspaceID)
	var backfilled, missing, tooLarge, failed int
	for _, d := range docs {
		abs, found := locateBackfillFile(roots, d.relPath)
		if !found {
			missing++
			continue
		}
		info, statErr := os.Stat(abs)
		if statErr != nil {
			missing++
			continue
		}
		if info.Size() > snapshotBackfillMaxBytes {
			tooLarge++
			continue
		}
		data, readErr := os.ReadFile(abs)
		if readErr != nil {
			missing++
			continue
		}
		contentType := detectSnapshotContentType(d.relPath, data)
		id, idErr := uuid.NewV7()
		if idErr != nil {
			failed++
			continue
		}
		key := "workspaces/" + workspaceID + "/" + id.String() + filepath.Ext(abs)
		link, upErr := h.Storage.Upload(ctx, key, data, contentType, filepath.Base(abs))
		if upErr != nil {
			failed++
			continue
		}
		if _, err := h.Queries.CreateAttachment(ctx, db.CreateAttachmentParams{
			ID:           pgtype.UUID{Bytes: id, Valid: true},
			WorkspaceID:  project.WorkspaceID,
			UploaderType: "member",
			UploaderID:   parseUUID(userID),
			Filename:     filepath.Base(d.relPath),
			Url:          link,
			ContentType:  contentType,
			SizeBytes:    info.Size(),
		}); err != nil {
			failed++
			continue
		}
		artID, parseErr := util.ParseUUID(d.id)
		if parseErr != nil {
			failed++
			continue
		}
		if _, err := h.DB.Exec(ctx,
			`UPDATE project_artifact SET attachment_id = $2 WHERE id = $1 AND deleted_at IS NULL`,
			artID, pgtype.UUID{Bytes: id, Valid: true}); err != nil {
			failed++
		} else {
			backfilled++
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"total":        len(docs),
		"backfilled":   backfilled,
		"missing":      missing,
		"too_large":    tooLarge,
		"failed":       failed,
		"archive_root": rootClean,
	})
}

// detectSnapshotContentType 复用上传口的扩展名优先判定。
func detectSnapshotContentType(relPath string, data []byte) string {
	ext := strings.ToLower(filepath.Ext(relPath))
	if ct, ok := extContentTypes[ext]; ok {
		return ct
	}
	buf := data
	if len(buf) > 512 {
		buf = buf[:512]
	}
	return http.DetectContentType(buf)
}
