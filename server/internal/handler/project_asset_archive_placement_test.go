package handler

// 资产五阶段 ↔ 档案 (stage, doc_type) 唯一映射契约（plan 资产阶段对齐与组件统一 §2.3 / §4.1）。
// 货架归属只认 doc_type，doc_module 是货架内的独立模块标签，不参与阶段映射。

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestArchivePlacementForLifecycle_SixStages(t *testing.T) {
	cases := []struct {
		lifecycle string
		wantStage int32
		wantType  string
	}{
		{"S0", 0, "requirement"}, // S0 需求描述：stage NULL（0 哨兵）+ requirement
		{"S1", 1, "research"},
		{"S2", 2, "product-design"},
		{"S3", 3, "architecture"},
		{"S4", 4, "retrospective"},
		{"S5", 5, "iteration"},
	}
	for _, c := range cases {
		placement, ok := archivePlacementForLifecycle(c.lifecycle)
		if !ok {
			t.Errorf("archivePlacementForLifecycle(%q) should map", c.lifecycle)
			continue
		}
		if placement.Stage != c.wantStage || placement.DocType != c.wantType {
			t.Errorf("archivePlacementForLifecycle(%q) = (%d,%s), want (%d,%s)",
				c.lifecycle, placement.Stage, placement.DocType, c.wantStage, c.wantType)
		}
	}
	// general / 空 / 非法 → 未分阶保留区 (NULL, asset)。
	for _, in := range []string{"general", "", "bogus", "S6", "s1 general"} {
		placement, ok := archivePlacementForLifecycle(in)
		if ok {
			t.Errorf("archivePlacementForLifecycle(%q) should not map, got %+v", in, placement)
		}
		if placement.DocType != "asset" || placement.Stage != 0 {
			t.Errorf("archivePlacementForLifecycle(%q) default placement = %+v, want (0, asset)", in, placement)
		}
	}
	// 大小写 / 空白容错
	if p, ok := archivePlacementForLifecycle(" s5 "); !ok || p.DocType != "iteration" {
		t.Errorf("lowercase/trim input should map, got %+v ok=%v", p, ok)
	}
}

func TestLifecycleForArchivePlacement(t *testing.T) {
	cases := []struct {
		stage   pgtype.Int4
		docType string
		want    string
	}{
		{pgtype.Int4{Int32: 1, Valid: true}, "research", "S1"},
		{pgtype.Int4{Int32: 2, Valid: true}, "product-design", "S2"},
		{pgtype.Int4{Int32: 3, Valid: true}, "architecture", "S3"},
		{pgtype.Int4{Int32: 4, Valid: true}, "retrospective", "S4"},
		{pgtype.Int4{Int32: 5, Valid: true}, "iteration", "S5"},
		{pgtype.Int4{}, "requirement", "S0"},
		{pgtype.Int4{}, "asset", "general"},
	}
	for _, c := range cases {
		got, ok := lifecycleForArchivePlacement(c.stage, c.docType)
		if !ok || got != c.want {
			t.Errorf("lifecycleForArchivePlacement(%v,%q) = (%q,%v), want (%q,true)",
				c.stage, c.docType, got, ok, c.want)
		}
	}
	// 矛盾组合与非关联 doc_type 一律拒绝。
	for _, bad := range []struct {
		stage   pgtype.Int4
		docType string
	}{
		{pgtype.Int4{Int32: 1, Valid: true}, "product-design"},
		{pgtype.Int4{Int32: 5, Valid: true}, "research"},
		{pgtype.Int4{}, "research"},
		{pgtype.Int4{Int32: 1, Valid: true}, "asset"},
		{pgtype.Int4{Int32: 1, Valid: true}, "meeting-notes"},
		{pgtype.Int4{Int32: 6, Valid: true}, "iteration"},
	} {
		if _, ok := lifecycleForArchivePlacement(bad.stage, bad.docType); ok {
			t.Errorf("lifecycleForArchivePlacement(%v,%q) must reject", bad.stage, bad.docType)
		}
	}
}

func TestIsAssetLinkedShelfDocType(t *testing.T) {
	for _, dt := range []string{"research", "product-design", "architecture", "retrospective", "iteration", "requirement"} {
		if !isAssetLinkedShelfDocType(dt) {
			t.Errorf("%q is a linked shelf doc_type", dt)
		}
	}
	for _, dt := range []string{"asset", "work-plan", "", "meeting-notes"} {
		if isAssetLinkedShelfDocType(dt) {
			t.Errorf("%q must not be a linked shelf doc_type", dt)
		}
	}
}

func artifactPlacementRow(stage pgtype.Int4, docType string) projectArtifactRow {
	return projectArtifactRow{Stage: stage, DocType: docType}
}

