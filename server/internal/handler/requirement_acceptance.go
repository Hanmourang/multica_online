package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issueposition"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
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

	// M-1 入口守卫：验收裁决只对「顶层需求 + 处于验收阶段（非终态） + acceptance_round<=3」
	// 有效。已 done/cancelled 的终态、已越界第10态（acceptance_round>3=验收失败）都拒绝
	// 二次裁决——否则 pass 会把终态抹成 done，fail 会让 round 无限增长 + 仲裁评论刷屏。
	// 子任务不承载验收语义（{id} 契约上是 root 需求本身），一并挡下。稳定枚举串供前端 i18n。
	if issue.ParentIssueID.Valid {
		writeError(w, http.StatusConflict, "not_a_top_level_requirement")
		return
	}
	if eff := issuestatus.Effective(ctx, h.Queries, issue.WorkspaceID, issue.Status); eff == issuestatus.Done || eff == issuestatus.Cancelled {
		writeError(w, http.StatusConflict, "requirement_already_terminal")
		return
	}
	if issue.AcceptanceRound > 3 {
		writeError(w, http.StatusConflict, "acceptance_failed")
		return
	}

	switch body.Verdict {
	case "pass":
		updated, err := h.Queries.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{
			ID:          issue.ID,
			Status:      "done",
			WorkspaceID: issue.WorkspaceID,
		})
		if err != nil {
			// M-6：DB 原始错误（含 SQL 片段/表名/约束名）不回吐客户端，仅落服务端日志。
			slog.Error("acceptance pass: mark requirement done failed",
				"error", err, "issue_id", uuidToString(issue.ID))
			writeError(w, http.StatusInternalServerError, "failed to mark requirement done")
			return
		}
		// M-2：复用平台既有 done 转换副作用——通知父级（root 无父，re-check 后 no-op 安全）
		// + 发 EventIssueUpdated，让看板/列表实时刷新（对照 github.go advanceIssueToDone 契约）。
		h.notifyParentOfChildDone(ctx, issue, updated)
		h.publishAcceptanceIssueUpdated(ctx, issue, updated, "acceptance_pass")
		writeJSON(w, http.StatusOK, map[string]any{
			"verdict":          "pass",
			"acceptance_round": updated.AcceptanceRound,
			"terminal":         true,
		})
	case "fail":
		// M-1 + H-2：round CAS（带期望值守卫）与修复子任务创建同事务——并发 fail 只有
		// 一个能 CAS 命中（另一个 0 行→409），杜绝重复修复子任务与 round 无限增长；
		// AllocateIssueNumber 也走同一 tx，满足配额计数器显式事务契约（service/issue_limit.go，
		// 镜像 requirement_decompose.go 正确用法）。
		tx, err := h.TxStarter.Begin(ctx)
		if err != nil {
			slog.Error("acceptance fail: begin tx failed", "error", err, "issue_id", uuidToString(issue.ID))
			writeError(w, http.StatusInternalServerError, "failed to record acceptance verdict")
			return
		}
		defer tx.Rollback(ctx) //nolint:errcheck // Commit 成功后 Rollback 为 no-op
		qtx := h.Queries.WithTx(tx)

		newRound, err := qtx.IncrementAcceptanceRoundIfExpected(ctx, db.IncrementAcceptanceRoundIfExpectedParams{
			ID:       issue.ID,
			Expected: issue.AcceptanceRound,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// 期望值不再匹配 = 并发裁决已抢先推进 round；本次转 409 让客户端重读最新态。
				writeError(w, http.StatusConflict, "acceptance_round_conflict")
				return
			}
			slog.Error("acceptance fail: increment acceptance_round failed",
				"error", err, "issue_id", uuidToString(issue.ID))
			writeError(w, http.StatusInternalServerError, "failed to record acceptance verdict")
			return
		}

		// 越界终态（spec §6 第 10 态 / 开放问题 #4）：累计 >3 轮仍打回 = 验收失败，
		// 不再建修复子任务，提交 round 后发人工仲裁 system 评论；派生投影据
		// acceptance_round>3 显示「验收失败」。
		if newRound > 3 {
			if err := tx.Commit(ctx); err != nil {
				slog.Error("acceptance fail: commit round failed", "error", err, "issue_id", uuidToString(issue.ID))
				writeError(w, http.StatusInternalServerError, "failed to record acceptance verdict")
				return
			}
			h.postAcceptanceFailedComment(ctx, issue, newRound, body.Evidence)
			// 派生态转「验收失败」——重读拿到最新 acceptance_round 后广播，让其他客户端
			// 看板同步（best-effort，重读失败仅跳过广播，round 已落库）。
			if fresh, ferr := h.Queries.GetIssue(ctx, issue.ID); ferr == nil {
				h.publishAcceptanceIssueUpdated(ctx, issue, fresh, "acceptance_failed")
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"verdict":          "fail",
				"acceptance_round": newRound,
				"terminal":         true,
			})
			return
		}

		repair, err := h.createAcceptanceRepairTask(ctx, tx, qtx, issue, newRound, body.Evidence)
		if err != nil {
			// M-6：不回吐 DB 原始错误；tx 由 defer Rollback 回退 round，避免脏状态。
			slog.Error("acceptance fail: create repair task failed",
				"error", err, "issue_id", uuidToString(issue.ID))
			writeError(w, http.StatusInternalServerError, "failed to create repair task")
			return
		}
		if err := tx.Commit(ctx); err != nil {
			slog.Error("acceptance fail: commit repair task failed", "error", err, "issue_id", uuidToString(issue.ID))
			writeError(w, http.StatusInternalServerError, "failed to create repair task")
			return
		}
		// M-2：修复子 issue 建成后发 EventIssueCreated，payload 形状同既有 CreateIssue
		// 广播（map{"issue": IssueResponse}），前端列表实时出现新子任务。
		h.publishRepairIssueCreated(ctx, repair)
		// 入队 best-effort：assignee 无 runtime / 已归档时 EnqueueTaskForIssue 返回 error，
		// 记录但不回滚 round 与修复子任务（子任务已建，后续可人工重派）。
		if _, err := h.TaskService.EnqueueTaskForIssue(ctx, repair); err != nil {
			slog.Warn("acceptance fail: enqueue repair task failed",
				"error", err, "repair_id", uuidToString(repair.ID))
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"verdict":          "fail",
			"acceptance_round": newRound,
			"terminal":         false,
			"repair_issue_id":  uuidToString(repair.ID),
		})
	default:
		writeError(w, http.StatusBadRequest, "verdict must be pass or fail")
	}
}

