package handler

import (
	"context"
	"encoding/json"
	"fmt"
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

// ── 模块自有版本的维护面（update / confirm / delete）─────────────────────────
//
// 这三条只对「模块自有」版本生效（issue_id 为空）。issue_id 非空的行仍然属于
// 需求原型序列：它的确认还要走 stage-1 收口、它的路径还有需求侧的审批语义，
// 从模块口子改会绕开那些闸门，故一律拒绝并指回 `multica requirement prototype`。

// loadModulePrototypeVersion 按 (module, version) 读一行；不存在返回 pgx.ErrNoRows。
func (h *Handler) loadModulePrototypeVersion(ctx context.Context, moduleID pgtype.UUID, version int32) (prototypeVersionRow, error) {
	var row prototypeVersionRow
	err := h.DB.QueryRow(ctx, `
		SELECT id, version, html_path, prompt, status, issue_id, created_at
		  FROM issue_prototype_version
		 WHERE module_id = $1 AND version = $2`, moduleID, version,
	).Scan(&row.id, &row.version, &row.htmlPath, &row.prompt, &row.status, &row.issueID, &row.createdAt)
	return row, err
}

// moduleOwned 判定一行是否可以由模块维护面改写：issue_id 为空才算模块自有。
func (row prototypeVersionRow) moduleOwned() bool { return !row.issueID.Valid }

// UpdateModulePrototypeVersionRequest 是 PATCH /prototype-versions/{version} 的请求体。
type UpdateModulePrototypeVersionRequest struct {
	HtmlPath *string `json:"html_path,omitempty"`
	Prompt   *string `json:"prompt,omitempty"`
	Status   *string `json:"status,omitempty"`
}

// UpdateModulePrototypeVersion 修正一个模块自有版本的路径 / 说明 / 状态。
// 登记错路径（换了目录、文件改名）不必再开一个新版本号——版本号是审计坐标，
// 改指针比造一条假版本更诚实。权威版本不允许离开 confirmed（与 set_canonical 同规则）。
func (h *Handler) UpdateModulePrototypeVersion(w http.ResponseWriter, r *http.Request) {
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
	version, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || version <= 0 {
		writeError(w, http.StatusBadRequest, "invalid version")
		return
	}
	mod, err := h.loadModuleSpec(r.Context(), project.ID, moduleID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	var req UpdateModulePrototypeVersionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.HtmlPath == nil && req.Prompt == nil && req.Status == nil {
		writeError(w, http.StatusBadRequest, "pass at least one of html_path, prompt, status")
		return
	}
	row, err := h.loadModulePrototypeVersion(r.Context(), moduleID, int32(version))
	if err != nil {
		writeError(w, http.StatusNotFound, "prototype version not found")
		return
	}
	if !row.moduleOwned() {
		writeModuleError(w, http.StatusConflict, "prototype_owned_by_requirement",
			"this version belongs to a requirement; update it with `multica requirement prototype` instead")
		return
	}

	sets := make([]string, 0, 3)
	args := make([]any, 0, 4)
	if req.HtmlPath != nil {
		path := strings.TrimSpace(*req.HtmlPath)
		if path == "" {
			writeError(w, http.StatusBadRequest, "html_path must not be empty")
			return
		}
		sets = append(sets, fmt.Sprintf("html_path = $%d", len(args)+1))
		args = append(args, path)
	}
	if req.Prompt != nil {
		sets = append(sets, fmt.Sprintf("prompt = $%d", len(args)+1))
		args = append(args, strings.TrimSpace(*req.Prompt))
	}
	if req.Status != nil {
		status := strings.TrimSpace(*req.Status)
		if status != "pending" && status != "confirmed" && status != "superseded" {
			writeError(w, http.StatusBadRequest, "status must be pending/confirmed/superseded")
			return
		}
		if mod.canonical.Valid && int32(mod.canonical.Int32) == int32(version) && status != "confirmed" {
			writeModuleError(w, http.StatusConflict, "canonical_pending_not_allowed",
				"the canonical version must stay confirmed")
			return
		}
		sets = append(sets, fmt.Sprintf("status = $%d", len(args)+1))
		args = append(args, status)
	}
	args = append(args, row.id)
	if _, err := h.DB.Exec(r.Context(), `
		UPDATE issue_prototype_version SET `+strings.Join(sets, ", ")+` WHERE id = $`+strconv.Itoa(len(args)),
		args...); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update prototype version")
		return
	}
	h.recordPrototypeEvent(r.Context(), project.WorkspaceID, moduleID, userID, "prototype_updated", map[string]any{
		"version": version,
	})
	updated, err := h.loadModulePrototypeVersion(r.Context(), moduleID, int32(version))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reload prototype version")
		return
	}
	writeJSON(w, http.StatusOK, updated.toResponse())
}

// ConfirmModulePrototypeRequest 是 POST /prototype-versions/{version}/confirm 的请求体。
type ConfirmModulePrototypeRequest struct {
	SetCanonical bool `json:"set_canonical,omitempty"`
}

