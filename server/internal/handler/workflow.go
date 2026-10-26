// 工作流模板 handler（CoCo 对标 plan 20261024 §01 C1，Agent-W 主产物）。
//
// 范式严格对照 requirement_acceptance.go / project_resource.go：
//   - loadProjectForResource 拿项目 + workspace 归属（防串租）；
//   - nodes JSON 写入前过 ValidateWorkflowNodes（mode 合法 / next 引用存在 / 图无环）；
//   - M-6：DB 原始错误只落 slog，不回吐客户端；
//   - 写成功后 publish EventWorkflowTemplateChanged，前端 invalidate 模板列表。
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"sort"

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
	ID               string          `json:"id"`
	WorkspaceID      string          `json:"workspace_id"`
	ProjectID        *string         `json:"project_id"`
	Name             string          `json:"name"`
	Description      *string         `json:"description"`
	Status           string          `json:"status"`
	Version          int32           `json:"version"`
	Nodes            json.RawMessage `json:"nodes"`
	Definition       json.RawMessage `json:"definition"`
	Enforce          bool            `json:"enforce"`
	Official         bool            `json:"official"`
	SourceProjectID  *string         `json:"source_project_id"`
	CreatedByType    string          `json:"created_by_type"`
	CreatedByID      string          `json:"created_by_id"`
	PublishedAt      string          `json:"published_at"`
	ArchivedAt       string          `json:"archived_at"`
	CreatedAt        string          `json:"created_at"`
	UpdatedAt        string          `json:"updated_at"`
	SharedProjectIDs []string        `json:"shared_project_ids"`
	// StageFlow 是从编译后的扁平 nodes 派生的画廊卡片摘要（按 stage 升序）。
	StageFlow []StageFlowItem `json:"stage_flow"`
}

// StageFlowItem 是画廊卡片上的一枚阶段 chip：mode 区分自动/人工（含 gate）。
type StageFlowItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Mode string `json:"mode"`
}

func (h *Handler) workflowTemplateToResponse(ctx context.Context, tpl db.WorkflowTemplate) WorkflowTemplateResponse {
	resp := WorkflowTemplateResponse{
		ID:               uuidToString(tpl.ID),
		WorkspaceID:      uuidToString(tpl.WorkspaceID),
		ProjectID:        uuidToPtr(tpl.ProjectID),
		Name:             tpl.Name,
		Description:      textToPtr(tpl.Description),
		Status:           tpl.Status,
		Version:          tpl.Version,
		Nodes:            json.RawMessage(tpl.Nodes),
		Definition:       json.RawMessage(tpl.Definition),
		Enforce:          tpl.Enforce,
		Official:         tpl.Official,
		SourceProjectID:  uuidToPtr(tpl.SourceProjectID),
		CreatedByType:    tpl.CreatedByType,
		CreatedByID:      uuidToString(tpl.CreatedByID),
		PublishedAt:      timestampToString(tpl.PublishedAt),
		ArchivedAt:       timestampToString(tpl.ArchivedAt),
		CreatedAt:        timestampToString(tpl.CreatedAt),
		UpdatedAt:        timestampToString(tpl.UpdatedAt),
		SharedProjectIDs: []string{},
		StageFlow:        stageFlowFromNodes(tpl.Nodes),
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
	Name        string                 `json:"name"`
	Description *string                `json:"description"`
	Nodes       []service.WorkflowNode `json:"nodes"`
	// Definition 是 CoCo 嵌套 authoring 原文（导入分支）；与扁平 Nodes 二选一。
	Definition json.RawMessage `json:"definition"`
	// WorkspaceOfficial=true 时创建 workspace 级官方模板（project_id NULL），
	// 否则默认挂在当前项目下。
	WorkspaceOfficial bool `json:"workspace_official"`
	// Enforce 标记项目专属强制门控模板（draft 阶段可置，发布时受部分唯一索引约束）。
	Enforce bool `json:"enforce"`
}

// CreateWorkflowTemplate POST /api/projects/{id}/workflow/templates
// 双路径：body 携 CoCo 嵌套 definition（或整体即 coco.workflow.template 文档）→
// 走 ValidateWorkflowDefinition + Flatten 编译出引擎 nodes；否则维持旧扁平路径。
func (h *Handler) CreateWorkflowTemplate(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userUUID, ok := workflowUserUUID(w, r)
	if !ok {
		return
	}
	rawBody, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var body createWorkflowTemplateRequest
	if err := json.Unmarshal(rawBody, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var nodesJSON, definitionJSON []byte
	// 识别 CoCo 导入：优先取 body.definition，否则整体 rawBody 若是嵌套文档也算。
	cocoRaw := []byte(body.Definition)
	if !service.IsCocoDefinition(cocoRaw) && service.IsCocoDefinition(rawBody) {
		cocoRaw = rawBody
	}
	if service.IsCocoDefinition(cocoRaw) {
		if err := service.ValidateWorkflowDefinition(cocoRaw); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		def, perr := service.ParseWorkflowDefinition(cocoRaw)
		if perr != nil {
			writeError(w, http.StatusBadRequest, perr.Error())
			return
		}
		flat, ferr := service.FlattenWorkflowDefinition(def)
		if ferr != nil {
			writeError(w, http.StatusBadRequest, ferr.Error())
			return
		}
		if nodesJSON, err = json.Marshal(flat); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to compile workflow definition")
			return
		}
		definitionJSON = cocoRaw
		if body.Name == "" {
			body.Name = def.Name
		}
		if body.Description == nil && def.Description != "" {
			body.Description = &def.Description
		}
	} else {
		nodesJSON, err = json.Marshal(body.Nodes)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid nodes payload")
			return
		}
		if verr := service.ValidateWorkflowNodes(nodesJSON); verr != nil {
			writeError(w, http.StatusBadRequest, verr.Error())
			return
		}
		definitionJSON = []byte("{}")
	}
	if body.Name == "" || len([]rune(body.Name)) > 120 {
		writeError(w, http.StatusBadRequest, "name is required and must be at most 120 characters")
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
		Definition:      definitionJSON,
		Enforce:         body.Enforce,
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
		Definition:      definitionOrDefault(tpl.Definition),
		Enforce:         false,
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

// definitionOrDefault 兜住历史模板的空 definition（NULL/空字节）→ 落库给 {}
// （NOT NULL 列），以免 duplicate/create 路径撞非空约束。
func definitionOrDefault(raw []byte) []byte {
	if len(bytes.TrimSpace(raw)) == 0 {
		return []byte("{}")
	}
	return raw
}

// stageFlowFromNodes 从编译后的扁平 nodes 派生画廊卡片的阶段 chip（按 stage 升序）。
// nodes 为空或非法时返回空切片（不阻断列表）。
func stageFlowFromNodes(raw []byte) []StageFlowItem {
	items := []StageFlowItem{}
	if len(bytes.TrimSpace(raw)) == 0 {
		return items
	}
	nodes, err := service.ParseWorkflowNodes(raw)
	if err != nil {
		return items
	}
	sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].Stage < nodes[j].Stage })
	for _, n := range nodes {
		items = append(items, StageFlowItem{ID: n.ID, Name: n.Name, Mode: n.Mode})
	}
	return items
}

