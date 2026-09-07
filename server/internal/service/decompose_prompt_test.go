package service

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func decomposeIssue() db.Issue {
	return db.Issue{
		Title:       "数据模型分析",
		Description: pgtype.Text{String: "梳理需求说明数据框架下的模块，并给出文档。", Valid: true},
		Goal:        pgtype.Text{String: "把积分规则引擎化", Valid: true},
	}
}

func TestAssembleDecomposeBrief(t *testing.T) {
	brief := AssembleDecomposeBrief(DecomposeBriefInput{
		Requirement:   decomposeIssue(),
		Identifier:    "TASK-2",
		ParentID:      "parent-uuid",
		RepoLabel:     "multica/app",
		PrototypePath: "docs/prototypes/TASK-2.html",
		Roster: []DecomposeBriefRole{
			{Role: "pm", Enabled: true, AssigneeType: "agent", AssigneeID: "pm-1"},
			{Role: "developer", Enabled: true, AssigneeType: "agent", AssigneeID: "dev-1"},
			{Role: "tester", Enabled: false, AssigneeType: "agent", AssigneeID: "qa-1"},
		},
	})

	for _, seg := range []string{
		"角色执行标准",
		"项目 PM",
		"禁止开工",
		"TASK-2",
		"parent-uuid",
		"multica issue comment add parent-uuid",
		"数据模型分析",
		"把积分规则引擎化",
		"multica/app",
		"docs/prototypes/TASK-2.html",
		"pm · agent pm-1",
		"developer · agent dev-1",
		"## 目标分解",
		"## 阶段",
		"## 风险",
		"decomposition-drafts",
		"\"temp_id\": \"t1\"",
		"没有这段围栏 = 拆解失败",
		"multica issue create",
		"in_review",
	} {
		if !strings.Contains(brief, seg) {
			t.Fatalf("brief missing %q:\n%s", seg, brief)
		}
	}
	if strings.Contains(brief, "tester · agent qa-1") {
		t.Fatalf("disabled roster role must be omitted:\n%s", brief)
	}
}

func TestAssembleDecomposeBriefOmitsOptionalSections(t *testing.T) {
	brief := AssembleDecomposeBrief(DecomposeBriefInput{
		Requirement: db.Issue{Title: "仅标题"},
	})
	if !strings.Contains(brief, "仅标题") {
		t.Fatalf("brief missing title:\n%s", brief)
	}
	for _, forbidden := range []string{"## 目标\n", "## 仓库", "## 已确认原型", "## 班底"} {
		if strings.Contains(brief, forbidden) {
			t.Fatalf("empty optional section %q should be omitted:\n%s", forbidden, brief)
		}
	}
}
