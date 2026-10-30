package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
)

// 功能模块工作区 · 右栏「功能点详解」的读写面（原型图 TAB v2 · 画面 3/5/6 · migration 499）。
//
// 三段式右栏只有三个数据源：
//   ① 模块说明   → module_brief_version.fields（逐字段带 {v, by, at, actor}）
//   ② 功能点清单 → project_module.spec.features + 同一份 fields 里的四段详情
//   ③ 版本记录   → module_brief_version（append-only）+ module_release（说明 ⨯ 原型）
//
// 写路径三道闸门（画面 5）：
//   只读 key → 422 read_only_field；base_version 陈旧 → 409 base_stale 并回传 current_version；
//   引用不存在的功能点 → 422 feature_not_found。同值重复提交幂等（返回 noop，不新增版本）。
// 全部走原生 h.DB / tx SQL（新表不入 sqlc 快照）。

// sqlQuerier 让同一批读取函数既能跑在连接池上，也能跑在事务里。
type sqlQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// moduleFieldValue 是 fields jsonb 里单个 key 的存储形状：值 + 版本 + 谁在哪一刻写的。
type moduleFieldValue struct {
	Value any    `json:"value"`
	V     int32  `json:"v"`
	By    string `json:"by"`
	At    string `json:"at"`
	Actor string `json:"actor,omitempty"`
}

type moduleFieldDef struct {
	Key        string   `json:"key"`
	Scope      string   `json:"scope"`
	Label      string   `json:"label"`
	Ord        int32    `json:"ord"`
	Kind       string   `json:"kind"`
	Owner      string   `json:"owner"`
	WritableBy []string `json:"writable_by"`
	Versioned  bool     `json:"versioned"`
}

type moduleBriefRow struct {
	version       int32
	baseVersion   pgtype.Int4
	fields        map[string]moduleFieldValue
	status        string
	source        string
	diffSummary   string
	changes       []byte
	createdByType string
	createdAt     pgtype.Timestamptz
}

type moduleWorkspaceRow struct {
	id             pgtype.UUID
	name           string
	color          string
	spec           []byte
	specVersion    int32
	canonical      pgtype.Int4
	briefVersion   pgtype.Int4
	releaseVersion pgtype.Int4
}

// moduleFieldDiff 是一条字段级差异，前端「版本记录」的 +/− 直接渲染它。
type moduleFieldDiff struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Scope string `json:"scope"`
	Op    string `json:"op"`
	From  any    `json:"from"`
	To    any    `json:"to"`
}

func (h *Handler) loadModuleWorkspace(ctx context.Context, projectID, moduleID pgtype.UUID) (moduleWorkspaceRow, error) {
	var row moduleWorkspaceRow
	err := h.DB.QueryRow(ctx, `
		SELECT id, name, COALESCE(color, ''), spec, spec_version,
		       canonical_prototype_version, brief_version, release_version
		  FROM project_module
		 WHERE id = $1 AND project_id = $2`, moduleID, projectID,
	).Scan(&row.id, &row.name, &row.color, &row.spec, &row.specVersion,
		&row.canonical, &row.briefVersion, &row.releaseVersion)
	return row, err
}

