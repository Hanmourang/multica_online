package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// 模块（project_module）：项目下的轻量单选枚举，issue 通过 module_id 归属一个模块。
// 核心理念：一个项目通常就是一个产品——同一模块下的修改通过显式依赖串行编排，
// 跨模块的修改默认互不阻塞（勾选「避免冲突」后按模块互斥）。
// spec: docs/superpowers/specs/2026-09-04-module-dependency-scheduling-design.md

// ProjectModuleResponse is the JSON shape returned by the project module API.
type ProjectModuleResponse struct {
	ID          string `json:"id"`
	ProjectID   string `json:"project_id"`
	WorkspaceID string `json:"workspace_id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	CreatedAt   string `json:"created_at"`
	// 任务数仅在列表查询中填充（模块管理表格）；create/update 响应为 0，
	// 前端以 invalidate 后的列表为准。
	TaskCount int32 `json:"task_count"`
}

func projectModuleToResponse(m db.ProjectModule) ProjectModuleResponse {
	return ProjectModuleResponse{
		ID:          uuidToString(m.ID),
		ProjectID:   uuidToString(m.ProjectID),
		WorkspaceID: uuidToString(m.WorkspaceID),
		Name:        m.Name,
		Color:       m.Color,
		CreatedAt:   timestampToString(m.CreatedAt),
	}
}

// CreateProjectModuleRequest is the body for POST /api/projects/{id}/modules.
type CreateProjectModuleRequest struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

// UpdateProjectModuleRequest is the body for PATCH /api/projects/{id}/modules/{moduleId}.
// Every field is optional; omitted fields keep their current value.
type UpdateProjectModuleRequest struct {
	Name  *string `json:"name"`
	Color *string `json:"color"`
}

// ListProjectModules returns the modules defined on a project.
func (h *Handler) ListProjectModules(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	modules, err := h.Queries.ListProjectModules(r.Context(), project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project modules")
		return
	}
	resp := make([]ProjectModuleResponse, len(modules))
	for i, m := range modules {
		// sqlc flattens `m.*` + the count into one row struct rather than
		// embedding ProjectModule, so the shared converter does not apply.
		resp[i] = ProjectModuleResponse{
			ID:          uuidToString(m.ID),
			ProjectID:   uuidToString(m.ProjectID),
			WorkspaceID: uuidToString(m.WorkspaceID),
			Name:        m.Name,
			Color:       m.Color,
			CreatedAt:   timestampToString(m.CreatedAt),
			TaskCount:   m.TaskCount,
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"modules": resp, "total": len(resp)})
}

// CreateProjectModule defines a new module on a project. The name is unique
// per project; duplicates are rejected with 409.
func (h *Handler) CreateProjectModule(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req CreateProjectModuleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	req.Color = strings.TrimSpace(req.Color)
	if req.Color == "" {
		req.Color = "#8A8F98"
	}
	module, err := h.Queries.CreateProjectModule(r.Context(), db.CreateProjectModuleParams{
		ProjectID:   project.ID,
		WorkspaceID: project.WorkspaceID,
		Name:        req.Name,
		Color:       req.Color,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "module name already exists in this project")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to create project module")
		return
	}
	resp := projectModuleToResponse(module)
	h.publish(
		protocol.EventProjectModuleCreated,
		uuidToString(project.WorkspaceID),
		"member",
		userID,
		map[string]any{"module": resp, "project_id": uuidToString(project.ID)},
	)
	writeJSON(w, http.StatusCreated, resp)
}

// UpdateProjectModule renames/recolors a module. Omitted fields keep their
// current value. Renaming onto an existing name in the same project → 409.
func (h *Handler) UpdateProjectModule(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "moduleId"), "module id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	existing, err := h.Queries.GetProjectModule(r.Context(), moduleUUID)
	if err != nil || existing.ProjectID != project.ID {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	var req UpdateProjectModuleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := existing.Name
	if req.Name != nil {
		name = strings.TrimSpace(*req.Name)
		if name == "" {
			writeError(w, http.StatusBadRequest, "name must not be empty")
			return
		}
	}
	color := existing.Color
	if req.Color != nil {
		color = strings.TrimSpace(*req.Color)
		if color == "" {
			writeError(w, http.StatusBadRequest, "color must not be empty")
			return
		}
	}
	module, err := h.Queries.UpdateProjectModule(r.Context(), db.UpdateProjectModuleParams{
		ID:    moduleUUID,
		Name:  name,
		Color: color,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "module name already exists in this project")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update project module")
		return
	}
	resp := projectModuleToResponse(module)
	h.publish(
		protocol.EventProjectModuleUpdated,
		uuidToString(project.WorkspaceID),
		"member",
		userID,
		map[string]any{"module": resp, "project_id": uuidToString(project.ID)},
	)
	writeJSON(w, http.StatusOK, resp)
}

// DeleteProjectModule removes a module. Issues pointing at it fall back to
// "no module" via the FK's ON DELETE SET NULL, which also releases them from
// any cross-module locking (spec §5: 无模块任务不参与任何锁).
func (h *Handler) DeleteProjectModule(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "moduleId"), "module id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	existing, err := h.Queries.GetProjectModule(r.Context(), moduleUUID)
	if err != nil || existing.ProjectID != project.ID {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	if err := h.Queries.DeleteProjectModule(r.Context(), moduleUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete project module")
		return
	}
	h.publish(
		protocol.EventProjectModuleDeleted,
		uuidToString(project.WorkspaceID),
		"member",
		userID,
		map[string]any{"module_id": uuidToString(moduleUUID), "project_id": uuidToString(project.ID)},
	)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}
