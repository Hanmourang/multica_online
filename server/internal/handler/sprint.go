package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// 迭代（Sprint）：项目下的时间盒工作集合，CoCo 对标 plan 20261024 §02。
// planned → active → completed 状态机全部走 CAS（WHERE 带期望状态），并发双
// start/complete 只有一个能命中；issue 通过 issue.sprint_id 归属迭代，
// 未归属 = backlog。范式对齐 requirement_acceptance.go / project_module.go。

// SprintResponse 是迭代 API 的 JSON 形状。IssueCount / DoneCount 仅列表查询
// 填充（LEFT JOIN issue 聚合）；单条查询走 sprintToResponse，两列为 0，前端
// 需要精确进度时读 GET /progress。
type SprintResponse struct {
	ID            string  `json:"id"`
	WorkspaceID   string  `json:"workspace_id"`
	ProjectID     string  `json:"project_id"`
	Name          string  `json:"name"`
	Goal          *string `json:"goal"`
	Status        string  `json:"status"`
	StartDate     *string `json:"start_date"`
	EndDate       *string `json:"end_date"`
	Capacity      *int32  `json:"capacity"`
	CreatedByType string  `json:"created_by_type"`
	CreatedByID   string  `json:"created_by_id"`
	StartedAt     *string `json:"started_at"`
	CompletedAt   *string `json:"completed_at"`
	CreatedAt     string  `json:"created_at"`
	UpdatedAt     string  `json:"updated_at"`
	IssueCount    int32   `json:"issue_count"`
	DoneCount     int32   `json:"done_count"`
}

func sprintToResponse(s db.Sprint) SprintResponse {
	return SprintResponse{
		ID:            uuidToString(s.ID),
		WorkspaceID:   uuidToString(s.WorkspaceID),
		ProjectID:     uuidToString(s.ProjectID),
		Name:          s.Name,
		Goal:          textToPtr(s.Goal),
		Status:        s.Status,
		StartDate:     dateToPtr(s.StartDate),
		EndDate:       dateToPtr(s.EndDate),
		Capacity:      int4ToPtr(s.Capacity),
		CreatedByType: s.CreatedByType,
		CreatedByID:   uuidToString(s.CreatedByID),
		StartedAt:     timestampToPtr(s.StartedAt),
		CompletedAt:   timestampToPtr(s.CompletedAt),
		CreatedAt:     timestampToString(s.CreatedAt),
		UpdatedAt:     timestampToString(s.UpdatedAt),
	}
}

// sprintID 解析路径参数 {sprintId} 并加载迭代；不存在 / 跨 workspace → 404。
func (h *Handler) loadSprint(w http.ResponseWriter, r *http.Request, project db.Project) (db.Sprint, bool) {
	sprintUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "sprintId"), "sprint id")
	if !ok {
		return db.Sprint{}, false
	}
	sprint, err := h.Queries.GetSprint(r.Context(), db.GetSprintParams{
		ID:          sprintUUID,
		WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.Error("load sprint failed", "error", err, "project_id", uuidToString(project.ID))
		}
		writeError(w, http.StatusNotFound, "sprint not found")
		return db.Sprint{}, false
	}
	// 迭代必须归属所请求项目：{id} 与 {sprintId} 错配按 404 处理（不泄露存在性）。
	if sprint.ProjectID != project.ID {
		writeError(w, http.StatusNotFound, "sprint not found")
		return db.Sprint{}, false
	}
	return sprint, true
}

// parseSprintDates 校验 start/end 日期（YYYY-MM-DD）。
// 返回 (start, end, 是否出错)；出错时已写好 400 响应。
func parseSprintDates(w http.ResponseWriter, startStr, endStr string, hasStart, hasEnd bool, curStart, curEnd pgtype.Date) (pgtype.Date, pgtype.Date, bool) {
	start, end := curStart, curEnd
	if hasStart {
		if startStr == "" {
			start = pgtype.Date{}
		} else {
			d, err := util.ParseCalendarDate(startStr)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid start_date format, expected YYYY-MM-DD")
				return start, end, false
			}
			start = d
		}
	}
	if hasEnd {
		if endStr == "" {
			end = pgtype.Date{}
		} else {
			d, err := util.ParseCalendarDate(endStr)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid end_date format, expected YYYY-MM-DD")
				return start, end, false
			}
			end = d
		}
	}
	if start.Valid && end.Valid && end.Time.Before(start.Time) {
		writeError(w, http.StatusBadRequest, "end_date must not be before start_date")
		return start, end, false
	}
	return start, end, true
}

