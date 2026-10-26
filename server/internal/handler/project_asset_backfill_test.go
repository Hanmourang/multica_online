package handler

import "testing"

// 存量推断新五阶段规则（plan §4.6）：只填空、按更具体优先顺序匹配，
// S5 仅明确命中 iteration/迭代 才推断，需求泛词不误伤。
func TestInferAssetStageRole(t *testing.T) {
	cases := []struct {
		name      string
		tags      []string
		assetName string
		relPath   string
		wantStage string
		wantRole  string
	}{
		{
			name: "prototype html is S2 output",
			tags: []string{"prototype"}, assetName: "pseudocode-split-view",
			relPath:   "docs/prototypes/pseudocode-split-view.html",
			wantStage: "S2", wantRole: "output",
		},
		{
			name: "prd is S1 input",
			tags: []string{"prd"}, assetName: "订单 PRD",
			relPath:   "specs/prd.md",
			wantStage: "S1", wantRole: "input",
		},
		{
			name: "architecture design is S3 output",
			tags: []string{"架构"}, assetName: "知识图谱技术方案",
			relPath:   "docs/architecture.md",
			wantStage: "S3", wantRole: "output",
		},
		{
			name: "retrospective is S4 output",
			tags: []string{"复盘"}, assetName: "线上故障复盘",
			relPath:   "docs/postmortem.md",
			wantStage: "S4", wantRole: "output",
		},
		{
			name: "iteration is S5 output",
			tags: []string{"迭代"}, assetName: "版本迭代路线图",
			relPath:   "docs/iteration.md",
			wantStage: "S5", wantRole: "output",
		},
		{
			name: "requirement keyword does not misfire iteration to S1",
			tags: []string{"requirement", "需求"}, assetName: "需求迭代评审",
			relPath:   "docs/requirement.md",
			wantStage: "S5", wantRole: "input",
		},
		{
			name: "acceptance keyword no longer infers S4",
			tags: nil, assetName: "上线验收清单",
			relPath:   "qa/acceptance.md",
			wantStage: "", wantRole: "output",
		},
		{
			name: "no keyword keeps untagged stage but defaults output",
			tags: nil, assetName: "PROJECT", relPath: "PROJECT.md",
			wantStage: "", wantRole: "output",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stage, role := inferAssetStageRole(tc.tags, tc.assetName, tc.relPath)
			if stage != tc.wantStage {
				t.Errorf("stage = %q, want %q", stage, tc.wantStage)
			}
			if role != tc.wantRole {
				t.Errorf("role = %q, want %q", role, tc.wantRole)
			}
		})
	}
}