// publishAcceptanceIssueUpdated 复用平台 EventIssueUpdated 广播形状（对照 github.go
// advanceIssueToDone / issue.go UpdateIssue），让看板与列表实时反映验收引起的状态/派生态
// 变化。best-effort：投影已落库，广播本身失败无需回滚。
func (h *Handler) publishAcceptanceIssueUpdated(ctx context.Context, prev, updated db.Issue, source string) {
	prefix := h.getIssuePrefix(ctx, updated.WorkspaceID)
	resp := issueToResponse(updated, prefix)
	h.fillStatusCategory(ctx, updated.WorkspaceID, &resp)
	h.publish(protocol.EventIssueUpdated, uuidToString(updated.WorkspaceID), "system", "", map[string]any{
		"issue":          resp,
		"status_changed": prev.Status != updated.Status,
		"prev_status":    prev.Status,
		"source":         source,
	})
}

// publishRepairIssueCreated 广播验收修复子任务的创建，payload 形状与既有 CreateIssue
// 广播一致（map{"issue": IssueResponse}），前端列表实时出现新子任务。
func (h *Handler) publishRepairIssueCreated(ctx context.Context, repair db.Issue) {
	prefix := h.getIssuePrefix(ctx, repair.WorkspaceID)
	resp := issueToResponse(repair, prefix)
	h.fillStatusCategory(ctx, repair.WorkspaceID, &resp)
	h.publish(protocol.EventIssueCreated, uuidToString(repair.WorkspaceID), "system", "", map[string]any{"issue": resp})
}

// createAcceptanceRepairTask 为验收打回新建一个 stage3 修复子任务（status=todo）。
// assignee 优先取需求班底第一个 enabled 'dev'，缺省回落需求自身 assignee；root/module/
// project/priority 全部继承需求，保证 WS3 组锁与派生投影把它算进同一需求组。
//
// H-2：tx/qtx 由调用方（RecordAcceptanceVerdict fail 分支）传入，NextTopPosition /
// AllocateIssueNumber / CreateIssue 三步全走同一事务，与 round CAS 同生共死。
func (h *Handler) createAcceptanceRepairTask(ctx context.Context, tx pgx.Tx, qtx *db.Queries, req db.Issue, round int32, evidence string) (db.Issue, error) {
	assigneeType, assigneeID := h.resolveRepairAssignee(ctx, qtx, req)

	rootID := req.RootRequirementID
	if !rootID.Valid {
		rootID = req.ID
	}
	description := "## 验收打回（第 " + strconv.Itoa(int(round)) + " 轮）\n\n" + evidence
	// H-2：NextTopPosition 走 tx（queryRower 接口），AllocateIssueNumber/CreateIssue 走 qtx，
	// 满足 AllocateIssueNumber 的显式事务契约（配额拒绝时计数器随 tx 回滚不泄漏，
	// 并发配额检查在 tx 内串行化，中途失败不留脏状态）。镜像 requirement_decompose.go。
	position, err := issueposition.NextTopPosition(ctx, tx, req.WorkspaceID, "todo")
	if err != nil {
		return db.Issue{}, fmt.Errorf("next top position: %w", err)
	}
	policy := service.ResolveIssueCountPolicy(ctx, h.Entitlements, req.WorkspaceID)
	number, err := service.AllocateIssueNumber(ctx, qtx, req.WorkspaceID, policy)
	if err != nil {
		return db.Issue{}, fmt.Errorf("allocate issue number: %w", err)
	}
	return qtx.CreateIssue(ctx, db.CreateIssueParams{
		ID:                dbid.NewV7(),
		WorkspaceID:       req.WorkspaceID,
		Title:             "验收修复（第 " + strconv.Itoa(int(round)) + " 轮）：" + req.Title,
		Description:       pgtype.Text{String: description, Valid: true},
		Status:            "todo",
		Priority:          req.Priority,
		AssigneeType:      pgtype.Text{String: assigneeType, Valid: assigneeType != ""},
		AssigneeID:        assigneeID,
		// L-5：plan §WS4 写 CreatorType="system"，但 001_init 的 issue.creator_type CHECK
		// 只允许 member/agent，"system" 会被拒；故取 member + 零 UUID 作为「非真人发起」的
		// 既有妥协约定（与 postAcceptanceFailedComment 的 system 评论 author_id 零 UUID 同源）。
		// 如需可辨识来源，后续改走 origin_type/origin_id，不改 creator_type CHECK。
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
// qtx 与修复子任务同事务，保证班底读取与写入一致性快照。
func (h *Handler) resolveRepairAssignee(ctx context.Context, qtx *db.Queries, req db.Issue) (string, pgtype.UUID) {
	roster, err := qtx.ListIssueRoleAssignments(ctx, req.ID)
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