// CreateSprintRequest 是 POST /api/projects/{id}/sprints 的 body。
type CreateSprintRequest struct {
	Name      string `json:"name"`
	Goal      string `json:"goal"`
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
	Capacity  *int32 `json:"capacity"`
}

// CreateSprint 处理 POST /api/projects/{id}/sprints。
// (project_id, name) 唯一冲突 → 409 sprint_name_exists；end<start → 400。
func (h *Handler) CreateSprint(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req CreateSprintRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len([]rune(req.Name)) > 80 {
		writeError(w, http.StatusBadRequest, "name is required and must be at most 80 characters")
		return
	}
	if req.Capacity != nil && *req.Capacity <= 0 {
		writeError(w, http.StatusBadRequest, "capacity must be positive when provided")
		return
	}
	start, end, ok := parseSprintDates(w, req.StartDate, req.EndDate, req.StartDate != "", req.EndDate != "", pgtype.Date{}, pgtype.Date{})
	if !ok {
		return
	}
	capacity := pgtype.Int4{}
	if req.Capacity != nil {
		capacity = pgtype.Int4{Int32: *req.Capacity, Valid: true}
	}
	creator, _ := h.parseUserUUIDOrZero(userID)
	var goal pgtype.Text
	if trimmed := strings.TrimSpace(req.Goal); trimmed != "" {
		goal = pgtype.Text{String: trimmed, Valid: true}
	}
	sprint, err := h.Queries.CreateSprint(r.Context(), db.CreateSprintParams{
		WorkspaceID:   project.WorkspaceID,
		ProjectID:     project.ID,
		Name:          req.Name,
		Goal:          goal,
		Status:        "planned",
		StartDate:     start,
		EndDate:       end,
		Capacity:      capacity,
		CreatedByType: "member",
		CreatedByID:   creator,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "sprint_name_exists")
			return
		}
		// M-6：DB 原始错误不回吐客户端，仅落服务端日志。
		slog.Error("create sprint failed", "error", err, "project_id", uuidToString(project.ID))
		writeError(w, http.StatusInternalServerError, "failed to create sprint")
		return
	}
	resp := sprintToResponse(sprint)
	h.publish(protocol.EventSprintUpdated, uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"sprint": resp, "action": "created", "project_id": uuidToString(project.ID)})
	writeJSON(w, http.StatusCreated, resp)
}

