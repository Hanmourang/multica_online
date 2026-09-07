// 拆解确认（spec: 2026-09-04-requirement-calendar-design.md §8/§9）：
// PM 的 stage 2 产出（plan 评论 + 子任务草稿）经确认后在本服务内批量生效：
// 单事务完成「校验 → 建 stage 3/4 子任务 → 依赖链写边 → 写
// decomposition_confirmed_at」。任一校验失败整体回滚，不留半成品。
//
// 与 IssueService.Create 的差异：确认生效的子任务**不**走 assignee 自动派发
// 管道——stage 3 的推进归触发 loop（spec §7.1）与模块互斥（§7.3）管，确认
// 时刻只落库。stage 4 验收子任务的执行人由服务端从班底取 tester（停用则
// 回落 pm），草稿无需指派。
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issueposition"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// ErrDecompositionAlreadyConfirmed 表示需求已确认过拆解（幂等重试）→ 409。
var ErrDecompositionAlreadyConfirmed = errors.New("decomposition already confirmed")

// DecompositionValidationError 是草稿内容错误（→ 400）。
type DecompositionValidationError struct{ Msg string }

func (e *DecompositionValidationError) Error() string { return e.Msg }

// DecompositionConflictError 是班底/依赖状态冲突（→ 409）。
type DecompositionConflictError struct{ Msg string }

func (e *DecompositionConflictError) Error() string { return e.Msg }

// DecomposeFeaturePoint 是功能点明细（spec §8：kind 必填，new=新增 / modify=改造）。
type DecomposeFeaturePoint struct {
	Title       string   `json:"title"`
	Kind        string   `json:"kind"`
	CodeObjects []string `json:"code_objects"`
	Detail      string   `json:"detail,omitempty"`
}

// DecomposeDraftTask 是一份待生效的子任务草稿。DependsOn 元素可以是同批草稿
// 的 TempID，也可以是已存在 issue 的 id（须与需求同模块）。
type DecomposeDraftTask struct {
	TempID         string
	Title          string
	Description    string
	Stage          int32 // 3=执行，4=验收
	AssigneeType   string
	AssigneeID     string
	FeaturePoints  []DecomposeFeaturePoint
	GraphContext   json.RawMessage
	AcceptanceSpec json.RawMessage
	DependsOn      []string
}

// ConfirmDecompositionParams 是 ConfirmDecomposition 的入参。Creator* 记录
// 确认操作者（通常为点击确认的 PM 成员）。
type ConfirmDecompositionParams struct {
	RequirementID pgtype.UUID
	Drafts        []DecomposeDraftTask
	CreatorType   string
	CreatorID     pgtype.UUID
}

type rosterEntry struct {
	enabled bool
	role    string
}

func rosterKeyOf(assigneeType string, assigneeID pgtype.UUID) string {
	return assigneeType + "/" + uuidString(assigneeID)
}

