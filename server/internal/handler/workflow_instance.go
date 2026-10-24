// 工作流实例 handler（CoCo 对标 plan 20261024 §01 C2/C3，Agent-W 主产物）。
//
// 生命周期铁律：实例状态的唯一写口在 WorkflowService（全 CAS），本文件只做
// 请求解析 / 归属校验 / 响应映射；任何"先读后写"都不作为并发依据。
package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ── 响应形状 ────────────────────────────────────────────────────────────────

type WorkflowInstanceResponse struct {
	ID              string          `json:"id"`
	WorkspaceID     string          `json:"workspace_id"`
	ProjectID       string          `json:"project_id"`
	TemplateID      string          `json:"template_id"`
	TemplateVersion int32           `json:"template_version"`
	RootIssueID     *string         `json:"root_issue_id"`
	SprintID        *string         `json:"sprint_id"`
	WorkitemSnapshot json.RawMessage `json:"workitem_snapshot"`
	Status          string          `json:"status"`
	StartedByType   string          `json:"started_by_type"`
	StartedByID     string          `json:"started_by_id"`
	TriggeredAt     string          `json:"triggered_at"`
	CompletedAt     string          `json:"completed_at"`
	CreatedAt       string          `json:"created_at"`
	UpdatedAt       string          `json:"updated_at"`
}

func workflowInstanceToResponse(inst db.WorkflowInstance) WorkflowInstanceResponse {
	snapshot := json.RawMessage(inst.WorkitemSnapshot)
	if len(snapshot) == 0 {
		snapshot = json.RawMessage("{}")
	}
	return WorkflowInstanceResponse{
		ID:               uuidToString(inst.ID),
		WorkspaceID:      uuidToString(inst.WorkspaceID),
		ProjectID:        uuidToString(inst.ProjectID),
		TemplateID:       uuidToString(inst.TemplateID),
		TemplateVersion:  inst.TemplateVersion,
		RootIssueID:      uuidToPtr(inst.RootIssueID),
		SprintID:         uuidToPtr(inst.SprintID),
		WorkitemSnapshot: snapshot,
		Status:           inst.Status,
		StartedByType:    inst.StartedByType,
		StartedByID:      uuidToString(inst.StartedByID),
		TriggeredAt:      timestampToString(inst.TriggeredAt),
		CompletedAt:      timestampToString(inst.CompletedAt),
		CreatedAt:        timestampToString(inst.CreatedAt),
		UpdatedAt:        timestampToString(inst.UpdatedAt),
	}
}

// workflowStageRunToResponse 在 workflow_stage.go 使用；gate 响应同理放
// workflow_gate.go——实例详情组装三张快照时共用。
func workflowStageRunToResponse(st db.WorkflowStageRun) map[string]any {
	return map[string]any{
		"id":          uuidToString(st.ID),
		"instance_id": uuidToString(st.InstanceID),
		"seq":         st.Seq,
		"node_id":     st.NodeID,
		"name":        st.Name,
		"mode":        st.Mode,
		"agent_id":    uuidToPtr(st.AgentID),
		"prompt":      textToPtr(st.Prompt),
		"task_id":     uuidToPtr(st.TaskID),
		"state":       st.State,
		"inputs":      json.RawMessage(st.Inputs),
		"outputs":     json.RawMessage(st.Outputs),
		"created_at":  timestampToString(st.CreatedAt),
		"updated_at":  timestampToString(st.UpdatedAt),
	}
}

// ── 项目作用域：列表 / 创建 ─────────────────────────────────────────────────

// workflowWorkspaceFromRequest 解析根作用域路由（/api/workflow-instances/...、
// /api/workflow/...）的当前 workspace（同项目路由一致的防串租口径）。
func (h *Handler) workflowWorkspaceFromRequest(w http.ResponseWriter, r *http.Request) (pgtype.UUID, bool) {
	return parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
}

// requireWorkflowService 保护 nil-service（flag 未开启/测试装配）路径。
func (h *Handler) requireWorkflowService(w http.ResponseWriter) bool {
	if h.WorkflowService == nil {
		writeError(w, http.StatusServiceUnavailable, "workflow_module_disabled")
		return false
	}
	return true
}

