package handler

// 资产五阶段 ↔ 档案 (stage, doc_type) 唯一映射契约（plan「资产阶段对齐与组件统一」§2.3/§4.1）。
//
// S1 项目规划 ↔ 1 ↔ research；S2 产品原型 ↔ 2 ↔ product-design；
// S3 技术方案 ↔ 3 ↔ architecture；S4 问题复盘 ↔ 4 ↔ retrospective；
// S5 需求迭代 ↔ 5 ↔ iteration。general / 未标 → (NULL, 'asset') 未分阶保留区。
//
// 货架归属只认 doc_type；doc_module 是货架内的独立模块标签，不参与阶段映射。
// 资产同步、档案 PATCH、归档重分类、manifest 同步共同调用本文件，正反映射只此一份。

import (
	"path"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
)

// archivePlacement 是档案行的货架归属二元组。Stage=0 表示 stage IS NULL。
type archivePlacement struct {
	Stage   int32
	DocType string
}

// assetUnstagedPlacement 是未分阶保留区形态。
var assetUnstagedPlacement = archivePlacement{Stage: 0, DocType: "asset"}

var lifecyclePlacementMap = map[string]archivePlacement{
	"S1": {1, "research"},
	"S2": {2, "product-design"},
	"S3": {3, "architecture"},
	"S4": {4, "retrospective"},
	"S5": {5, "iteration"},
}

// isAssetLinkedShelfDocType：五货架 doc_type 集合（资产关联行的合法归属）。
func isAssetLinkedShelfDocType(docType string) bool {
	switch docType {
	case "research", "product-design", "architecture", "retrospective", "iteration":
		return true
	}
	return false
}

// archivePlacementForLifecycle：资产阶段 → 档案 placement。ok=false 表示
// general/空/非法（未分阶保留区），返回值仍给出 (0, asset) 便于调用方直接使用。
func archivePlacementForLifecycle(lifecycle string) (archivePlacement, bool) {
	key := strings.ToUpper(strings.TrimSpace(lifecycle))
	if p, ok := lifecyclePlacementMap[key]; ok {
		return p, true
	}
	return assetUnstagedPlacement, false
}

// archiveStageFromLifecycle 保留旧签名（测试与调用方兼容），由统一映射派生。
func archiveStageFromLifecycle(stage string) pgtype.Int4 {
	p, ok := archivePlacementForLifecycle(stage)
	if !ok || p.Stage == 0 {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: p.Stage, Valid: true}
}

// placementForArchiveStage 只按 stage 反查（要求 stage 在 1..5）。
func placementForArchiveStage(stage pgtype.Int4) (archivePlacement, bool) {
	if !stage.Valid || stage.Int32 < 1 || stage.Int32 > 5 {
		return archivePlacement{}, false
	}
	for _, p := range lifecyclePlacementMap {
		if p.Stage == stage.Int32 {
			return p, true
		}
	}
	return archivePlacement{}, false
}

// lifecycleForArchivePlacement：档案 placement → 资产阶段。只接受五种合法组合
// 及 (NULL, asset)；矛盾组合、开放式非货架 doc_type 一律 ok=false。
func lifecycleForArchivePlacement(stage pgtype.Int4, docType string) (string, bool) {
	docType = strings.TrimSpace(docType)
	if !stage.Valid {
		if docType == "asset" {
			return "general", true
		}
		return "", false
	}
	for lifecycle, p := range lifecyclePlacementMap {
		if p.Stage == stage.Int32 && p.DocType == docType {
			return lifecycle, true
		}
	}
	return "", false
}

// linkedArtifactPlacement 是 normalizeLinkedArtifactPlacement 的判定结果：
// 需要写回的档案字段（相对当前值实际变化者）与需要回写的资产生命周期。
type linkedArtifactPlacement struct {
	Stage                *int32 // 写回档案 stage（nil = 不改）
	ClearStage           *bool  // true = stage 置 NULL（未分阶保留区）
	DocType              *string
	Lifecycle            *string // nil = 不动资产；"" = 清空 lifecycle_stage
	NeedsLifecycleUpdate bool
	PreserveAssetSource  bool // 资产原生关联行（source='asset'）编辑后保留来源
	Err                  string
}

