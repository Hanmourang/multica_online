package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 拆解发起（spec: 2026-09-04-requirement-calendar-design.md §8/§9）：
// POST /api/issues/{id}/decompose。
//
//   - confirm / auto：把「PM plan + 拆解」落成 stage=2 子任务，指派给需求班底
//     快照里第一个 enabled 的 pm。任务负载由 AssembleDecomposeBrief 固定为
//     「项目 PM / 禁止开工」协议：父需求投递地址 + 需求/目标/仓库/原型/班底 +
//     先分析再拆的步骤 + 产出约定。assignee 为 agent 时由 IssueService.Create
//     的既有管道自动派发（confirm 与 auto 都需要 PM 先产出草稿；两种模式的
//     差异在确认门，不在发起处）。
//   - manual：不建任何任务，返回草稿模板 schema 供人手工填写。
//
// 前置约束：班底无 enabled pm → 409；已有 stage=2 子任务（拆解已发起）→ 409 幂等。

// decomposeTemplateSchema 是 manual 模式返回的草稿模板形状（feature_points/
// graph_context/acceptance_spec 三要素 + 依赖 + 指派），与 Task 11 确认门的
// 校验字段一一对应。
var decomposeTemplateSchema = map[string]any{
	"feature_points": []any{
		map[string]any{
			"title":        "string — 功能点标题",
			"kind":         "new | modify",
			"code_objects": []string{"符号/文件路径"},
		},
	},
	"graph_context": map[string]any{
		"nodes": []string{"GitNexus 节点 id"},
		"edges": []string{"依赖边"},
	},
	"acceptance_spec": map[string]any{
		"version": 1,
		"cases": []any{
			map[string]any{"name": "string", "given": "string", "when": "string", "then": "string"},
		},
	},
	"dependencies":  []any{map[string]any{"depends_on": "子任务序号", "type": "blocked_by"}},
	"assignee_role": "developer | data | tester",
}

