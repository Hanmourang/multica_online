package handler

// 资产 → 项目档案自动映射（migration 474 + 五阶段对齐 plan §4.2）。
//
// 规则：知识 / 文档类资产（knowledge_repo / knowledge_group / other）绑定时自动落
// 一条 project_artifact 档案行（source='asset'，asset_binding_id 反向持链）；
// lifecycle_stage 按唯一映射写 stage + doc_type 直接入五货架，未分阶落
// (NULL, 'asset') 保留区；解绑经 FK ON DELETE CASCADE 自动清档。
//
// 防循环：从档案反向绑定成资产的 binding（external_ref 携带 artifact_id）不新建
// 档案，但阶段变化会在同一事务内回写原档案的 placement。
// 事务一致性：syncAssetToArchive 返回 error，调用方失败必须回滚主流程，
// 不再 best-effort（避免接口成功但两侧数据分叉）。

import (
	"context"
	"encoding/json"
	"path"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
)

// archiveAssetCategories：只有知识 / 文档语义的资产分类参与档案映射；
// 代码仓库 / 应用 / 制品包是运行资源而非文档，不进档案货架。
var archiveAssetCategories = map[string]bool{
	"knowledge_repo":  true,
	"knowledge_group": true,
	"other":           true,
}

// assetExternalRef 是 binding.external_ref 中档案映射关心的字段。
type assetExternalRef struct {
	URL          string `json:"url"`
	AttachmentID string `json:"attachment_id"`
	Filename     string `json:"filename"`
	RelPath      string `json:"rel_path"`
	SizeBytes    int64  `json:"size_bytes"`
	ArtifactID   string `json:"artifact_id"` // 档案反向绑定的标记（防循环）
}

// archiveStageFromLifecycle 已归一到 project_asset_archive_placement.go 的
// 统一五阶段映射，避免正反映射各自漂移。

// assetArchivePlan 是从 binding 推导出的档案行形态；ok=false 表示不参与映射。
type assetArchivePlan struct {
	relPath      string
	docType      string
	archiveStage int32 // 0 = stage IS NULL（未分阶保留区）
	docClass     *string
	attachmentID pgtype.UUID
	sizeBytes    int64
}

// planAssetArchive 纯函数：判定 + 推导（单测覆盖点）。doc_module 不再取资产
// 首标签：资产标签与档案模块标签各自独立，不做元数据双向映射。
func planAssetArchive(b assetBindingRow) (assetArchivePlan, bool) {
	if !archiveAssetCategories[b.assetCategory] {
		return assetArchivePlan{}, false
	}
	var ref assetExternalRef
	_ = json.Unmarshal(b.externalRef, &ref) // 解析失败按空 ref 走后续判定
	if strings.TrimSpace(ref.ArtifactID) != "" {
		return assetArchivePlan{}, false // 档案 → 资产的反向行不新建档案（placement 回写见 planImportedAssetPlacementUpdate）
	}
	hasPayload := strings.TrimSpace(ref.AttachmentID) != "" ||
		strings.TrimSpace(ref.URL) != "" ||
		strings.TrimSpace(ref.Filename) != ""
	if !hasPayload {
		return assetArchivePlan{}, false
	}

	name := strings.TrimSpace(ref.Filename)
	if name == "" {
		name = strings.TrimSpace(b.assetName)
	}
	if ext := strings.TrimSpace(b.assetSubtype.String); ext != "" && b.assetSubtype.Valid &&
		!strings.Contains(name, ".") {
		name += "." + strings.TrimPrefix(ext, ".")
	}
	rel := strings.TrimSpace(ref.RelPath)
	if rel == "" {
		rel = name
	}
	// 纯记录性路径（供档案展示 / 预览定位），不落盘读文件；仍剥掉 '..' 段
	// 保持路径整洁，避免前端把异常 rel_path 当真实目录拼接。
	rel = sanitizeArchiveRelPath(rel)
	// assets/ 前缀：与 git 同步行的目录命名空间隔离，避免 (resource_id, rel_path) 冲突。
	relPath := path.Join("assets", b.assetCategory, rel)

	placement, _ := archivePlacementForLifecycle(b.lifecycleStage.String)
	plan := assetArchivePlan{
		relPath:      relPath,
		docType:      placement.DocType,
		archiveStage: placement.Stage,
		docClass:     docClassPtr(nil, placement.DocType, relPath), // 文件名命中 BRD-/MRD- 等规则时自动挂规划货架
		sizeBytes:    ref.SizeBytes,
	}
	if id, err := parseUUIDLoose(ref.AttachmentID); err == nil && id.Valid {
		plan.attachmentID = id
	}
	if ref.AttachmentID == "" {
		plan.attachmentID = pgtype.UUID{}
	}
	return plan, true
}

