package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issueposition"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// recordAcceptanceVerdictRequest 是 stage4 tester 上报验收裁决的 body。
// verdict: "pass"（验收通过）| "fail"（打回修复）；evidence: 裁决依据/缺陷说明。
type recordAcceptanceVerdictRequest struct {
	Verdict  string `json:"verdict"`
	Evidence string `json:"evidence"`
}

// RecordAcceptanceVerdict 处理 POST /api/issues/{id}/acceptance/verdict（spec §8 / WS4）。
// {id} 为需求（root）本身。pass → 需求落 done（WS3 的 root 终态钩子随后释放组锁）；
// fail → acceptance_round + 1，未越界则建 stage3 修复子任务并入队，越界（>3）则发人工仲裁通知。
func (h *Handler) RecordAcceptanceVerdict(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var body recordAcceptanceVerdictRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ctx := r.Context()

	switch body.Verdict {
	case "pass":
		updated, err := h.Queries.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{
			ID:          issue.ID,
			Status:      "done",
			WorkspaceID: issue.WorkspaceID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to mark requirement done: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"verdict":          "pass",
			"acceptance_round": updated.AcceptanceRound,
			"terminal":         true,
		})
	case "fail":
		newRound, err := h.Queries.IncrementAcceptanceRound(ctx, issue.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to increment acceptance_round: "+err.Error())
			return
		}
		// 越界终态（spec §6 第 10 态 / 开放问题 #4）：累计 >3 轮仍打回 = 验收失败，
		// 不再建修复子任务，改发人工仲裁 system 评论；派生投影据 acceptance_round>3 显示「验收失败」。
		if newRound > 3 {
			h.postAcceptanceFailedComment(ctx, issue, newRound, body.Evidence)
			writeJSON(w, http.StatusOK, map[string]any{
				"verdict":          "fail",
				"acceptance_round": newRound,
				"terminal":         true,
			})
			return
		}
		repair, err := h.createAcceptanceRepairTask(ctx, issue, newRound, body.Evidence)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to create repair task: "+err.Error())
			return
		}
		// 入队 best-effort：assignee 无 runtime / 已归档时 EnqueueTaskForIssue 返回 error，
		// 记录但不回滚 round 与修复子任务（子任务已建，后续可人工重派）。
		if _, err := h.TaskService.EnqueueTaskForIssue(ctx, repair); err != nil {
			slog.Warn("acceptance fail: enqueue repair task failed",
				"error", err, "repair_id", uuidToString(repair.ID))
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"verdict":         "fail",
			"acceptance_round": newRound,
			"terminal":        false,
			"repair_issue_id": uuidToString(repair.ID),
		})
	default:
		writeError(w, http.StatusBadRequest, "verdict must be pass or fail")
	}
}

// createAcceptanceRepairTask 为验收打回新建一个 stage3 修复子任务（status=todo）。
// assignee 优先取需求班底第一个 enabled 'dev'，缺省回落需求自身 assignee；root/module/
// project/priority 全部继承需求，保证 WS3 组锁与派生投影把它算进同一需求组。
func (h *Handler) createAcceptanceRepairTask(ctx context.Context, req db.Issue, round int32, evidence string) (db.Issue, error) {
	assigneeType, assigneeID := h.resolveRepairAssignee(ctx, req)

	rootID := req.RootRequirementID
	if !rootID.Valid {
		rootID = req.ID
	}
	description := "## 验收打回（第 " + strconv.Itoa(int(round)) + " 轮）\n\n" + evidence
	position, err := issueposition.NextTopPosition(ctx, h.DB, req.WorkspaceID, "todo")
	if err != nil {
		return db.Issue{}, fmt.Errorf("next top position: %w", err)
	}
	policy := service.ResolveIssueCountPolicy(ctx, h.Entitlements, req.WorkspaceID)
	number, err := service.AllocateIssueNumber(ctx, h.Queries, req.WorkspaceID, policy)
	if err != nil {
		return db.Issue{}, fmt.Errorf("allocate issue number: %w", err)
	}
	return h.Queries.CreateIssue(ctx, db.CreateIssueParams{
		ID:                dbid.NewV7(),
		WorkspaceID:       req.WorkspaceID,
		Title:             "验收修复（第 " + strconv.Itoa(int(round)) + " 轮）：" + req.Title,
		Description:       pgtype.Text{String: description, Valid: true},
		Status:            "todo",
		Priority:          req.Priority,
		AssigneeType:      pgtype.Text{String: assigneeType, Valid: assigneeType != ""},
		AssigneeID:        assigneeID,
		CreatorType:       "member",
		CreatorID:         pgtype.UUID{Valid: true},
		ParentIssueID:     req.ID,
		Position:          position,
		Number:            number,
		ProjectID:         req.ProjectID,
		Stage:             pgtype.Int4{Int32: 3, Valid: true},
		ModuleID:          req.ModuleID,
		AvoidConflict:     pgtype.Bool{Bool: false, Valid: true},
		RootRequirementID: rootID,
	})
}

// resolveRepairAssignee 取班底第一个 enabled 'dev' 角色；缺省回落需求自身 assignee。
// 返回值直接喂给 CreateIssueParams（assigneeID 为 pgtype.UUID，可能 invalid=无 assignee）。
func (h *Handler) resolveRepairAssignee(ctx context.Context, req db.Issue) (string, pgtype.UUID) {
	roster, err := h.Queries.ListIssueRoleAssignments(ctx, req.ID)
	if err == nil {
		for _, r := range roster {
			if r.Role == "dev" && r.Enabled && r.AssigneeID.Valid {
				return r.AssigneeType, r.AssigneeID
			}
		}
	}
	return req.AssigneeType.String, req.AssigneeID
}

// postAcceptanceFailedComment 在验收失败终态时，于需求上发一条 system 评论请求人工仲裁。
// author_type='system'、author_id=zero UUID（与 postChildDoneComment 同约定）。
// best-effort：失败仅记录，不影响 verdict 响应（round 已落库，投影已判验收失败）。
func (h *Handler) postAcceptanceFailedComment(ctx context.Context, req db.Issue, round int32, evidence string) {
	content := "验收失败（累计 " + strconv.Itoa(int(round)) + " 轮打回，超过 3 轮上限）——需人工仲裁。最近一次裁决依据：" + evidence
	if _, err := h.Queries.CreateComment(ctx, db.CreateCommentParams{
		ID:          dbid.NewV7(),
		IssueID:     req.ID,
		WorkspaceID: req.WorkspaceID,
		AuthorType:  "system",
		AuthorID:    pgtype.UUID{Valid: true},
		Content:     content,
		Type:        "system",
		ParentID:    pgtype.UUID{Valid: false},
	}); err != nil {
		slog.Warn("acceptance failed: create arbitration comment failed",
			"error", err, "requirement_id", uuidToString(req.ID))
	}
}