func (h *Handler) DecomposeRequirement(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	issue, ok := h.loadIssueForUser(w, r, id)
	if !ok {
		return
	}
	ctx := r.Context()

	roster, err := h.Queries.ListIssueRoleAssignments(ctx, issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load requirement roster")
		return
	}
	var pm *db.IssueRoleAssignment
	for i := range roster {
		if roster[i].Role == "pm" && roster[i].Enabled {
			pm = &roster[i]
			break
		}
	}
	if pm == nil {
		writeError(w, http.StatusConflict, "pm role disabled: enable a pm in the requirement roster before decomposing")
		return
	}

	if issue.DecomposeMode == "manual" {
		writeJSON(w, http.StatusOK, map[string]any{
			"mode":            "manual",
			"template_schema": decomposeTemplateSchema,
		})
		return
	}

	// 幂等：stage=2 子任务已存在 = 拆解已发起。
	children, err := h.Queries.ListRequirementChildren(ctx, issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list requirement children")
		return
	}
	for _, c := range children {
		if c.Stage.Valid && c.Stage.Int32 == 2 {
			writeError(w, http.StatusConflict, "decomposition already started")
			return
		}
	}

	// git 库标签 + 已确认原型路径进入任务负载（均为可选段）。
	repoLabel := ""
	if issue.RepoResourceID.Valid {
		if res, err := h.Queries.GetProjectResource(ctx, issue.RepoResourceID); err == nil && res.Label.Valid {
			repoLabel = res.Label.String
		}
	}
	prototypePath := ""
	if v, err := h.Queries.GetLatestPrototypeVersion(ctx, issue.ID); err == nil && v.Status == "confirmed" {
		prototypePath = v.HtmlPath
	}

	userID := requestUserID(r)
	workspaceID := uuidToString(issue.WorkspaceID)
	actorType, actorID := h.resolveActor(r, userID, workspaceID)

	prefix := h.getIssuePrefix(ctx, issue.WorkspaceID)
	rosterRoles := make([]service.DecomposeBriefRole, 0, len(roster))
	for _, row := range roster {
		rosterRoles = append(rosterRoles, service.DecomposeBriefRole{
			Role:         row.Role,
			Enabled:      row.Enabled,
			AssigneeType: row.AssigneeType,
			AssigneeID:   uuidToString(row.AssigneeID),
		})
	}
	brief := service.AssembleDecomposeBrief(service.DecomposeBriefInput{
		Requirement:   issue,
		Identifier:    prefix + "-" + strconv.Itoa(int(issue.Number)),
		ParentID:      uuidToString(issue.ID),
		RepoLabel:     repoLabel,
		PrototypePath: prototypePath,
		Roster:        rosterRoles,
		Playbook:      h.resolveIssuePlaybook(r, issue.ID, "pm"),
	})
	fill := h.newStatusCategoryFiller(ctx, issue.WorkspaceID)
	res, err := h.IssueService.Create(ctx, service.IssueCreateParams{
		WorkspaceID:   issue.WorkspaceID,
		Title:         "PM plan + 拆解：" + issue.Title,
		Description:   pgtype.Text{String: brief, Valid: true},
		Status:        "todo",
		Priority:      issue.Priority,
		AssigneeType:  pgtype.Text{String: pm.AssigneeType, Valid: true},
		AssigneeID:    pm.AssigneeID,
		CreatorType:   actorType,
		CreatorID:     parseUUID(actorID),
		ParentIssueID: issue.ID,
		ProjectID:     issue.ProjectID,
		Stage:         pgtype.Int4{Int32: 2, Valid: true},
		ModuleID:      issue.ModuleID,
	}, service.IssueCreateOpts{
		BroadcastPayload: func(child db.Issue, _ []db.Attachment, _ []db.IssueLabel) map[string]any {
			payload := issueToResponse(child, prefix)
			fill(&payload)
			return map[string]any{"issue": payload}
		},
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create PM decompose task: "+err.Error())
		return
	}

	resp := issueToResponse(res.Issue, prefix)
	fill(&resp)
	writeJSON(w, http.StatusCreated, resp)
}

// ---- 拆解读取（spec §9：GET /issues/{id}/decomposition）----

// decompositionDraftsFence 是 PM plan 评论里子任务草稿机读块的围栏标记
// （quick-actions 同款约定：人类可读正文 + 一段 ```<tag> 包裹的 JSON）。
const decompositionDraftsFence = "```decomposition-drafts"

// splitDecompositionComment 把 PM 评论拆成（plan 正文, 草稿 JSON 数组, ok）。
// plan = 围栏前正文 + 围栏后的尾部说明；机读块必须是合法 JSON 数组，
// 否则整条评论不算产出（半截输出回退到更早的有效评论）。
// 围栏允许可选语言后缀（```decomposition-drafts json）和下划线写法。
func splitDecompositionComment(content string) (plan string, drafts json.RawMessage, ok bool) {
	idx := indexDraftsFence(content)
	if idx < 0 {
		return "", nil, false
	}
	nl := strings.IndexByte(content[idx:], '\n')
	if nl < 0 {
		return "", nil, false
	}
	headEnd := idx + nl + 1
	rest := content[headEnd:]
	close := strings.Index(rest, "```")
	if close < 0 {
		return "", nil, false
	}
	raw := strings.TrimSpace(rest[:close])
	if !isDraftsArray(raw) {
		return "", nil, false
	}
	plan = strings.TrimSpace(content[:idx])
	if tail := strings.TrimSpace(rest[close+3:]); tail != "" {
		if plan != "" {
			plan += "\n\n" + tail
		} else {
			plan = tail
		}
	}
	return plan, json.RawMessage(raw), true
}

var draftsFenceRe = regexp.MustCompile("(?m)^```decomposition[-_]drafts[^\\n]*\\n")

func indexDraftsFence(content string) int {
	if loc := draftsFenceRe.FindStringIndex(content); loc != nil {
		return loc[0]
	}
	// 兼容围栏不在行首、或只有开头没有换行的旧写法。
	for _, mark := range []string{decompositionDraftsFence, "```decomposition_drafts"} {
		if idx := strings.Index(content, mark); idx >= 0 {
			return idx
		}
	}
	return -1
}

func isDraftsArray(raw string) bool {
	var arr []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &arr); err != nil || arr == nil {
		return false
	}
	return true
}

func isDraftsObjectArray(raw string) bool {
	var arr []map[string]any
	if err := json.Unmarshal([]byte(raw), &arr); err != nil || arr == nil {
		return false
	}
	for _, item := range arr {
		if _, hasTemp := item["temp_id"]; hasTemp {
			return true
		}
		if _, hasTitle := item["title"]; hasTitle {
			if _, hasStage := item["stage"]; hasStage {
				return true
			}
		}
	}
	return false
}

// parseDecompositionPayload 从评论 / 描述里回收 plan 与草稿。
// 优先机读围栏，再接受任意 ```json 数组或正文里带 temp_id 的 JSON 数组；
// 只有 PM plan 标题（目标分解 / 阶段 / 风险）时也算产出，drafts 为空。
func parseDecompositionPayload(content string) (plan string, drafts json.RawMessage, ok bool) {
	if plan, drafts, ok = splitDecompositionComment(content); ok {
		return plan, drafts, true
	}
	if plan, drafts, ok = splitJSONDraftsFence(content); ok {
		return plan, drafts, true
	}
	if plan, drafts, ok = extractEmbeddedDraftsJSON(content); ok {
		return plan, drafts, true
	}
	if looksLikePMPlan(content) {
		return strings.TrimSpace(content), json.RawMessage("[]"), true
	}
	return "", nil, false
}

