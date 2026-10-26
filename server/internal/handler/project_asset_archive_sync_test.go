package handler

import (
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

func archiveTestBinding(category string, ref map[string]any) assetBindingRow {
	blob, _ := json.Marshal(ref)
	return assetBindingRow{
		id:            pgtype.UUID{Bytes: [16]byte{1}, Valid: true},
		assetCategory: category,
		assetName:     "架构说明",
		externalRef:   blob,
	}
}

// 五阶段契约：S1..S5 → 1..5；general/未标/非法 → 未分阶保留区（archiveStage=0）。
func TestArchiveStageFromLifecycle(t *testing.T) {
	cases := map[string]struct {
		stage int32
		valid bool
	}{
		"S1":      {1, true},
		"s2":      {2, true},
		" S3 ":    {3, true},
		"S4":      {4, true},
		"S5":      {5, true},
		"general": {0, false},
		"":        {0, false},
		"bogus":   {0, false},
		"S6":      {0, false},
	}
	for in, want := range cases {
		got := archiveStageFromLifecycle(in)
		if want.valid {
			if !got.Valid || got.Int32 != want.stage {
				t.Errorf("archiveStageFromLifecycle(%q) = %+v, want valid %d", in, got, want.stage)
			}
			continue
		}
		if got.Valid || got.Int32 != 0 {
			t.Errorf("archiveStageFromLifecycle(%q) = %+v, want invalid", in, got)
		}
	}
}

func TestPlanAssetArchiveCategoryGate(t *testing.T) {
	ref := map[string]any{"url": "https://kb.example.com/doc/1"}
	for _, cat := range []string{"knowledge_repo", "knowledge_group", "other"} {
		if _, ok := planAssetArchive(archiveTestBinding(cat, ref)); !ok {
			t.Errorf("category %q should map into archive", cat)
		}
	}
	for _, cat := range []string{"code_repository", "application", "package"} {
		if _, ok := planAssetArchive(archiveTestBinding(cat, ref)); ok {
			t.Errorf("category %q must not enter archive", cat)
		}
	}
}

func TestPlanAssetArchiveLoopGuardAndEmptyRef(t *testing.T) {
	// 档案反向 binding（带 artifact_id）：跳过，防 档案→资产→档案 循环。
	back := archiveTestBinding("other", map[string]any{
		"artifact_id": "0a6db0d2-0000-0000-0000-000000000001",
		"rel_path":    "overview/research/BRD-知识经营价值.md",
	})
	if _, ok := planAssetArchive(back); ok {
		t.Error("archive-sourced binding must not re-sync into archive")
	}
	// 无任何可定位内容（无 url / attachment / filename）：不入档。
	bare := archiveTestBinding("other", map[string]any{})
	if _, ok := planAssetArchive(bare); ok {
		t.Error("binding without payload must not enter archive")
	}
}

func TestPlanAssetArchiveDerivation(t *testing.T) {
	att := "7f1fb123-4567-89ab-cdef-000000000001"
	b := archiveTestBinding("other", map[string]any{
		"attachment_id": att,
		"filename":      "01-可行性评估报告.md",
		"rel_path":      "docs/../调研/01-可行性评估报告.md",
		"size_bytes":    float64(2048),
	})
	b.assetSubtype = pgtype.Text{String: "md", Valid: true}
	b.lifecycleStage = pgtype.Text{String: "S2", Valid: true}
	b.tags = []string{"评估", "调研"}
	b.issueID = pgtype.UUID{Bytes: [16]byte{9}, Valid: true}

	plan, ok := planAssetArchive(b)
	if !ok {
		t.Fatal("expected archive plan")
	}
	if plan.relPath != "assets/other/docs/调研/01-可行性评估报告.md" {
		t.Errorf("rel_path = %q, want assets/ prefix + sanitized dir", plan.relPath)
	}
	// S2 → 产品原型货架：doc_type 按五阶段映射，stage 同步。
	if plan.docType != "product-design" {
		t.Errorf("doc_type = %q, want product-design", plan.docType)
	}
	if plan.archiveStage != 2 {
		t.Errorf("archive_stage = %d, want 2", plan.archiveStage)
	}
	if plan.docClass == nil || *plan.docClass != "" {
		// "01-可行性评估报告.md" 不命中 prd/mrd/brd 规则 → docClass 应为 nil
		if plan.docClass != nil {
			t.Errorf("doc_class = %q, want nil", *plan.docClass)
		}
	}
	if !plan.attachmentID.Valid || plan.attachmentID.Bytes != [16]byte{
		0x7f, 0x1f, 0xb1, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0, 0, 0, 0, 0, 1,
	} {
		t.Errorf("attachment_id = %+v", plan.attachmentID)
	}
	// doc_module 不再取资产首标签：plan 结构已移除该字段（编译期即防回归），
	// 档案侧 doc_module 保留与独立编辑行为由 DB 集成用例钉住。
	if plan.sizeBytes != 2048 {
		t.Errorf("size_bytes = %d", plan.sizeBytes)
	}

	// BRD- 前缀文件名命中规划货架规则。
	b2 := archiveTestBinding("knowledge_repo", map[string]any{"url": "https://kb.example.com/x"})
	b2.assetName = "BRD-知识经营价值"
	plan2, ok := planAssetArchive(b2)
	if !ok {
		t.Fatal("expected archive plan for BRD asset")
	}
	if plan2.relPath != "assets/knowledge_repo/BRD-知识经营价值" {
		t.Errorf("rel_path = %q", plan2.relPath)
	}
	if plan2.docClass == nil || *plan2.docClass != "brd" {
		t.Errorf("doc_class = %+v, want brd", plan2.docClass)
	}
	// 未分阶（lifecycle 空）→ 未分阶保留区 (NULL, asset)。
	if plan2.docType != "asset" || plan2.archiveStage != 0 {
		t.Errorf("unstaged plan = (%q,%d), want (asset,0)", plan2.docType, plan2.archiveStage)
	}
}

func TestPlanAssetArchiveS5AndGeneral(t *testing.T) {
	b := archiveTestBinding("other", map[string]any{"filename": "迭代计划.md"})
	b.lifecycleStage = pgtype.Text{String: "S5", Valid: true}
	plan, ok := planAssetArchive(b)
	if !ok {
		t.Fatal("expected archive plan")
	}
	if plan.docType != "iteration" || plan.archiveStage != 5 {
		t.Errorf("S5 plan = (%q,%d), want (iteration,5)", plan.docType, plan.archiveStage)
	}

	b.lifecycleStage = pgtype.Text{String: "general", Valid: true}
	plan, ok = planAssetArchive(b)
	if !ok {
		t.Fatal("general assets still map into archive")
	}
	if plan.docType != "asset" || plan.archiveStage != 0 {
		t.Errorf("general plan = (%q,%d), want (asset,0)", plan.docType, plan.archiveStage)
	}
}

func TestPlanImportedAssetPlacementUpdate(t *testing.T) {
	// 档案导入资产（external_ref.artifact_id）：不新建档案，但阶段变化要回写原档案。
	b := archiveTestBinding("knowledge_repo", map[string]any{
		"artifact_id": "0a6db0d2-0000-0000-0000-000000000001",
	})
	b.lifecycleStage = pgtype.Text{String: "S3", Valid: true}
	stage, docType, ok := planImportedAssetPlacementUpdate(b)
	if !ok {
		t.Fatal("staged imported binding must push placement back to its artifact")
	}
	if stage != 3 || docType != "architecture" {
		t.Errorf("imported placement = (%d,%q), want (3,architecture)", stage, docType)
	}

	// general / 未标 → 清空原档案阶段并落入未分阶保留区。
	b.lifecycleStage = pgtype.Text{String: "general", Valid: true}
	stage, docType, ok = planImportedAssetPlacementUpdate(b)
	if !ok {
		t.Fatal("unstaged imported binding still needs placement reset")
	}
	if stage != 0 || docType != "asset" {
		t.Errorf("unstaged imported placement = (%d,%q), want (0,asset)", stage, docType)
	}

	// 非文档分类不参与。
	b2 := archiveTestBinding("application", map[string]any{
		"artifact_id": "0a6db0d2-0000-0000-0000-000000000002",
	})
	if _, _, ok := planImportedAssetPlacementUpdate(b2); ok {
		t.Error("non-document category must not push placement")
	}
}

func TestSanitizeArchiveRelPath(t *testing.T) {
	cases := map[string]string{
		"docs/a.md":        "docs/a.md",
		"/etc/passwd":      "etc/passwd",
		"../../secret.txt": "secret.txt",
		"a//b/./c":         "a/b/c",
		"":                 "untitled",
		"..":               "untitled",
	}
	for in, want := range cases {
		if got := sanitizeArchiveRelPath(in); got != want {
			t.Errorf("sanitizeArchiveRelPath(%q) = %q, want %q", in, got, want)
		}
	}
}
