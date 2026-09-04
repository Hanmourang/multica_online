package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 角色班底（spec: 2026-09-04-requirement-calendar-design.md §5.2/§9）：
// 项目默认班底（project_role_default）在创建需求时快照为需求班底（issue_role_assignment），
// 之后改项目默认不影响已创建需求。五个角色中 pm/developer 必选（至少一行 enabled），
// prototyper/data/tester 可整体启停；研发角色允许指定多个 agent。
//
// PUT 均为 whole-document replace：客户端一次提交完整班底，服务端在单事务内
// DELETE+INSERT（不能合并为单语句 CTE：WITH 内数据修改语句与主查询共享快照，
// INSERT 看不到同语句 DELETE 的效果，重写已有行会触唯一约束冲突）。

// RoleAssignmentResponse 是项目默认班底与需求班底共用的 JSON 形状。
type RoleAssignmentResponse struct {
	ID           string `json:"id"`
	Role         string `json:"role"`
	AssigneeType string `json:"assignee_type"`
	AssigneeID   string `json:"assignee_id"`
	Enabled      bool   `json:"enabled"`
	Ordinal      int32  `json:"ordinal"`
}

// roleRosterEntry 是 PUT 请求体 entries 的条目；ordinal 由服务端按数组顺序赋，
// 客户端不传（顺序即展示顺序）。
type roleRosterEntry struct {
	Role         string `json:"role"`
	AssigneeType string `json:"assignee_type"`
	AssigneeID   string `json:"assignee_id"`
	Enabled      bool   `json:"enabled"`
}

var rosterRoles = map[string]bool{
	"pm": true, "prototyper": true, "developer": true, "data": true, "tester": true,
}

var rosterAssigneeTypes = map[string]bool{"member": true, "agent": true}

// validateRoster 校验班底条目的形状与完整性约束，返回非 0 的 HTTP 状态码与消息。
// 形状错误（未知 role/类型/非法 uuid）→ 400；完整性冲突（同 role 重复 assignee、
// 必选角色无 enabled 行）→ 409，与创建资源的唯一冲突语义一致。
func validateRoster(entries []roleRosterEntry) (int, string) {
	seen := make(map[string]bool, len(entries))
	pmOK, devOK := false, false
	for _, e := range entries {
		if !rosterRoles[e.Role] {
			return http.StatusBadRequest, "unknown role: " + e.Role
		}
		if !rosterAssigneeTypes[e.AssigneeType] {
			return http.StatusBadRequest, "unknown assignee_type: " + e.AssigneeType
		}
		if _, err := util.ParseUUID(e.AssigneeID); err != nil {
			return http.StatusBadRequest, "invalid assignee_id: " + e.AssigneeID
		}
		key := e.Role + "|" + e.AssigneeType + "|" + e.AssigneeID
		if seen[key] {
			return http.StatusConflict, "duplicate assignee within role " + e.Role
		}
		seen[key] = true
		if e.Enabled {
			switch e.Role {
			case "pm":
				pmOK = true
			case "developer":
				devOK = true
			}
		}
	}
	if !pmOK || !devOK {
		return http.StatusConflict, "pm and developer must each have at least one enabled assignee"
	}
	return 0, ""
}

// marshalRosterEntries 把校验过的条目序列化为 sqlc jsonb_to_recordset 需要的
// JSONB 数组，并按数组顺序赋 ordinal（展示顺序）。
func marshalRosterEntries(entries []roleRosterEntry) []byte {
	type row struct {
		Role         string `json:"role"`
		AssigneeType string `json:"assignee_type"`
		AssigneeID   string `json:"assignee_id"`
		Enabled      bool   `json:"enabled"`
		Ordinal      int    `json:"ordinal"`
	}
	rows := make([]row, len(entries))
	for i, e := range entries {
		rows[i] = row{e.Role, e.AssigneeType, e.AssigneeID, e.Enabled, i}
	}
	payload, _ := json.Marshal(rows)
	return payload
}