// ListProjectWorkflowInstances GET /api/projects/{id}/workflow-instances
// ?scope=mine|all&status=a,b&limit=N；行内含项目级六态计数。
func (h *Handler) ListProjectWorkflowInstances(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var startedBy pgtype.UUID
	if r.URL.Query().Get("scope") == "mine" {
		userUUID, ok := workflowUserUUID(w, r)
		if !ok {
			return
		}
		startedBy = userUUID
	}
	var statuses []string
	if raw := r.URL.Query().Get("status"); raw != "" {
		for _, s := range strings.Split(raw, ",") {
			s = strings.TrimSpace(s)
			switch s {
			case "waiting", "running", "paused", "done", "failed", "cancelled":
				statuses = append(statuses, s)
			}
		}
	}
	limit := int32(50)
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 200 {
			limit = int32(n)
		}
	}
	rows, err := h.Queries.ListWorkflowInstancesByProject(r.Context(), db.ListWorkflowInstancesByProjectParams{
		WorkspaceID: project.WorkspaceID,
		ProjectID:   project.ID,
		Column3:     startedBy,
		Column4:     statuses,
		Limit:       limit,
	})
	if err != nil {
		slogWorkflow("list workflow instances", err)
		writeError(w, http.StatusInternalServerError, "failed to list workflow instances")
		return
	}
	instances := make([]WorkflowInstanceResponse, len(rows))
	counts := map[string]int64{}
	for i, row := range rows {
		instances[i] = workflowInstanceToResponse(db.WorkflowInstance{
			ID: row.ID, WorkspaceID: row.WorkspaceID, ProjectID: row.ProjectID,
			TemplateID: row.TemplateID, TemplateVersion: row.TemplateVersion,
			RootIssueID: row.RootIssueID, SprintID: row.SprintID,
			WorkitemSnapshot: row.WorkitemSnapshot, Status: row.Status,
			StartedByType: row.StartedByType, StartedByID: row.StartedByID,
			TriggeredAt: row.TriggeredAt, CompletedAt: row.CompletedAt,
			CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		})
		counts["waiting"] = row.WaitingCount
		counts["running"] = row.RunningCount
		counts["paused"] = row.PausedCount
		counts["done"] = row.DoneCount
		counts["failed"] = row.FailedCount
		counts["cancelled"] = row.CancelledCount
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"instances": instances,
		"total":     len(instances),
		"status_counts": counts,
	})
}

type createWorkflowInstanceRequest struct {
	TemplateID       string         `json:"template_id"`
	IssueID          *string        `json:"issue_id"`
	WorkitemSnapshot map[string]any `json:"workitem_snapshot"`
}

// CreateProjectWorkflowInstance POST /api/projects/{id}/workflow-instances
// 模板版本锁定 + nodes 快照成 stage_run（此后模板编辑不影响已跑实例）；
// 创建即 waiting，由本请求同步幂等启动，30s sweep 兜底。
func (h *Handler) CreateProjectWorkflowInstance(w http.ResponseWriter, r *http.Request) {
	if !h.requireWorkflowService(w) {
		return
	}
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userUUID, ok := workflowUserUUID(w, r)
	if !ok {
		return
	}
	var body createWorkflowInstanceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.TemplateID == "" {
		writeError(w, http.StatusBadRequest, "template_id is required")
		return
	}
	tpl, ok := h.loadWorkflowTemplate(w, r, uuidToString(project.WorkspaceID), body.TemplateID)
	if !ok {
		return
	}
	if tpl.Status != "published" {
		writeError(w, http.StatusConflict, "template_not_published")
		return
	}
	nodes, err := service.ParseWorkflowNodes(tpl.Nodes)
	if err != nil {
		writeError(w, http.StatusConflict, "template_nodes_invalid")
		return
	}

	var rootIssue pgtype.UUID
	if body.IssueID != nil && *body.IssueID != "" {
		issueUUID, ok := parseUUIDOrBadRequest(w, *body.IssueID, "issue_id")
		if !ok {
			return
		}
		issue, err := h.Queries.GetIssue(r.Context(), issueUUID)
		if err != nil || uuidToString(issue.WorkspaceID) != uuidToString(project.WorkspaceID) {
			writeError(w, http.StatusNotFound, "issue not found")
			return
		}
		rootIssue = issue.ID
	}
	snapshot := []byte("{}")
	if body.WorkitemSnapshot != nil {
		if raw, merr := json.Marshal(body.WorkitemSnapshot); merr == nil {
			snapshot = raw
		}
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		slogWorkflow("begin workflow instance tx", err)
		writeError(w, http.StatusInternalServerError, "failed to create workflow instance")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck // Commit 成功后 Rollback 为 no-op
	qtx := h.Queries.WithTx(tx)

	inst, err := qtx.CreateWorkflowInstance(r.Context(), db.CreateWorkflowInstanceParams{
		WorkspaceID:     project.WorkspaceID,
		ProjectID:       project.ID,
		TemplateID:      tpl.ID,
		TemplateVersion: tpl.Version,
		RootIssueID:     rootIssue,
		WorkitemSnapshot: snapshot,
		StartedByType:   "member",
		StartedByID:     userUUID,
	})
	if err != nil {
		slogWorkflow("create workflow instance", err)
		writeError(w, http.StatusInternalServerError, "failed to create workflow instance")
		return
	}
	// seq = 按 node.stage 升序（稳定，同 stage 保持模板顺序）后的下标+1，
	// 满足 UNIQUE(instance_id, seq)；执行推进按 seq 线性派发（service 侧）。
	ordered := make([]service.WorkflowNode, len(nodes))
	copy(ordered, nodes)
	sortWorkflowNodesByStage(ordered)
	for i, node := range ordered {
		var agentID pgtype.UUID
		if u, perr := util.ParseUUID(node.AgentRef); perr == nil {
			agentID = u
		}
		inputs := jsonNullIfEmpty(node.Inputs)
		outputs := jsonNullIfEmpty(node.Outputs)
		if _, err := qtx.CreateWorkflowStageRun(r.Context(), db.CreateWorkflowStageRunParams{
			InstanceID:  inst.ID,
			WorkspaceID: project.WorkspaceID,
			Seq:         int32(i + 1),
			NodeID:      node.ID,
			Name:        node.Name,
			Mode:        node.Mode,
			AgentID:     agentID,
			Prompt:      pgtype.Text{String: node.Prompt, Valid: node.Prompt != ""},
			Inputs:      inputs,
			Outputs:     outputs,
		}); err != nil {
			slogWorkflow("create workflow stage run", err)
			writeError(w, http.StatusInternalServerError, "failed to snapshot workflow stages")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		slogWorkflow("commit workflow instance tx", err)
		writeError(w, http.StatusInternalServerError, "failed to create workflow instance")
		return
	}

	// 同步幂等启动（MarkWorkflowStarted CAS）；失败不回滚创建——sweep 兜底。
	if err := h.WorkflowService.StartWorkflowInstance(r.Context(), inst.ID); err != nil {
		slogWorkflow("start workflow instance after create", err)
	}
	created, err := h.Queries.GetWorkflowInstance(r.Context(), db.GetWorkflowInstanceParams{
		ID: inst.ID, WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read workflow instance")
		return
	}
	writeJSON(w, http.StatusOK, workflowInstanceToResponse(created))
}

// sortWorkflowNodesByStage：按 node.stage 升序（sort.SliceStable 保持同 stage
// 内模板声明顺序），seq = 排序后下标 + 1。
func sortWorkflowNodesByStage(nodes []service.WorkflowNode) {
	sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].Stage < nodes[j].Stage })
}