func TestNormalizeLinkedArtifactPlacement(t *testing.T) {
	st1 := pgtype.Int4{Int32: 1, Valid: true}
	st3 := pgtype.Int4{Int32: 3, Valid: true}
	unmapped := artifactPlacementRow(st3, "meeting-notes")

	t.Run("非关联档案不做联动", func(t *testing.T) {
		res := normalizeLinkedArtifactPlacement(artifactPlacementRow(st1, "research"), nil,
			&PatchProjectArtifactRequest{Stage: ptrInt32(5)}, "")
		if res.NeedsLifecycleUpdate || res.Lifecycle != nil {
			t.Errorf("unlinked artifact must not touch asset lifecycle: %+v", res)
		}
		if res.Err != "" {
			t.Errorf("unlinked artifact must not error: %q", res.Err)
		}
	})

	t.Run("仅 stage 实际变化时同步推导 doc_type", func(t *testing.T) {
		res := normalizeLinkedArtifactPlacement(artifactPlacementRow(st1, "research"), nil,
			&PatchProjectArtifactRequest{Stage: ptrInt32(5), DocType: strPtr("research")}, "asset")
		if res.Err != "" {
			t.Fatalf("unexpected err: %q", res.Err)
		}
		if res.Stage == nil || *res.Stage != 5 || res.DocType == nil || *res.DocType != "iteration" {
			t.Errorf("placement = (%v,%v), want (5, iteration)", res.Stage, res.DocType)
		}
		if !res.NeedsLifecycleUpdate || res.Lifecycle == nil || *res.Lifecycle != "S5" {
			t.Errorf("lifecycle = %v, needUpdate=%v", res.Lifecycle, res.NeedsLifecycleUpdate)
		}
		if !res.PreserveAssetSource {
			t.Error("native linked row must keep source")
		}
	})

	t.Run("表单携带未修改旧值不妨碍另一侧校正", func(t *testing.T) {
		res := normalizeLinkedArtifactPlacement(artifactPlacementRow(st1, "research"), nil,
			&PatchProjectArtifactRequest{Stage: ptrInt32(1), DocType: strPtr("iteration")}, "asset")
		if res.Err != "" {
			t.Fatalf("unexpected err: %q", res.Err)
		}
		// stage 旧值未变 → 由新货架 doc_type 反向校正 stage。
		if res.Stage == nil || *res.Stage != 5 || res.DocType == nil || *res.DocType != "iteration" {
			t.Errorf("docType-only change: stage=%v docType=%v, want stage=5 docType=iteration", res.Stage, res.DocType)
		}
		if !res.NeedsLifecycleUpdate || res.Lifecycle == nil || *res.Lifecycle != "S5" {
			t.Errorf("lifecycle = %v", res.Lifecycle)
		}
	})

	t.Run("两者都实际变化且矛盾时 400", func(t *testing.T) {
		res := normalizeLinkedArtifactPlacement(artifactPlacementRow(st1, "research"), nil,
			&PatchProjectArtifactRequest{Stage: ptrInt32(3), DocType: strPtr("iteration")}, "asset")
		if res.Err == "" {
			t.Fatalf("conflicting stage+doc_type must be rejected, got %+v", res)
		}
	})

	t.Run("移到 asset 未分阶区清空阶段与关联生命周期", func(t *testing.T) {
		res := normalizeLinkedArtifactPlacement(artifactPlacementRow(st1, "research"), nil,
			&PatchProjectArtifactRequest{DocType: strPtr("asset")}, "asset")
		if res.Err != "" {
			t.Fatalf("unexpected err: %q", res.Err)
		}
		if res.ClearStage == nil || !*res.ClearStage {
			t.Errorf("ClearStage must be true: %+v", res)
		}
		if res.DocType == nil || *res.DocType != "asset" {
			t.Errorf("doc_type = %v", res.DocType)
		}
		if !res.NeedsLifecycleUpdate || res.Lifecycle == nil || *res.Lifecycle != "" {
			t.Errorf("linked asset lifecycle must be cleared: %v", res.Lifecycle)
		}
	})

	t.Run("导入关系保留原来源", func(t *testing.T) {
		external := pgtype.UUID{Bytes: [16]byte{8}, Valid: true}
		res := normalizeLinkedArtifactPlacement(artifactPlacementRow(st1, "research"), &external,
			&PatchProjectArtifactRequest{Stage: ptrInt32(2)}, "archive")
		if res.PreserveAssetSource {
			t.Error("import-linked row must keep its own source, not asset")
		}
		if !res.NeedsLifecycleUpdate || res.Lifecycle == nil || *res.Lifecycle != "S2" {
			t.Errorf("import link should still update lifecycle: %+v", res)
		}
	})

	t.Run("未映射开放 doc_type 上仅改 stage 直接换货架", func(t *testing.T) {
		res := normalizeLinkedArtifactPlacement(unmapped, nil,
			&PatchProjectArtifactRequest{Stage: ptrInt32(5)}, "asset")
		if res.Err != "" {
			t.Fatalf("unexpected err: %q", res.Err)
		}
		if res.DocType == nil || *res.DocType != "iteration" {
			t.Errorf("doc_type = %v, want iteration", res.DocType)
		}
	})

	t.Run("未映射开放 doc_type 上仅改货架 doc_type 需要 stage 一起给", func(t *testing.T) {
		res := normalizeLinkedArtifactPlacement(unmapped, nil,
			&PatchProjectArtifactRequest{DocType: strPtr("iteration")}, "asset")
		if res.Err == "" {
			t.Fatalf("open doc_type + shelf-only change must ask for explicit stage")
		}
	})

	t.Run("仅改 doc_module 等内容字段不做 placement 联动", func(t *testing.T) {
		res := normalizeLinkedArtifactPlacement(artifactPlacementRow(st1, "research"), nil,
			&PatchProjectArtifactRequest{DocModule: strPtr("评估")}, "asset")
		if res.Err != "" || res.NeedsLifecycleUpdate || res.Stage != nil || res.DocType != nil {
			t.Errorf("module-only patch must be a no-op for placement: %+v", res)
		}
	})

	t.Run("导入反向关系按 externalBinding 判定", func(t *testing.T) {
		linked := pgtype.UUID{Bytes: [16]byte{7}, Valid: true}
		res := normalizeLinkedArtifactPlacement(artifactPlacementRow(st1, "research"), &linked,
			&PatchProjectArtifactRequest{Stage: ptrInt32(4)}, "")
		if !res.NeedsLifecycleUpdate || res.Lifecycle == nil || *res.Lifecycle != "S4" {
			t.Errorf("external-linked artifact must reverse update: %+v", res)
		}
	})
}