func projectRoleDefaultToResponse(r db.ProjectRoleDefault) RoleAssignmentResponse {
	return RoleAssignmentResponse{
		ID:           uuidToString(r.ID),
		Role:         r.Role,
		AssigneeType: r.AssigneeType,
		AssigneeID:   uuidToString(r.AssigneeID),
		Enabled:      r.Enabled,
		Ordinal:      r.Ordinal,
	}
}

func issueRoleAssignmentToResponse(r db.IssueRoleAssignment) RoleAssignmentResponse {
	return RoleAssignmentResponse{
		ID:           uuidToString(r.ID),
		Role:         r.Role,
		AssigneeType: r.AssigneeType,
		AssigneeID:   uuidToString(r.AssigneeID),
		Enabled:      r.Enabled,
		Ordinal:      r.Ordinal,
	}
}

// ListProjectRoleDefaults returns the project's default roster (GET /api/projects/{id}/role-defaults).
func (h *Handler) ListProjectRoleDefaults(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.Queries.ListProjectRoleDefaults(r.Context(), project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project role defaults")
		return
	}
	resp := make([]RoleAssignmentResponse, len(rows))
	for i, row := range rows {
		resp[i] = projectRoleDefaultToResponse(row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": resp, "total": len(resp)})
}

// ReplaceProjectRoleDefaults atomically replaces the project's default roster
// (PUT /api/projects/{id}/role-defaults) and returns the resulting roster.
// DELETE+INSERT 必须在同一事务：半途中断绝不能留下已清空的班底。
func (h *Handler) ReplaceProjectRoleDefaults(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var req struct {
		Entries []roleRosterEntry `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if code, msg := validateRoster(req.Entries); code != 0 {
		writeError(w, code, msg)
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if err := qtx.DeleteProjectRoleDefaults(r.Context(), project.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to replace project role defaults")
		return
	}
	if err := qtx.InsertProjectRoleDefaults(r.Context(), db.InsertProjectRoleDefaultsParams{
		ProjectID:   project.ID,
		WorkspaceID: project.WorkspaceID,
		Entries:     marshalRosterEntries(req.Entries),
	}); err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "duplicate assignee within role")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to replace project role defaults")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit role defaults")
		return
	}
	rows, err := h.Queries.ListProjectRoleDefaults(r.Context(), project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project role defaults")
		return
	}
	resp := make([]RoleAssignmentResponse, len(rows))
	for i, row := range rows {
		resp[i] = projectRoleDefaultToResponse(row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": resp, "total": len(resp)})
}

// ListIssueRoleAssignments returns the requirement's roster snapshot
// (GET /api/issues/{id}/roles)。快照在创建需求时从项目默认拷贝（service.Create）。
func (h *Handler) ListIssueRoleAssignments(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.Queries.ListIssueRoleAssignments(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list issue role assignments")
		return
	}
	resp := make([]RoleAssignmentResponse, len(rows))
	for i, row := range rows {
		resp[i] = issueRoleAssignmentToResponse(row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": resp, "total": len(resp)})
}

// ReplaceIssueRoleAssignments atomically replaces the requirement's roster snapshot
// (PUT /api/issues/{id}/roles)。需求级覆盖只影响当前需求；必选校验同项目默认。
func (h *Handler) ReplaceIssueRoleAssignments(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var req struct {
		Entries []roleRosterEntry `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if code, msg := validateRoster(req.Entries); code != 0 {
		writeError(w, code, msg)
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if err := qtx.DeleteIssueRoleAssignments(r.Context(), issue.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to replace issue role assignments")
		return
	}
	if err := qtx.InsertIssueRoleAssignments(r.Context(), db.InsertIssueRoleAssignmentsParams{
		IssueID:     issue.ID,
		WorkspaceID: issue.WorkspaceID,
		Entries:     marshalRosterEntries(req.Entries),
	}); err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "duplicate assignee within role")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to replace issue role assignments")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit role assignments")
		return
	}
	rows, err := h.Queries.ListIssueRoleAssignments(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list issue role assignments")
		return
	}
	resp := make([]RoleAssignmentResponse, len(rows))
	for i, row := range rows {
		resp[i] = issueRoleAssignmentToResponse(row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": resp, "total": len(resp)})
}