// jsonNullIfEmpty：空切片落 "[]"（workflow_stage_run.inputs/outputs 列 NOT NULL，
// 显式 NULL 会撞 23502；空数组才是合法的 JSONB 空语义）。
func jsonNullIfEmpty(v []any) []byte {
	if len(v) == 0 {
		return []byte("[]")
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return raw
}

// ── 实例根作用域：详情 / 生命周期迁移 / 诊断 ────────────────────────────────

// loadWorkflowInstanceForRequest 解析 {iid} + 当前 workspace 归属（防串租）。
func (h *Handler) loadWorkflowInstanceForRequest(w http.ResponseWriter, r *http.Request) (db.WorkflowInstance, bool) {
	iidUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "iid"), "instance id")
	if !ok {
		return db.WorkflowInstance{}, false
	}
	wsUUID, ok := h.workflowWorkspaceFromRequest(w, r)
	if !ok {
		return db.WorkflowInstance{}, false
	}
	inst, err := h.Queries.GetWorkflowInstance(r.Context(), db.GetWorkflowInstanceParams{
		ID: iidUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "workflow instance not found")
		return db.WorkflowInstance{}, false
	}
	return inst, true
}

// GetWorkflowInstanceDetail GET /api/workflow-instances/{iid}
// 一次返回实例 + 全部 stage + 全部 gate（前端 TAB 渲染单一数据源，stage 按 seq）。
func (h *Handler) GetWorkflowInstanceDetail(w http.ResponseWriter, r *http.Request) {
	inst, ok := h.loadWorkflowInstanceForRequest(w, r)
	if !ok {
		return
	}
	stages, err := h.Queries.ListWorkflowStageRuns(r.Context(), inst.ID)
	if err != nil {
		slogWorkflow("list stage runs", err)
		writeError(w, http.StatusInternalServerError, "failed to load workflow stages")
		return
	}
	gates, err := h.Queries.ListWorkflowGateRuns(r.Context(), inst.ID)
	if err != nil {
		slogWorkflow("list gate runs", err)
		writeError(w, http.StatusInternalServerError, "failed to load workflow gates")
		return
	}
	stageResp := make([]map[string]any, len(stages))
	for i, st := range stages {
		stageResp[i] = workflowStageRunToResponse(st)
	}
	gateResp := make([]map[string]any, len(gates))
	for i, g := range gates {
		gateResp[i] = workflowGateToResponse(g)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"instance": workflowInstanceToResponse(inst),
		"stages":   stageResp,
		"gates":    gateResp,
	})
}

