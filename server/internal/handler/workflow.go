// 工作流模板 handler（CoCo 对标 plan 20261024 §01 C1，Agent-W 主产物）。
//
// 范式严格对照 requirement_acceptance.go / project_resource.go：
//   - loadProjectForResource 拿项目 + workspace 归属（防串租）；
//   - nodes JSON 写入前过 ValidateWorkflowNodes（mode 合法 / next 引用存在 / 图无环）；
//   - M-6：DB 原始错误只落 slog，不回吐客户端；
//   - 写成功后 publish EventWorkflowTemplateChanged，前端 invalidate 模板列表。
package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// WorkflowTemplateResponse 是 workflow_template 的 API 形状。nodes 原样透传
// JSONB（前端 types/workflow.ts 按 WorkflowNode[] 解析）。
type WorkflowTemplateResponse struct {
	ID              string          `json:"id"`
	WorkspaceID     string          `json:"workspace_id"`
	ProjectID       *string         `json:"project_id"`
	Name            string          `json:"name"`
	Description     *string         `json:"description"`
	Status          string          `json:"status"`
	Version         int32           `json:"version"`
	Nodes           json.RawMessage `json:"nodes"`
	Official        bool            `json:"official"`
	SourceProjectID *string         `json:"source_project_id"`
	CreatedByType   string          `json:"created_by_type"`
	CreatedByID     string          `json:"created_by_id"`
	PublishedAt     string          `json:"published_at"`
	ArchivedAt      string          `json:"archived_at"`
	CreatedAt       string          `json:"created_at"`
	UpdatedAt       string          `json:"updated_at"`
	SharedProjectIDs []string       `json:"shared_project_ids"`
}

func (h *Handler) workflowTemplateToResponse(ctx context.Context, tpl db.WorkflowTemplate) WorkflowTemplateResponse {
	resp := WorkflowTemplateResponse{
		ID:              uuidToString(tpl.ID),
		WorkspaceID:     uuidToString(tpl.WorkspaceID),
		ProjectID:       uuidToPtr(tpl.ProjectID),
		Name:            tpl.Name,
		Description:     textToPtr(tpl.Description),
		Status:          tpl.Status,
		Version:         tpl.Version,
		Nodes:           json.RawMessage(tpl.Nodes),
		Official:        tpl.Official,
		SourceProjectID: uuidToPtr(tpl.SourceProjectID),
		CreatedByType:   tpl.CreatedByType,
		CreatedByID:     uuidToString(tpl.CreatedByID),
		PublishedAt:     timestampToString(tpl.PublishedAt),
		ArchivedAt:      timestampToString(tpl.ArchivedAt),
		CreatedAt:       timestampToString(tpl.CreatedAt),
		UpdatedAt:       timestampToString(tpl.UpdatedAt),
		SharedProjectIDs: []string{},
	}
	if shares, err := h.Queries.ListWorkflowTemplateShares(ctx, tpl.ID); err == nil {
		for _, s := range shares {
			resp.SharedProjectIDs = append(resp.SharedProjectIDs, uuidToString(s.ProjectID))
		}
	}
	return resp
}

// workflowUserUUID 取当前登录成员 UUID（模板/实例的 created_by / started_by）。
func workflowUserUUID(w http.ResponseWriter, r *http.Request) (pgtype.UUID, bool) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return pgtype.UUID{}, false
	}
	uuid, err := util.ParseUUID(userID)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid user id")
		return pgtype.UUID{}, false
	}
	return uuid, true
}

// loadWorkflowTemplate 解析 {tid} 并做 workspace 归属校验（防串租）。
func (h *Handler) loadWorkflowTemplate(w http.ResponseWriter, r *http.Request, workspaceID, templateIDParam string) (db.WorkflowTemplate, bool) {
	tplUUID, ok := parseUUIDOrBadRequest(w, templateIDParam, "template id")
	if !ok {
		return db.WorkflowTemplate{}, false
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return db.WorkflowTemplate{}, false
	}
	tpl, err := h.Queries.GetWorkflowTemplate(r.Context(), db.GetWorkflowTemplateParams{
		ID: tplUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "workflow template not found")
		return db.WorkflowTemplate{}, false
	}
	return tpl, true
}

// ListWorkflowTemplates GET /api/projects/{id}/workflow/templates
// 官方模板（project_id NULL / official）+ 本项目模板 + 共享到本项目的模板。
func (h *Handler) ListWorkflowTemplates(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	templates, err := h.Queries.ListWorkflowTemplates(r.Context(), db.ListWorkflowTemplatesParams{
		WorkspaceID: project.WorkspaceID,
		ProjectID:   project.ID,
	})
	if err != nil {
		slogWorkflow("list workflow templates", err)
		writeError(w, http.StatusInternalServerError, "failed to list workflow templates")
		return
	}
	resp := make([]WorkflowTemplateResponse, len(templates))
	for i, t := range templates {
		resp[i] = h.workflowTemplateToResponse(r.Context(), t)
	}
	writeJSON(w, http.StatusOK, map[string]any{"templates": resp, "total": len(resp)})
}

