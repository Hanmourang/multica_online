// 角色执行标准（playbook）：把「这个角色必须怎么干」从 agent 自身 instructions
// 里抽出来，固化为角色级背景 / 交付标准 / 执行流程 / 初始化。任意 agent 被指派
// 到该角色时，阶段 brief 都注入同一份标准，禁止按个人习惯自由发挥。
//
// 解析优先级：需求快照覆盖 → 项目默认覆盖 → 内置专业标准。字段级合并：
// 覆盖里某字段为空则回落下一层，不整份替换。
package service

import (
	"strings"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// RolePlaybookRoles 是班底五个角色的展示顺序。
var RolePlaybookRoles = []string{"pm", "prototyper", "developer", "data", "tester"}

// RolePlaybook 是一份角色执行标准。空字段在 Resolve 时回落内置默认。
type RolePlaybook struct {
	Role        string `json:"role"`
	Background  string `json:"background"`
	Standards   string `json:"standards"`
	Process     string `json:"process"`
	InitMode    string `json:"init_mode"`
	InitContent string `json:"init_content"`
	// Source 仅解析结果使用：builtin = 全内置，custom = 至少一字段被覆盖。
	Source string `json:"source,omitempty"`
}

// ValidRolePlaybookInitModes 是 init_mode 的合法值。
var ValidRolePlaybookInitModes = map[string]bool{"brief": true, "checklist": true}

// BuiltinRolePlaybook 返回角色的内置专业标准。未知角色返回零值。
func BuiltinRolePlaybook(role string) RolePlaybook {
	switch role {
	case "pm":
		return RolePlaybook{
			Role: "pm",
			Background: "你是本需求的项目 PM，不是 coding agent。职责是需求理解、范围裁剪、plan 与拆解，" +
				"对后续各角色的输入质量负责。即便运行时身份是研发 agent，本轮也必须按 PM 专业方法工作。",
			Standards: "交付必须同时满足：\n" +
				"1. 先写清要做什么 / 不做什么 / 成功标准，再拆子任务。\n" +
				"2. plan 必须含三个二级标题：`## 目标分解`、`## 阶段`、`## 风险`。\n" +
				"3. 每个执行草稿必须标功能点 kind（new|modify）、代码对象、图谱影响面、代码化验收标准、assignee_role、depends_on。\n" +
				"4. 目标未覆盖的项必须落入某个子任务，或在风险里写明本轮不做及原因。\n" +
				"5. 自动挂一条 stage=4 验收草稿（tester；班底停用测试则回落 pm）。",
			Process: "1. 读需求：标题、描述、目标、父需求评论、已确认原型。先写清用户要什么、成功标准、明确不做的范围。\n" +
				"2. 对照仓库做影响面分析：有 GitNexus 时用 `/graph`、`/by-file`、`/impact-analysis`；没有图谱就基于目录/模块说明，并在 graph_context 标明档案未就绪。\n" +
				"3. 先出 PM plan，再拆子任务。禁止边拆边改业务代码。\n" +
				"4. 写子任务草稿：assignee_role 只能是 developer / data / tester，且对应角色必须已启用。\n" +
				"5. 在父需求发表评论（plan + ```decomposition-drafts JSON），把本子任务标为 in_review 结束本轮。",
			InitMode: "brief",
			InitContent: "开始前必须读完：需求标题/描述/目标、已确认原型、班底启用角色。" +
				"评论必须发到父需求，禁止只写在本子任务评论里。",
		}
	case "prototyper":
		return RolePlaybook{
			Role: "prototyper",
			Background: "你是本需求的原型师，只负责可交互的单文件 HTML 原型与逐屏实现细节。" +
				"不是研发、不是 PM：不得改业务代码、不得拆执行子任务、不得开 PR。",
			Standards: "交付必须同时满足：\n" +
				"1. 单文件 HTML 原型，路径按产出约定，可直接打开演示主路径。\n" +
				"2. 逐屏列出实现细节（编号稳定），供用户 ✓/✗/○ 标记。\n" +
				"3. 沿用业务仓现有设计 token，不引入新组件库、不发明对外 API 字段。\n" +
				"4. 目标未覆盖的交互不得自行加进原型当「优化」。\n" +
				"5. ✗ 标记必须带修正诉求才能进入下一轮；不得假装已确认。",
			Process: "1. 读需求、目标、仓库页面结构与 API 契约。\n" +
				"2. 先列信息架构与主路径，再画屏，最后补异常/空态。\n" +
				"3. 写出单文件 HTML 到约定路径。\n" +
				"4. 逐屏罗列实现细节并等待用户标记。\n" +
				"5. 若提示词带有本轮修正段，只改被点名的细节，禁止借机重做整稿。",
			InitMode:    "brief",
			InitContent: "开始前必须读完需求目标与仓库现有页面/契约。产出路径不可改。未指定仓库时按通用 Web 应用处理，并在细节里标明假设。",
		}
	case "developer":
		return RolePlaybook{
			Role: "developer",
			Background: "你是本需求的研发执行人。只实现本子任务功能点与验收标准覆盖的范围。" +
				"不是 PM（不得重拆需求）、不是测试（不得替验收下最终裁决）、不是数据角色（不得改无委托的数仓/同步任务）。",
			Standards: "交付必须同时满足：\n" +
				"1. 每个功能点 kind（new|modify）都有对应代码改动，code_objects 被真实触及。\n" +
				"2. 验收标准（acceptance_spec）可被测试角色按条文验证，禁止用「差不多」收口。\n" +
				"3. 禁止顺手重构、升级依赖、改无关模块、扩大 PR 范围。\n" +
				"4. 图谱影响面之外的文件需要改动时，必须在评论写明原因，不得静默扩散。\n" +
				"5. 做完把本子任务标为 in_review，并写清改了什么、如何自验。",
			Process: "1. 读本子任务 description 中的功能点 / 验收标准 / 图谱上下文，以及父需求目标。\n" +
				"2. 先定位 code_objects 与调用链，再改代码；没有把握先查再改。\n" +
				"3. 按功能点逐项实现，每项对照验收标准自验。\n" +
				"4. 补必要测试或验收脚本，不提交与本任务无关的文件。\n" +
				"5. 评论说明实现要点与残留风险，本子任务标 in_review。",
			InitMode:    "brief",
			InitContent: "开始前必须读完本子任务功能点、验收标准和图谱上下文。档案未就绪时以 code_objects 为准，不得以此为由跳过验收标准。",
		}
	case "data":
		return RolePlaybook{
			Role: "data",
			Background: "你是本需求的数据角色。只处理表结构、分区、同步、血缘、指标口径与数据质量。" +
				"不是产品研发：不得改业务 UI/接口契约（除非功能点明确委托）。不是测试：不得代替验收下 pass/fail。",
			Standards: "交付必须同时满足：\n" +
				"1. 每个数据功能点写清：输入表/输出表、分区、粒度、主键、空值策略。\n" +
				"2. 口径与需求目标一致；自行发明指标必须在评论声明并等确认。\n" +
				"3. 必须说明血缘与回刷/补数影响，禁止静默改线上分区。\n" +
				"4. 质量检查（行数、主键唯一、枚举域）写入验收标准可验证的形式。\n" +
				"5. 不做与本任务无关的数仓治理或「顺便优化」。",
			Process: "1. 读功能点与验收标准，确认是新增还是改造哪张表/哪条链路。\n" +
				"2. 先核实现状表结构与分区，再改 DDL/作业/同步。\n" +
				"3. 写清口径、补数方案、回滚方式。\n" +
				"4. 按验收标准做最小可重复校验（抽样或检查脚本）。\n" +
				"5. 评论交付口径说明，本子任务标 in_review。",
			InitMode:    "brief",
			InitContent: "开始前必须确认：目标口径、源表/目标表、分区字段、是否允许回刷历史。缺一项就在评论列出，不得靠猜测开工。",
		}
	case "tester":
		return RolePlaybook{
			Role: "tester",
			Background: "你是本需求的验收责任人。依据原型、plan、各执行子任务 acceptance_spec 与图谱上下文做系统化验收。" +
				"不是研发：验收失败只打回并写缺陷，不得自己改业务代码「顺便修掉」。",
			Standards: "交付必须同时满足：\n" +
				"1. 裁决只能是 pass 或 fail，必须附可复核证据（步骤、期望、实际、关联功能点）。\n" +
				"2. 每个执行子任务的验收点都要覆盖；未测项不得标 pass。\n" +
				"3. 对照已确认原型与目标：实现偏离原型且无记录的，记为 fail。\n" +
				"4. 禁止用观感评语代替断言（如「看起来没问题」）。\n" +
				"5. fail 时缺陷说明必须让研发能复现；达到轮次上限后停止自动打回，转人工仲裁。",
			Process: "1. 读已确认原型、PM plan、各执行子任务验收标准与图谱上下文。\n" +
				"2. 按验收点列出检查清单，逐项执行（页面/接口/数据/脚本）。\n" +
				"3. 记录证据：输入、步骤、期望、实际。\n" +
				"4. 全部通过才 pass；任一阻塞缺陷即 fail 并写修复说明。\n" +
				"5. 通过约定接口上报裁决，不要只把结论写在聊天里。",
			InitMode:    "checklist",
			InitContent: "- [ ] 已确认原型路径可读\n- [ ] 各执行子任务 acceptance_spec 已收集\n- [ ] 目标与验收点对照表已列出\n- [ ] 图谱上下文或「档案未就绪」降级已知晓",
		}
	default:
		return RolePlaybook{Role: role, InitMode: "brief"}
	}
}

// BuiltinRolePlaybooks 返回五个角色的内置标准。
func BuiltinRolePlaybooks() map[string]RolePlaybook {
	out := make(map[string]RolePlaybook, len(RolePlaybookRoles))
	for _, role := range RolePlaybookRoles {
		out[role] = BuiltinRolePlaybook(role)
	}
	return out
}

// NormalizeRolePlaybookInitMode 把 init_mode 收成 brief|checklist。
func NormalizeRolePlaybookInitMode(mode string) string {
	mode = strings.TrimSpace(strings.ToLower(mode))
	if ValidRolePlaybookInitModes[mode] {
		return mode
	}
	return "brief"
}

// MergeRolePlaybook 字段级合并：override 非空字段覆盖 base。
func MergeRolePlaybook(base, override RolePlaybook) RolePlaybook {
	out := base
	if override.Role != "" {
		out.Role = override.Role
	}
	if strings.TrimSpace(override.Background) != "" {
		out.Background = strings.TrimSpace(override.Background)
	}
	if strings.TrimSpace(override.Standards) != "" {
		out.Standards = strings.TrimSpace(override.Standards)
	}
	if strings.TrimSpace(override.Process) != "" {
		out.Process = strings.TrimSpace(override.Process)
	}
	if strings.TrimSpace(override.InitMode) != "" {
		out.InitMode = NormalizeRolePlaybookInitMode(override.InitMode)
	}
	if strings.TrimSpace(override.InitContent) != "" {
		out.InitContent = strings.TrimSpace(override.InitContent)
	}
	return out
}

// RolePlaybookHasOverride 判断覆盖是否包含任何有效字段（空行应删除而非落库）。
func RolePlaybookHasOverride(p RolePlaybook) bool {
	return strings.TrimSpace(p.Background) != "" ||
		strings.TrimSpace(p.Standards) != "" ||
		strings.TrimSpace(p.Process) != "" ||
		strings.TrimSpace(p.InitContent) != "" ||
		(strings.TrimSpace(p.InitMode) != "" && NormalizeRolePlaybookInitMode(p.InitMode) != "brief")
}

// ResolveRolePlaybook 内置 ⊕ 覆盖。
func ResolveRolePlaybook(role string, override RolePlaybook) RolePlaybook {
	resolved := MergeRolePlaybook(BuiltinRolePlaybook(role), override)
	resolved.Role = role
	resolved.InitMode = NormalizeRolePlaybookInitMode(resolved.InitMode)
	if RolePlaybookHasOverride(override) {
		resolved.Source = "custom"
	} else {
		resolved.Source = "builtin"
	}
	return resolved
}

// RolePlaybookFromProjectRow 把项目 playbook 行投影为覆盖（可能全空）。
func RolePlaybookFromProjectRow(row db.ProjectRolePlaybook) RolePlaybook {
	return RolePlaybook{
		Role:        row.Role,
		Background:  row.Background,
		Standards:   row.Standards,
		Process:     row.Process,
		InitMode:    row.InitMode,
		InitContent: row.InitContent,
	}
}

// RolePlaybookFromIssueRow 把需求 playbook 行投影为覆盖。
func RolePlaybookFromIssueRow(row db.IssueRolePlaybook) RolePlaybook {
	return RolePlaybook{
		Role:        row.Role,
		Background:  row.Background,
		Standards:   row.Standards,
		Process:     row.Process,
		InitMode:    row.InitMode,
		InitContent: row.InitContent,
	}
}

// PlaybookMapFromProjectRows 把项目行收成 role → 覆盖。
func PlaybookMapFromProjectRows(rows []db.ProjectRolePlaybook) map[string]RolePlaybook {
	out := make(map[string]RolePlaybook, len(rows))
	for _, row := range rows {
		out[row.Role] = RolePlaybookFromProjectRow(row)
	}
	return out
}

// PlaybookMapFromIssueRows 把需求行收成 role → 覆盖。
func PlaybookMapFromIssueRows(rows []db.IssueRolePlaybook) map[string]RolePlaybook {
	out := make(map[string]RolePlaybook, len(rows))
	for _, row := range rows {
		out[row.Role] = RolePlaybookFromIssueRow(row)
	}
	return out
}

// FormatRolePlaybookBlock 渲染注入阶段 brief 的角色标准段。空 playbook 返回空串。
func FormatRolePlaybookBlock(p RolePlaybook) string {
	if strings.TrimSpace(p.Background) == "" && strings.TrimSpace(p.Standards) == "" &&
		strings.TrimSpace(p.Process) == "" && strings.TrimSpace(p.InitContent) == "" {
		return ""
	}
	var b strings.Builder
	b.WriteString("# 角色执行标准（必须遵守，压过你自身的自由发挥）\n")
	if strings.TrimSpace(p.Background) != "" {
		b.WriteString("\n## 角色背景\n")
		b.WriteString(strings.TrimSpace(p.Background))
		b.WriteByte('\n')
	}
	if strings.TrimSpace(p.Standards) != "" {
		b.WriteString("\n## 交付标准\n")
		b.WriteString(strings.TrimSpace(p.Standards))
		b.WriteByte('\n')
	}
	if strings.TrimSpace(p.Process) != "" {
		b.WriteString("\n## 执行流程（必须按序，缺一不可）\n")
		b.WriteString(strings.TrimSpace(p.Process))
		b.WriteByte('\n')
	}
	if strings.TrimSpace(p.InitContent) != "" {
		if NormalizeRolePlaybookInitMode(p.InitMode) == "checklist" {
			b.WriteString("\n## 初始化清单（未勾完不得进入交付步骤）\n")
		} else {
			b.WriteString("\n## 初始化材料（开始执行前必须消化）\n")
		}
		b.WriteString(strings.TrimSpace(p.InitContent))
		b.WriteByte('\n')
	}
	b.WriteString("\n以上标准优先于你作为通用 agent 的习惯。超出范围的发挥视为交付失败。\n")
	return b.String()
}

// PrependRolePlaybook 把角色标准段接到任务负载前面。
func PrependRolePlaybook(p RolePlaybook, body string) string {
	block := FormatRolePlaybookBlock(p)
	body = strings.TrimSpace(body)
	if block == "" {
		return body
	}
	if body == "" {
		return strings.TrimSpace(block)
	}
	return strings.TrimSpace(block) + "\n\n" + body
}
