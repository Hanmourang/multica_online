package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
)

// 功能模块原型中枢 · spec 读写面（plans/20261026 07 §3.3 · M-03）。
//
// project_module.spec 是「能力规格」的唯一真源（module_spec/v1）；project_module_feature
// 是其派生投影，仅在 PublishModuleSpec 事务内重建，供覆盖率/列表徽标/聊天摘要使用。
// 全部走原生 h.DB / tx SQL（新表不入 sqlc 快照，见记忆「新表 handler 走原生 SQL」）。

// moduleSpecRow 是 project_module 的规格相关列（484 新增，sqlc 结构未含，故原生扫描）。
type moduleSpecRow struct {
	id        pgtype.UUID
	name      string
	color     string
	spec      []byte
	version   int32
	canonical pgtype.Int4
	updatedAt pgtype.Timestamptz
}

// loadModuleSpec 以「模块属于该项目」为作用域读取规格列；找不到返回 pgx.ErrNoRows。
func (h *Handler) loadModuleSpec(ctx context.Context, projectID, moduleID pgtype.UUID) (moduleSpecRow, error) {
	var row moduleSpecRow
	err := h.DB.QueryRow(ctx, `
		SELECT id, name, color, spec, spec_version, canonical_prototype_version, spec_updated_at
		FROM project_module
		WHERE id = $1 AND project_id = $2`, moduleID, projectID,
	).Scan(&row.id, &row.name, &row.color, &row.spec, &row.version, &row.canonical, &row.updatedAt)
	return row, err
}

func writeModuleError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": msg, "code": code})
}

// normalizeModuleSpec 校验并反序列化 module_spec/v1：
//   - schema 必须为 module_spec/v1，否则 spec_schema_invalid（422）；
//   - 每个功能点 code 非空，否则 spec_schema_invalid（422）；
//   - code 在项目内唯一，否则 feature_code_duplicated（422）。
func normalizeModuleSpec(raw []byte) (service.ModuleSpec, string, string) {
	var spec service.ModuleSpec
	if len(raw) == 0 {
		return spec, "spec_schema_invalid", "spec is required"
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		return spec, "spec_schema_invalid", "spec must be valid JSON"
	}
	if spec.Schema != "module_spec/v1" {
		return spec, "spec_schema_invalid", "spec.schema must be module_spec/v1"
	}
	seen := make(map[string]bool, len(spec.Features))
	for i := range spec.Features {
		code := strings.TrimSpace(spec.Features[i].Code)
		if code == "" {
			return spec, "spec_schema_invalid", "every feature must have a non-empty code"
		}
		spec.Features[i].Code = code
		if seen[code] {
			return spec, "feature_code_duplicated", "duplicate feature code: " + code
		}
		seen[code] = true
		kind := strings.TrimSpace(spec.Features[i].Kind)
		if kind != "edge" {
			spec.Features[i].Kind = "core"
		} else {
			spec.Features[i].Kind = kind
		}
	}
	return spec, "", ""
}

