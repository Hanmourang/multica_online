package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
)

// 功能模块原型中枢 · 模块级原型版本面（plans/20261026 07 §3.3 · M-04）。
//
// 关键：484 把 issue_prototype_version.issue_id 放宽为可空并加 owner CHECK，
// 于是原型可只挂 module_id 而不带 issue —— 这正是解开「无需求即无原型」（硬伤 3）
// 的落点。D-A：不新建原型存储表，仍复用 issue_prototype_version，只补 module_id。

func uuidPtr(v pgtype.UUID) *string {
	if !v.Valid {
		return nil
	}
	s := uuidToString(v)
	return &s
}

// prototypeVersionRow maps one issue_prototype_version row for a module.
type prototypeVersionRow struct {
	id        pgtype.UUID
	version   int32
	htmlPath  string
	prompt    string
	status    string
	issueID   pgtype.UUID
	createdAt pgtype.Timestamptz
}

func (p prototypeVersionRow) toResponse() map[string]any {
	return map[string]any{
		"id":         uuidToString(p.id),
		"version":    p.version,
		"html_path":  p.htmlPath,
		"prompt":     p.prompt,
		"status":     p.status,
		"issue_id":   uuidPtr(p.issueID),
		"created_at": timestampToString(p.createdAt),
	}
}

// ListModulePrototypeVersions returns the module's version sequence, optionally
// only the confirmed ones (?canonical=1). Works for modules with NO linked
// requirement — the 硬伤 3 closure path.
// (07 §3.2 GET /modules/{moduleId}/prototype-versions)
func (h *Handler) ListModulePrototypeVersions(w http.ResponseWriter, r *http.Request) {
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
	confirmedOnly := r.URL.Query().Get("canonical") == "1"
	query := `
		SELECT id, version, html_path, prompt, status, issue_id, created_at
		FROM issue_prototype_version
		WHERE module_id = $1`
	if confirmedOnly {
		query += ` AND status = 'confirmed'`
	}
	query += ` ORDER BY version DESC`
	rows, err := h.DB.Query(r.Context(), query, moduleID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list prototype versions")
		return
	}
	defer rows.Close()

	versions := []map[string]any{}
	for rows.Next() {
		var v prototypeVersionRow
		if err := rows.Scan(&v.id, &v.version, &v.htmlPath, &v.prompt, &v.status, &v.issueID, &v.createdAt); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read prototype version")
			return
		}
		versions = append(versions, v.toResponse())
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to iterate prototype versions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id":                   uuidToString(moduleID),
		"canonical_prototype_version": int4ToPtr(row.canonical),
		"versions":                    versions,
		"total":                       len(versions),
	})
}

// RegisterModulePrototypeVersionRequest is the body for POST /prototype-versions.
type RegisterModulePrototypeVersionRequest struct {
	Version      int32  `json:"version"`
	HtmlPath     string `json:"html_path"`
	Prompt       string `json:"prompt"`
	Status       string `json:"status,omitempty"`
	IssueID      string `json:"issue_id,omitempty"`      // 可选：带需求则同时挂 issue
	SetCanonical bool   `json:"set_canonical,omitempty"` // 登记即设为权威（需 confirmed）
}