// ListSprints 处理 GET /api/projects/{id}/sprints?status=planned|active|completed。
func (h *Handler) ListSprints(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var statusFilter pgtype.Text
	if s := r.URL.Query().Get("status"); s != "" {
		statusFilter = pgtype.Text{String: s, Valid: true}
	}
	rows, err := h.Queries.ListSprints(r.Context(), db.ListSprintsParams{
		WorkspaceID: project.WorkspaceID,
		ProjectID:   project.ID,
		Status:      statusFilter,
	})
	if err != nil {
		slog.Error("list sprints failed", "error", err, "project_id", uuidToString(project.ID))
		writeError(w, http.StatusInternalServerError, "failed to list sprints")
		return
	}
	resp := make([]SprintResponse, len(rows))
	for i, row := range rows {
		resp[i] = SprintResponse{
			ID:            uuidToString(row.ID),
			WorkspaceID:   uuidToString(row.WorkspaceID),
			ProjectID:     uuidToString(row.ProjectID),
			Name:          row.Name,
			Goal:          textToPtr(row.Goal),
			Status:        row.Status,
			StartDate:     dateToPtr(row.StartDate),
			EndDate:       dateToPtr(row.EndDate),
			Capacity:      int4ToPtr(row.Capacity),
			CreatedByType: row.CreatedByType,
			CreatedByID:   uuidToString(row.CreatedByID),
			StartedAt:     timestampToPtr(row.StartedAt),
			CompletedAt:   timestampToPtr(row.CompletedAt),
			CreatedAt:     timestampToString(row.CreatedAt),
			UpdatedAt:     timestampToString(row.UpdatedAt),
			IssueCount:    row.IssueCount,
			DoneCount:     row.DoneCount,
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sprints": resp, "total": len(resp)})
}

// GetSprint 处理 GET /api/projects/{id}/sprints/{sprintId}。
func (h *Handler) GetSprint(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	sprint, ok := h.loadSprint(w, r, project)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, sprintToResponse(sprint))
}

// UpdateSprintRequest 是 PATCH /api/projects/{id}/sprints/{sprintId} 的 body。
// 指针字段省略即保持原值（对照 UpdateProjectModule）；goal 传空串 = 清空。
type UpdateSprintRequest struct {
	Name      *string `json:"name"`
	Goal      *string `json:"goal"`
	StartDate *string `json:"start_date"`
	EndDate   *string `json:"end_date"`
	Capacity  *int32  `json:"capacity"`
}

// UpdateSprint 处理 PATCH。completed 迭代的名称/日期改动会破坏时间盒语义，
// 一并 CAS 拒绝吗？——不：日期编辑仍允许（历史时间盒修正），只有改名/容量受
// 状态机影响最小，全部字段允许在任意状态修改；启停仍走专用 endpoint。
func (h *Handler) UpdateSprint(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	sprint, ok := h.loadSprint(w, r, project)
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req UpdateSprintRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := sprint.Name
	if req.Name != nil {
		name = strings.TrimSpace(*req.Name)
		if name == "" || len([]rune(name)) > 80 {
			writeError(w, http.StatusBadRequest, "name must be between 1 and 80 characters")
			return
		}
	}
	goal := sprint.Goal
	if req.Goal != nil {
		goal = pgtype.Text{String: strings.TrimSpace(*req.Goal), Valid: strings.TrimSpace(*req.Goal) != ""}
	}
	capacity := sprint.Capacity
	if req.Capacity != nil {
		if *req.Capacity <= 0 {
			writeError(w, http.StatusBadRequest, "capacity must be positive")
			return
		}
		capacity = pgtype.Int4{Int32: *req.Capacity, Valid: true}
	}
	hasStart := req.StartDate != nil
	hasEnd := req.EndDate != nil
	start, end, ok := parseSprintDates(w, dereq(req.StartDate), dereq(req.EndDate), hasStart, hasEnd, sprint.StartDate, sprint.EndDate)
	if !ok {
		return
	}
	updated, err := h.Queries.UpdateSprint(r.Context(), db.UpdateSprintParams{
		ID:          sprint.ID,
		WorkspaceID: project.WorkspaceID,
		Name:        name,
		Goal:        goal,
		StartDate:   start,
		EndDate:     end,
		Capacity:    capacity,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "sprint_name_exists")
			return
		}
		slog.Error("update sprint failed", "error", err, "sprint_id", uuidToString(sprint.ID))
		writeError(w, http.StatusInternalServerError, "failed to update sprint")
		return
	}
	resp := sprintToResponse(updated)
	h.publish(protocol.EventSprintUpdated, uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"sprint": resp, "action": "updated", "project_id": uuidToString(project.ID)})
	writeJSON(w, http.StatusOK, resp)
}

func dereq(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// DeleteSprint 处理 DELETE。仅 planned 可删（active/completed 承载执行事实，
// 只能 complete 归档）；删除后成员经 FK SET NULL 回落 backlog，逐条广播
// issue:updated 让看板同步。
func (h *Handler) DeleteSprint(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	sprint, ok := h.loadSprint(w, r, project)
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if sprint.Status != "planned" {
		writeError(w, http.StatusConflict, "sprint_not_planned")
		return
	}
	// 删除前抓取成员列表：FK SET NULL 静默清引用，看板需要显式 issue:updated 广播。
	members, err := h.Queries.ListSprintIssues(r.Context(), db.ListSprintIssuesParams{
		SprintID:    sprint.ID,
		WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		slog.Error("list sprint issues before delete failed", "error", err, "sprint_id", uuidToString(sprint.ID))
		writeError(w, http.StatusInternalServerError, "failed to delete sprint")
		return
	}
	if err := h.Queries.DeleteSprint(r.Context(), sprint.ID); err != nil {
		slog.Error("delete sprint failed", "error", err, "sprint_id", uuidToString(sprint.ID))
		writeError(w, http.StatusInternalServerError, "failed to delete sprint")
		return
	}
	h.publish(protocol.EventSprintUpdated, uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"sprint_id": uuidToString(sprint.ID), "action": "deleted", "project_id": uuidToString(project.ID)})
	h.publishSprintMembershipChanged(r.Context(), project.WorkspaceID, userID, sprint.ID, members)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// runSprintTransition 执行 start/complete/reopen 的 CAS 迁移：0 行 = 状态不
// 匹配（并发或非法迁移）→ 409 <notXCode>。成功后广播 sprint:updated。
func (h *Handler) runSprintTransition(
	w http.ResponseWriter, r *http.Request, project db.Project, sprint db.Sprint,
	action string, cas func(context.Context) (db.Sprint, error), conflictCode string,
) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	updated, err := cas(r.Context())
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusConflict, conflictCode)
			return
		}
		slog.Error("sprint transition failed", "error", err, "sprint_id", uuidToString(sprint.ID), "action", action)
		writeError(w, http.StatusInternalServerError, "failed to update sprint status")
		return
	}
	resp := sprintToResponse(updated)
	h.publish(protocol.EventSprintUpdated, uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"sprint": resp, "action": action, "project_id": uuidToString(project.ID)})
	writeJSON(w, http.StatusOK, resp)
}