type createWorkflowTemplateRequest struct {
	Name        string         `json:"name"`
	Description *string        `json:"description"`
	Nodes       []service.WorkflowNode `json:"nodes"`
	// WorkspaceOfficial=true 时创建 workspace 级官方模板（project_id NULL），
	// 否则默认挂在当前项目下。
	WorkspaceOfficial bool `json:"workspace_official"`
}

// CreateWorkflowTemplate POST /api/projects/{id}/workflow/templates
func (h *Handler) CreateWorkflowTemplate(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userUUID, ok := workflowUserUUID(w, r)
	if !ok {
		return
	}
	var body createWorkflowTemplateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Name == "" || len([]rune(body.Name)) > 120 {
		writeError(w, http.StatusBadRequest, "name is required and must be at most 120 characters")
		return
	}
	nodesJSON, err := json.Marshal(body.Nodes)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid nodes payload")
		return
	}
	if err := service.ValidateWorkflowNodes(nodesJSON); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var projectID pgtype.UUID
	if !body.WorkspaceOfficial {
		projectID = project.ID
	}
	tpl, err := h.Queries.CreateWorkflowTemplate(r.Context(), db.CreateWorkflowTemplateParams{
		WorkspaceID:     project.WorkspaceID,
		ProjectID:       projectID,
		Name:            body.Name,
		Description:     pgtype.Text{String: derefString(body.Description), Valid: body.Description != nil},
		Status:          "draft",
		Nodes:           nodesJSON,
		CreatedByType:   "member",
		CreatedByID:     userUUID,
		SourceProjectID: pgtype.UUID{},
	})
	if err != nil {
		slogWorkflow("create workflow template", err)
		writeError(w, http.StatusInternalServerError, "failed to create workflow template")
		return
	}
	h.publishWorkflowTemplateChanged(r, project.WorkspaceID, tpl)
	writeJSON(w, http.StatusOK, h.workflowTemplateToResponse(r.Context(), tpl))
}

type updateWorkflowTemplateRequest struct {
	Name        string                 `json:"name"`
	Description *string                `json:"description"`
	Nodes       []service.WorkflowNode `json:"nodes"`
}

// UpdateWorkflowTemplate PUT /api/projects/{id}/workflow/templates/{tid}
// 官方模板与已归档模板只读；published 模板编辑即回 draft（版本继续 +1 由 publish 承担）。
func (h *Handler) UpdateWorkflowTemplate(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	tpl, ok := h.loadWorkflowTemplate(w, r, uuidToString(project.WorkspaceID), chi.URLParam(r, "tid"))
	if !ok {
		return
	}
	if tpl.Official {
		writeError(w, http.StatusConflict, "official_template_readonly")
		return
	}
	if tpl.Status == "archived" {
		writeError(w, http.StatusConflict, "template_archived")
		return
	}
	var body updateWorkflowTemplateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Name == "" || len([]rune(body.Name)) > 120 {
		writeError(w, http.StatusBadRequest, "name is required and must be at most 120 characters")
		return
	}
	nodesJSON, err := json.Marshal(body.Nodes)
	if err != nil || service.ValidateWorkflowNodes(nodesJSON) != nil {
		writeError(w, http.StatusBadRequest, "invalid nodes graph")
		return
	}
	updated, err := h.Queries.UpdateWorkflowTemplate(r.Context(), db.UpdateWorkflowTemplateParams{
		ID:          tpl.ID,
		WorkspaceID: project.WorkspaceID,
		Name:        body.Name,
		Description: pgtype.Text{String: derefString(body.Description), Valid: body.Description != nil},
		Nodes:       nodesJSON,
	})
	if err != nil {
		slogWorkflow("update workflow template", err)
		writeError(w, http.StatusInternalServerError, "failed to update workflow template")
		return
	}
	h.publishWorkflowTemplateChanged(r, project.WorkspaceID, updated)
	writeJSON(w, http.StatusOK, h.workflowTemplateToResponse(r.Context(), updated))
}

// PublishWorkflowTemplate POST /api/projects/{id}/workflow/templates/{tid}/publish
// version+1：已运行实例锁定各自的 template_version（快照语义），新版本只影响新实例。
func (h *Handler) PublishWorkflowTemplate(w http.ResponseWriter, r *http.Request) {
	h.transitionWorkflowTemplate(w, r, "publish")
}

// ArchiveWorkflowTemplate POST /api/projects/{id}/workflow/templates/{tid}/archive
func (h *Handler) ArchiveWorkflowTemplate(w http.ResponseWriter, r *http.Request) {
	h.transitionWorkflowTemplate(w, r, "archive")
}

