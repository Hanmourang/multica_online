// 工作流阶段 handler（CoCo 对标 plan 20261024 §01 C3，Agent-W）。
//
// v1 边界（计划 §01 决议）：transcript = stage task 的 task_message；
// messages = root issue 评论流；sessions / pending-turns / handoff /
// restart-session 为未实现占位（501），接口形状先行，避免前端契约返工。
package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// loadWorkflowStageForRequest 解析 {sid} + 当前 workspace 归属（防串租）。
func (h *Handler) loadWorkflowStageForRequest(w http.ResponseWriter, r *http.Request) (db.WorkflowStageRun, bool) {
	sidUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "sid"), "stage run id")
	if !ok {
		return db.WorkflowStageRun{}, false
	}
	wsUUID, ok := h.workflowWorkspaceFromRequest(w, r)
	if !ok {
		return db.WorkflowStageRun{}, false
	}
	stage, err := h.Queries.GetWorkflowStageRun(r.Context(), db.GetWorkflowStageRunParams{
		ID: sidUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "workflow stage run not found")
		return db.WorkflowStageRun{}, false
	}
	return stage, true
}

// workflowStageInstance 载入 stage 所属实例（root issue / workspace 上下文）。
func (h *Handler) workflowStageInstance(w http.ResponseWriter, r *http.Request, stage db.WorkflowStageRun) (db.WorkflowInstance, bool) {
	inst, err := h.Queries.GetWorkflowInstance(r.Context(), db.GetWorkflowInstanceParams{
		ID: stage.InstanceID, WorkspaceID: stage.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "workflow instance not found")
		return db.WorkflowInstance{}, false
	}
	return inst, true
}

// GetWorkflowStageTranscript GET /api/workflow/stage-runs/{sid}/transcript
// auto stage 的执行流水（task_message 序列）；无 task → 空列表。
func (h *Handler) GetWorkflowStageTranscript(w http.ResponseWriter, r *http.Request) {
	stage, ok := h.loadWorkflowStageForRequest(w, r)
	if !ok {
		return
	}
	messages := make([]map[string]any, 0)
	if stage.TaskID.Valid {
		rows, err := h.Queries.ListTaskMessages(r.Context(), stage.TaskID)
		if err != nil {
			slogWorkflow("list stage transcript", err)
			writeError(w, http.StatusInternalServerError, "failed to load stage transcript")
			return
		}
		for _, m := range rows {
			messages = append(messages, map[string]any{
				"id":         uuidToString(m.ID),
				"seq":        m.Seq,
				"type":       m.Type,
				"tool":       textToPtr(m.Tool),
				"content":    textToPtr(m.Content),
				"input":      json.RawMessage(m.Input),
				"output":     textToPtr(m.Output),
				"created_at": timestampToString(m.CreatedAt),
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"stage_run_id": uuidToString(stage.ID), "task_id": uuidToPtr(stage.TaskID), "messages": messages})
}

// GetWorkflowStageMessages GET /api/workflow/stage-runs/{sid}/messages
// 阶段人机会话 = root issue 评论流（v1 复用 comment 表，不新建会话表）。
func (h *Handler) GetWorkflowStageMessages(w http.ResponseWriter, r *http.Request) {
	stage, ok := h.loadWorkflowStageForRequest(w, r)
	if !ok {
		return
	}
	inst, ok := h.workflowStageInstance(w, r, stage)
	if !ok {
		return
	}
	comments := make([]CommentResponse, 0)
	if inst.RootIssueID.Valid {
		rows, err := h.Queries.ListCommentsForIssue(r.Context(), db.ListCommentsForIssueParams{
			IssueID: inst.RootIssueID, WorkspaceID: inst.WorkspaceID, Limit: 200,
		})
		if err != nil {
			slogWorkflow("list stage messages", err)
			writeError(w, http.StatusInternalServerError, "failed to load stage messages")
			return
		}
		comments = make([]CommentResponse, len(rows))
		for i, c := range rows {
			comments[i] = commentToResponse(c, nil, nil)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"stage_run_id": uuidToString(stage.ID), "messages": comments})
}

// decideStageGate 是 approve（exit）/ loop-back（loop）的合一入口：
// 阶段当前 waiting 门 → service.DecideGate（CAS，0 行 → 409）。
func (h *Handler) decideStageGate(w http.ResponseWriter, r *http.Request, decision string) {
	if !h.requireWorkflowService(w) {
		return
	}
	stage, ok := h.loadWorkflowStageForRequest(w, r)
	if !ok {
		return
	}
	gate, err := h.Queries.GetWaitingGateByStageRun(r.Context(), stage.ID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusConflict, "no_waiting_gate_for_stage")
			return
		}
		slogWorkflow("load waiting gate for stage", err)
		writeError(w, http.StatusInternalServerError, "failed to load stage gate")
		return
	}
	userUUID, ok := workflowUserUUID(w, r)
	if !ok {
		return
	}
	newGate, inst, derr := h.WorkflowService.DecideGate(r.Context(), gate.ID, stage.WorkspaceID, decision, "member", userUUID)
	if derr != nil {
		if errors.Is(derr, service.ErrWorkflowConflict) {
			writeError(w, http.StatusConflict, "workflow_state_conflict")
			return
		}
		slogWorkflow("decide stage gate "+decision, derr)
		writeError(w, http.StatusInternalServerError, "failed to decide stage gate")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"gate":     workflowGateToResponse(newGate),
		"instance": workflowInstanceToResponse(inst),
	})
}

