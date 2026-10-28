package service

import (
	"math"
	"testing"
)

func specOf(features ...ModuleSpecFeature) ModuleSpec {
	return ModuleSpec{Schema: "module_spec/v1", Features: features}
}

func feature(code, title, kind string) ModuleSpecFeature {
	return ModuleSpecFeature{Code: code, Title: title, Kind: kind}
}

func protoOf(anchors map[string]ProtoAnchor) ParsedPrototype {
	return ParsedPrototype{Anchors: anchors}
}

func stateByCode(rows []ReconcileRow, code string) (ReconcileState, bool) {
	for _, r := range rows {
		if r.Code == code {
			return r.State, true
		}
	}
	return "", false
}

func TestReconcile(t *testing.T) {
	cases := []struct {
		name      string
		spec      ModuleSpec
		proto     ParsedPrototype
		decisions map[string]Decision
		wantState map[string]ReconcileState
		wantCov   Coverage
	}{
		{
			name: "all_covered",
			spec: specOf(feature("FP-1", "申报清单列表", "core"), feature("FP-2", "新建申报", "core")),
			proto: protoOf(map[string]ProtoAnchor{
				"FP-1": {Count: 2, Title: "申报清单列表"},
				"FP-2": {Count: 1, Title: "新建申报"},
			}),
			wantState: map[string]ReconcileState{"FP-1": StateCovered, "FP-2": StateCovered},
			wantCov:   Coverage{Total: 2, Covered: 2, Denominator: 2, Rate: 1.0},
		},
		{
			name: "changed_title_drift",
			spec: specOf(feature("FP-1", "新建申报", "core"), feature("FP-2", "批量导出", "edge")),
			proto: protoOf(map[string]ProtoAnchor{
				"FP-1": {Count: 1, Title: "新建 申报"}, // 规范化后仍不等 → changed
				"FP-2": {Count: 1, Title: "批量导出"},
			}),
			wantState: map[string]ReconcileState{"FP-1": StateChanged, "FP-2": StateCovered},
			wantCov:   Coverage{Total: 2, Covered: 1, Changed: 1, Denominator: 2, Rate: 0.5},
		},
		{
			name:      "missing_spec_has_proto_without",
			spec:      specOf(feature("FP-1", "申报状态筛选", "edge"), feature("FP-2", "撤回申报", "core")),
			proto:     protoOf(map[string]ProtoAnchor{"FP-2": {Count: 1, Title: "撤回申报"}}),
			wantState: map[string]ReconcileState{"FP-1": StateMissing, "FP-2": StateCovered},
			wantCov:   Coverage{Total: 2, Covered: 1, Missing: 1, Denominator: 2, Rate: 0.5},
		},
		{
			name:      "unregistered_proto_has_spec_without",
			spec:      specOf(feature("FP-1", "申报清单列表", "core")),
			proto:     protoOf(map[string]ProtoAnchor{"FP-1": {Count: 1, Title: "申报清单列表"}, "FP-9": {Count: 3, Title: "隐藏调试面板"}}),
			wantState: map[string]ReconcileState{"FP-1": StateCovered, "FP-9": StateUnregistered},
			wantCov:   Coverage{Total: 1, Covered: 1, Unregistered: 1, Denominator: 1, Rate: 1.0},
		},
		{
			name:      "deprecated_excluded_from_denominator",
			spec:      specOf(feature("FP-1", "旧版导入", "edge"), feature("FP-2", "新建申报", "core")),
			proto:     protoOf(map[string]ProtoAnchor{"FP-2": {Count: 1, Title: "新建申报"}}),
			decisions: map[string]Decision{"FP-1": DecisionDeprecate},
			wantState: map[string]ReconcileState{"FP-1": StateDeprecated, "FP-2": StateCovered},
			wantCov:   Coverage{Total: 2, Covered: 1, Deprecated: 1, Denominator: 1, Rate: 1.0},
		},
		{
			name: "mixed_all_five_states",
			spec: specOf(
				feature("FP-1", "申报清单列表", "core"),
				feature("FP-2", "新建申报", "core"),
				feature("FP-3", "批量导出", "edge"),
				feature("FP-4", "旧版导入", "edge"),
			),
			proto: protoOf(map[string]ProtoAnchor{
				"FP-1": {Count: 1, Title: "申报清单列表"},
				"FP-2": {Count: 1, Title: "新建 申报"},
				"FP-5": {Count: 2, Title: "实验性功能"},
			}),
			decisions: map[string]Decision{"FP-4": DecisionDeprecate},
			wantState: map[string]ReconcileState{
				"FP-1": StateCovered, "FP-2": StateChanged, "FP-3": StateMissing,
				"FP-4": StateDeprecated, "FP-5": StateUnregistered,
			},
			wantCov: Coverage{Total: 4, Covered: 1, Changed: 1, Missing: 1, Unregistered: 1, Deprecated: 1, Denominator: 3, Rate: 1.0 / 3.0},
		},
		{
			name:      "empty_spec_all_unregistered",
			spec:      specOf(),
			proto:     protoOf(map[string]ProtoAnchor{"FP-1": {Count: 1, Title: "任意原型"}}),
			wantState: map[string]ReconcileState{"FP-1": StateUnregistered},
			wantCov:   Coverage{Total: 0, Unregistered: 1, Denominator: 0, Rate: 0.0},
		},
		{
			name:      "empty_proto_all_missing",
			spec:      specOf(feature("FP-1", "申报清单列表", "core"), feature("FP-2", "新建申报", "core")),
			proto:     protoOf(nil),
			wantState: map[string]ReconcileState{"FP-1": StateMissing, "FP-2": StateMissing},
			wantCov:   Coverage{Total: 2, Missing: 2, Denominator: 2, Rate: 0.0},
		},
		{
			name:      "all_deprecated_zero_denominator",
			spec:      specOf(feature("FP-1", "旧A", "edge"), feature("FP-2", "旧B", "edge")),
			proto:     protoOf(nil),
			decisions: map[string]Decision{"FP-1": DecisionDeprecate, "FP-2": DecisionDeprecate},
			wantState: map[string]ReconcileState{"FP-1": StateDeprecated, "FP-2": StateDeprecated},
			wantCov:   Coverage{Total: 2, Deprecated: 2, Denominator: 0, Rate: 0.0},
		},
		{
			name:      "override_on_changed_not_counted_in_numerator",
			spec:      specOf(feature("FP-1", "新建申报", "core")),
			proto:     protoOf(map[string]ProtoAnchor{"FP-1": {Count: 1, Title: "新建 申报"}}),
			decisions: map[string]Decision{"FP-1": DecisionOverride},
			wantState: map[string]ReconcileState{"FP-1": StateChanged},
			wantCov:   Coverage{Total: 1, Changed: 1, Denominator: 1, Rate: 0.0},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rows, cov := Reconcile(tc.spec, tc.proto, tc.decisions)

			for code, want := range tc.wantState {
				got, ok := stateByCode(rows, code)
				if !ok {
					t.Fatalf("code %q: no row produced", code)
				}
				if got != want {
					t.Errorf("code %q: state = %q, want %q", code, got, want)
				}
			}
			if len(rows) != len(tc.wantState) {
				t.Errorf("row count = %d, want %d", len(rows), len(tc.wantState))
			}

			if cov.Total != tc.wantCov.Total {
				t.Errorf("cov.Total = %d, want %d", cov.Total, tc.wantCov.Total)
			}
			if cov.Covered != tc.wantCov.Covered {
				t.Errorf("cov.Covered = %d, want %d", cov.Covered, tc.wantCov.Covered)
			}
			if cov.Changed != tc.wantCov.Changed {
				t.Errorf("cov.Changed = %d, want %d", cov.Changed, tc.wantCov.Changed)
			}
			if cov.Missing != tc.wantCov.Missing {
				t.Errorf("cov.Missing = %d, want %d", cov.Missing, tc.wantCov.Missing)
			}
			if cov.Unregistered != tc.wantCov.Unregistered {
				t.Errorf("cov.Unregistered = %d, want %d", cov.Unregistered, tc.wantCov.Unregistered)
			}
			if cov.Deprecated != tc.wantCov.Deprecated {
				t.Errorf("cov.Deprecated = %d, want %d", cov.Deprecated, tc.wantCov.Deprecated)
			}
			if cov.Denominator != tc.wantCov.Denominator {
				t.Errorf("cov.Denominator = %d, want %d", cov.Denominator, tc.wantCov.Denominator)
			}
			if math.Abs(cov.Rate-tc.wantCov.Rate) > 1e-9 {
				t.Errorf("cov.Rate = %f, want %f", cov.Rate, tc.wantCov.Rate)
			}
		})
	}
}

func TestNormalizeTitle(t *testing.T) {
	cases := map[string]string{
		"新建申报":         "新建申报",
		"新建 申报":        "新建 申报",
		"  New Task  ": "new task",
		"A   B":        "a b",
	}
	for in, want := range cases {
		if got := normalizeTitle(in); got != want {
			t.Errorf("normalizeTitle(%q) = %q, want %q", in, got, want)
		}
	}
}