func splitJSONDraftsFence(content string) (plan string, drafts json.RawMessage, ok bool) {
	remaining := content
	offset := 0
	for {
		start := strings.Index(remaining, "```")
		if start < 0 {
			return "", nil, false
		}
		abs := offset + start
		after := remaining[start+3:]
		nl := strings.IndexByte(after, '\n')
		if nl < 0 {
			return "", nil, false
		}
		bodyAndRest := after[nl+1:]
		close := strings.Index(bodyAndRest, "```")
		if close < 0 {
			return "", nil, false
		}
		raw := strings.TrimSpace(bodyAndRest[:close])
		if isDraftsObjectArray(raw) {
			plan = strings.TrimSpace(content[:abs] + bodyAndRest[close+3:])
			return plan, json.RawMessage(raw), true
		}
		consumed := start + 3 + nl + 1 + close + 3
		offset += consumed
		remaining = remaining[consumed:]
	}
}

func extractEmbeddedDraftsJSON(content string) (plan string, drafts json.RawMessage, ok bool) {
	for i := 0; i < len(content); i++ {
		if content[i] != '[' {
			continue
		}
		dec := json.NewDecoder(strings.NewReader(content[i:]))
		var arr []map[string]any
		if err := dec.Decode(&arr); err != nil || len(arr) == 0 {
			continue
		}
		end := i + int(dec.InputOffset())
		raw := strings.TrimSpace(content[i:end])
		if !isDraftsObjectArray(raw) {
			continue
		}
		plan = strings.TrimSpace(content[:i] + content[end:])
		return plan, json.RawMessage(raw), true
	}
	return "", nil, false
}

func looksLikePMPlan(content string) bool {
	text := strings.TrimSpace(content)
	if len(text) < 40 {
		return false
	}
	markers := []string{
		"## 目标分解", "## 阶段", "## 风险", "## 目标",
		"## Goals", "## Phases", "## Risks",
		"## 阶段划分", "## 范围",
	}
	for _, m := range markers {
		if strings.Contains(text, m) {
			return true
		}
	}
	return false
}

// decompositionResponse 是 GET 的响应：plan 评论正文（机读块之外的部分）+
// 草稿数组原样透传；草稿字段由确认门（ConfirmDecomposition）校验，读取侧不解释。
type decompositionResponse struct {
	Plan            *string         `json:"plan"`
	Drafts          json.RawMessage `json:"drafts"`
	SourceCommentID *string         `json:"source_comment_id"`
}