func (h *Handler) transitionWorkflowTemplate(w http.ResponseWriter, r *http.Request, action string) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	tpl, ok := h.loadWorkflowTemplate(w, r, uuidToString(project.WorkspaceID), chi.URLParam(r, "tid"))
	if !ok {
		return
	}
	if tpl.Status == "archived" {
		writeError(w, http.StatusConflict, "template_archived")
		return
	}
	var updated db.WorkflowTemplate
	var err error
	switch action {
	case "publish":
		updated, err = h.Queries.PublishWorkflowTemplate(r.Context(), db.PublishWorkflowTemplateParams{
			ID: tpl.ID, WorkspaceID: project.WorkspaceID,
		})
	case "archive":
		updated, err = h.Queries.ArchiveWorkflowTemplate(r.Context(), db.ArchiveWorkflowTemplateParams{
			ID: tpl.ID, WorkspaceID: project.WorkspaceID,
		})
	}
	if err != nil {
		slogWorkflow("transition workflow template "+action, err)
		writeError(w, http.StatusInternalServerError, "failed to transition workflow template")
		return
	}
	h.publishWorkflowTemplateChanged(r, project.WorkspaceID, updated)
	writeJSON(w, http.StatusOK, h.workflowTemplateToResponse(r.Context(), updated))
}

type duplicateWorkflowTemplateRequest struct {
	Name string `json:"name"`
}

// DuplicateWorkflowTemplate POST /api/projects/{id}/workflow/templates/{tid}/duplicate
// 跨项目复制锚点：source_project_id 记录原模板所属项目（CoCo 同款溯源语义）。
func (h *Handler) DuplicateWorkflowTemplate(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userUUID, ok := workflowUserUUID(w, r)
	if !ok {
		return
	}
	tpl, ok := h.loadWorkflowTemplate(w, r, uuidToString(project.WorkspaceID), chi.URLParam(r, "tid"))
	if !ok {
		return
	}
	var body duplicateWorkflowTemplateRequest
	_ = json.NewDecoder(r.Body).Decode(&body) // body 可选：仅自定义名称
	name := body.Name
	if name == "" {
		name = tpl.Name + "（副本）"
	}
	dup, err := h.Queries.CreateWorkflowTemplate(r.Context(), db.CreateWorkflowTemplateParams{
		WorkspaceID:     project.WorkspaceID,
		ProjectID:       project.ID,
		Name:            name,
		Description:     tpl.Description,
		Status:          "draft",
		Nodes:           tpl.Nodes,
		CreatedByType:   "member",
		CreatedByID:     userUUID,
		SourceProjectID: tpl.ProjectID,
	})
	if err != nil {
		slogWorkflow("duplicate workflow template", err)
		writeError(w, http.StatusInternalServerError, "failed to duplicate workflow template")
		return
	}
	h.publishWorkflowTemplateChanged(r, project.WorkspaceID, dup)
	writeJSON(w, http.StatusOK, h.workflowTemplateToResponse(r.Context(), dup))
}

type shareWorkflowTemplateRequest struct {
	ProjectID string `json:"project_id"`
}

// ShareWorkflowTemplate POST /api/projects/{id}/workflow/templates/{tid}/share
// 幂等（ON CONFLICT DO NOTHING）；目标项目必须同 workspace（loadProjectForResource 复核）。
func (h *Handler) ShareWorkflowTemplate(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userUUID, ok := workflowUserUUID(w, r)
	if !ok {
		return
	}
	tpl, ok := h.loadWorkflowTemplate(w, r, uuidToString(project.WorkspaceID), chi.URLParam(r, "tid"))
	if !ok {
		return
	}
	var body shareWorkflowTemplateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	target, ok := h.loadProjectForResource(w, r, body.ProjectID)
	if !ok {
		return
	}
	if err := h.Queries.ShareWorkflowTemplate(r.Context(), db.ShareWorkflowTemplateParams{
		TemplateID: tpl.ID,
		ProjectID:  target.ID,
		SharedBy:   userUUID,
	}); err != nil {
		slogWorkflow("share workflow template", err)
		writeError(w, http.StatusInternalServerError, "failed to share workflow template")
		return
	}
	h.publishWorkflowTemplateChanged(r, project.WorkspaceID, tpl)
	writeJSON(w, http.StatusOK, h.workflowTemplateToResponse(r.Context(), tpl))
}

func (h *Handler) publishWorkflowTemplateChanged(r *http.Request, workspaceID pgtype.UUID, tpl db.WorkflowTemplate) {
	h.publish(protocol.EventWorkflowTemplateChanged, uuidToString(workspaceID), "system", "", map[string]any{
		"template_id": uuidToString(tpl.ID),
		"status":      tpl.Status,
		"version":     tpl.Version,
	})
}

// slogWorkflow 是 M-6 约定的统一落日志入口：DB 原始错误（含 SQL 片段/表名/
// 约束名）不回吐客户端，仅落服务端日志。
func slogWorkflow(msg string, err error) {
	if err != nil {
		slog.Error(msg, "error", err)
	}
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