// StartSprint 处理 POST /api/projects/{id}/sprints/{sprintId}/start（planned→active）。
func (h *Handler) StartSprint(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	sprint, ok := h.loadSprint(w, r, project)
	if !ok {
		return
	}
	h.runSprintTransition(w, r, project, sprint, "started",
		func(ctx context.Context) (db.Sprint, error) { return h.Queries.StartSprint(ctx, sprint.ID) },
		"sprint_not_planned")
}

// CompleteSprint 处理 POST /api/projects/{id}/sprints/{sprintId}/complete（active→completed）。
func (h *Handler) CompleteSprint(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	sprint, ok := h.loadSprint(w, r, project)
	if !ok {
		return
	}
	h.runSprintTransition(w, r, project, sprint, "completed",
		func(ctx context.Context) (db.Sprint, error) { return h.Queries.CompleteSprint(ctx, sprint.ID) },
		"sprint_not_active")
}

// ReopenSprint 处理 POST /api/projects/{id}/sprints/{sprintId}/reopen（completed→active）。
func (h *Handler) ReopenSprint(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	sprint, ok := h.loadSprint(w, r, project)
	if !ok {
		return
	}
	h.runSprintTransition(w, r, project, sprint, "reopened",
		func(ctx context.Context) (db.Sprint, error) { return h.Queries.ReopenSprint(ctx, sprint.ID) },
		"sprint_not_completed")
}

// sprintIssuesRequest 是纳入/移出的 body：{issue_ids: [...]}。
type sprintIssuesRequest struct {
	IssueIDs []string `json:"issue_ids"`
}

// parseSprintIssueIDs 解码 body 并解析 UUID 列表（畸形 → 400，已写响应）。
func parseSprintIssueIDs(w http.ResponseWriter, r *http.Request) ([]pgtype.UUID, bool) {
	var req sprintIssuesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return nil, false
	}
	if len(req.IssueIDs) == 0 {
		writeError(w, http.StatusBadRequest, "issue_ids must not be empty")
		return nil, false
	}
	ids := make([]pgtype.UUID, 0, len(req.IssueIDs))
	for _, raw := range req.IssueIDs {
		id, ok := parseUUIDOrBadRequest(w, raw, "issue id")
		if !ok {
			return nil, false
		}
		ids = append(ids, id)
	}
	return ids, true
}

// AssignSprintIssues 处理 POST /api/projects/{id}/sprints/{sprintId}/issues。
// 事务内校验每个 issue 属同 workspace（防串租）；completed 迭代拒绝纳入 → 409。
func (h *Handler) AssignSprintIssues(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	sprint, ok := h.loadSprint(w, r, project)
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if sprint.Status == "completed" {
		writeError(w, http.StatusConflict, "sprint_completed")
		return
	}
	issueIDs, ok := parseSprintIssueIDs(w, r)
	if !ok {
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		slog.Error("assign sprint issues: begin tx failed", "error", err, "sprint_id", uuidToString(sprint.ID))
		writeError(w, http.StatusInternalServerError, "failed to assign issues to sprint")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck // Commit 成功后 Rollback 为 no-op
	qtx := h.Queries.WithTx(tx)

	affected := make([]db.Issue, 0, len(issueIDs))
	for _, id := range issueIDs {
		issue, err := qtx.GetIssue(r.Context(), id)
		if err != nil || issue.WorkspaceID != project.WorkspaceID {
			// 跨租户/不存在统一 404 语义：批量操作中一个不合格整单拒绝，
			// 避免部分纳入造成前端与事实不一致。
			writeError(w, http.StatusNotFound, "issue not found")
			return
		}
		affected = append(affected, issue)
	}
	if err := qtx.AssignIssuesToSprint(r.Context(), db.AssignIssuesToSprintParams{
		SprintID:    sprint.ID,
		WorkspaceID: project.WorkspaceID,
		IssueIds:    issueIDs,
	}); err != nil {
		slog.Error("assign sprint issues failed", "error", err, "sprint_id", uuidToString(sprint.ID))
		writeError(w, http.StatusInternalServerError, "failed to assign issues to sprint")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("assign sprint issues: commit failed", "error", err, "sprint_id", uuidToString(sprint.ID))
		writeError(w, http.StatusInternalServerError, "failed to assign issues to sprint")
		return
	}
	h.publish(protocol.EventSprintIssuesChanged, uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"sprint_id": uuidToString(sprint.ID), "project_id": uuidToString(project.ID), "action": "assigned", "issue_ids": len(issueIDs)})
	h.publishSprintMembershipChanged(r.Context(), project.WorkspaceID, userID, sprint.ID, affected)
	writeJSON(w, http.StatusOK, map[string]any{"assigned": len(issueIDs)})
}

