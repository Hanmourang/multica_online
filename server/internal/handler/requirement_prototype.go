package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 原型一键生成（spec: 2026-09-04-requirement-calendar-design.md §5.3/§8/§9）：
// POST /api/issues/{id}/prototype/generate。
//
// 流程：班底校验（须有 enabled prototyper，否则 409——停用即跳过 stage 1）→
// 组装提示词（固定五段 + ✗ 标记回流的〔本轮修正〕段 + 请求体追加段）→
// service.GeneratePrototypeVersion 单事务登记新版本并 supersede 旧 pending →
// 建/复用 stage=1 子任务派给该 prototyper（首建走 IssueService.Create 的
// assignee 自动派发；重生成时更新任务负载并在无 pending 任务时重新入队）。
//
// 已有 confirmed 版本时 409——确认门（Task 14）是版本流转的终点。

// generatePrototypeRequest 是 generate 的请求体。marks 为可选：携带时参与
// 本轮提示词的〔本轮修正〕组装；缺省时沿用当前 pending 版本上已存的标记。
type generatePrototypeRequest struct {
	Marks        *[]service.PrototypeMark `json:"marks"`
	PromptAppend string                   `json:"prompt_append"`
}

// prototypeVersionResponse 是原型版本行的 API 投影；marks 原样透传 JSONB。
type prototypeVersionResponse struct {
	ID            string          `json:"id"`
	IssueID       string          `json:"issue_id"`
	Version       int32           `json:"version"`
	HtmlPath      string          `json:"html_path"`
	Prompt        string          `json:"prompt"`
	Marks         json.RawMessage `json:"marks"`
	Status        string          `json:"status"`
	CreatedByType string          `json:"created_by_type"`
	CreatedByID   string          `json:"created_by_id"`
	CreatedAt     string          `json:"created_at"`
}

func prototypeVersionToResponse(v db.IssuePrototypeVersion) prototypeVersionResponse {
	marks := json.RawMessage(v.Marks)
	if len(marks) == 0 {
		marks = json.RawMessage("[]")
	}
	return prototypeVersionResponse{
		ID:            uuidToString(v.ID),
		IssueID:       uuidToString(v.IssueID),
		Version:       v.Version,
		HtmlPath:      v.HtmlPath,
		Prompt:        v.Prompt,
		Marks:         marks,
		Status:        v.Status,
		CreatedByType: v.CreatedByType,
		CreatedByID:   uuidToString(v.CreatedByID),
		CreatedAt:     v.CreatedAt.Time.UTC().Format("2006-01-02T15:04:05Z"),
	}
}