func loadModuleFieldDefs(ctx context.Context, q sqlQuerier) ([]moduleFieldDef, error) {
	rows, err := q.Query(ctx, `
		SELECT key, scope, label, ord, kind, owner, writable_by, versioned
		  FROM module_field_def
		 ORDER BY scope, ord, key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	defs := make([]moduleFieldDef, 0, 32)
	for rows.Next() {
		var d moduleFieldDef
		if err := rows.Scan(&d.Key, &d.Scope, &d.Label, &d.Ord, &d.Kind, &d.Owner, &d.WritableBy, &d.Versioned); err != nil {
			return nil, err
		}
		defs = append(defs, d)
	}
	return defs, rows.Err()
}

// resolveFieldDef 先按精确 key 查，再按功能点模板 key（fp.*.<suffix>）查，
// 这样「＋添加字段」新建的字段与内置字段走完全相同的只读/类型规则。
func resolveFieldDef(defs map[string]moduleFieldDef, key string) (moduleFieldDef, bool) {
	if d, ok := defs[key]; ok {
		return d, true
	}
	rest, ok := strings.CutPrefix(key, "fp.")
	if !ok {
		return moduleFieldDef{}, false
	}
	dot := strings.Index(rest, ".")
	if dot <= 0 {
		return moduleFieldDef{}, false
	}
	d, ok := defs["fp.*."+rest[dot+1:]]
	return d, ok
}

// featureCodeFromKey 从 fp.<code>.<suffix> 取出 code；fp.code 这类系统 key 返回空。
func featureCodeFromKey(key string) string {
	rest, ok := strings.CutPrefix(key, "fp.")
	if !ok {
		return ""
	}
	dot := strings.Index(rest, ".")
	if dot <= 0 {
		return ""
	}
	if rest == "code" || rest == "since" || rest == "removed" {
		return ""
	}
	return rest[:dot]
}

func parseBriefFields(raw []byte) (map[string]moduleFieldValue, error) {
	fields := map[string]moduleFieldValue{}
	if len(bytes.TrimSpace(raw)) == 0 {
		return fields, nil
	}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	return fields, nil
}

func loadLatestBrief(ctx context.Context, q sqlQuerier, moduleID pgtype.UUID, forUpdate bool) (moduleBriefRow, error) {
	var row moduleBriefRow
	var raw []byte
	stmt := `
		SELECT version, base_version, fields, status, source,
		       COALESCE(diff_summary, ''), changes, COALESCE(created_by_type, ''), created_at
		  FROM module_brief_version
		 WHERE module_id = $1
		 ORDER BY version DESC
		 LIMIT 1`
	if forUpdate {
		stmt += ` FOR UPDATE`
	}
	if err := q.QueryRow(ctx, stmt, moduleID).Scan(&row.version, &row.baseVersion, &raw,
		&row.status, &row.source, &row.diffSummary, &row.changes, &row.createdByType, &row.createdAt); err != nil {
		return row, err
	}
	fields, err := parseBriefFields(raw)
	if err != nil {
		return row, err
	}
	row.fields = fields
	return row, nil
}

func briefToResponse(row moduleBriefRow) map[string]any {
	fields := row.fields
	if fields == nil {
		fields = map[string]moduleFieldValue{}
	}
	changes := json.RawMessage(row.changes)
	if len(row.changes) == 0 {
		changes = json.RawMessage("[]")
	}
	return map[string]any{
		"version":         row.version,
		"base_version":    int4ToPtr(row.baseVersion),
		"fields":          fields,
		"status":          row.status,
		"source":          row.source,
		"diff_summary":    row.diffSummary,
		"changes":         changes,
		"created_by_type": row.createdByType,
		"created_at":      timestampToString(row.createdAt),
	}
}

func loadBriefVersions(ctx context.Context, q sqlQuerier, moduleID pgtype.UUID) ([]map[string]any, error) {
	rows, err := q.Query(ctx, `
		SELECT version, base_version, status, source, COALESCE(diff_summary, ''),
		       changes, COALESCE(created_by_type, ''), created_at
		  FROM module_brief_version
		 WHERE module_id = $1
		 ORDER BY version DESC
		 LIMIT 50`, moduleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]map[string]any, 0, 16)
	for rows.Next() {
		var (
			version       int32
			base          pgtype.Int4
			status        string
			source        string
			summary       string
			changes       []byte
			createdByType string
			createdAt     pgtype.Timestamptz
		)
		if err := rows.Scan(&version, &base, &status, &source, &summary, &changes, &createdByType, &createdAt); err != nil {
			return nil, err
		}
		payload := json.RawMessage(changes)
		if len(changes) == 0 {
			payload = json.RawMessage("[]")
		}
		out = append(out, map[string]any{
			"version":         version,
			"base_version":    int4ToPtr(base),
			"status":          status,
			"source":          source,
			"diff_summary":    summary,
			"changes":         payload,
			"created_by_type": createdByType,
			"created_at":      timestampToString(createdAt),
		})
	}
	return out, rows.Err()
}

func loadModuleReleases(ctx context.Context, q sqlQuerier, moduleID pgtype.UUID) ([]map[string]any, error) {
	rows, err := q.Query(ctx, `
		SELECT version, brief_version, prototype_version, diff, released_by, created_at
		  FROM module_release
		 WHERE module_id = $1
		 ORDER BY version DESC
		 LIMIT 50`, moduleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]map[string]any, 0, 8)
	for rows.Next() {
		var (
			version    int32
			brief      int32
			proto      int32
			diff       []byte
			releasedBy pgtype.UUID
			createdAt  pgtype.Timestamptz
		)
		if err := rows.Scan(&version, &brief, &proto, &diff, &releasedBy, &createdAt); err != nil {
			return nil, err
		}
		payload := json.RawMessage(diff)
		if len(diff) == 0 {
			payload = json.RawMessage("{}")
		}
		by := ""
		if releasedBy.Valid {
			by = uuidToString(releasedBy)
		}
		out = append(out, map[string]any{
			"version":           version,
			"brief_version":     brief,
			"prototype_version": proto,
			"diff":              payload,
			"released_by":       by,
			"created_at":        timestampToString(createdAt),
		})
	}
	return out, rows.Err()
}

// workspaceFeature 是功能点清单的一行：规格投影 + 四段详情填充度。
type workspaceFeature struct {
	Code         string         `json:"code"`
	Title        string         `json:"title"`
	Kind         string         `json:"kind"`
	Priority     string         `json:"priority,omitempty"`
	Group        string         `json:"group,omitempty"`
	SpecVersion  int32          `json:"spec_version"`
	Detail       map[string]any `json:"detail"`
	Filled       int            `json:"filled"`
	Total        int            `json:"total"`
	AcceptanceOK int            `json:"acceptance_ok"`
	AcceptanceN  int            `json:"acceptance_total"`
}

// 四段详情：1 描述/定位、2 细节要求、3 交互/依赖、4 验收标准。
var featureDetailSegments = [][]string{
	{"desc", "loc"},
	{"req"},
	{"interaction", "deps"},
	{"acceptance"},
}

func buildWorkspaceFeatures(spec service.ModuleSpec, specVersion int32, fields map[string]moduleFieldValue) []workspaceFeature {
	out := make([]workspaceFeature, 0, len(spec.Features))
	for _, f := range spec.Features {
		detail := map[string]any{}
		filled := 0
		for _, segment := range featureDetailSegments {
			hasValue := false
			for _, suffix := range segment {
				entry, ok := fields["fp."+f.Code+"."+suffix]
				if !ok || isEmptyFieldValue(entry.Value) {
					continue
				}
				detail[suffix] = entry.Value
				hasValue = true
			}
			if hasValue {
				filled++
			}
		}
		okCount, totalCount := acceptanceCounts(detail["acceptance"])
		out = append(out, workspaceFeature{
			Code:         f.Code,
			Title:        f.Title,
			Kind:         f.Kind,
			Priority:     f.Priority,
			Group:        f.Group,
			SpecVersion:  specVersion,
			Detail:       detail,
			Filled:       filled,
			Total:        len(featureDetailSegments),
			AcceptanceOK: okCount,
			AcceptanceN:  totalCount,
		})
	}
	return out
}

func isEmptyFieldValue(v any) bool {
	switch typed := v.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	}
	return false
}

// acceptanceCounts 统计验收标准的 ✓/○：条目可以是 {text, ok} 对象，也可以是裸字符串。
func acceptanceCounts(v any) (okCount, total int) {
	list, isList := v.([]any)
	if !isList {
		return 0, 0
	}
	for _, item := range list {
		total++
		if obj, isObj := item.(map[string]any); isObj {
			if passed, isBool := obj["ok"].(bool); isBool && passed {
				okCount++
			}
			continue
		}
		switch typed := item.(type) {
		case string:
			if strings.HasPrefix(typed, "✓") {
				okCount++
			}
		}
	}
	return okCount, total
}

// GetModuleWorkspace 一次给齐右栏三段所需的全部数据（画面 3）。
func (h *Handler) GetModuleWorkspace(w http.ResponseWriter, r *http.Request) {
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
	defs, err := loadModuleFieldDefs(ctx, h.DB)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load module field definitions")
		return
	}
	brief, err := loadLatestBrief(ctx, h.DB, moduleID, false)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "failed to load module brief")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		brief = moduleBriefRow{fields: map[string]moduleFieldValue{}}
	}
	spec, _, _ := normalizeModuleSpec(mod.spec)
	versions, err := loadBriefVersions(ctx, h.DB, moduleID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load brief versions")
		return
	}
	releases, err := loadModuleReleases(ctx, h.DB, moduleID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load module releases")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"module_id":                   uuidToString(mod.id),
		"name":                        mod.name,
		"color":                       mod.color,
		"spec_version":                mod.specVersion,
		"canonical_prototype_version": int4ToPtr(mod.canonical),
		"brief_version":               int4ToPtr(mod.briefVersion),
		"release_version":             int4ToPtr(mod.releaseVersion),
		"brief":                       briefToResponse(brief),
		"field_defs":                  defs,
		"features":                    buildWorkspaceFeatures(spec, mod.specVersion, brief.fields),
		"versions":                    versions,
		"releases":                    releases,
		"feature_count":               len(spec.Features),
	})
}

// ModuleWorkspacePatchRequest 是 POST /workspace/patch 的请求体。
type ModuleWorkspacePatchRequest struct {
	BaseVersion int32          `json:"base_version"`
	Source      string         `json:"source,omitempty"`
	Note        string         `json:"note,omitempty"`
	Fields      map[string]any `json:"fields"`
}

type pendingFieldWrite struct {
	key   string
	def   moduleFieldDef
	value any
	add   bool
}

// PatchModuleWorkspace 追加一条说明版本。三道闸门全部在事务内判定，
// 同值重复提交直接返回 noop（不产生空版本，画面 5「并发同值幂等」）。
func (h *Handler) PatchModuleWorkspace(w http.ResponseWriter, r *http.Request) {
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
	var req ModuleWorkspacePatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Fields) == 0 {
		writeModuleError(w, http.StatusUnprocessableEntity, "empty_patch", "fields must not be empty")
		return
	}
	source := strings.TrimSpace(req.Source)
	switch source {
	case "":
		source = "manual"
	case "manual", "agent", "mcp", "extract", "rollback":
	default:
		writeModuleError(w, http.StatusUnprocessableEntity, "invalid_source", "source must be manual, agent, mcp, extract or rollback")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, uuidToString(project.WorkspaceID))
	byLabel := "human"
	if actorType == "agent" {
		byLabel = "agent"
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to open module workspace transaction")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	mod, err := h.loadModuleWorkspace(ctx, project.ID, moduleID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project module not found")
		return
	}
	current, err := loadLatestBrief(ctx, tx, moduleID, true)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "failed to load module brief")
			return
		}
		current = moduleBriefRow{fields: map[string]moduleFieldValue{}}
	}
	if req.BaseVersion != current.version {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":           "base_version is stale; reload the workspace and retry",
			"code":            "base_stale",
			"current_version": current.version,
		})
		return
	}

	defList, err := loadModuleFieldDefs(ctx, tx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load module field definitions")
		return
	}
	defs := make(map[string]moduleFieldDef, len(defList))
	for _, d := range defList {
		defs[d.Key] = d
	}
	spec, _, _ := normalizeModuleSpec(mod.spec)
	knownCodes := make(map[string]bool, len(spec.Features))
	for _, f := range spec.Features {
		knownCodes[f.Code] = true
	}

	newVersion := current.version + 1
	now := time.Now().UTC().Format(time.RFC3339)
	writes := make([]pendingFieldWrite, 0, len(req.Fields))
	diff := make([]moduleFieldDiff, 0, len(req.Fields))

	for key, rawValue := range req.Fields {
		key = strings.TrimSpace(key)
		if key == "" {
			writeModuleError(w, http.StatusUnprocessableEntity, "invalid_field_key", "field key must not be empty")
			return
		}
		def, found := resolveFieldDef(defs, key)
		if found && def.Owner == "system" {
			writeModuleError(w, http.StatusUnprocessableEntity, "read_only_field",
				"field "+key+" is produced by the system and cannot be written")
			return
		}
		if !found {
			// module.* 是系统命名空间（版本号/覆盖率/权威原型版本），不允许自定义。
			if strings.HasPrefix(key, "module.") {
				writeModuleError(w, http.StatusUnprocessableEntity, "read_only_field",
					"field "+key+" is reserved for the system")
				return
			}
			scope := "module"
			kind := "text"
			if strings.HasPrefix(key, "fp.") {
				scope = "feature_point"
				kind = "longtext"
				if strings.HasSuffix(key, ".acceptance") {
					kind = "acceptance"
				} else if strings.HasSuffix(key, ".req") || strings.HasSuffix(key, ".deps") {
					kind = "list"
				}
			}
			def = moduleFieldDef{Key: key, Scope: scope, Label: key, Kind: kind, Owner: "user", Versioned: true}
			writes = append(writes, pendingFieldWrite{key: key, def: def, add: true})
		}
		if def.Scope == "feature_point" {
			if code := featureCodeFromKey(key); code != "" && !knownCodes[code] {
				writeModuleError(w, http.StatusUnprocessableEntity, "feature_not_found",
					"feature point "+code+" does not exist in the current spec")
				return
			}
		}
		if prev, exists := current.fields[key]; exists && jsonValueEqual(prev.Value, rawValue) {
			continue
		} else {
			var from any
			if exists {
				from = prev.Value
			}
			diff = append(diff, moduleFieldDiff{
				Key:   key,
				Label: def.Label,
				Scope: def.Scope,
				Op:    diffOp(rawValue),
				From:  from,
				To:    rawValue,
			})
			writes = append(writes, pendingFieldWrite{key: key, def: def, value: rawValue, add: !found})
		}
	}

	if len(writes) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"module_id": uuidToString(moduleID),
			"version":   current.version,
			"prev":      current.version,
			"noop":      true,
			"diff":      []moduleFieldDiff{},
			"brief":     briefToResponse(current),
		})
		return
	}

	merged := make(map[string]moduleFieldValue, len(current.fields)+len(writes))
	for k, v := range current.fields {
		merged[k] = v
	}
	for _, write := range writes {
		if write.add && write.value == nil {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO module_field_def (key, scope, label, ord, kind, owner)
			VALUES ($1, $2, $3, $4, $5, 'user')
			ON CONFLICT (key) DO NOTHING`,
			write.key, write.def.Scope, write.def.Label, 500, write.def.Kind); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to register module field")
			return
		}
		merged[write.key] = moduleFieldValue{Value: write.value, V: newVersion, By: byLabel, At: now, Actor: actorID}
	}

	fieldsJSON, err := json.Marshal(merged)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode module fields")
		return
	}
	changesJSON, err := json.Marshal(diff)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode module field diff")
		return
	}
	summary := strings.TrimSpace(req.Note)
	if summary == "" {
		summary = briefDiffSummary(diff)
	}
	createdBy := parseUUID(userID)
	if actorType == "agent" {
		createdBy = parseUUID(actorID)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO module_brief_version
		    (module_id, version, base_version, fields, status, source, diff_summary, changes, created_by, created_by_type)
		VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9)`,
		moduleID, newVersion, current.version, fieldsJSON, source, summary, changesJSON,
		createdBy, actorType); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to append module brief version")
		return
	}
	if _, err := tx.Exec(ctx, `
		UPDATE project_module SET brief_version = $1 WHERE id = $2`, newVersion, moduleID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to advance module brief pointer")
		return
	}
	eventPayload, _ := json.Marshal(map[string]any{
		"version": newVersion,
		"prev":    current.version,
		"changed": len(diff),
		"source":  source,
	})
	if _, err := tx.Exec(ctx, `
		INSERT INTO module_change_event (workspace_id, module_id, event_type, payload, actor_type, actor_id)
		VALUES ($1, $2, 'brief_patched', $3, $4, $5)`,
		project.WorkspaceID, moduleID, eventPayload, actorType, createdBy); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record change event")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit module brief version")
		return
	}

	h.publish("project_module:brief_updated", uuidToString(project.WorkspaceID), actorType, actorID,
		map[string]any{"module_id": uuidToString(moduleID), "project_id": uuidToString(project.ID),
			"version": newVersion, "prev": current.version})

	brief, _ := loadLatestBrief(ctx, h.DB, moduleID, false)
	writeJSON(w, http.StatusOK, map[string]any{
		"module_id": uuidToString(moduleID),
		"version":   newVersion,
		"prev":      current.version,
		"noop":      false,
		"diff":      diff,
		"brief":     briefToResponse(brief),
	})
}

// briefDiffSummary 是「版本记录」那一行说清改了哪些字段的文案：优先用字段标签，
// 功能点字段补上编号（否则四个功能点的“1 · 功能描述”看起来一模一样）。
func briefDiffSummary(diff []moduleFieldDiff) string {
	if len(diff) == 0 {
		return "无字段变化"
	}
	parts := make([]string, 0, 3)
	for _, d := range diff {
		if len(parts) == 3 {
			break
		}
		label := d.Label
		if label == "" || label == d.Key {
			label = d.Key
		}
		if d.Scope == "feature_point" {
			if code := featureCodeFromKey(d.Key); code != "" {
				label = code + " " + label
			}
		}
		parts = append(parts, label)
	}
	summary := strings.Join(parts, "、")
	if len(diff) > len(parts) {
		summary += " 等 " + strconv.Itoa(len(diff)) + " 个字段"
	}
	return summary
}

func diffOp(value any) string {
	if value == nil {
		return "clear"
	}
	if s, isString := value.(string); isString && strings.TrimSpace(s) == "" {
		return "clear"
	}
	return "set"
}

func jsonValueEqual(a, b any) bool {
	ab, errA := json.Marshal(a)
	bb, errB := json.Marshal(b)
	if errA != nil || errB != nil {
		return false
	}
	return bytes.Equal(ab, bb)
}