// RemoveSprintIssues 处理 DELETE /api/projects/{id}/sprints/{sprintId}/issues。
// 移出对任意状态可用（completed 迭代也允许纠错性移出）。
func (h *Handler) RemoveSprintIssues(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	sprint, ok := h.loadSprint(w, r, project)
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	issueIDs, ok := parseSprintIssueIDs(w, r)
	if !ok {
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		slog.Error("remove sprint issues: begin tx failed", "error", err, "sprint_id", uuidToString(sprint.ID))
		writeError(w, http.StatusInternalServerError, "failed to remove issues from sprint")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	qtx := h.Queries.WithTx(tx)

	affected := make([]db.Issue, 0, len(issueIDs))
	for _, id := range issueIDs {
		issue, err := qtx.GetIssue(r.Context(), id)
		if err != nil || issue.WorkspaceID != project.WorkspaceID {
			writeError(w, http.StatusNotFound, "issue not found")
			return
		}
		affected = append(affected, issue)
	}
	if err := qtx.RemoveIssuesFromSprint(r.Context(), db.RemoveIssuesFromSprintParams{
		WorkspaceID: project.WorkspaceID,
		IssueIds:    issueIDs,
		SprintID:    sprint.ID,
	}); err != nil {
		slog.Error("remove sprint issues failed", "error", err, "sprint_id", uuidToString(sprint.ID))
		writeError(w, http.StatusInternalServerError, "failed to remove issues from sprint")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("remove sprint issues: commit failed", "error", err, "sprint_id", uuidToString(sprint.ID))
		writeError(w, http.StatusInternalServerError, "failed to remove issues from sprint")
		return
	}
	h.publish(protocol.EventSprintIssuesChanged, uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"sprint_id": uuidToString(sprint.ID), "project_id": uuidToString(project.ID), "action": "removed", "issue_ids": len(issueIDs)})
	h.publishSprintMembershipChanged(r.Context(), project.WorkspaceID, userID, sprint.ID, affected)
	writeJSON(w, http.StatusOK, map[string]any{"removed": len(issueIDs)})
}

// publishSprintMembershipChanged 对每个受影响 issue 广播 issue:updated，payload
// 形状对照 publishAcceptanceIssueUpdated，让看板/列表实时反映 sprint_id 变化。
// best-effort：sprint 归属已落库，单条广播失败仅跳过该条。
func (h *Handler) publishSprintMembershipChanged(ctx context.Context, workspaceID pgtype.UUID, userID string, sprintID pgtype.UUID, issues []db.Issue) {
	prefix := h.getIssuePrefix(ctx, workspaceID)
	ws := uuidToString(workspaceID)
	for _, issue := range issues {
		resp := issueToResponse(issue, prefix)
		h.fillStatusCategory(ctx, issue.WorkspaceID, &resp)
		h.publish(protocol.EventIssueUpdated, ws, "member", userID, map[string]any{
			"issue":          resp,
			"sprint_changed": true,
			"sprint_id":      uuidToString(sprintID),
			"status_changed": false,
			"source":         "sprint_membership",
		})
	}
}

// GetSprintProgress 处理 GET /api/projects/{id}/sprints/{sprintId}/progress。
// 完成度派生不落列；capacity 为空时前端不显示容量。
func (h *Handler) GetSprintProgress(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	sprint, ok := h.loadSprint(w, r, project)
	if !ok {
		return
	}
	row, err := h.Queries.GetSprintProgress(r.Context(), db.GetSprintProgressParams{
		SprintID:    sprint.ID,
		WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		slog.Error("get sprint progress failed", "error", err, "sprint_id", uuidToString(sprint.ID))
		writeError(w, http.StatusInternalServerError, "failed to get sprint progress")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"done_count":      row.DoneCount,
		"cancelled_count": row.CancelledCount,
		"total_count":     row.TotalCount,
		"capacity":        int4ToPtr(sprint.Capacity),
		"sprint_id":       uuidToString(sprint.ID),
		"sprint_status":   sprint.Status,
	})
}