// GetDecomposition handles GET /api/issues/{id}/decomposition（spec §9）：
// 最新一条带有效机读块的需求评论拆出 plan 与草稿；无产出时 plan=null、drafts=[]。
func (h *Handler) GetDecomposition(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	// 与评论区同源的读窗口（足够覆盖 PM 产出所在的近期时间线）。
	comments, err := h.Queries.ListCommentsForIssue(r.Context(), db.ListCommentsForIssueParams{
		IssueID:     issue.ID,
		WorkspaceID: issue.WorkspaceID,
		Limit:       200,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list comments")
		return
	}
	if resp, found := firstDecompositionHit(comments, nil); found {
		writeJSON(w, http.StatusOK, resp)
		return
	}

	// 兜底：coding agent 常把 plan 写在 stage=2 子任务评论或描述里（runtime
	// 默认投递当前 issue）。父需求读不到就不能进确认门。
	children, err := h.Queries.ListRequirementChildren(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list requirement children")
		return
	}
	for _, child := range children {
		childComments, err := h.Queries.ListCommentsForIssue(r.Context(), db.ListCommentsForIssueParams{
			IssueID:     child.ID,
			WorkspaceID: issue.WorkspaceID,
			Limit:       200,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to list decompose-task comments")
			return
		}
		var description *string
		if child.Description.Valid {
			description = &child.Description.String
		}
		if resp, found := firstDecompositionHit(childComments, description); found {
			writeJSON(w, http.StatusOK, resp)
			return
		}
	}

	writeJSON(w, http.StatusOK, decompositionResponse{
		Plan:   nil,
		Drafts: json.RawMessage("[]"),
	})
}

// firstDecompositionHit 优先回收带草稿的评论，其次 plan-only，最后描述。
func firstDecompositionHit(comments []db.Comment, description *string) (decompositionResponse, bool) {
	var planOnly *decompositionResponse
	for i := len(comments) - 1; i >= 0; i-- {
		c := comments[i]
		plan, drafts, found := parseDecompositionPayload(c.Content)
		if !found {
			continue
		}
		id := uuidToString(c.ID)
		resp := decompositionResponse{
			Plan:            stringPtr(plan),
			Drafts:          drafts,
			SourceCommentID: &id,
		}
		if hasDraftItems(drafts) {
			return resp, true
		}
		if planOnly == nil {
			planOnly = &resp
		}
	}
	if description != nil {
		if plan, drafts, found := parseDecompositionPayload(*description); found {
			resp := decompositionResponse{
				Plan:   stringPtr(plan),
				Drafts: drafts,
			}
			if hasDraftItems(drafts) {
				return resp, true
			}
			if planOnly == nil {
				planOnly = &resp
			}
		}
	}
	if planOnly != nil {
		return *planOnly, true
	}
	return decompositionResponse{}, false
}

func hasDraftItems(raw json.RawMessage) bool {
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return false
	}
	return len(arr) > 0
}

func stringPtr(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

// ---- 拆解确认（spec §9：POST /issues/{id}/decomposition/confirm）----

// confirmDecompositionRequest 是确认请求体：PM 产出（或人工整理）的子任务草稿
// 列表，服务端校验通过后批量生效。depends_on 元素为同批草稿 temp_id 或已有
// issue id（须与需求同模块）。
type confirmDecompositionRequest struct {
	Drafts []confirmDraft `json:"drafts"`
}

type confirmDraft struct {
	TempID         string                          `json:"temp_id"`
	Title          string                          `json:"title"`
	Description    string                          `json:"description"`
	Stage          int32                           `json:"stage"`
	AssigneeType   string                          `json:"assignee_type"`
	AssigneeID     string                          `json:"assignee_id"`
	FeaturePoints  []service.DecomposeFeaturePoint `json:"feature_points"`
	GraphContext   json.RawMessage                 `json:"graph_context"`
	AcceptanceSpec json.RawMessage                 `json:"acceptance_spec"`
	DependsOn      []string                        `json:"depends_on"`
}

// ConfirmDecomposition handles POST /api/issues/{id}/decomposition/confirm。
// 错误映射：草稿内容错误 400；班底/依赖/重复确认 409。
func (h *Handler) ConfirmDecomposition(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var body confirmDecompositionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	drafts := make([]service.DecomposeDraftTask, 0, len(body.Drafts))
	for _, d := range body.Drafts {
		drafts = append(drafts, service.DecomposeDraftTask{
			TempID:         d.TempID,
			Title:          d.Title,
			Description:    d.Description,
			Stage:          d.Stage,
			AssigneeType:   d.AssigneeType,
			AssigneeID:     d.AssigneeID,
			FeaturePoints:  d.FeaturePoints,
			GraphContext:   d.GraphContext,
			AcceptanceSpec: d.AcceptanceSpec,
			DependsOn:      d.DependsOn,
		})
	}

	userID := requestUserID(r)
	actorType, actorID := h.resolveActor(r, userID, uuidToString(issue.WorkspaceID))
	created, err := h.IssueService.ConfirmDecomposition(r.Context(), service.ConfirmDecompositionParams{
		RequirementID: issue.ID,
		Drafts:        drafts,
		CreatorType:   actorType,
		CreatorID:     parseUUID(actorID),
	})
	if err != nil {
		var valErr *service.DecompositionValidationError
		var conErr *service.DecompositionConflictError
		switch {
		case errors.As(err, &valErr):
			writeError(w, http.StatusBadRequest, valErr.Msg)
		case errors.As(err, &conErr):
			writeError(w, http.StatusConflict, conErr.Msg)
		case errors.Is(err, service.ErrDecompositionAlreadyConfirmed):
			writeError(w, http.StatusConflict, "decomposition already confirmed")
		default:
			writeError(w, http.StatusInternalServerError, "failed to confirm decomposition: "+err.Error())
		}
		return
	}

	prefix := h.getIssuePrefix(r.Context(), issue.WorkspaceID)
	fill := h.newStatusCategoryFiller(r.Context(), issue.WorkspaceID)
	out := make([]IssueResponse, 0, len(created))
	for _, child := range created {
		resp := issueToResponse(child, prefix)
		fill(&resp)
		out = append(out, resp)
	}
	writeJSON(w, http.StatusOK, map[string]any{"issues": out})
}