// ConfirmModulePrototypeVersion 把模块自有版本标记为 confirmed，可顺带设为权威版本。
// 与 plan apply 的区别：这里不升 spec、不重建投影——它只解决「这一版原型被认可了」，
// 功能点与规格的合并仍走两段式 plan。
func (h *Handler) ConfirmModulePrototypeVersion(w http.ResponseWriter, r *http.Request) {
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
	version, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || version <= 0 {
		writeError(w, http.StatusBadRequest, "invalid version")
		return
	}
	if _, err := h.loadModuleSpec(r.Context(), project.ID, moduleID); err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	var req ConfirmModulePrototypeRequest
	if r.Body != nil {
		// 空 body 表示「只确认、不动权威指针」，不算错误。
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	row, err := h.loadModulePrototypeVersion(r.Context(), moduleID, int32(version))
	if err != nil {
		writeError(w, http.StatusNotFound, "prototype version not found")
		return
	}
	if !row.moduleOwned() {
		writeModuleError(w, http.StatusConflict, "prototype_owned_by_requirement",
			"this version belongs to a requirement; confirm it with `multica requirement prototype confirm` instead")
		return
	}
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to open transaction")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `UPDATE issue_prototype_version SET status = 'confirmed' WHERE id = $1`, row.id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to confirm prototype version")
		return
	}
	if req.SetCanonical {
		if _, err := tx.Exec(ctx, `UPDATE project_module SET canonical_prototype_version = $1 WHERE id = $2`, version, moduleID); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to set canonical version")
			return
		}
		// 上一版权威版本置为 superseded：两条时间轴只允许一个权威指针。
		// 只动模块自有行——需求名下的版本由需求侧的确认流程管，从模块口子改状态
		// 会绕开那边已有的审批语义。
		if _, err := tx.Exec(ctx, `
			UPDATE issue_prototype_version SET status = 'superseded'
			 WHERE module_id = $1 AND version <> $2 AND status = 'confirmed'
			   AND issue_id IS NULL`, moduleID, version); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to supersede the previous canonical version")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit prototype confirmation")
		return
	}
	h.recordPrototypeEvent(ctx, project.WorkspaceID, moduleID, userID, "prototype_confirmed", map[string]any{
		"version": version, "set_canonical": req.SetCanonical,
	})
	h.publish("prototype:published", uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"module_id": uuidToString(moduleID), "version": version, "status": "confirmed"})
	updated, err := h.loadModulePrototypeVersion(ctx, moduleID, int32(version))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reload prototype version")
		return
	}
	writeJSON(w, http.StatusOK, updated.toResponse())
}

// DeleteModulePrototypeVersion 删除一个模块自有版本（登记手滑、文件已废）。
// 两道拒绝：权威版本不能删（先 confirm 新一版），被成对发布引用过的不能删
// （module_release 记的是版本号，删掉会让历史指向空）。
func (h *Handler) DeleteModulePrototypeVersion(w http.ResponseWriter, r *http.Request) {
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
	version, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || version <= 0 {
		writeError(w, http.StatusBadRequest, "invalid version")
		return
	}
	mod, err := h.loadModuleSpec(r.Context(), project.ID, moduleID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	row, err := h.loadModulePrototypeVersion(r.Context(), moduleID, int32(version))
	if err != nil {
		writeError(w, http.StatusNotFound, "prototype version not found")
		return
	}
	if !row.moduleOwned() {
		writeModuleError(w, http.StatusConflict, "prototype_owned_by_requirement",
			"this version belongs to a requirement and cannot be deleted from the module")
		return
	}
	if mod.canonical.Valid && int32(mod.canonical.Int32) == int32(version) {
		writeModuleError(w, http.StatusConflict, "canonical_prototype_in_use",
			"the canonical prototype version cannot be deleted; confirm another version first")
		return
	}
	var released int
	if err := h.DB.QueryRow(r.Context(), `
		SELECT count(*) FROM module_release WHERE module_id = $1 AND prototype_version = $2`,
		moduleID, version).Scan(&released); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check releases")
		return
	}
	if released > 0 {
		writeModuleError(w, http.StatusConflict, "prototype_in_release",
			"this version is referenced by a release; releases keep their history")
		return
	}
	if _, err := h.DB.Exec(r.Context(), `DELETE FROM issue_prototype_version WHERE id = $1`, row.id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete prototype version")
		return
	}
	// 解析缓存跟着版本走：留着会让 reconcile 读到已删除版本的锚点。
	if _, err := h.DB.Exec(r.Context(), `DELETE FROM module_prototype_parse WHERE module_id = $1 AND version = $2`, moduleID, version); err != nil {
		_ = err
	}
	h.recordPrototypeEvent(r.Context(), project.WorkspaceID, moduleID, userID, "prototype_deleted", map[string]any{
		"version": version,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id": uuidToString(moduleID),
		"version":   version,
		"deleted":   true,
	})
}

// recordPrototypeEvent 写一条模块变更事件；审计失败不回滚业务结果。
func (h *Handler) recordPrototypeEvent(ctx context.Context, workspaceID, moduleID pgtype.UUID, userID, eventType string, payload map[string]any) {
	raw, _ := json.Marshal(payload)
	if _, err := h.DB.Exec(ctx, `
		INSERT INTO module_change_event (workspace_id, module_id, event_type, payload, actor_type, actor_id)
		VALUES ($1, $2, $3, $4, 'member', $5)`,
		workspaceID, moduleID, eventType, raw, parseUUID(userID)); err != nil {
		_ = err
	}
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
	// 版本必须存在：否则锚点会挂在一个并不存在的版本号上，对账时看上去“有标记”，
	// 实际那个版本谁也读不到。需求名下的版本也可以解析（前端两边共用同一张缓存）。
	if _, err := h.loadModulePrototypeVersion(r.Context(), moduleID, int32(version)); err != nil {
		writeError(w, http.StatusNotFound, "prototype version not found")
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
