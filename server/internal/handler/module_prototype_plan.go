package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
)

// 功能模块原型中枢 · 发布两段式 plan/apply 面（plans/20261026 07 §2.5 · M-07）。
//
// D-D：Agent 只能产「候选版本 + 合并计划」(draft)，canonical 指针的移动必须由人
// 显式 apply。状态机：draft ──apply──> applying ──ok──> applied / ──error──> failed
// ──retry──> applying；draft ──expire(24h)──> expired。
// 六步中的 1–4（产物落盘/注册版本在 M-04 已完成，此处为 canonical 移动 + spec 升版
// + 投影重建 + 计划置 applied）在**同一事务**；5（广播）在提交后执行、失败不回滚。
// 幂等：同一 planId 只生效一次（重复 apply → 409 plan_already_applied）。

// 计划快照（存于 module_prototype_plan.plan jsonb）。
type prototypePlanSnapshot struct {
	NewSpec   *service.ModuleSpec         `json:"newSpec,omitempty"`
	Decisions map[string]service.Decision `json:"decisions,omitempty"`
}

type prototypePlanRow struct {
	id               pgtype.UUID
	moduleID         pgtype.UUID
	status           string
	candidateVersion int32
	baseVersion      pgtype.Int4
	specVersion      int32
	plan             []byte
	errCol           pgtype.Text
	createdAt        pgtype.Timestamptz
	updatedAt        pgtype.Timestamptz
}

func (p prototypePlanRow) toResponse() map[string]any {
	return map[string]any{
		"id":                uuidToString(p.id),
		"module_id":         uuidToString(p.moduleID),
		"status":            p.status,
		"candidate_version": p.candidateVersion,
		"base_version":      int4ToPtr(p.baseVersion),
		"spec_version":      p.specVersion,
		"plan":              json.RawMessage(p.plan),
		"error":             p.errCol.String,
		"created_at":        timestampToString(p.createdAt),
		"updated_at":        timestampToString(p.updatedAt),
	}
}

// CreatePrototypePlanRequest is the body for POST /prototype-plans.
type CreatePrototypePlanRequest struct {
	CandidateVersion int32                       `json:"candidate_version"`
	NewSpec          json.RawMessage             `json:"new_spec,omitempty"` // 缺省 = 沿用当前已发布 spec，仅移权威
	Decisions        map[string]service.Decision `json:"decisions,omitempty"`
}

// CreatePrototypePlan 把「候选版本 + 新 spec + 功能点处置」快照成一条 draft 计划，
// 不改任何权威指针（07 D-D：canonical 只能由 ApplyPrototypePlan 移动）。
// (07 §3.2 POST /modules/{moduleId}/prototype-plans)
func (h *Handler) CreatePrototypePlan(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "moduleId"), "module id")
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	mod, err := h.loadModuleSpec(r.Context(), project.ID, moduleID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	var req CreatePrototypePlanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.CandidateVersion <= 0 {
		writeError(w, http.StatusBadRequest, "candidate_version must be > 0")
		return
	}

	// 候选必须是已登记的模块级原型版本（产物落盘 + 注册在 M-04 完成）。
	var candStatus string
	if err := h.DB.QueryRow(r.Context(), `
		SELECT status FROM issue_prototype_version WHERE module_id = $1 AND version = $2`,
		moduleID, req.CandidateVersion,
	).Scan(&candStatus); err != nil {
		writeModuleError(w, http.StatusNotFound, "prototype_version_not_found",
			"candidate prototype version not found")
		return
	}
	// §2.5：canonical 只能指向 confirmed（pending 需专门 flag，本接口不放行）。
	if candStatus != "confirmed" {
		writeModuleError(w, http.StatusConflict, "canonical_pending_not_allowed",
			"candidate version must be confirmed before planning")
		return
	}

	snapshot := prototypePlanSnapshot{Decisions: req.Decisions}
	if len(req.NewSpec) > 0 {
		spec, code, msg := normalizeModuleSpec(req.NewSpec)
		if code != "" {
			writeModuleError(w, http.StatusUnprocessableEntity, code, msg)
			return
		}
		snapshot.NewSpec = &spec
	}
	planBytes, _ := json.Marshal(snapshot)

	var out prototypePlanRow
	err = h.DB.QueryRow(r.Context(), `
		INSERT INTO module_prototype_plan
		  (module_id, status, candidate_version, base_version, spec_version, plan)
		VALUES ($1, 'draft', $2, $3, $4, $5)
		RETURNING id, module_id, status, candidate_version, base_version, spec_version,
		          plan, error, created_at, updated_at`,
		moduleID, req.CandidateVersion, mod.canonical, mod.version, planBytes,
	).Scan(&out.id, &out.moduleID, &out.status, &out.candidateVersion, &out.baseVersion,
		&out.specVersion, &out.plan, &out.errCol, &out.createdAt, &out.updatedAt)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create prototype plan")
		return
	}
	writeJSON(w, http.StatusCreated, out.toResponse())
}

