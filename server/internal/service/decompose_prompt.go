// PM plan + 拆解提示词（spec: 2026-09-04-requirement-calendar-design.md §8 PM 行 +
// 2026-09-06 全模块动线 B4 · S2）：stage 2 只做需求理解与拆解，确认门通过后才
// 批量落执行子任务。本模板必须压过通用 coding-agent 身份——班底 PM 经常就是
// 同一套 coding runtime，否则会把「分析需求」做成「直接开工」。
package service

import (
	"fmt"
	"strings"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// DecomposeBriefRole 是写入 PM 简报的班底一行（只读投影，供指派候选）。
type DecomposeBriefRole struct {
	Role         string
	Enabled      bool
	AssigneeType string
	AssigneeID   string
}

// DecomposeBriefInput 是 AssembleDecomposeBrief 的入参。
type DecomposeBriefInput struct {
	Requirement   db.Issue
	Identifier    string
	ParentID      string
	RepoLabel     string
	PrototypePath string
	Roster        []DecomposeBriefRole
	// Playbook 为零值时回落内置 PM 标准；自定义字段覆盖对应段。
	Playbook RolePlaybook
}

// AssembleDecomposeBrief 组装 stage=2 PM 子任务的任务负载。
// 固定段：角色禁令 / 父需求投递地址 / 需求 / 目标 / 仓库 / 原型 / 班底 /
// 分析步骤 / 产出约定。可选段缺失时整段省略（仓库、原型、空班底）。
func AssembleDecomposeBrief(in DecomposeBriefInput) string {
	var b strings.Builder
	issue := in.Requirement
	playbook := ResolveRolePlaybook("pm", in.Playbook)
	if block := FormatRolePlaybookBlock(playbook); block != "" {
		b.WriteString(block)
		b.WriteString("\n")
	}

	b.WriteString("# 角色：项目 PM（本轮只做需求理解与拆解，禁止开工）\n\n")
	b.WriteString("你当前被指派的是 stage=2「PM plan + 拆解」子任务，**不是**研发执行任务。")
	b.WriteString("即便你平时是 coding agent，本轮也必须按项目 PM 工作：")
	b.WriteString("先从需求理解视角把「要做什么 / 不做什么 / 如何拆」写清楚，")
	b.WriteString("**不得**改业务代码、**不得**开 PR、**不得**用 `multica issue create` 创建会立刻派发的执行子任务。")
	b.WriteString("执行子任务只由人工（或全自动模式的确认门）批量落库。\n")

	b.WriteString("\n## 本需求（评论必须发到这里）\n")
	if in.Identifier != "" {
		fmt.Fprintf(&b, "- 标识：%s\n", in.Identifier)
	}
	if in.ParentID != "" {
		fmt.Fprintf(&b, "- issue_id：%s\n", in.ParentID)
		fmt.Fprintf(&b, "- 投递：`multica issue comment add %s`（把 plan 文件作为非 inline content）\n", in.ParentID)
	}
	b.WriteString("禁止把 plan 只写在本子任务评论里当作交付——父需求读不到就不能进入拆解确认。\n")

	b.WriteString("\n## 需求\n")
	b.WriteString(issue.Title)
	if issue.Description.Valid && strings.TrimSpace(issue.Description.String) != "" {
		b.WriteString("\n\n")
		b.WriteString(strings.TrimSpace(issue.Description.String))
	}

	if issue.Goal.Valid && strings.TrimSpace(issue.Goal.String) != "" {
		b.WriteString("\n\n## 目标\n")
		b.WriteString(strings.TrimSpace(issue.Goal.String))
		b.WriteString("\n\n目标是后续拆解与验收的共同基准。未覆盖的目标必须落入某个子任务，或在风险里写明为何本轮不做。")
	}

	if in.RepoLabel != "" {
		fmt.Fprintf(&b, "\n\n## 仓库\n%s\n先从模块 / 目录 / 调用关系理解现状，再决定拆哪些子任务；不要一上来改代码。", in.RepoLabel)
	}
	if in.PrototypePath != "" {
		fmt.Fprintf(&b, "\n\n## 已确认原型\n%s\n对照原型实现细节拆功能点；原型未覆盖的目标转本阶段关注。", in.PrototypePath)
	}

	enabled := make([]DecomposeBriefRole, 0, len(in.Roster))
	for _, r := range in.Roster {
		if r.Enabled {
			enabled = append(enabled, r)
		}
	}
	if len(enabled) > 0 {
		b.WriteString("\n\n## 班底（指派只能从这里选）\n")
		for _, r := range enabled {
			fmt.Fprintf(&b, "- %s · %s %s\n", r.Role, r.AssigneeType, r.AssigneeID)
		}
		b.WriteString("执行草稿的 assignee_role 只能是 developer / data / tester，且对应角色必须已启用。")
	}

	b.WriteString("\n\n## 工作步骤（必须按序，缺一不可）\n")
	b.WriteString("1. **读需求**：标题、描述、目标、父需求评论、已确认原型。先写清：用户要什么、成功标准、明确不做的范围。\n")
	b.WriteString("2. **对照仓库做影响面分析**：有 GitNexus 时用 `/graph`、`/by-file`、`/impact-analysis`；没有图谱就基于目录/模块说明，并在 graph_context 标明档案未就绪。\n")
	b.WriteString("3. **先出 PM plan，再拆子任务**。plan 必须含三个二级标题：`## 目标分解`、`## 阶段`、`## 风险`。\n")
	b.WriteString("4. **再写子任务草稿**：每个执行草稿必须标功能点 kind（new|modify）、代码对象、图谱影响面、代码化验收标准、assignee_role、depends_on。\n")
	b.WriteString("5. **自动挂一条 stage=4 验收草稿**（tester；班底停用测试则回落 pm）。\n")

	b.WriteString("\n## 禁止\n")
	b.WriteString("- 修改业务代码、提交、开 PR、跑与拆解无关的重构\n")
	b.WriteString("- `multica issue create`（`--status todo` 会立刻派研发开工；确认门才会批量落库）\n")
	b.WriteString("- 把本阶段当成实现任务「先干起来再补 plan」\n")
	b.WriteString("- 目标/范围未写清就产出草稿\n")

	b.WriteString("\n## 产出约定\n")
	b.WriteString("本轮唯一成功标准：在**父需求**发表一条评论，正文为 markdown plan")
	b.WriteString("（必须含 `## 目标分解` / `## 阶段` / `## 风险`），")
	b.WriteString("末尾必须附 ```decomposition-drafts 围栏 JSON 数组。")
	b.WriteString("没有这段围栏 = 拆解失败，禁止改业务文件、禁止写评估结论、禁止把本子任务当执行任务做完。\n")
	b.WriteString("每个草稿含 temp_id/title/description/stage（3=执行，4=验收）/")
	b.WriteString("assignee_role（developer|data|tester）/")
	b.WriteString("feature_points（kind: new|modify + title + code_objects）/")
	b.WriteString("graph_context/acceptance_spec/depends_on（同批 temp_id）。\n")
	b.WriteString("形状必须如下（按需求改内容，不要改围栏名）：\n\n")
	b.WriteString("```decomposition-drafts\n")
	b.WriteString("[\n")
	b.WriteString("  {\n")
	b.WriteString("    \"temp_id\": \"t1\",\n")
	b.WriteString("    \"title\": \"评估本地对象模块数据模型\",\n")
	b.WriteString("    \"stage\": 3,\n")
	b.WriteString("    \"assignee_role\": \"developer\",\n")
	b.WriteString("    \"feature_points\": [\n")
	b.WriteString("      {\"title\": \"出具达标评估结论\", \"kind\": \"modify\", \"code_objects\": []}\n")
	b.WriteString("    ],\n")
	b.WriteString("    \"graph_context\": {\"nodes\": [], \"code_objects\": []},\n")
	b.WriteString("    \"acceptance_spec\": {\"version\": 1, \"cases\": [{\"name\": \"结论可复核\", \"given\": \"仓库现状\", \"when\": \"阅读评估产物\", \"then\": \"有达标/不达标结论与证据\"}]}\n")
	b.WriteString("  },\n")
	b.WriteString("  {\n")
	b.WriteString("    \"temp_id\": \"t-accept\",\n")
	b.WriteString("    \"title\": \"验收评估结论\",\n")
	b.WriteString("    \"stage\": 4,\n")
	b.WriteString("    \"depends_on\": [\"t1\"]\n")
	b.WriteString("  }\n")
	b.WriteString("]\n")
	b.WriteString("```\n\n")
	b.WriteString("发完父需求评论后，把**本子任务**标为 in_review 结束本轮，不要继续实现。")
	return b.String()
}