// ConfirmDecomposition 校验并批量生效子任务草稿，返回生效的子任务列表
// （按草稿顺序）。重复确认返回 ErrDecompositionAlreadyConfirmed。
func (s *IssueService) ConfirmDecomposition(ctx context.Context, p ConfirmDecompositionParams) ([]db.Issue, error) {
	if len(p.Drafts) == 0 {
		return nil, &DecompositionValidationError{Msg: "drafts required"}
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	qtx := s.Queries.WithTx(tx)

	req, err := qtx.GetIssue(ctx, p.RequirementID)
	if err != nil {
		return nil, fmt.Errorf("load requirement: %w", err)
	}
	if req.DecompositionConfirmedAt.Valid {
		return nil, ErrDecompositionAlreadyConfirmed
	}

	// ---- 校验（spec §9：功能点无 pending / 执行人在班底内且角色启用 / 依赖双方同 module）
	rosterRows, err := qtx.ListIssueRoleAssignments(ctx, p.RequirementID)
	if err != nil {
		return nil, fmt.Errorf("load roster: %w", err)
	}
	roster := map[string]rosterEntry{}
	for _, r := range rosterRows {
		roster[rosterKeyOf(r.AssigneeType, r.AssigneeID)] = rosterEntry{enabled: r.Enabled, role: r.Role}
	}

	tempIDs := map[string]bool{}
	for _, d := range p.Drafts {
		if d.TempID == "" {
			return nil, &DecompositionValidationError{Msg: "draft temp_id required"}
		}
		if tempIDs[d.TempID] {
			return nil, &DecompositionValidationError{Msg: "duplicate draft temp_id: " + d.TempID}
		}
		tempIDs[d.TempID] = true
	}

	externalDeps := map[string]bool{} // 引用已有 issue 的依赖（uuid 字符串集合）
	for _, d := range p.Drafts {
		if d.Title == "" {
			return nil, &DecompositionValidationError{Msg: "draft title required"}
		}
		if d.Stage != 3 && d.Stage != 4 {
			return nil, &DecompositionValidationError{Msg: fmt.Sprintf("draft %q stage must be 3 or 4", d.TempID)}
		}
		for _, fp := range d.FeaturePoints {
			if fp.Kind != "new" && fp.Kind != "modify" {
				return nil, &DecompositionValidationError{
					Msg: fmt.Sprintf("feature_point kind required (new|modify): draft %q point %q", d.TempID, fp.Title),
				}
			}
		}
		if d.Stage == 3 && len(d.FeaturePoints) == 0 {
			return nil, &DecompositionValidationError{Msg: "feature_point kind required: exec draft needs at least one feature point"}
		}
		if d.Stage == 3 {
			key := d.AssigneeType + "/" + d.AssigneeID
			entry, ok := roster[key]
			if !ok {
				return nil, &DecompositionConflictError{Msg: "assignee not in roster: " + d.AssigneeID}
			}
			if !entry.enabled {
				return nil, &DecompositionConflictError{Msg: "assignee role disabled: " + entry.role}
			}
		}
		for _, dep := range d.DependsOn {
			if tempIDs[dep] {
				continue
			}
			var depUUID pgtype.UUID
			if err := depUUID.Scan(dep); err != nil || !depUUID.Valid {
				return nil, &DecompositionValidationError{Msg: "unknown draft dependency: " + dep}
			}
			externalDeps[dep] = true
		}
	}

	// 依赖已有 issue：必须同模块（含需求自身有模块）。
	if len(externalDeps) > 0 {
		if !req.ModuleID.Valid {
			return nil, &DecompositionConflictError{Msg: "dependency module mismatch: requirement has no module"}
		}
		ids := make([]pgtype.UUID, 0, len(externalDeps))
		for s := range externalDeps {
			var u pgtype.UUID
			_ = u.Scan(s)
			ids = append(ids, u)
		}
		rows, err := qtx.GetIssuesModuleIDs(ctx, ids)
		if err != nil {
			return nil, fmt.Errorf("load dependency modules: %w", err)
		}
		if len(rows) != len(ids) {
			return nil, &DecompositionValidationError{Msg: "unknown dependency issue"}
		}
		for _, row := range rows {
			if !row.ModuleID.Valid || row.ModuleID != req.ModuleID {
				return nil, &DecompositionConflictError{Msg: "dependency module mismatch: " + uuidString(row.ID)}
			}
		}
	}

	// 草稿 DAG 防环（含自依赖）。
	adj := map[string][]string{}
	for _, d := range p.Drafts {
		for _, dep := range d.DependsOn {
			if tempIDs[dep] {
				adj[d.TempID] = append(adj[d.TempID], dep)
			}
		}
	}
	for _, d := range p.Drafts {
		if draftReaches(adj, d.TempID, d.TempID, map[string]bool{}) {
			return nil, &DecompositionValidationError{Msg: "dependency cycle detected at draft " + d.TempID}
		}
	}

	// ---- 批量生效
	issueCountPolicy := ResolveIssueCountPolicy(ctx, s.Entitlements, req.WorkspaceID)
	rootID := req.RootRequirementID
	if !rootID.Valid {
		rootID = req.ID
	}

	// stage 4 验收子任务的执行人：班底第一个 enabled tester，停用/缺省则 pm。
	var testerType, testerID string
	testerFallbackPM := false
	for _, r := range rosterRows {
		if r.Role == "tester" && r.Enabled {
			testerType, testerID = r.AssigneeType, uuidString(r.AssigneeID)
			break
		}
	}
	if testerID == "" {
		testerFallbackPM = true
		for _, r := range rosterRows {
			if r.Role == "pm" && r.Enabled {
				testerType, testerID = r.AssigneeType, uuidString(r.AssigneeID)
				break
			}
		}
	}

	playbooks := map[string]RolePlaybook{}
	if playbookRows, err := qtx.ListIssueRolePlaybooks(ctx, p.RequirementID); err == nil {
		playbooks = PlaybookMapFromIssueRows(playbookRows)
	}

	// 验收依据汇总（执行草稿标题 + acceptance_spec；已确认原型路径可选）。
	prototypePath := ""
	if v, err := qtx.GetLatestPrototypeVersion(ctx, req.ID); err == nil && v.Status == "confirmed" {
		prototypePath = v.HtmlPath
	}

	created := make([]db.Issue, 0, len(p.Drafts))
	idByTemp := map[string]pgtype.UUID{}
	for _, d := range p.Drafts {
		issueNumber, err := AllocateIssueNumber(ctx, qtx, req.WorkspaceID, issueCountPolicy)
		if err != nil {
			return nil, fmt.Errorf("allocate issue number: %w", err)
		}
		newPosition, err := issueposition.NextTopPosition(ctx, tx, req.WorkspaceID, "todo")
		if err != nil {
			return nil, fmt.Errorf("next top position: %w", err)
		}

		assigneeType := d.AssigneeType
		assigneeID := d.AssigneeID
		description := d.Description
		var featurePoints []byte
		if d.Stage == 3 {
			featurePoints, err = json.Marshal(d.FeaturePoints)
			if err != nil {
				return nil, fmt.Errorf("marshal feature points: %w", err)
			}
			// #11（spec §8 研发输入）：执行 agent 运行时经 multica CLI 取 issue，
			// 服务端不存任务上下文快照（task.go:1091），IssueResponse 又不渲染
			// feature_points/acceptance_spec/graph_context 三列；故把三要素注入
			// description——与 stage4 buildAcceptanceBrief 同源的既有透传通道。
			role := "developer"
			if entry, ok := roster[d.AssigneeType+"/"+d.AssigneeID]; ok && entry.role != "" {
				role = entry.role
			}
			description = PrependRolePlaybook(ResolveRolePlaybook(role, playbooks[role]), buildExecBrief(d))
		} else {
			if testerID == "" {
				return nil, &DecompositionConflictError{Msg: "tester role disabled: no enabled tester or pm in the requirement roster"}
			}
			assigneeType, assigneeID = testerType, testerID
			acceptRole := "tester"
			if testerFallbackPM {
				acceptRole = "pm"
			}
			description = PrependRolePlaybook(ResolveRolePlaybook(acceptRole, playbooks[acceptRole]), buildAcceptanceBrief(d, p.Drafts, prototypePath))
		}
		var assigneeUUID pgtype.UUID
		if assigneeID != "" {
			if err := assigneeUUID.Scan(assigneeID); err != nil {
				return nil, &DecompositionValidationError{Msg: "invalid assignee id: " + assigneeID}
			}
		}

		newIssueID := dbid.NewV7()
		issue, err := qtx.CreateIssue(ctx, db.CreateIssueParams{
			ID:                newIssueID,
			WorkspaceID:       req.WorkspaceID,
			Title:             d.Title,
			Description:       pgtype.Text{String: description, Valid: description != ""},
			Status:            "todo",
			Priority:          req.Priority,
			AssigneeType:      pgtype.Text{String: assigneeType, Valid: assigneeType != ""},
			AssigneeID:        assigneeUUID,
			CreatorType:       p.CreatorType,
			CreatorID:         p.CreatorID,
			ParentIssueID:     req.ID,
			Position:          newPosition,
			Number:            issueNumber,
			ProjectID:         req.ProjectID,
			Stage:             pgtype.Int4{Int32: d.Stage, Valid: true},
			ModuleID:          req.ModuleID,
			AvoidConflict:     pgtype.Bool{Bool: false, Valid: true},
			RootRequirementID: rootID,
			FeaturePoints:     featurePoints,
			GraphContext:      d.GraphContext,
			AcceptanceSpec:    d.AcceptanceSpec,
		})
		if err != nil {
			return nil, fmt.Errorf("create draft issue %q: %w", d.TempID, err)
		}
		idByTemp[d.TempID] = issue.ID
		created = append(created, issue)
	}

	// 依赖链写边（type='blocked_by'，InsertIssueDependency 的默认 type）。
	for _, d := range p.Drafts {
		for _, dep := range d.DependsOn {
			depID, ok := idByTemp[dep]
			if !ok {
				if err := depID.Scan(dep); err != nil {
					return nil, &DecompositionValidationError{Msg: "unknown draft dependency: " + dep}
				}
			}
			if err := qtx.InsertIssueDependency(ctx, db.InsertIssueDependencyParams{
				IssueID:          idByTemp[d.TempID],
				DependsOnIssueID: depID,
			}); err != nil {
				return nil, fmt.Errorf("insert dependency %q -> %q: %w", d.TempID, dep, err)
			}
		}
	}

	// 确认标记（并发兜底：影响 0 行 = 另一请求已确认，整体回滚）。
	rows, err := qtx.ConfirmDecomposition(ctx, p.RequirementID)
	if err != nil {
		return nil, fmt.Errorf("mark decomposition confirmed: %w", err)
	}
	if rows == 0 {
		return nil, ErrDecompositionAlreadyConfirmed
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return created, nil
}

// draftReaches 沿「草稿 → 其草稿前置」边 DFS，判环。
func draftReaches(adj map[string][]string, from, target string, seen map[string]bool) bool {
	for _, next := range adj[from] {
		if next == target {
			return true
		}
		if seen[next] {
			continue
		}
		seen[next] = true
		if draftReaches(adj, next, target, seen) {
			return true
		}
	}
	return false
}

// buildAcceptanceBrief 组装 stage 4 验收子任务的 description（spec §8 测试角色
// 输入：已确认原型 + 各执行子任务 acceptance_spec 汇总）。
func buildAcceptanceBrief(d DecomposeDraftTask, execDrafts []DecomposeDraftTask, prototypePath string) string {
	var b strings.Builder
	b.WriteString("## 验收依据\n")
	if prototypePath != "" {
		b.WriteString("\n已确认原型：" + prototypePath + "\n")
	}
	b.WriteString("\n### 各执行子任务验收点\n")
	for _, e := range execDrafts {
		if e.Stage != 3 {
			continue
		}
		b.WriteString("\n- " + e.Title)
		if len(e.AcceptanceSpec) > 0 {
			b.WriteString("：" + string(e.AcceptanceSpec))
		}
	}
	if d.Description != "" {
		b.WriteString("\n\n" + d.Description)
	}
	// #11（spec §8 测试输入含 graph_context）：附图谱上下文段，空则降级「档案未就绪」。
	b.WriteString("\n\n" + graphContextSectionBody(d.GraphContext))
	return b.String()
}

// jsonRawEmpty 判 JSONB 原始值是否「空」（未填写）：nil/空白/{}/[]/null 均视为空。
// graph WS 未落地时 graph_context 落库默认 '{}'，据此触发「档案未就绪」降级。
func jsonRawEmpty(raw json.RawMessage) bool {
	switch strings.TrimSpace(string(raw)) {
	case "", "{}", "[]", "null":
		return true
	}
	return false
}

// graphContextNotReady 是 spec §14 #11 的图谱缺失降级文案：GitNexus 本体/快照未
// 就绪（graph WS 未落地）时输出「档案未就绪」，不阻断流水线，待就绪后自动接管。
const graphContextNotReady = "档案未就绪：GitNexus 图谱本体/快照尚未就绪（graph WS 未落地）。" +
	"本段不阻断执行——待档案就绪后由后续轮次自动接管；本轮影响面请以「功能点」中的 code_objects 为准。"

// graphContextSectionBody 渲染「## 图谱上下文」段正文：graph_context 非空则原样嵌入
// JSON，空（多为 '{}'）则降级为「档案未就绪」（spec §8/§14 #11）。
func graphContextSectionBody(raw json.RawMessage) string {
	if jsonRawEmpty(raw) {
		return "## 图谱上下文\n" + graphContextNotReady
	}
	return "## 图谱上下文\n```json\n" + strings.TrimSpace(string(raw)) + "\n```"
}

// buildExecBrief 组装 stage 3 执行子任务的 description（spec §8 研发输入：子任务
// 三要素 feature_points/acceptance_spec/graph_context + 图谱上下文）。以 PM 草稿正文
// 打头（保持既有「description = 草稿正文」语义为前缀，纯追加），再附功能点 / 验收
// 标准 / 图谱上下文三段——执行 agent 运行时经 CLI 读 description 即可拿到本任务三要素
// （服务端不存任务快照，IssueResponse 不渲染这三列，见 task.go:1091）。
func buildExecBrief(d DecomposeDraftTask) string {
	var sections []string
	if strings.TrimSpace(d.Description) != "" {
		sections = append(sections, strings.TrimSpace(d.Description))
	}
	if len(d.FeaturePoints) > 0 {
		var b strings.Builder
		b.WriteString("## 功能点")
		for _, fp := range d.FeaturePoints {
			b.WriteString("\n- [" + fp.Kind + "] " + fp.Title)
			if len(fp.CodeObjects) > 0 {
				b.WriteString("：" + strings.Join(fp.CodeObjects, "、"))
			}
		}
		sections = append(sections, b.String())
	}
	if !jsonRawEmpty(d.AcceptanceSpec) {
		sections = append(sections, "## 验收标准\n```json\n"+strings.TrimSpace(string(d.AcceptanceSpec))+"\n```")
	}
	sections = append(sections, graphContextSectionBody(d.GraphContext))
	return strings.Join(sections, "\n\n")
}
