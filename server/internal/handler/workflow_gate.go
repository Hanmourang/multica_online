// 工作流门禁 handler（CoCo 对标 plan 20261024 §01 C3，Agent-W）。
//
// 裁决唯一入口 service.DecideGate：仅 waiting 门可决（DecideWorkflowGate CAS），
// loop 超限收敛在 service 内完成；handler 只做归属校验与响应映射。
// 门会话（messages）v1 = root issue 评论流（对齐"消息复用 comment"铁律）。
package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// workflowNewCommentUUID 与 service 侧同形（dbid.NewV7，时间有序）。
func workflowNewCommentUUID() pgtype.UUID {
	return dbid.NewV7()
}

func workflowGateToResponse(g db.WorkflowGateRun) map[string]any {
	return map[string]any{
		"id":              uuidToString(g.ID),
		"instance_id":     uuidToString(g.InstanceID),
		"stage_run_id":    uuidToString(g.StageRunID),
		"round":           g.Round,
		"mode":            g.Mode,
		"state":           g.State,
		"decision":        g.Decision,
		"generation":      g.Generation,
		"parent_id":       uuidToPtr(g.ParentID),
		"decided_by_type": textToPtr(g.DecidedByType),
		"decided_by_id":   uuidToPtr(g.DecidedByID),
		"created_at":      timestampToString(g.CreatedAt),
		"decided_at":      timestampToString(g.DecidedAt),
	}
}

// loadWorkflowGateForRequest 解析 {gid} + 当前 workspace 归属（防串租）。
func (h *Handler) loadWorkflowGateForRequest(w http.ResponseWriter, r *http.Request) (db.WorkflowGateRun, bool) {
	gidUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "gid"), "gate run id")
	if !ok {
		return db.WorkflowGateRun{}, false
	}
	wsUUID, ok := h.workflowWorkspaceFromRequest(w, r)
	if !ok {
		return db.WorkflowGateRun{}, false
	}
	gate, err := h.Queries.GetWorkflowGateRun(r.Context(), db.GetWorkflowGateRunParams{
		ID: gidUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "workflow gate run not found")
		return db.WorkflowGateRun{}, false
	}
	return gate, true
}

type decideWorkflowGateRequest struct {
	Decision string `json:"decision"` // loop | exit
}

// DecideWorkflowGate POST /api/workflow/gate-runs/{gid}/decide
func (h *Handler) DecideWorkflowGate(w http.ResponseWriter, r *http.Request) {
	if !h.requireWorkflowService(w) {
		return
	}
	gate, ok := h.loadWorkflowGateForRequest(w, r)
	if !ok {
		return
	}
	userUUID, ok := workflowUserUUID(w, r)
	if !ok {
		return
	}
	var body decideWorkflowGateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Decision != "loop" && body.Decision != "exit" {
		writeError(w, http.StatusBadRequest, "decision must be loop or exit")
		return
	}
	newGate, inst, err := h.WorkflowService.DecideGate(r.Context(), gate.ID, gate.WorkspaceID, body.Decision, "member", userUUID)
	if err != nil {
		if errors.Is(err, service.ErrWorkflowConflict) {
			writeError(w, http.StatusConflict, "workflow_state_conflict")
			return
		}
		slogWorkflow("decide workflow gate", err)
		writeError(w, http.StatusInternalServerError, "failed to decide workflow gate")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"gate":     workflowGateToResponse(newGate),
		"instance": workflowInstanceToResponse(inst),
	})
}

// ListWorkflowGateMessages GET /api/workflow/gate-runs/{gid}/messages
// 门上下文讨论 = root issue 评论流（v1 复用 comment，不新建会话表）。
func (h *Handler) ListWorkflowGateMessages(w http.ResponseWriter, r *http.Request) {
	gate, ok := h.loadWorkflowGateForRequest(w, r)
	if !ok {
		return
	}
	inst, err := h.Queries.GetWorkflowInstance(r.Context(), db.GetWorkflowInstanceParams{
		ID: gate.InstanceID, WorkspaceID: gate.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "workflow instance not found")
		return
	}
	messages := make([]CommentResponse, 0)
	if inst.RootIssueID.Valid {
		rows, cerr := h.Queries.ListCommentsForIssue(r.Context(), db.ListCommentsForIssueParams{
			IssueID: inst.RootIssueID, WorkspaceID: inst.WorkspaceID, Limit: 200,
		})
		if cerr != nil {
			slogWorkflow("list gate messages", cerr)
			writeError(w, http.StatusInternalServerError, "failed to load gate messages")
			return
		}
		messages = make([]CommentResponse, len(rows))
		for i, c := range rows {
			messages[i] = commentToResponse(c, nil, nil)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"gate_run_id": uuidToString(gate.ID), "messages": messages})
}

type postWorkflowGateMessageRequest struct {
	Content string `json:"content"`
}

// PostWorkflowGateMessage POST /api/workflow/gate-runs/{gid}/messages
// 门边讨论落 root issue comment（author=当前 member）；无 root issue → 409。
func (h *Handler) PostWorkflowGateMessage(w http.ResponseWriter, r *http.Request) {
	gate, ok := h.loadWorkflowGateForRequest(w, r)
	if !ok {
		return
	}
	userUUID, ok := workflowUserUUID(w, r)
	if !ok {
		return
	}
	var body postWorkflowGateMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}
	inst, err := h.Queries.GetWorkflowInstance(r.Context(), db.GetWorkflowInstanceParams{
		ID: gate.InstanceID, WorkspaceID: gate.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "workflow instance not found")
		return
	}
	if !inst.RootIssueID.Valid {
		writeError(w, http.StatusConflict, "instance_without_root_issue")
		return
	}
	comment, err := h.Queries.CreateComment(r.Context(), db.CreateCommentParams{
		ID:          workflowNewCommentUUID(),
		IssueID:     inst.RootIssueID,
		WorkspaceID: inst.WorkspaceID,
		AuthorType:  "member",
		AuthorID:    userUUID,
		Content:     body.Content,
		Type:        "comment",
		ParentID:    pgtype.UUID{Valid: false},
	})
	if err != nil {
		slogWorkflow("post gate message", err)
		writeError(w, http.StatusInternalServerError, "failed to post gate message")
		return
	}
	h.publish(protocol.EventCommentCreated, util.UUIDToString(inst.WorkspaceID), "member", util.UUIDToString(userUUID), map[string]any{
		"comment_id":     uuidToString(comment.ID),
		"issue_id":       uuidToString(inst.RootIssueID),
		"gate_run_id":    uuidToString(gate.ID),
		"workflow_bound": true,
	})
	full, err := h.Queries.GetComment(r.Context(), comment.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read gate message")
		return
	}
	writeJSON(w, http.StatusOK, commentToResponse(full, nil, nil))
}
