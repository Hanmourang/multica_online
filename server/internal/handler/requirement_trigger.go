// 手动触发端点（spec: 2026-09-04-requirement-calendar-design.md §7.1 / §9，
// plan: 2026-09-06-requirement-calendar-phase1-completion.md §WS2 Task 2.5）：
// POST /api/issues/{id}/trigger 立即触发一个顶层需求 —— 与 30s sweep 共用
// scheduler.RequirementTriggerService.TriggerRequirementNow，同一套预检 +
// 幂等标记 + stage3 入队，永远不会与 sweep 分叉。
//
// 响应体契约（WS6 前端已按此并行编码，勿改）：
//
//	200 OK: {"triggered": true, "enqueued": <int>, "issue_id": "<uuid>"}
//	4xx/5xx: writeError 标准体 {"error": "<reason or message>"}
//
// 阻断原因（Reason 串，稳定枚举，前端可直接展示 / i18n key）：
//   - 400 not_a_top_level_requirement：目标是子任务（parent_issue_id 非空）
//   - 409 decomposition_not_confirmed：拆解未确认
//   - 409 dependency_cycle：组内 blocked_by 成环
//   - 409 acceptance_spec_missing：无 stage3 子任务写了非空 acceptance_spec
//   - 409 module_window_busy：同模块上有其它 root 组活动任务（v1 桩恒不触发）
//   - 409 already_triggered：MarkRequirementTriggered 返回 0 行（并发触发竞争）
package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/multica-ai/multica/server/internal/scheduler"
	"github.com/multica-ai/multica/server/internal/util"
)

// TriggerRequirement 处理 POST /api/issues/{id}/trigger。
//
// 就地构造 scheduler.RequirementTriggerService（h.Queries + h.TaskService）
// 而不是把服务挂在 Handler struct 上：Handler 结构体本轮 WS 文件范围外，
// 而服务本身是无状态薄壳，每次构造开销可忽略；这样也保证 handler 与 sweep
// 一定用同一份 queries/dispatcher，杜绝装配漂移。
func (h *Handler) TriggerRequirement(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		// loadIssueForUser 已写好 400/403/404 响应，此处直接返回。
		return
	}
	if issue.ParentIssueID.Valid {
		// 只有顶层需求可被触发；子任务由 451 claim 闸门按依赖放行，
		// 不接受显式触发（避免绕过组的预检）。
		writeError(w, http.StatusBadRequest, "only top-level requirements can be triggered")
		return
	}

	svc := scheduler.NewRequirementTriggerService(h.Queries, h.TaskService)
	result, err := svc.TriggerRequirementNow(r.Context(), issue)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to trigger requirement")
		return
	}
	if !result.Pass {
		// 阻断原因串稳定，前端按此做 i18n；HTTP 语义上一律 409（状态冲突：
		// 需求当前状态不允许触发），非顶层已在上面用 400 单独挡下。
		writeError(w, http.StatusConflict, result.Reason)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"triggered": true,
		"enqueued":  result.Enqueued,
		"issue_id":  util.UUIDToString(issue.ID),
	})
}