func (h *Handler) GeneratePrototype(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	ctx := r.Context()

	var body generatePrototypeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err.Error() != "EOF" {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Marks != nil {
		for _, m := range *body.Marks {
			if m.Verdict != "ok" && m.Verdict != "no" && m.Verdict != "pending" {
				writeError(w, http.StatusBadRequest, "invalid mark verdict: "+m.Verdict)
				return
			}
		}
	}

	roster, err := h.Queries.ListIssueRoleAssignments(ctx, issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load requirement roster")
		return
	}
	var prototyper *db.IssueRoleAssignment
	for i := range roster {
		if roster[i].Role == "prototyper" && roster[i].Enabled {
			prototyper = &roster[i]
			break
		}
	}
	if prototyper == nil {
		writeError(w, http.StatusConflict, "prototyper role disabled: enable a prototyper in the requirement roster before generating")
		return
	}

	// 提示词标记来源：请求体优先，缺省沿用当前 pending 版本已存标记。
	var marks []service.PrototypeMark
	if body.Marks != nil {
		marks = *body.Marks
	} else if latest, err := h.Queries.GetLatestPrototypeVersion(ctx, issue.ID); err == nil && latest.Status == "pending" {
		_ = json.Unmarshal(latest.Marks, &marks)
	}

	repoLabel := ""
	if issue.RepoResourceID.Valid {
		if res, err := h.Queries.GetProjectResource(ctx, issue.RepoResourceID); err == nil && res.Label.Valid {
			repoLabel = res.Label.String
		}
	}

	prefix := h.getIssuePrefix(ctx, issue.WorkspaceID)
	identifier := prefix + "-" + strconv.Itoa(int(issue.Number))
	outputPath := service.PrototypeOutputPath(identifier, issue.Title)
	prompt := service.AssemblePrototypePromptWithPlaybook(issue, repoLabel, outputPath, body.PromptAppend, marks, h.resolveIssuePlaybook(r, issue.ID, "prototyper"))

	userID := requestUserID(r)
	actorType, actorID := h.resolveActor(r, userID, uuidToString(issue.WorkspaceID))
	version, err := h.IssueService.GeneratePrototypeVersion(ctx, service.GeneratePrototypeVersionParams{
		IssueID:     issue.ID,
		WorkspaceID: issue.WorkspaceID,
		HtmlPath:    outputPath,
		Prompt:      prompt,
		CreatorType: actorType,
		CreatorID:   parseUUID(actorID),
	})
	if err != nil {
		if errors.Is(err, service.ErrPrototypeAlreadyConfirmed) {
			writeError(w, http.StatusConflict, "prototype already confirmed: unconfirm the current version before regenerating")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to register prototype version: "+err.Error())
		return
	}

	task, err := h.ensurePrototypeStageTask(ctx, r, issue, *prototyper, buildPrototypeBrief(prompt, outputPath, version.Version))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to upsert stage-1 prototype task: "+err.Error())
		return
	}

	fill := h.newStatusCategoryFiller(ctx, issue.WorkspaceID)
	resp := issueToResponse(task, prefix)
	fill(&resp)
	writeJSON(w, http.StatusCreated, map[string]any{
		"version": prototypeVersionToResponse(version),
		"task":    resp,
	})
}

// ensurePrototypeStageTask 建/复用 stage=1 原型子任务。复用语义：更新任务负载
// 为本轮提示词；若任务已终态（上轮 done）则重开为 todo；执行人为 agent 且
// 当前无 queued/dispatched 任务时重新入队（pending 任务会读到更新后的负载，
// 无需重复入队）。
func (h *Handler) ensurePrototypeStageTask(ctx context.Context, r *http.Request, issue db.Issue, prototyper db.IssueRoleAssignment, brief string) (db.Issue, error) {
	children, err := h.Queries.ListRequirementChildren(ctx, issue.ID)
	if err != nil {
		return db.Issue{}, fmt.Errorf("list requirement children: %w", err)
	}
	for i := range children {
		child := children[i]
		if !child.Stage.Valid || child.Stage.Int32 != 1 {
			continue
		}
		if isTerminalChildStatus(issuestatus.Effective(ctx, h.Queries, child.WorkspaceID, child.Status)) {
			child, err = h.Queries.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{
				ID:          child.ID,
				Status:      "todo",
				WorkspaceID: child.WorkspaceID,
			})
			if err != nil {
				return db.Issue{}, fmt.Errorf("reopen stage-1 task: %w", err)
			}
		}
		updated, err := h.IssueService.UpdateContent(ctx, child, service.IssueContentPatch{Description: &brief})
		if err != nil {
			return db.Issue{}, fmt.Errorf("update stage-1 brief: %w", err)
		}
		if updated.AssigneeType.Valid && updated.AssigneeType.String == "agent" && updated.AssigneeID.Valid {
			hasPending, perr := h.Queries.HasPendingTaskForIssueAndAgent(ctx, db.HasPendingTaskForIssueAndAgentParams{
				IssueID: updated.ID,
				AgentID: updated.AssigneeID,
			})
			if perr == nil && !hasPending {
				if _, err := h.TaskService.EnqueueTaskForIssue(ctx, updated); err != nil {
					return db.Issue{}, fmt.Errorf("re-dispatch stage-1 task: %w", err)
				}
			}
		}
		return updated, nil
	}

	userID := requestUserID(r)
	actorType, actorID := h.resolveActor(r, userID, uuidToString(issue.WorkspaceID))
	prefix := h.getIssuePrefix(ctx, issue.WorkspaceID)
	fill := h.newStatusCategoryFiller(ctx, issue.WorkspaceID)
	res, err := h.IssueService.Create(ctx, service.IssueCreateParams{
		WorkspaceID:   issue.WorkspaceID,
		Title:         "原型：" + issue.Title,
		Description:   pgtype.Text{String: brief, Valid: true},
		Status:        "todo",
		Priority:      issue.Priority,
		AssigneeType:  pgtype.Text{String: prototyper.AssigneeType, Valid: true},
		AssigneeID:    prototyper.AssigneeID,
		CreatorType:   actorType,
		CreatorID:     parseUUID(actorID),
		ParentIssueID: issue.ID,
		ProjectID:     issue.ProjectID,
		Stage:         pgtype.Int4{Int32: 1, Valid: true},
		ModuleID:      issue.ModuleID,
	}, service.IssueCreateOpts{
		BroadcastPayload: func(child db.Issue, _ []db.Attachment, _ []db.IssueLabel) map[string]any {
			payload := issueToResponse(child, prefix)
			fill(&payload)
			return map[string]any{"issue": payload}
		},
	})
	if err != nil {
		return db.Issue{}, err
	}
	return res.Issue, nil
}