// workflowAllowedStates 每个动作合法的实例当前状态（非法迁移直接 409，
// 与服务层 CAS 双保险：这里给可读错误，CAS 兜并发）。
var workflowAllowedStates = map[string][]string{
	"pause":   {"running"},
	"resume":  {"paused"},
	"cancel":  {"waiting", "running", "paused"},
	"succeed": {"running", "paused"},
	"recover": {"failed"},
}

func workflowStateAllows(action, status string) bool {
	for _, s := range workflowAllowedStates[action] {
		if s == status {
			return true
		}
	}
	return false
}

// TransitionWorkflowInstance POST /api/workflow-instances/{iid}/{action}
// action ∈ pause|resume|cancel|succeed|recover（router 逐动作注册）。
func (h *Handler) transitionWorkflowInstance(w http.ResponseWriter, r *http.Request, action string) {
	if !h.requireWorkflowService(w) {
		return
	}
	inst, ok := h.loadWorkflowInstanceForRequest(w, r)
	if !ok {
		return
	}
	if !workflowStateAllows(action, inst.Status) {
		writeError(w, http.StatusConflict, "workflow_state_conflict")
		return
	}
	var (
		updated db.WorkflowInstance
		err     error
	)
	ctx := r.Context()
	switch action {
	case "pause":
		updated, err = h.WorkflowService.TransitionInstance(ctx, inst, "paused")
	case "resume":
		updated, err = h.WorkflowService.TransitionInstance(ctx, inst, "running")
	case "cancel":
		updated, err = h.WorkflowService.CancelInstance(ctx, inst)
	case "succeed":
		updated, err = h.WorkflowService.SucceedInstance(ctx, inst)
	case "recover":
		updated, err = h.WorkflowService.RecoverInstance(ctx, inst)
	}
	if err != nil {
		if errors.Is(err, service.ErrWorkflowConflict) {
			writeError(w, http.StatusConflict, "workflow_state_conflict")
			return
		}
		slogWorkflow("transition workflow instance "+action, err)
		writeError(w, http.StatusInternalServerError, "failed to transition workflow instance")
		return
	}
	writeJSON(w, http.StatusOK, workflowInstanceToResponse(updated))
}

func (h *Handler) PauseWorkflowInstance(w http.ResponseWriter, r *http.Request) {
	h.transitionWorkflowInstance(w, r, "pause")
}

func (h *Handler) ResumeWorkflowInstance(w http.ResponseWriter, r *http.Request) {
	h.transitionWorkflowInstance(w, r, "resume")
}

func (h *Handler) CancelWorkflowInstance(w http.ResponseWriter, r *http.Request) {
	h.transitionWorkflowInstance(w, r, "cancel")
}

func (h *Handler) SucceedWorkflowInstance(w http.ResponseWriter, r *http.Request) {
	h.transitionWorkflowInstance(w, r, "succeed")
}

func (h *Handler) RecoverWorkflowInstance(w http.ResponseWriter, r *http.Request) {
	h.transitionWorkflowInstance(w, r, "recover")
}

// GetWorkflowRecoveryDiagnosis GET /api/workflow-instances/{iid}/recovery-diagnosis
// v1 简化口径：failed stage + 其 task 终态 → 建议动作（对齐 agent_run stalled 探测思路）。
func (h *Handler) GetWorkflowRecoveryDiagnosis(w http.ResponseWriter, r *http.Request) {
	inst, ok := h.loadWorkflowInstanceForRequest(w, r)
	if !ok {
		return
	}
	stages, err := h.Queries.ListWorkflowStageRuns(r.Context(), inst.ID)
	if err != nil {
		slogWorkflow("list stages for diagnosis", err)
		writeError(w, http.StatusInternalServerError, "failed to load workflow stages")
		return
	}
	suggestions := make([]map[string]any, 0, len(stages))
	for _, st := range stages {
		if st.State != "failed" {
			continue
		}
		item := map[string]any{
			"stage_run_id": uuidToString(st.ID),
			"name":         st.Name,
			"mode":         st.Mode,
			"state":        st.State,
			"task_id":      uuidToPtr(st.TaskID),
		}
		if st.TaskID.Valid {
			if task, terr := h.Queries.GetAgentTask(r.Context(), st.TaskID); terr == nil {
				item["task_status"] = task.Status
			} else {
				item["task_status"] = "unknown"
			}
			item["recommendation"] = "task_failed_rerun_stage"
		} else if st.Mode == "auto" {
			item["recommendation"] = "auto_stage_not_dispatched_check_agent_and_root_issue"
		} else {
			item["recommendation"] = "human_stage_recover_and_approve"
		}
		suggestions = append(suggestions, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"instance_id":     uuidToString(inst.ID),
		"instance_status": inst.Status,
		"can_recover":     inst.Status == "failed",
		"suggestions":     suggestions,
	})
}