// rebuildModuleFeatureProjection 在发布事务内重建 project_module_feature 投影
// （07 D-C：派生表非真源，先清后插，与 spec 写入同事务）。PublishModuleSpec 与
// ApplyPrototypePlan 共用，保证两处口径完全一致。
func rebuildModuleFeatureProjection(ctx context.Context, tx pgx.Tx, moduleID pgtype.UUID, spec service.ModuleSpec, specVersion int32) error {
	if _, err := tx.Exec(ctx, `DELETE FROM project_module_feature WHERE module_id = $1`, moduleID); err != nil {
		return err
	}
	for _, f := range spec.Features {
		prio := any(nil)
		if strings.TrimSpace(f.Priority) != "" {
			prio = f.Priority
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO project_module_feature (module_id, code, title, kind, priority, spec_version)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (module_id, code) DO UPDATE
			  SET title = EXCLUDED.title, kind = EXCLUDED.kind,
			      priority = EXCLUDED.priority, spec_version = EXCLUDED.spec_version`,
			moduleID, f.Code, f.Title, f.Kind, prio, specVersion); err != nil {
			return err
		}
	}
	return nil
}

// GetModuleSpec returns the module's capability spec, its version, the canonical
// prototype pointer and a feature count. (07 §3.2 GET /modules/{moduleId}/spec)
func (h *Handler) GetModuleSpec(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "moduleId"), "module id")
	if !ok {
		return
	}
	row, err := h.loadModuleSpec(r.Context(), project.ID, moduleID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	spec, _, _ := normalizeModuleSpec(row.spec)
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id":                   uuidToString(row.id),
		"name":                        row.name,
		"color":                       row.color,
		"spec":                        json.RawMessage(row.spec),
		"spec_version":                row.version,
		"canonical_prototype_version": int4ToPtr(row.canonical),
		"feature_count":               len(spec.Features),
		"spec_updated_at":             timestampToString(row.updatedAt),
	})
}

// DraftModuleSpecRequest carries a full spec to stash as the working draft.
type DraftModuleSpecRequest struct {
	Spec json.RawMessage `json:"spec"`
}

// DraftModuleSpec writes/updates the spec JSON without bumping spec_version or
// rebuilding the projection — the draft is a pre-publish workspace (07 D-D 两段式).
func (h *Handler) DraftModuleSpec(w http.ResponseWriter, r *http.Request) {
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
	var req DraftModuleSpecRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	spec, code, msg := normalizeModuleSpec(req.Spec)
	if code != "" {
		writeModuleError(w, http.StatusUnprocessableEntity, code, msg)
		return
	}
	specBytes, _ := json.Marshal(spec)
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE project_module SET spec = $1, spec_updated_at = now()
		WHERE id = $2 AND project_id = $3`, specBytes, moduleID, project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to draft module spec")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id":     uuidToString(moduleID),
		"feature_count": len(spec.Features),
		"spec":          json.RawMessage(specBytes),
	})
}

// PublishModuleSpecRequest is the body for POST /spec/publish.
type PublishModuleSpecRequest struct {
	Spec            json.RawMessage `json:"spec"`
	ExpectedVersion *int32          `json:"expected_version,omitempty"`
}

// PublishModuleSpec commits the spec: within ONE transaction it bumps
// spec_version, persists the spec, rebuilds project_module_feature, and records
// a module_change_event. A stale expected_version → 409 spec_version_conflict
// (07 §3.3 / 附录 C).
func (h *Handler) PublishModuleSpec(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "moduleId"), "module id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req PublishModuleSpecRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	spec, code, msg := normalizeModuleSpec(req.Spec)
	if code != "" {
		writeModuleError(w, http.StatusUnprocessableEntity, code, msg)
		return
	}
	specBytes, _ := json.Marshal(spec)

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to publish module spec")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var cur int32
	if err := tx.QueryRow(ctx, `
		SELECT spec_version FROM project_module
		WHERE id = $1 AND project_id = $2 FOR UPDATE`, moduleID, project.ID,
	).Scan(&cur); err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	if req.ExpectedVersion != nil && *req.ExpectedVersion != cur {
		writeModuleError(w, http.StatusConflict, "spec_version_conflict",
			"expected_version does not match current spec_version")
		return
	}
	newVersion := cur + 1

	if _, err := tx.Exec(ctx, `
		UPDATE project_module SET spec = $1, spec_version = $2, spec_updated_at = now()
		WHERE id = $3`, specBytes, newVersion, moduleID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to write module spec")
		return
	}
	// 投影重建（D-C 派生表非真源）：与 spec 同事务。
	if err := rebuildModuleFeatureProjection(ctx, tx, moduleID, spec, newVersion); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to rebuild feature projection")
		return
	}

	payload, _ := json.Marshal(map[string]any{"spec_version": newVersion, "feature_count": len(spec.Features)})
	if _, err := tx.Exec(ctx, `
		INSERT INTO module_change_event (workspace_id, module_id, event_type, payload, actor_type, actor_id)
		VALUES ($1, $2, 'spec_published', $3, 'member', $4)`,
		project.WorkspaceID, moduleID, payload, parseUUID(userID)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record change event")
		return
	}

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to publish module spec")
		return
	}

	h.publish("project_module:spec_updated", uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"module_id": uuidToString(moduleID), "spec_version": newVersion,
			"feature_count": len(spec.Features), "project_id": uuidToString(project.ID)})
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id":     uuidToString(moduleID),
		"spec_version":  newVersion,
		"feature_count": len(spec.Features),
	})
}