// buildPrototypeBrief 组装 stage=1 原型子任务的任务负载：当轮完整提示词 +
// 产出约定路径 + 完成约定（写仓 → 置 done → 用户在需求详情逐项标记）。
func buildPrototypeBrief(prompt, outputPath string, version int32) string {
	var b strings.Builder
	fmt.Fprintf(&b, "## 原型生成任务（v%d）\n\n", version)
	b.WriteString(prompt)
	b.WriteString("\n\n## 交付约定\n把单文件 HTML 原型写入业务仓 ")
	b.WriteString(outputPath)
	b.WriteString("，完成后将本任务置为 done；用户会在需求详情对原型逐屏标记 ✓/✗/○。")
	return b.String()
}

// ListPrototypeVersions handles GET /api/issues/{id}/prototypes —— 版本历史
// （version 降序），供画面 4 右侧版本列表渲染。
func (h *Handler) ListPrototypeVersions(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	versions, err := h.Queries.ListPrototypeVersions(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list prototype versions")
		return
	}
	out := make([]prototypeVersionResponse, 0, len(versions))
	for _, v := range versions {
		out = append(out, prototypeVersionToResponse(v))
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": out})
}

// ---- 原型标记 + 确认门（spec §5.3/§9 + 画面 4 标注 9）----

// updatePrototypeMarksRequest 是 marks 写入的请求体：整体替换目标 pending
// 版本的标记集合（客户端逐项标记合并后一次性提交）。
type updatePrototypeMarksRequest struct {
	Marks []service.PrototypeMark `json:"marks"`
}

// prototypeHandlerError 把 service 层原型错误映射为 HTTP 状态码。
func prototypeHandlerError(w http.ResponseWriter, err error, fallback string) {
	var valErr *service.PrototypeValidationError
	var gateErr *service.PrototypeConfirmGateError
	switch {
	case errors.As(err, &valErr):
		writeError(w, http.StatusBadRequest, valErr.Msg)
	case errors.Is(err, service.ErrPrototypeVersionNotFound):
		writeError(w, http.StatusNotFound, "prototype version not found")
	case errors.Is(err, service.ErrPrototypeVersionNotPending):
		writeError(w, http.StatusConflict, "prototype version is not pending")
	case errors.As(err, &gateErr):
		writeError(w, http.StatusConflict, gateErr.Error())
	default:
		writeError(w, http.StatusInternalServerError, fallback+": "+err.Error())
	}
}

// UpdatePrototypeMarks handles POST /api/issues/{id}/prototypes/{version}/marks。
func (h *Handler) UpdatePrototypeMarks(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	versionNum, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || versionNum < 1 {
		writeError(w, http.StatusBadRequest, "invalid version")
		return
	}
	var body updatePrototypeMarksRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	updated, err := h.IssueService.UpdatePrototypeMarks(r.Context(), issue.ID, int32(versionNum), body.Marks)
	if err != nil {
		prototypeHandlerError(w, err, "failed to update prototype marks")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": prototypeVersionToResponse(updated)})
}

// ConfirmPrototype handles POST /api/issues/{id}/prototypes/{version}/confirm。
//
// 确认门在 service 内校验（pending + 无 verdict='no' 标记）；通过后这里把
// stage=1 子任务置 done，并走既有 notifyParentOfChildDone stage barrier——
// 父任务执行人（stage 2 的 PM）随之被唤醒（spec 画面 4 标注 9：确认 → 进
// stage 2 由 PM 出 plan + 拆解）。
func (h *Handler) ConfirmPrototype(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	versionNum, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || versionNum < 1 {
		writeError(w, http.StatusBadRequest, "invalid version")
		return
	}
	confirmed, err := h.IssueService.ConfirmPrototypeVersion(r.Context(), issue.ID, int32(versionNum))
	if err != nil {
		prototypeHandlerError(w, err, "failed to confirm prototype version")
		return
	}

	ctx := r.Context()
	children, err := h.Queries.ListRequirementChildren(ctx, issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list requirement children")
		return
	}
	for _, child := range children {
		if !child.Stage.Valid || child.Stage.Int32 != 1 {
			continue
		}
		if isTerminalChildStatus(issuestatus.Effective(ctx, h.Queries, child.WorkspaceID, child.Status)) {
			continue
		}
		updated, err := h.Queries.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{
			ID:          child.ID,
			Status:      "done",
			WorkspaceID: child.WorkspaceID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to close stage-1 prototype task: "+err.Error())
			return
		}
		// 既有 barrier：进入终态的转移才触发；best-effort，失败不回滚确认。
		h.notifyParentOfChildDone(ctx, child, updated)
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": prototypeVersionToResponse(confirmed)})
}
