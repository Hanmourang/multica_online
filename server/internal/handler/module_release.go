package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// 功能模块工作区 · 成对发布（原型图 TAB v2 · 画面 6 · migration 499）。
//
// 一个 module_release = 一个说明版本 ⨯ 一个原型版本。项目模块的两个指针
// （brief_version / canonical_prototype_version）只在这里被推进，其他地方一律只读。
// 三条不可变性：发布序号不复用、旧版本不可修改、指针只有一个写点。
// 发布是**人工动作**：actor 为 agent 一律 403 agent_cannot_release。

var (
	errReleaseBriefMissing     = errors.New("brief version not found")
	errReleasePrototypeMissing = errors.New("prototype version not found")
)

// moduleReleaseRequest 是 POST /releases 的请求体。
type moduleReleaseRequest struct {
	BriefVersion     *int32 `json:"brief_version,omitempty"`
	PrototypeVersion *int32 `json:"prototype_version,omitempty"`
	Note             string `json:"note,omitempty"`
}

// publishModuleReleaseTx 是唯一的指针推进点：说明版本置 published（其余 published 转
// superseded）、写一条 release、推 project_module 的两个指针。调用方负责提交。
func publishModuleReleaseTx(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID, moduleID pgtype.UUID,
	briefVersion, prototypeVersion int32,
	releasedBy pgtype.UUID,
	note string,
) (map[string]any, error) {
	var (
		currentRelease int32
		canonical      int32
	)
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(release_version, 0), COALESCE(canonical_prototype_version, 0)
		  FROM project_module WHERE id = $1 FOR UPDATE`, moduleID,
	).Scan(&currentRelease, &canonical); err != nil {
		return nil, err
	}
	var briefStatus string
	if err := tx.QueryRow(ctx, `
		SELECT status FROM module_brief_version
		 WHERE module_id = $1 AND version = $2`, moduleID, briefVersion).Scan(&briefStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errReleaseBriefMissing
		}
		return nil, err
	}
	if prototypeVersion > 0 {
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT true FROM issue_prototype_version
			 WHERE module_id = $1 AND version = $2`, moduleID, prototypeVersion).Scan(&exists); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, errReleasePrototypeMissing
			}
			return nil, err
		}
	}

	newRelease := currentRelease + 1
	diffPayload, _ := json.Marshal(map[string]any{
		"brief_version":     briefVersion,
		"prototype_version": prototypeVersion,
		"note":              strings.TrimSpace(note),
	})
	if _, err := tx.Exec(ctx, `
		INSERT INTO module_release (module_id, version, brief_version, prototype_version, diff, released_by)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		moduleID, newRelease, briefVersion, prototypeVersion, diffPayload, releasedBy); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE module_brief_version SET status = 'superseded'
		 WHERE module_id = $1 AND status = 'published' AND version <> $2`, moduleID, briefVersion); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE module_brief_version SET status = 'published'
		 WHERE module_id = $1 AND version = $2`, moduleID, briefVersion); err != nil {
		return nil, err
	}
	nextCanonical := canonical
	if prototypeVersion > 0 {
		nextCanonical = prototypeVersion
	}
	if _, err := tx.Exec(ctx, `
		UPDATE project_module
		   SET release_version = $1, brief_version = $2,
		       canonical_prototype_version = $3, spec_updated_at = now()
		 WHERE id = $4`, newRelease, briefVersion, nextCanonical, moduleID); err != nil {
		return nil, err
	}
	eventPayload, _ := json.Marshal(map[string]any{
		"release_version":   newRelease,
		"brief_version":     briefVersion,
		"prototype_version": prototypeVersion,
	})
	if _, err := tx.Exec(ctx, `
		INSERT INTO module_change_event (workspace_id, module_id, event_type, payload, actor_type, actor_id)
		VALUES ($1, $2, 'release_published', $3, 'member', $4)`,
		workspaceID, moduleID, eventPayload, releasedBy); err != nil {
		return nil, err
	}
	by := ""
	if releasedBy.Valid {
		by = uuidToString(releasedBy)
	}
	return map[string]any{
		"version":           newRelease,
		"brief_version":     briefVersion,
		"prototype_version": prototypeVersion,
		"released_by":       by,
	}, nil
}

func (h *Handler) requireHumanActor(w http.ResponseWriter, r *http.Request, projectWorkspaceID string) (string, string, bool) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return "", "", false
	}
	actorType, actorID := h.resolveActor(r, userID, projectWorkspaceID)
	if actorType == "agent" {
		writeModuleError(w, http.StatusForbidden, "agent_cannot_release",
			"releases are a human action; agents can propose a brief version instead")
		return "", "", false
	}
	return userID, actorID, true
}

// GetModuleReleases 返回发布历史与当前两条时间轴的指针。
func (h *Handler) GetModuleReleases(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "moduleId"), "module id")
	if !ok {
		return
	}
	ctx := r.Context()
	mod, err := h.loadModuleWorkspace(ctx, project.ID, moduleID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	releases, err := loadModuleReleases(ctx, h.DB, moduleID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load module releases")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id":                   uuidToString(moduleID),
		"brief_version":               int4ToPtr(mod.briefVersion),
		"release_version":             int4ToPtr(mod.releaseVersion),
		"canonical_prototype_version": int4ToPtr(mod.canonical),
		"releases":                    releases,
	})
}

// PublishModuleRelease 把「说明 vN ⨯ 原型 vM」成对发布（仅人可调用）。
func (h *Handler) PublishModuleRelease(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "moduleId"), "module id")
	if !ok {
		return
	}
	userID, _, ok := h.requireHumanActor(w, r, uuidToString(project.WorkspaceID))
	if !ok {
		return
	}
	var req moduleReleaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ctx := r.Context()
	mod, err := h.loadModuleWorkspace(ctx, project.ID, moduleID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	briefVersion := int32(0)
	if mod.briefVersion.Valid {
		briefVersion = mod.briefVersion.Int32
	} else if latest, err := loadLatestBrief(ctx, h.DB, moduleID, false); err == nil {
		briefVersion = latest.version
	}
	if req.BriefVersion != nil {
		briefVersion = *req.BriefVersion
	}
	prototypeVersion := int32(0)
	if mod.canonical.Valid {
		prototypeVersion = mod.canonical.Int32
	}
	if req.PrototypeVersion != nil {
		prototypeVersion = *req.PrototypeVersion
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to open release transaction")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	release, err := publishModuleReleaseTx(ctx, tx, project.WorkspaceID, moduleID,
		briefVersion, prototypeVersion, parseUUID(userID), req.Note)
	switch {
	case errors.Is(err, errReleaseBriefMissing):
		writeModuleError(w, http.StatusUnprocessableEntity, "brief_version_not_found", "brief version does not exist")
		return
	case errors.Is(err, errReleasePrototypeMissing):
		writeModuleError(w, http.StatusUnprocessableEntity, "prototype_version_not_found", "prototype version does not exist")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "failed to publish module release")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit module release")
		return
	}

	h.publish("project_module:released", uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"module_id": uuidToString(moduleID), "project_id": uuidToString(project.ID),
			"release_version": release["version"], "brief_version": briefVersion,
			"prototype_version": prototypeVersion})
	writeJSON(w, http.StatusOK, map[string]any{"module_id": uuidToString(moduleID), "release": release})
}

// RollbackModuleRelease 回滚 = 以旧版为基发新版（不修改任何历史行，画面 6）。
func (h *Handler) RollbackModuleRelease(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	moduleID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "moduleId"), "module id")
	if !ok {
		return
	}
	releaseVersion, convErr := strconv.Atoi(strings.TrimSpace(chi.URLParam(r, "version")))
	if convErr != nil {
		writeError(w, http.StatusBadRequest, "invalid release version")
		return
	}
	userID, _, ok := h.requireHumanActor(w, r, uuidToString(project.WorkspaceID))
	if !ok {
		return
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to open rollback transaction")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var (
		targetBrief int32
		targetProto int32
	)
	if err := tx.QueryRow(ctx, `
		SELECT brief_version, prototype_version FROM module_release
		 WHERE module_id = $1 AND version = $2`, moduleID, releaseVersion).Scan(&targetBrief, &targetProto); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "module release not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load module release")
		return
	}
	var targetRaw []byte
	if err := tx.QueryRow(ctx, `
		SELECT fields FROM module_brief_version
		 WHERE module_id = $1 AND version = $2`, moduleID, targetBrief).Scan(&targetRaw); err != nil {
		writeModuleError(w, http.StatusUnprocessableEntity, "brief_version_not_found", "the release's brief version is gone")
		return
	}
	targetFields, err := parseBriefFields(targetRaw)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to decode brief fields")
		return
	}
	current, err := loadLatestBrief(ctx, tx, moduleID, true)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "failed to load module brief")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		current = moduleBriefRow{fields: map[string]moduleFieldValue{}}
	}
	newVersion := current.version + 1
	fieldsJSON, err := json.Marshal(targetFields)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode brief fields")
		return
	}
	changesJSON, _ := json.Marshal(fieldDiffBetween(current.fields, targetFields))
	summary := "回滚至 R" + strconv.Itoa(releaseVersion)
	if _, err := tx.Exec(ctx, `
		INSERT INTO module_brief_version
		    (module_id, version, base_version, fields, status, source, diff_summary, changes, created_by, created_by_type)
		VALUES ($1, $2, $3, $4, 'draft', 'rollback', $5, $6, $7, 'member')`,
		moduleID, newVersion, current.version, fieldsJSON,
		summary, changesJSON, parseUUID(userID)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to append rollback brief version")
		return
	}
	release, err := publishModuleReleaseTx(ctx, tx, project.WorkspaceID, moduleID,
		newVersion, targetProto, parseUUID(userID), summary)
	switch {
	case errors.Is(err, errReleasePrototypeMissing):
		writeModuleError(w, http.StatusUnprocessableEntity, "prototype_version_not_found", "prototype version does not exist")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "failed to publish rollback release")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit rollback")
		return
	}
	h.publish("project_module:released", uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"module_id": uuidToString(moduleID), "project_id": uuidToString(project.ID),
			"release_version": release["version"], "rollback_of": releaseVersion})
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id":     uuidToString(moduleID),
		"brief_version": newVersion,
		"release":       release,
	})
}

// fieldDiffBetween 给出两个说明快照的差异，回滚时用来展示「这次回滚改了什么」。
func fieldDiffBetween(from, to map[string]moduleFieldValue) []moduleFieldDiff {
	out := make([]moduleFieldDiff, 0, len(to))
	for key, next := range to {
		prev, exists := from[key]
		if exists && jsonValueEqual(prev.Value, next.Value) {
			continue
		}
		var before any
		if exists {
			before = prev.Value
		}
		out = append(out, moduleFieldDiff{Key: key, Op: diffOp(next.Value), From: before, To: next.Value})
	}
	for key, prev := range from {
		if _, exists := to[key]; exists || isEmptyFieldValue(prev.Value) {
			continue
		}
		out = append(out, moduleFieldDiff{Key: key, Op: "clear", From: prev.Value, To: nil})
	}
	return out
}
