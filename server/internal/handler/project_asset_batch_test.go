package handler

import "testing"

func strp(s string) *string { return &s }

func TestPlanBatchAssetMeta(t *testing.T) {
	t.Run("valid stage/role/category/tags", func(t *testing.T) {
		plan, errMsg := planBatchAssetMeta(batchUpdateAssetMetaRequest{
			LifecycleStage: strp("S2"),
			AssetRole:      strp("input"),
			AssetCategory:  strp("knowledge_repo"),
			Tags:           &[]string{"prd", " prd ", "调研"},
			TagsMode:       "add",
		})
		if errMsg != "" {
			t.Fatalf("unexpected err: %q", errMsg)
		}
		if !plan.hasStage || plan.setStage.String != "S2" || !plan.setStage.Valid {
			t.Errorf("stage plan wrong: %+v", plan.setStage)
		}
		if !plan.hasRole || plan.setRole.String != "input" {
			t.Errorf("role plan wrong: %+v", plan.setRole)
		}
		if !plan.hasCategory || plan.setCategory != "knowledge_repo" {
			t.Errorf("category plan wrong: %q", plan.setCategory)
		}
		// tags normalized: dedup + trim → ["prd","调研"]
		if !plan.hasTags || plan.tagsMode != "add" || len(plan.setTags) != 2 {
			t.Errorf("tags plan wrong: mode=%q tags=%v", plan.tagsMode, plan.setTags)
		}
		if !plan.hasAnyUpdate() {
			t.Error("hasAnyUpdate should be true")
		}
	})

	t.Run("empty stage clears (Valid=false)", func(t *testing.T) {
		plan, errMsg := planBatchAssetMeta(batchUpdateAssetMetaRequest{LifecycleStage: strp("")})
		if errMsg != "" {
			t.Fatalf("unexpected err: %q", errMsg)
		}
		if !plan.hasStage || plan.setStage.Valid {
			t.Errorf("clear stage should set hasStage with NULL text, got %+v", plan.setStage)
		}
	})

	t.Run("invalid enum rejected", func(t *testing.T) {
		if _, errMsg := planBatchAssetMeta(batchUpdateAssetMetaRequest{LifecycleStage: strp("S9")}); errMsg == "" {
			t.Error("expected error for invalid stage")
		}
		if _, errMsg := planBatchAssetMeta(batchUpdateAssetMetaRequest{AssetRole: strp("maybe")}); errMsg == "" {
			t.Error("expected error for invalid role")
		}
	})

	t.Run("category empty string invalid (NOT NULL)", func(t *testing.T) {
		if _, errMsg := planBatchAssetMeta(batchUpdateAssetMetaRequest{AssetCategory: strp("")}); errMsg == "" {
			t.Error("expected error for empty category")
		}
	})

	t.Run("invalid tags mode rejected", func(t *testing.T) {
		if _, errMsg := planBatchAssetMeta(batchUpdateAssetMetaRequest{
			Tags: &[]string{"a"}, TagsMode: "merge",
		}); errMsg == "" {
			t.Error("expected error for invalid tags_mode")
		}
	})

	t.Run("empty request has no update", func(t *testing.T) {
		plan, errMsg := planBatchAssetMeta(batchUpdateAssetMetaRequest{})
		if errMsg != "" {
			t.Fatalf("unexpected err: %q", errMsg)
		}
		if plan.hasAnyUpdate() {
			t.Error("empty plan should have no update")
		}
	})
}