// ListWorkspaceWorkflowTemplates GET /api/workflow/templates
// 工作区级画廊（侧边栏「工作流」入口）：跨项目列出本 workspace 模板。
// query: status(空/all=非已删除，published/draft/archived=精确)、scope=mine、project_id。
func (h *Handler) ListWorkspaceWorkflowTemplates(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	userUUID, ok := workflowUserUUID(w, r)
	if !ok {
		return
	}
	createdBy := pgtype.UUID{}
	if r.URL.Query().Get("scope") == "mine" {
		createdBy = userUUID
	}
	requested := r.URL.Query().Get("status")

	// 计数需覆盖全量（含 archived）→ 拉非已删除 + 已删除两组，再 Go 侧过滤展示。
	nonArchived, err := h.Queries.ListWorkspaceWorkflowTemplates(r.Context(), db.ListWorkspaceWorkflowTemplatesParams{
		WorkspaceID: wsUUID,
		CreatedBy:   createdBy,
	})
	if err != nil {
		slogWorkflow("list workspace workflow templates", err)
		writeError(w, http.StatusInternalServerError, "failed to list workflow templates")
		return
	}
	archived, err := h.Queries.ListWorkspaceWorkflowTemplates(r.Context(), db.ListWorkspaceWorkflowTemplatesParams{
		WorkspaceID: wsUUID,
		Status:      pgtype.Text{String: "archived", Valid: true},
		CreatedBy:   createdBy,
	})
	if err != nil {
		slogWorkflow("list workspace workflow templates (archived)", err)
		writeError(w, http.StatusInternalServerError, "failed to list workflow templates")
		return
	}

	counts := map[string]int{"all": len(nonArchived), "published": 0, "draft": 0, "archived": len(archived)}
	for _, t := range nonArchived {
		counts[t.Status]++
	}

	// 展示源：archived tab 用 archived，其余用 nonArchived。
	src := nonArchived
	if requested == "archived" {
		src = archived
	}
	projectFilter := r.URL.Query().Get("project_id")
	resp := make([]WorkflowTemplateResponse, 0, len(src))
	for _, t := range src {
		if requested != "" && requested != "all" && requested != "archived" && t.Status != requested {
			continue
		}
		if projectFilter != "" && uuidToString(t.ProjectID) != projectFilter {
			continue
		}
		resp = append(resp, h.workflowTemplateToResponse(r.Context(), t))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"templates": resp, "total": len(resp), "status_counts": counts,
	})
}

