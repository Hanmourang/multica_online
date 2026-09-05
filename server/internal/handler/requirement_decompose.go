package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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
//     快照里第一个 enabled 的 pm。任务负载（description）组装需求描述/目标/
//     git 库/（已确认原型 html_path）+ 产出约定。assignee 为 agent 时由
//     IssueService.Create 的既有 assignee 管道自动派发（confirm 与 auto 都需要
//     PM 先产出草稿；两种模式的差异在 Task 11 的确认门，不在发起处）。
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
	fill := h.newStatusCategoryFiller(ctx, issue.WorkspaceID)
	res, err := h.IssueService.Create(ctx, service.IssueCreateParams{
		WorkspaceID:   issue.WorkspaceID,
		Title:         "PM plan + 拆解：" + issue.Title,
		Description:   pgtype.Text{String: buildDecomposeBrief(issue, repoLabel, prototypePath), Valid: true},
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

// buildDecomposeBrief 组装 stage=2 PM 子任务的任务负载（spec §8 的 PM 输入）：
// 需求描述 + 目标 + git 库 + 已确认原型 + 产出约定。可选段缺失时整段省略。
func buildDecomposeBrief(issue db.Issue, repoLabel, prototypePath string) string {
	var b strings.Builder
	b.WriteString("## 需求\n")
	b.WriteString(issue.Title)
	if issue.Description.Valid && issue.Description.String != "" {
		b.WriteString("\n\n")
		b.WriteString(issue.Description.String)
	}
	if issue.Goal.Valid && issue.Goal.String != "" {
		b.WriteString("\n\n## 目标\n")
		b.WriteString(issue.Goal.String)
	}
	if repoLabel != "" {
		fmt.Fprintf(&b, "\n\n## 仓库\n%s", repoLabel)
	}
	if prototypePath != "" {
		fmt.Fprintf(&b, "\n\n## 已确认原型\n%s", prototypePath)
	}
	b.WriteString("\n\n## 产出约定\n" +
		"输出 plan 评论 + 子任务草稿：每个草稿含 feature_points（kind: new|modify + 代码对象）、" +
		"graph_context、acceptance_spec、依赖链与指派角色。")
	return b.String()
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
