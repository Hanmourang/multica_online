package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 角色执行标准（项目默认 + 需求快照）：
// GET 返回内置 ⊕ 覆盖的解析结果，以及原始覆盖，供编辑器「恢复默认」。
// PUT 为 whole-document replace：只落有覆盖字段的角色行；全空 = 删除该角色覆盖。

type rolePlaybookEntry struct {
	Background  string `json:"background"`
	Standards   string `json:"standards"`
	Process     string `json:"process"`
	InitMode    string `json:"init_mode"`
	InitContent string `json:"init_content"`
}

type rolePlaybookPutRequest struct {
	Overrides map[string]rolePlaybookEntry `json:"overrides"`
}

func playbookResponse(overrides map[string]service.RolePlaybook) map[string]any {
	resolved := make(map[string]service.RolePlaybook, len(service.RolePlaybookRoles))
	builtins := service.BuiltinRolePlaybooks()
	overrideOut := make(map[string]service.RolePlaybook, len(overrides))
	for _, role := range service.RolePlaybookRoles {
		ov := overrides[role]
		resolved[role] = service.ResolveRolePlaybook(role, ov)
		if service.RolePlaybookHasOverride(ov) {
			ov.Role = role
			ov.InitMode = service.NormalizeRolePlaybookInitMode(ov.InitMode)
			overrideOut[role] = ov
		}
	}
	return map[string]any{
		"playbooks": resolved,
		"overrides": overrideOut,
		"builtins":  builtins,
	}
}

func parsePlaybookOverrides(raw map[string]rolePlaybookEntry) (map[string]service.RolePlaybook, int, string) {
	out := make(map[string]service.RolePlaybook, len(raw))
	for role, e := range raw {
		if !rosterRoles[role] {
			return nil, http.StatusBadRequest, "unknown role: " + role
		}
		if trimmed := strings.TrimSpace(strings.ToLower(e.InitMode)); trimmed != "" && !service.ValidRolePlaybookInitModes[trimmed] {
			return nil, http.StatusBadRequest, "invalid init_mode: " + e.InitMode
		}
		out[role] = service.RolePlaybook{
			Role:        role,
			Background:  e.Background,
			Standards:   e.Standards,
			Process:     e.Process,
			InitMode:    e.InitMode,
			InitContent: e.InitContent,
		}
	}
	return out, 0, ""
}

func marshalPlaybookEntries(overrides map[string]service.RolePlaybook) []byte {
	type row struct {
		Role        string `json:"role"`
		Background  string `json:"background"`
		Standards   string `json:"standards"`
		Process     string `json:"process"`
		InitMode    string `json:"init_mode"`
		InitContent string `json:"init_content"`
	}
	rows := make([]row, 0, len(overrides))
	for _, role := range service.RolePlaybookRoles {
		p, ok := overrides[role]
		if !ok || !service.RolePlaybookHasOverride(p) {
			continue
		}
		rows = append(rows, row{
			Role:        role,
			Background:  p.Background,
			Standards:   p.Standards,
			Process:     p.Process,
			InitMode:    service.NormalizeRolePlaybookInitMode(p.InitMode),
			InitContent: p.InitContent,
		})
	}
	if len(rows) == 0 {
		return []byte("[]")
	}
	payload, _ := json.Marshal(rows)
	return payload
}

func (h *Handler) resolveIssuePlaybook(r *http.Request, issueID pgtype.UUID, role string) service.RolePlaybook {
	rows, err := h.Queries.ListIssueRolePlaybooks(r.Context(), issueID)
	if err != nil {
		return service.RolePlaybook{}
	}
	return service.PlaybookMapFromIssueRows(rows)[role]
}

// ListProjectRolePlaybooks returns resolved + override + builtin playbooks
// (GET /api/projects/{id}/role-playbooks).
func (h *Handler) ListProjectRolePlaybooks(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.Queries.ListProjectRolePlaybooks(r.Context(), project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project role playbooks")
		return
	}
	writeJSON(w, http.StatusOK, playbookResponse(service.PlaybookMapFromProjectRows(rows)))
}

// ReplaceProjectRolePlaybooks atomically replaces the project's role playbook
// overrides (PUT /api/projects/{id}/role-playbooks).
func (h *Handler) ReplaceProjectRolePlaybooks(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var req rolePlaybookPutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	overrides, code, msg := parsePlaybookOverrides(req.Overrides)
	if code != 0 {
		writeError(w, code, msg)
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if err := qtx.DeleteProjectRolePlaybooks(r.Context(), project.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to replace project role playbooks")
		return
	}
	entries := marshalPlaybookEntries(overrides)
	if string(entries) != "[]" {
		if err := qtx.InsertProjectRolePlaybooks(r.Context(), db.InsertProjectRolePlaybooksParams{
			ProjectID:   project.ID,
			WorkspaceID: project.WorkspaceID,
			Entries:     entries,
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to replace project role playbooks")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit role playbooks")
		return
	}
	rows, err := h.Queries.ListProjectRolePlaybooks(r.Context(), project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project role playbooks")
		return
	}
	writeJSON(w, http.StatusOK, playbookResponse(service.PlaybookMapFromProjectRows(rows)))
}

// ListIssueRolePlaybooks returns the requirement playbook snapshot
// (GET /api/issues/{id}/role-playbooks).
func (h *Handler) ListIssueRolePlaybooks(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.Queries.ListIssueRolePlaybooks(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list issue role playbooks")
		return
	}
	writeJSON(w, http.StatusOK, playbookResponse(service.PlaybookMapFromIssueRows(rows)))
}

// ReplaceIssueRolePlaybooks atomically replaces the requirement playbook snapshot
// (PUT /api/issues/{id}/role-playbooks).
func (h *Handler) ReplaceIssueRolePlaybooks(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var req rolePlaybookPutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	overrides, code, msg := parsePlaybookOverrides(req.Overrides)
	if code != 0 {
		writeError(w, code, msg)
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if err := qtx.DeleteIssueRolePlaybooks(r.Context(), issue.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to replace issue role playbooks")
		return
	}
	entries := marshalPlaybookEntries(overrides)
	if string(entries) != "[]" {
		if err := qtx.InsertIssueRolePlaybooks(r.Context(), db.InsertIssueRolePlaybooksParams{
			IssueID:     issue.ID,
			WorkspaceID: issue.WorkspaceID,
			Entries:     entries,
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to replace issue role playbooks")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit role playbooks")
		return
	}
	rows, err := h.Queries.ListIssueRolePlaybooks(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list issue role playbooks")
		return
	}
	writeJSON(w, http.StatusOK, playbookResponse(service.PlaybookMapFromIssueRows(rows)))
}