type updateWorkflowTemplateDefinitionRequest struct {
	Definition  json.RawMessage `json:"definition"`
	Name        string          `json:"name"`
	Description *string         `json:"description"`
}

// UpdateWorkflowTemplateDefinition PUT /api/workflow/templates/{tid}/definition
// 编辑器 JSON 保存：校验 CoCo 嵌套原文 → 展平编译 nodes → 同写 definition/nodes。
// 官方与已归档模板只读。
func (h *Handler) UpdateWorkflowTemplateDefinition(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	tpl, ok := h.loadWorkflowTemplate(w, r, workspaceID, chi.URLParam(r, "tid"))
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
	var body updateWorkflowTemplateDefinitionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !service.IsCocoDefinition(body.Definition) {
		writeError(w, http.StatusBadRequest, "definition must be a coco.workflow.template document")
		return
	}
	if err := service.ValidateWorkflowDefinition(body.Definition); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	def, perr := service.ParseWorkflowDefinition(body.Definition)
	if perr != nil {
		writeError(w, http.StatusBadRequest, perr.Error())
		return
	}
	flat, ferr := service.FlattenWorkflowDefinition(def)
	if ferr != nil {
		writeError(w, http.StatusBadRequest, ferr.Error())
		return
	}
	nodesJSON, merr := json.Marshal(flat)
	if merr != nil {
		writeError(w, http.StatusInternalServerError, "failed to compile workflow definition")
		return
	}
	name := body.Name
	if name == "" {
		name = def.Name
	}
	if name == "" {
		name = tpl.Name
	}
	if len([]rune(name)) > 120 {
		writeError(w, http.StatusBadRequest, "name must be at most 120 characters")
		return
	}
	desc := tpl.Description
	if body.Description != nil {
		desc = pgtype.Text{String: *body.Description, Valid: true}
	} else if def.Description != "" {
		desc = pgtype.Text{String: def.Description, Valid: true}
	}
	updated, err := h.Queries.UpdateWorkflowTemplateDefinition(r.Context(), db.UpdateWorkflowTemplateDefinitionParams{
		ID:          tpl.ID,
		WorkspaceID: wsUUID,
		Name:        name,
		Description: desc,
		Nodes:       nodesJSON,
		Definition:  body.Definition,
	})
	if err != nil {
		slogWorkflow("update workflow template definition", err)
		writeError(w, http.StatusInternalServerError, "failed to update workflow template")
		return
	}
	h.publishWorkflowTemplateChanged(r, wsUUID, updated)
	writeJSON(w, http.StatusOK, h.workflowTemplateToResponse(r.Context(), updated))
}

type setWorkflowTemplateEnforceRequest struct {
	Enforce bool `json:"enforce"`
}

// SetWorkflowTemplateEnforce PUT /api/workflow/templates/{tid}/enforce
// 置/取消项目专属强制门控标志。仅 project 专属 + published 模板可置 true；
// 同项目重复置 true 撞部分唯一索引 → 409。
func (h *Handler) SetWorkflowTemplateEnforce(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	tpl, ok := h.loadWorkflowTemplate(w, r, workspaceID, chi.URLParam(r, "tid"))
	if !ok {
		return
	}
	var body setWorkflowTemplateEnforceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Enforce {
		if !tpl.ProjectID.Valid {
			writeError(w, http.StatusBadRequest, "enforce requires a project-scoped template")
			return
		}
		if tpl.Status != "published" {
			writeError(w, http.StatusConflict, "template_not_published")
			return
		}
	}
	updated, err := h.Queries.SetWorkflowTemplateEnforce(r.Context(), db.SetWorkflowTemplateEnforceParams{
		ID:          tpl.ID,
		WorkspaceID: wsUUID,
		Enforce:     body.Enforce,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "workflow_enforce_conflict")
			return
		}
		slogWorkflow("set workflow template enforce", err)
		writeError(w, http.StatusInternalServerError, "failed to set workflow template enforce")
		return
	}
	h.publishWorkflowTemplateChanged(r, wsUUID, updated)
	writeJSON(w, http.StatusOK, h.workflowTemplateToResponse(r.Context(), updated))
}