// RegisterModulePrototypeVersion writes a module-scoped prototype version WITHOUT
// requiring an issue (module_id set, issue_id may be NULL). Optionally moves the
// canonical pointer. (07 §3.2 POST /modules/{moduleId}/prototype-versions)
func (h *Handler) RegisterModulePrototypeVersion(w http.ResponseWriter, r *http.Request) {
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
	if _, err := h.loadModuleSpec(r.Context(), project.ID, moduleID); err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	var req RegisterModulePrototypeVersionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Version <= 0 {
		writeError(w, http.StatusBadRequest, "version must be > 0")
		return
	}
	if strings.TrimSpace(req.HtmlPath) == "" {
		writeError(w, http.StatusBadRequest, "html_path is required")
		return
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "pending"
	}
	if status != "pending" && status != "confirmed" && status != "superseded" {
		writeError(w, http.StatusBadRequest, "status must be pending/confirmed/superseded")
		return
	}
	// set_canonical 只允许指向 confirmed 版本（07 §2.5：pending 权威需专门 flag，此处不放行）。
	if req.SetCanonical && status != "confirmed" {
		writeModuleError(w, http.StatusConflict, "canonical_pending_not_allowed",
			"only a confirmed version may become canonical")
		return
	}

	var issueID pgtype.UUID
	if s := strings.TrimSpace(req.IssueID); s != "" {
		parsed, ok := parseUUIDOrBadRequest(w, s, "issue_id")
		if !ok {
			return
		}
		issueID = parsed
	}

	ctx := r.Context()
	// 应用级 (module_id, version) 去重：DB 只有 UNIQUE(issue_id, version)，模块级序列需自证。
	var dup int
	if err := h.DB.QueryRow(ctx, `
		SELECT count(*) FROM issue_prototype_version WHERE module_id = $1 AND version = $2`,
		moduleID, req.Version,
	).Scan(&dup); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check version")
		return
	}
	if dup > 0 {
		writeModuleError(w, http.StatusConflict, "prototype_version_exists",
			"a module prototype with this version already exists")
		return
	}

	var out prototypeVersionRow
	// 存量原型行（需求级、module_id 为空）登记为模块原型时直接认领：插入新行会撞
	// issue_prototype_version 的 UNIQUE(issue_id, version)，而这正是「把当前预览这版
	// 登记成模块原型」的主路径（历史需求原型都没有回填 module_id）。
	claimed := false
	if issueID.Valid {
		tag, err := h.DB.Exec(ctx, `
			UPDATE issue_prototype_version
			   SET module_id = $1, status = $2
			 WHERE issue_id = $3 AND version = $4 AND module_id IS NULL`,
			moduleID, status, issueID, req.Version)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to claim prototype version")
			return
		}
		claimed = tag.RowsAffected() > 0
	}
	if claimed {
		err := h.DB.QueryRow(ctx, `
			SELECT id, version, html_path, prompt, status, issue_id, created_at
			  FROM issue_prototype_version
			 WHERE issue_id = $1 AND version = $2`, issueID, req.Version,
		).Scan(&out.id, &out.version, &out.htmlPath, &out.prompt, &out.status, &out.issueID, &out.createdAt)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to register prototype version")
			return
		}
	} else {
		err := h.DB.QueryRow(ctx, `
			INSERT INTO issue_prototype_version
			  (issue_id, workspace_id, module_id, version, html_path, prompt, status, created_by_type, created_by_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'member', $8)
			RETURNING id, version, html_path, prompt, status, issue_id, created_at`,
			issueID, project.WorkspaceID, moduleID, req.Version, req.HtmlPath, req.Prompt, status, parseUUID(userID),
		).Scan(&out.id, &out.version, &out.htmlPath, &out.prompt, &out.status, &out.issueID, &out.createdAt)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to register prototype version")
			return
		}
	}

	if req.SetCanonical {
		if _, err := h.DB.Exec(ctx, `
			UPDATE project_module SET canonical_prototype_version = $1 WHERE id = $2`,
			req.Version, moduleID); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to set canonical version")
			return
		}
		out.status = status
	}
	payload, _ := json.Marshal(map[string]any{"version": req.Version, "status": status, "set_canonical": req.SetCanonical})
	if _, err := h.DB.Exec(ctx, `
		INSERT INTO module_change_event (workspace_id, module_id, event_type, payload, actor_type, actor_id)
		VALUES ($1, $2, 'prototype_registered', $3, 'member', $4)`,
		project.WorkspaceID, moduleID, payload, parseUUID(userID)); err != nil {
		// 审计写失败不回滚已登记的版本（版本本身可用），仅记录后继续。
		_ = err
	}

	h.publish("prototype:published", uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"module_id": uuidToString(moduleID), "version": req.Version, "status": status})
	writeJSON(w, http.StatusCreated, out.toResponse())
}

// ParseModulePrototypeRequest is the body for POST /prototype-versions/{version}/parse.
type ParseModulePrototypeRequest struct {
	Anchors map[string]service.ProtoAnchor `json:"anchors"`
}

// ParseModulePrototype stores the front-end-parsed data-fp anchors for a version
// so reconcile/coverage can read a cache instead of re-parsing HTML server-side
// (07 §2.3-4：后端不解析 HTML). (07 §3.2 .../parse)
func (h *Handler) ParseModulePrototype(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "moduleId"), "module id")
	if !ok {
		return
	}
	versionParam := chi.URLParam(r, "version")
	version, err := strconv.Atoi(versionParam)
	if err != nil || version <= 0 {
		writeError(w, http.StatusBadRequest, "invalid version")
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	if _, err := h.loadModuleSpec(r.Context(), project.ID, moduleID); err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	var req ParseModulePrototypeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Anchors == nil {
		req.Anchors = map[string]service.ProtoAnchor{}
	}
	anchors, _ := json.Marshal(req.Anchors)
	if _, err := h.DB.Exec(r.Context(), `
		INSERT INTO module_prototype_parse (module_id, version, anchors, parsed_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (module_id, version) DO UPDATE
		  SET anchors = EXCLUDED.anchors, parsed_at = now()`,
		moduleID, int32(version), anchors); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to cache prototype parse")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id":    uuidToString(moduleID),
		"version":      version,
		"anchor_count": len(req.Anchors),
	})
}
