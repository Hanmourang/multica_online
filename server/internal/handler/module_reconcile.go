package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
)

// 功能模块原型中枢 · 四态对账面（plans/20261026 07 §3.3 · M-06）。
//
// 覆盖率与四态判定的唯一口径在后端：读 project_module.spec + module_prototype_parse
// 缓存（前端解析出的 data-fp anchors，后端不解析 HTML），调 service.Reconcile 计算。
// 列表徽标与详情环都取这里的 coverage，禁止前端二次自算（07 §3.5 / 记忆防漂移）。

// loadProtoAnchors 读取指定原型版本的解析缓存；无记录返回空锚点集（→ 全 missing）。
func (h *Handler) loadProtoAnchors(ctx context.Context, moduleID pgtype.UUID, version int32) (map[string]service.ProtoAnchor, error) {
	var raw []byte
	err := h.DB.QueryRow(ctx, `
		SELECT anchors FROM module_prototype_parse WHERE module_id = $1 AND version = $2`,
		moduleID, version,
	).Scan(&raw)
	if err != nil {
		return nil, err
	}
	var anchors map[string]service.ProtoAnchor
	if err := json.Unmarshal(raw, &anchors); err != nil {
		return nil, err
	}
	return anchors, nil
}

// resolveReconcileTarget 决定对账用哪个原型版本：显式 ?version > canonical 指针。
// 返回 ok=false 表示没有任何可对标版本（proto 视为空 → 规格功能点全 missing）。
func (h *Handler) resolveReconcileTarget(row moduleSpecRow, versionParam string) (int32, bool, error) {
	if strings.TrimSpace(versionParam) != "" {
		v, err := strconv.Atoi(versionParam)
		if err != nil {
			return 0, false, err
		}
		return int32(v), true, nil
	}
	if row.canonical.Valid {
		return row.canonical.Int32, true, nil
	}
	return 0, false, nil
}

// computeReconcile 组装 spec×proto 并跑唯一口径对账。
func (h *Handler) computeReconcile(ctx context.Context, row moduleSpecRow, versionParam string) (int32, []service.ReconcileRow, service.Coverage, error) {
	spec, code, msg := normalizeModuleSpec(row.spec)
	if code != "" {
		return 0, nil, service.Coverage{}, &specError{code: code, msg: msg}
	}
	version, hasVersion, err := h.resolveReconcileTarget(row, versionParam)
	if err != nil {
		return 0, nil, service.Coverage{}, err
	}
	proto := service.ParsedPrototype{Anchors: map[string]service.ProtoAnchor{}}
	if hasVersion {
		anchors, err := h.loadProtoAnchors(ctx, row.id, version)
		if err == nil && anchors != nil {
			proto.Anchors = anchors
		}
		// 无解析缓存不视为错误：退化为「原型尚空」→ 全 missing，前端据此提示先解析。
	}
	rows, cov := service.Reconcile(spec, proto, nil)
	return version, rows, cov, nil
}

type specError struct{ code, msg string }

func (e *specError) Error() string { return e.msg }

// GetPrototypeReconcile returns the four-state matrix + coverage for a prototype
// version (default canonical). (07 §3.2 GET /modules/{moduleId}/prototype-reconcile)
func (h *Handler) GetPrototypeReconcile(w http.ResponseWriter, r *http.Request) {
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
	version, rows, cov, err := h.computeReconcile(r.Context(), row, r.URL.Query().Get("version"))
	if err != nil {
		if se, ok := err.(*specError); ok {
			writeModuleError(w, http.StatusUnprocessableEntity, se.code, se.msg)
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to reconcile prototype")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id": uuidToString(moduleID),
		"version":   version,
		"coverage":  cov,
		"rows":      rows,
	})
}

// GetModuleCoverage returns only the coverage KPI for the canonical prototype
// version — the list-badge and detail-ring share this single source.
// (07 §3.2 GET /modules/{moduleId}/coverage)
func (h *Handler) GetModuleCoverage(w http.ResponseWriter, r *http.Request) {
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
	_, _, cov, err := h.computeReconcile(r.Context(), row, r.URL.Query().Get("version"))
	if err != nil {
		if se, ok := err.(*specError); ok {
			writeModuleError(w, http.StatusUnprocessableEntity, se.code, se.msg)
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to compute coverage")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id": uuidToString(moduleID),
		"coverage":  cov,
	})
}