// GetPrototypePlan returns one plan owned by the module.
// (07 §3.2 GET /modules/{moduleId}/prototype-plans/{planId})
func (h *Handler) GetPrototypePlan(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "moduleId"), "module id")
	if !ok {
		return
	}
	planID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "planId"), "plan id")
	if !ok {
		return
	}
	var out prototypePlanRow
	err := h.DB.QueryRow(r.Context(), `
		SELECT id, module_id, status, candidate_version, base_version, spec_version,
		       plan, error, created_at, updated_at
		FROM module_prototype_plan WHERE id = $1 AND module_id = $2`,
		planID, moduleID,
	).Scan(&out.id, &out.moduleID, &out.status, &out.candidateVersion, &out.baseVersion,
		&out.specVersion, &out.plan, &out.errCol, &out.createdAt, &out.updatedAt)
	if err != nil {
		writeError(w, http.StatusNotFound, "prototype plan not found")
		return
	}
	// 校验模块确属该项目，防跨项目枚举 planId。
	if _, err := h.loadModuleSpec(r.Context(), project.ID, out.moduleID); err != nil {
		writeError(w, http.StatusNotFound, "prototype plan not found")
		return
	}
	writeJSON(w, http.StatusOK, out.toResponse())
}

// markPlanFailed 在事务回滚后把计划置为 failed（可 retry），独立连接、不回滚已回滚的事物。
func (h *Handler) markPlanFailed(ctx context.Context, planID pgtype.UUID, reason string) {
	_, _ = h.DB.Exec(ctx, `
		UPDATE module_prototype_plan SET status = 'failed', error = $1, updated_at = now()
		WHERE id = $2 AND status <> 'applied'`, reason, planID)
}

