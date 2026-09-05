// 手动触发（spec: 2026-09-04-requirement-calendar-design.md §7.1/§9）：
// POST /issues/{id}/trigger 立即触发一个顶层需求——与 30s sweep 共用
// service.IssueService.TriggerRequirement（manual=true 忽略 start_at 判定），
// triggered_at 幂等守卫不变：已触发再调 → 409。
package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/service"
)

// TriggerRequirement 处理 POST /api/issues/{id}/trigger。
func (h *Handler) TriggerRequirement(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	issue, ok := h.loadIssueForUser(w, r, id)
	if !ok {
		return
	}
	if issue.ParentIssueID.Valid {
		writeError(w, http.StatusBadRequest, "only top-level requirements can be triggered")
		return
	}
	// 终态需求（done/cancelled，含自定义类目）不可触发。
	if eff := issuestatus.Effective(r.Context(), h.Queries, issue.WorkspaceID, issue.Status); eff == "done" || eff == "cancelled" {
		writeError(w, http.StatusConflict, "requirement is already in a terminal status")
		return
	}

	res, err := h.IssueService.TriggerRequirement(r.Context(), issue.ID, true)
	switch {
	case errors.Is(err, service.ErrRequirementAlreadyTriggered):
		writeError(w, http.StatusConflict, "requirement already triggered")
		return
	case errors.Is(err, service.ErrRequirementNotConfirmed):
		writeError(w, http.StatusConflict, "decomposition not confirmed: confirm the decomposition drafts before triggering")
		return
	case errors.Is(err, service.ErrRequirementNotTopLevel):
		writeError(w, http.StatusBadRequest, "only top-level requirements can be triggered")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "failed to trigger requirement")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"triggered":         true,
		"enqueued_children": res.EnqueuedChildren,
		"skipped_children":  res.SkippedChildren,
	})
}