func (h *Handler) ApproveWorkflowStage(w http.ResponseWriter, r *http.Request) {
	h.decideStageGate(w, r, "exit")
}

func (h *Handler) LoopBackWorkflowStage(w http.ResponseWriter, r *http.Request) {
	h.decideStageGate(w, r, "loop")
}

// SkipWorkflowStage POST /api/workflow/stage-runs/{sid}/skip
// pending/running/waiting_gate→skipped（service.SkipStage 收敛副作用）。
func (h *Handler) SkipWorkflowStage(w http.ResponseWriter, r *http.Request) {
	if !h.requireWorkflowService(w) {
		return
	}
	stage, ok := h.loadWorkflowStageForRequest(w, r)
	if !ok {
		return
	}
	inst, ok := h.workflowStageInstance(w, r, stage)
	if !ok {
		return
	}
	if err := h.WorkflowService.SkipStage(r.Context(), inst, stage); err != nil {
		if errors.Is(err, service.ErrWorkflowConflict) {
			writeError(w, http.StatusConflict, "workflow_state_conflict")
			return
		}
		slogWorkflow("skip workflow stage", err)
		writeError(w, http.StatusInternalServerError, "failed to skip workflow stage")
		return
	}
	refreshed, err := h.Queries.GetWorkflowStageRun(r.Context(), db.GetWorkflowStageRunParams{
		ID: stage.ID, WorkspaceID: stage.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read workflow stage")
		return
	}
	writeJSON(w, http.StatusOK, workflowStageRunToResponse(refreshed))
}

// RerunWorkflowStage POST /api/workflow/stage-runs/{sid}/rerun
// done/failed/skipped→pending 重派；实例必须 running（否则 409）。
func (h *Handler) RerunWorkflowStage(w http.ResponseWriter, r *http.Request) {
	if !h.requireWorkflowService(w) {
		return
	}
	stage, ok := h.loadWorkflowStageForRequest(w, r)
	if !ok {
		return
	}
	inst, ok := h.workflowStageInstance(w, r, stage)
	if !ok {
		return
	}
	if err := h.WorkflowService.RerunStage(r.Context(), inst, stage); err != nil {
		if errors.Is(err, service.ErrWorkflowConflict) {
			writeError(w, http.StatusConflict, "workflow_state_conflict")
			return
		}
		slogWorkflow("rerun workflow stage", err)
		writeError(w, http.StatusInternalServerError, "failed to rerun workflow stage")
		return
	}
	refreshed, err := h.Queries.GetWorkflowStageRun(r.Context(), db.GetWorkflowStageRunParams{
		ID: stage.ID, WorkspaceID: stage.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read workflow stage")
		return
	}
	writeJSON(w, http.StatusOK, workflowStageRunToResponse(refreshed))
}

// InterruptWorkflowStage POST /api/workflow/stage-runs/{sid}/interrupt
// 打断运行中的 auto stage：cancel 底层 task；EventTaskCancelled → OnTaskDone
// 把 stage/instance 收敛到 failed（本请求只负责发起取消）。
func (h *Handler) InterruptWorkflowStage(w http.ResponseWriter, r *http.Request) {
	if !h.requireWorkflowService(w) {
		return
	}
	stage, ok := h.loadWorkflowStageForRequest(w, r)
	if !ok {
		return
	}
	if stage.State != "running" || !stage.TaskID.Valid {
		writeError(w, http.StatusConflict, "stage_not_running")
		return
	}
	if _, err := h.WorkflowService.TaskService.CancelTask(r.Context(), stage.TaskID); err != nil {
		slogWorkflow("interrupt workflow stage: cancel task", err)
		writeError(w, http.StatusInternalServerError, "failed to interrupt workflow stage")
		return
	}
	h.publish(protocol.EventWorkflowInstanceState, uuidToString(stage.WorkspaceID), "member", uuidToString(stage.AgentID), map[string]any{
		"instance_id":  uuidToString(stage.InstanceID),
		"stage_run_id": uuidToString(stage.ID),
		"source":       "stage_interrupted",
	})
	writeJSON(w, http.StatusOK, workflowStageRunToResponse(stage))
}

// workflowStageStub：v1 未实现端点的统一响应（形状先行，前端可按契约降级）。
func workflowStageStub(w http.ResponseWriter, r *http.Request, feature string) {
	writeError(w, http.StatusNotImplemented, feature+"_not_implemented")
}

func (h *Handler) GetWorkflowStageSessions(w http.ResponseWriter, r *http.Request) {
	workflowStageStub(w, r, "workflow_stage_sessions")
}

func (h *Handler) GetWorkflowStagePendingTurns(w http.ResponseWriter, r *http.Request) {
	workflowStageStub(w, r, "workflow_stage_pending_turns")
}

func (h *Handler) HandoffWorkflowStage(w http.ResponseWriter, r *http.Request) {
	workflowStageStub(w, r, "workflow_stage_handoff")
}

func (h *Handler) RestartWorkflowStageSession(w http.ResponseWriter, r *http.Request) {
	workflowStageStub(w, r, "workflow_stage_restart_session")
}

// RecheckWorkflowStageAdmission POST /api/workflow/stage-runs/{sid}/recheck
// blocked 阶段的「重新校验准入」手动兜底（plan 20261025 §B3c）：立刻走一遍
// dispatchNextPending 的 blocked→pending 复评分支，返刷新后的阶段快照；
// 非 blocked 阶段 → 409（无意义操作），实例非 running → 409（状态机约束优先）。
func (h *Handler) RecheckWorkflowStageAdmission(w http.ResponseWriter, r *http.Request) {
	if !h.requireWorkflowService(w) {
		return
	}
	stage, ok := h.loadWorkflowStageForRequest(w, r)
	if !ok {
		return
	}
	if stage.State != "blocked" {
		writeError(w, http.StatusConflict, "stage_not_blocked")
		return
	}
	inst, ok := h.workflowStageInstance(w, r, stage)
	if !ok {
		return
	}
	if err := h.WorkflowService.ReevaluateInstance(r.Context(), inst); err != nil {
		if errors.Is(err, service.ErrWorkflowConflict) {
			writeError(w, http.StatusConflict, "workflow_state_conflict")
			return
		}
		slogWorkflow("recheck workflow stage admission", err)
		writeError(w, http.StatusInternalServerError, "failed to recheck workflow stage admission")
		return
	}
	refreshed, err := h.Queries.GetWorkflowStageRun(r.Context(), db.GetWorkflowStageRunParams{
		ID: stage.ID, WorkspaceID: stage.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read workflow stage")
		return
	}
	writeJSON(w, http.StatusOK, workflowStageRunToResponse(refreshed))
}