// planImportedAssetPlacementUpdate：档案导入资产（external_ref.artifact_id）的
// placement 回写计划。不新建、不删除档案，只把五阶段映射后的 (stage, doc_type)
// 写回原档案；general/未标 → (0, asset) 未分阶保留区。非文档分类不参与。
func planImportedAssetPlacementUpdate(b assetBindingRow) (int32, string, bool) {
	if !archiveAssetCategories[b.assetCategory] {
		return 0, "", false
	}
	var ref assetExternalRef
	_ = json.Unmarshal(b.externalRef, &ref)
	if strings.TrimSpace(ref.ArtifactID) == "" {
		return 0, "", false
	}
	placement, _ := archivePlacementForLifecycle(b.lifecycleStage.String)
	return placement.Stage, placement.DocType, true
}

// sanitizeArchiveRelPath 去掉绝对路径前缀与 '..' 段，保证相对形态。
func sanitizeArchiveRelPath(p string) string {
	p = filepath.ToSlash(strings.TrimSpace(p))
	p = strings.TrimPrefix(p, "/")
	segs := []string{}
	for _, s := range strings.Split(p, "/") {
		if s == "" || s == "." || s == ".." {
			continue
		}
		segs = append(segs, s)
	}
	if len(segs) == 0 {
		return "untitled"
	}
	return strings.Join(segs, "/")
}

// syncAssetToArchive 幂等 upsert binding 对应的档案行；不满足映射条件时清掉旧行
// （覆盖分类被改 / external_ref 被清空的边缘场景）。失败返回 error，调用方在同一
// 事务内回滚，不允许 best-effort 分叉。
func (h *Handler) syncAssetToArchive(ctx context.Context, store assetDB, b assetBindingRow) error {
	// 档案导入资产：不新建不删除，只把 placement 回写原档案（保留来源/路径/正文）。
	if stage, docType, ok := planImportedAssetPlacementUpdate(b); ok {
		var ref assetExternalRef
		_ = json.Unmarshal(b.externalRef, &ref)
		artifactID, err := parseUUIDLoose(ref.ArtifactID)
		if err != nil || !artifactID.Valid {
			return nil // artifact_id 不可解析：没有可回写的原档案，不算失败
		}
		if _, err := store.Exec(ctx, `
			UPDATE project_artifact
			SET stage = $2, doc_type = $3, updated_at = now()
			WHERE id = $1 AND deleted_at IS NULL`,
			artifactID, nilIfZeroStage(stage), docType); err != nil {
			return err
		}
		return nil
	}

	plan, ok := planAssetArchive(b)
	if !ok {
		if _, err := store.Exec(ctx,
			`DELETE FROM project_artifact WHERE asset_binding_id = $1`, b.id); err != nil {
			return err
		}
		return nil
	}

	stage := pgtype.Int4{}
	if plan.archiveStage > 0 {
		stage = pgtype.Int4{Int32: plan.archiveStage, Valid: true}
	}
	scope, issueID := "project", pgtype.UUID{}
	if b.issueID.Valid {
		scope, issueID = "requirement", b.issueID
	}
	// best-effort 挂项目的档案资源指针（有则一致，无则 NULL——读路径按 project_id 过滤）。
	archiveResourceID, _ := h.lookupArchiveResourceID(ctx, b.projectID)

	_, err := store.Exec(ctx, `
		INSERT INTO project_artifact
		    (workspace_id, project_id, resource_id, issue_id, scope, stage,
		     doc_type, version, rel_path, doc_class,
		     blob_sha, attachment_id, size_bytes, source, asset_binding_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'',$10,$11,'asset',$12)
		ON CONFLICT (asset_binding_id) WHERE asset_binding_id IS NOT NULL
		DO UPDATE SET
		    issue_id = EXCLUDED.issue_id,
		    scope = EXCLUDED.scope,
		    stage = EXCLUDED.stage,
		    doc_type = EXCLUDED.doc_type,
		    -- 路径乒乓防护：仅 overview/<旧货架>/ 标准路径随货架迁移替换货架段；
		    -- assets/ 与自定义路径保持原样，新建行走 EXCLUDED。
		    rel_path = CASE
		        WHEN project_artifact.rel_path LIKE 'overview/%' AND (EXCLUDED.stage IS NULL OR project_artifact.stage IS DISTINCT FROM EXCLUDED.stage)
		        THEN 'overview/' || EXCLUDED.doc_type || '/' ||
		             regexp_replace(project_artifact.rel_path, '^overview/[^/]+/', '')
		        ELSE project_artifact.rel_path END,
		    attachment_id = EXCLUDED.attachment_id,
		    size_bytes = EXCLUDED.size_bytes,
		    source = 'asset',
		    deleted_at = NULL,
		    synced_at = now(),
		    updated_at = now()`,
		b.workspaceID, b.projectID, archiveResourceID, issueID,
		scope, stage, plan.docType, plan.relPath, plan.docClass,
		plan.attachmentID, plan.sizeBytes, b.id,
	)
	return err
}

// nilIfZeroStage：回写导入档案时 stage=0 表示置 NULL。
func nilIfZeroStage(stage int32) any {
	if stage == 0 {
		return nil
	}
	return stage
}