// ApplyPrototypePlan 是人确认后的第二段：单事务内移动 canonical → 候选、spec 升版、
// 重建投影、计划置 applied；提交后广播 project_module:spec_updated（失败不回滚已提交规格）。
// 任一步失败整体回滚，canonical 保持不变；同一 planId 只生效一次。
// (07 §3.2 POST /modules/{moduleId}/prototype-plans/{planId}/apply)
func (h *Handler) ApplyPrototypePlan(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "moduleId"), "module id")
	if !ok {
		return
	}
	planID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "planId"), "plan id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to apply prototype plan")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var plan prototypePlanRow
	err = tx.QueryRow(ctx, `
		SELECT id, module_id, status, candidate_version, base_version, spec_version,
		       plan, error, created_at, updated_at
		FROM module_prototype_plan WHERE id = $1 AND module_id = $2 FOR UPDATE`,
		planID, moduleID,
	).Scan(&plan.id, &plan.moduleID, &plan.status, &plan.candidateVersion, &plan.baseVersion,
		&plan.specVersion, &plan.plan, &plan.errCol, &plan.createdAt, &plan.updatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "prototype plan not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load prototype plan")
		return
	}
	switch plan.status {
	case "applied":
		writeModuleError(w, http.StatusConflict, "plan_already_applied",
			"this plan has already been applied")
		return
	case "expired":
		writeModuleError(w, http.StatusConflict, "plan_expired",
			"draft plans expire after 24h; create a fresh plan")
		return
	}

	var mod moduleSpecRow
	err = tx.QueryRow(ctx, `
		SELECT id, name, color, spec, spec_version, canonical_prototype_version, spec_updated_at
		FROM project_module WHERE id = $1 AND project_id = $2 FOR UPDATE`,
		moduleID, project.ID,
	).Scan(&mod.id, &mod.name, &mod.color, &mod.spec, &mod.version, &mod.canonical, &mod.updatedAt)
	if err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}

	// 候选此刻仍须存在且 confirmed（登记后可能被归档/删除）。
	var candStatus string
	if err := tx.QueryRow(ctx, `
		SELECT status FROM issue_prototype_version WHERE module_id = $1 AND version = $2`,
		moduleID, plan.candidateVersion,
	).Scan(&candStatus); err != nil {
		writeModuleError(w, http.StatusNotFound, "prototype_version_not_found",
			"candidate prototype version not found")
		return
	}
	if candStatus != "confirmed" {
		writeModuleError(w, http.StatusConflict, "canonical_pending_not_allowed",
			"candidate version must be confirmed to move canonical")
		return
	}

	// 目标 spec：计划快照带 newSpec 则用之；否则沿用当前 spec 仅移权威（仍 bump 版本、重建投影）。
	var snapshot prototypePlanSnapshot
	if len(plan.plan) > 0 {
		if err := json.Unmarshal(plan.plan, &snapshot); err != nil {
			writeModuleError(w, http.StatusUnprocessableEntity, "spec_schema_invalid",
				"plan snapshot is corrupt")
			return
		}
	}
	targetSpec := mod.spec
	if snapshot.NewSpec != nil {
		raw, _ := json.Marshal(snapshot.NewSpec)
		spec, code, msg := normalizeModuleSpec(raw)
		if code != "" {
			writeModuleError(w, http.StatusUnprocessableEntity, code, msg)
			return
		}
		if b, err := json.Marshal(spec); err == nil {
			targetSpec = b
		}
	}
	targetFeats, _, _ := normalizeModuleSpec(targetSpec)
	newVersion := mod.version + 1

	// 事务体：任何一步失败 → rollback（defer）→ canonical 不变；置 failed 可 retry。
	appliedAt := time.Now().UTC()
	if err := h.runPlanApplyTx(ctx, tx, project.WorkspaceID, moduleID, planID, userID,
		plan.candidateVersion, targetSpec, targetFeats, newVersion, appliedAt); err != nil {
		tx.Rollback(ctx) //nolint:errcheck
		h.markPlanFailed(ctx, planID, err.Error())
		if he, ok := err.(*handlerApplyError); ok {
			writeModuleError(w, he.status, he.code, he.msg)
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to apply prototype plan")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		h.markPlanFailed(ctx, planID, "commit failed")
		writeError(w, http.StatusInternalServerError, "failed to apply prototype plan")
		return
	}

	// 步 5：提交后广播（失败不回滚已提交的规格）。
	h.publish("project_module:spec_updated", uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"module_id": uuidToString(moduleID), "spec_version": newVersion,
			"canonical_prototype_version": plan.candidateVersion,
			"plan_id":                     uuidToString(planID),
			"project_id":                  uuidToString(project.ID)})

	plan.status = "applied"
	plan.specVersion = newVersion
	plan.updatedAt = pgtype.Timestamptz{Time: appliedAt, Valid: true}
	writeJSON(w, http.StatusOK, map[string]any{
		"plan_id":                     uuidToString(planID),
		"module_id":                   uuidToString(moduleID),
		"status":                      "applied",
		"canonical_prototype_version": plan.candidateVersion,
		"spec_version":                newVersion,
		"feature_count":               len(targetFeats.Features),
	})
}

// handlerApplyError 携带 HTTP 语义的事务内错误（回滚后按原样映射响应）。
type handlerApplyError struct {
	status int
	code   string
	msg    string
}

func (e *handlerApplyError) Error() string { return e.code + ": " + e.msg }

// runPlanApplyTx 执行 07 §2.5 的第 3、4 步（canonical 移动 + spec 升版 + 投影重建 +
// 变更事件 + 计划置 applied），全部在同一 tx 内；失败返回 error 触发整体回滚。
func (h *Handler) runPlanApplyTx(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID pgtype.UUID,
	moduleID pgtype.UUID,
	planID pgtype.UUID,
	userID string,
	candidateVersion int32,
	specBytes []byte,
	spec service.ModuleSpec,
	newVersion int32,
	appliedAt time.Time,
) error {
	if _, err := tx.Exec(ctx, `
		UPDATE project_module
		SET spec = $1, spec_version = $2, spec_updated_at = now(), canonical_prototype_version = $3
		WHERE id = $4`, specBytes, newVersion, candidateVersion, moduleID); err != nil {
		return err
	}
	if err := rebuildModuleFeatureProjection(ctx, tx, moduleID, spec, newVersion); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{
		"spec_version":  newVersion,
		"feature_count": len(spec.Features),
		"candidate":     candidateVersion,
		"via":           "plan_apply",
	})
	if _, err := tx.Exec(ctx, `
		INSERT INTO module_change_event (workspace_id, module_id, event_type, payload, actor_type, actor_id)
		VALUES ($1, $2, 'prototype_plan_applied', $3, 'member', $4)`,
		workspaceID, moduleID, payload, parseUUID(userID)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE module_prototype_plan SET status = 'applied', spec_version = $1, updated_at = $2, error = NULL
		WHERE id = $3`, newVersion, appliedAt, planID); err != nil {
		return err
	}
	return nil
}