// normalizeLinkedArtifactPlacement 合并「档案编辑请求」与当前行值，产出两侧
// 实际要写的字段。linked 判定：资产原生关联（assetBindingID 有效或
// current.Source=='asset'）或档案导入关联（externalBindingID 有效）。
// currentStage/currentDocType 取请求中的原始指针（nil=本次未提交该字段）。
func normalizeLinkedArtifactPlacement(current projectArtifactRow, externalBindingID *pgtype.UUID, req *PatchProjectArtifactRequest, currentSource string) linkedArtifactPlacement {
	var res linkedArtifactPlacement
	assetBindingLinked := currentSource == "asset"
	linked := assetBindingLinked || (externalBindingID != nil && externalBindingID.Valid)
	if !linked {
		return res
	}
	if assetBindingLinked {
		res.PreserveAssetSource = true
	}

	stageChanged := req.Stage != nil && !(current.Stage.Valid && *req.Stage == current.Stage.Int32)
	docTypeChanged := req.DocType != nil && strings.TrimSpace(*req.DocType) != current.DocType
	if !stageChanged && !docTypeChanged {
		return res
	}

	// 只把 stage 改成 1..5 之外的值不属于联动（校验在调用方先行拒绝）。
	setStage := func(v int32) { res.Stage = &v }
	setLifecycle := func(v string) {
		res.NeedsLifecycleUpdate = true
		l := v
		res.Lifecycle = &l
	}

	if stageChanged && docTypeChanged {
		p := archivePlacement{Stage: *req.Stage, DocType: strings.TrimSpace(*req.DocType)}
		if _, ok := lifecycleForArchivePlacement(pgtype.Int4{Int32: p.Stage, Valid: true}, p.DocType); !ok {
			res.Err = "stage and doc_type do not form a valid asset shelf combination"
			return res
		}
		setStage(p.Stage)
		dt := p.DocType
		res.DocType = &dt
		lc, _ := lifecycleForArchivePlacement(pgtype.Int4{Int32: p.Stage, Valid: true}, p.DocType)
		setLifecycle(lc)
		return res
	}

	if stageChanged {
		// stage 单独变化：五货架之间迁移，同步推导 doc_type。
		newStage := pgtype.Int4{Int32: *req.Stage, Valid: true}
		if _, ok := placementForArchiveStage(newStage); !ok {
			res.Err = "stage must be within 1..5 for asset-linked artifacts"
			return res
		}
		if current.DocType != "asset" && !isAssetLinkedShelfDocType(current.DocType) {
			// 当前挂在开放式非货架 doc_type：仅凭 stage 无法确定迁移意图。
			if _, ok := placementForArchiveStage(current.Stage); !ok {
				res.Err = "doc_type must be provided together with stage for non-shelf artifacts"
				return res
			}
		}
		setStage(*req.Stage)
		p, _ := placementForArchiveStage(newStage)
		dt := p.DocType
		res.DocType = &dt
		lc, _ := lifecycleForArchivePlacement(newStage, p.DocType)
		setLifecycle(lc)
		return res
	}

	// doc_type 单独变化。
	newDocType := strings.TrimSpace(*req.DocType)
	if newDocType == "asset" {
		// 移入未分阶保留区：清空档案 stage，并清空关联资产阶段（不推断 general）。
		t := true
		res.ClearStage = &t
		res.DocType = &newDocType
		setLifecycle("")
		return res
	}
	if isAssetLinkedShelfDocType(newDocType) {
		if !isAssetLinkedShelfDocType(current.DocType) && current.DocType != "asset" {
			// 从开放式 doc_type 进货架：需要显式 stage 才能确定归属。
			res.Err = "stage must be provided together with doc_type when moving a non-shelf artifact into a shelf"
			return res
		}
		p, ok := placementForArchiveStage(current.Stage)
		_ = p
		if !ok && req.Stage == nil {
			res.Err = "current artifact has no valid shelf stage to carry over"
			return res
		}
		dt := newDocType
		res.DocType = &dt
		var stageVal int32
		for lifecycle, cand := range lifecyclePlacementMap {
			if cand.DocType == newDocType {
				stageVal = cand.Stage
				lc := lifecycle
				setLifecycle(lc)
			}
		}
		setStage(stageVal)
		return res
	}
	// 改到开放式 doc_type：档案脱离五货架，关联资产清空阶段，档案 stage 置 NULL。
	t := true
	res.ClearStage = &t
	dt := newDocType
	res.DocType = &dt
	setLifecycle("")
	return res
}

// shelfRelPathForMove 计算档案标准货架间移动后的路径：仅当当前路径位于
// overview/<旧货架>/ 前缀下时替换货架段；'assets/' 前缀与自定义路径不动
// （返回 ""），消除档案拖拽与资产同步之间的路径乒乓。
func shelfRelPathForMove(currentRelPath, oldDocType, newDocType string) string {
	currentRelPath = strings.TrimSpace(currentRelPath)
	if oldDocType == "" || newDocType == "" || oldDocType == newDocType {
		return ""
	}
	prefix := "overview/" + oldDocType + "/"
	if !strings.HasPrefix(currentRelPath, prefix) {
		return ""
	}
	return path.Join("overview", newDocType, strings.TrimPrefix(currentRelPath, prefix))
}
