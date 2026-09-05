package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 档案同步配置 + 分阶段诊断 + 批量绑定候选（migration 461）。
// spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §4.9；
// 原型: docs/superpowers/specs/2026-09-05-project-archive-prototype.html #f2 / #f3。
//
// 三张表/两列均晚于 sqlc 快照，本文件全部使用 h.DB 原生 SQL（同
// issue_archive.go:loadDeliverablesStageGates 的既定模式），不触碰
// pkg/db/queries 与 generated，以免触发 sqlc 门禁并避开并行会话的在途重生。

// ──────────────────────────────────────────────────────────────────────────
// sync config（§4.9.7）
// ──────────────────────────────────────────────────────────────────────────

// ArchiveSyncConfigResponse 是 project_archive_sync_config 行的 JSON 形态；
// 无配置行时 GET 返回默认值（与 migration 461 的 DEFAULT 逐字对齐）。
type ArchiveSyncConfigResponse struct {
	ProjectID          string          `json:"project_id"`
	WorkspaceID        string          `json:"workspace_id"`
	SyncMode           string          `json:"sync_mode"`
	ConflictPolicy     string          `json:"conflict_policy"`
	ScopeFilter        json.RawMessage `json:"scope_filter"`
	BatchBindThreshold float64         `json:"batch_bind_threshold"`
	CronExpr           *string         `json:"cron_expr"`
	CreatedAt          string          `json:"created_at,omitempty"`
	UpdatedAt          string          `json:"updated_at,omitempty"`
}

var validSyncModes = map[string]bool{"hook": true, "scheduled": true, "manual": true}
var validConflictPolicies = map[string]bool{"path_first": true, "review_queue": true}

// GetArchiveSyncConfig 处理 GET /api/projects/{id}/archive/sync-config。
// 未配置过的项目返回 migration 461 的默认行（不落库），让控制台首渲染即有表单初值。
func (h *Handler) GetArchiveSyncConfig(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}

	cfg, found, err := h.loadArchiveSyncConfig(r.Context(), project)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load sync config")
		return
	}
	if !found {
		cfg = ArchiveSyncConfigResponse{
			ProjectID:          uuidToString(project.ID),
			WorkspaceID:        uuidToString(project.WorkspaceID),
			SyncMode:           "manual",
			ConflictPolicy:     "path_first",
			ScopeFilter:        json.RawMessage(`{}`),
			BatchBindThreshold: 0.85,
		}
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (h *Handler) loadArchiveSyncConfig(ctx context.Context, project db.Project) (ArchiveSyncConfigResponse, bool, error) {
	var cfg ArchiveSyncConfigResponse
	var threshold pgtype.Numeric
	var cronExpr pgtype.Text
	var createdAt, updatedAt pgtype.Timestamptz
	err := h.DB.QueryRow(ctx, `
SELECT project_id, workspace_id, sync_mode, conflict_policy, scope_filter,
       batch_bind_threshold, cron_expr, created_at, updated_at
FROM project_archive_sync_config
WHERE project_id = $1`, project.ID).Scan(
		&cfg.ProjectID, &cfg.WorkspaceID, &cfg.SyncMode, &cfg.ConflictPolicy,
		&cfg.ScopeFilter, &threshold, &cronExpr, &createdAt, &updatedAt,
	)
	if err != nil {
		if err.Error() == "no rows in result set" {
			return ArchiveSyncConfigResponse{}, false, nil
		}
		return ArchiveSyncConfigResponse{}, false, err
	}
	cfg.BatchBindThreshold = numericToFloat(threshold)
	cfg.CronExpr = textToPtr(cronExpr)
	cfg.CreatedAt = timestampToString(createdAt)
	cfg.UpdatedAt = timestampToString(updatedAt)
	return cfg, true, nil
}

// PutArchiveSyncConfig 处理 PUT /api/projects/{id}/archive/sync-config（upsert）。
func (h *Handler) PutArchiveSyncConfig(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}

	var req struct {
		SyncMode           string          `json:"sync_mode"`
		ConflictPolicy     string          `json:"conflict_policy"`
		ScopeFilter        json.RawMessage `json:"scope_filter"`
		BatchBindThreshold *float64        `json:"batch_bind_threshold"`
		CronExpr           *string         `json:"cron_expr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !validSyncModes[req.SyncMode] {
		writeError(w, http.StatusBadRequest, "sync_mode must be one of hook|scheduled|manual")
		return
	}
	if !validConflictPolicies[req.ConflictPolicy] {
		writeError(w, http.StatusBadRequest, "conflict_policy must be one of path_first|review_queue")
		return
	}
	threshold := 0.85
	if req.BatchBindThreshold != nil {
		threshold = *req.BatchBindThreshold
	}
	if threshold < 0 || threshold > 1 {
		writeError(w, http.StatusBadRequest, "batch_bind_threshold must be within 0..1")
		return
	}
	scopeFilter := req.ScopeFilter
	if len(scopeFilter) == 0 {
		scopeFilter = json.RawMessage(`{}`)
	}
	if !json.Valid(scopeFilter) {
		writeError(w, http.StatusBadRequest, "scope_filter must be valid JSON")
		return
	}

	var cfg ArchiveSyncConfigResponse
	var thresholdNum pgtype.Numeric
	var cronExpr pgtype.Text
	var createdAt, updatedAt pgtype.Timestamptz
	err := h.DB.QueryRow(r.Context(), `
INSERT INTO project_archive_sync_config
    (project_id, workspace_id, sync_mode, conflict_policy, scope_filter, batch_bind_threshold, cron_expr)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (project_id) DO UPDATE SET
    sync_mode = EXCLUDED.sync_mode,
    conflict_policy = EXCLUDED.conflict_policy,
    scope_filter = EXCLUDED.scope_filter,
    batch_bind_threshold = EXCLUDED.batch_bind_threshold,
    cron_expr = EXCLUDED.cron_expr,
    updated_at = now()
RETURNING project_id, workspace_id, sync_mode, conflict_policy, scope_filter,
          batch_bind_threshold, cron_expr, created_at, updated_at`,
		project.ID, project.WorkspaceID, req.SyncMode, req.ConflictPolicy,
		scopeFilter, threshold, req.CronExpr,
	).Scan(&cfg.ProjectID, &cfg.WorkspaceID, &cfg.SyncMode, &cfg.ConflictPolicy,
		&cfg.ScopeFilter, &thresholdNum, &cronExpr, &createdAt, &updatedAt)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save sync config")
		return
	}
	cfg.BatchBindThreshold = numericToFloat(thresholdNum)
	cfg.CronExpr = textToPtr(cronExpr)
	cfg.CreatedAt = timestampToString(createdAt)
	cfg.UpdatedAt = timestampToString(updatedAt)
	writeJSON(w, http.StatusOK, cfg)
}

// ──────────────────────────────────────────────────────────────────────────
// sync diagnostics（§4.9.6）—— 写入方只能是 CLI，server 无法分阶段感知
// ──────────────────────────────────────────────────────────────────────────

var validDiagStages = map[string]bool{"scan": true, "parse": true, "upload": true, "index": true, "recount": true}
var validDiagLevels = map[string]bool{"error": true, "warning": true, "info": true}

// SyncDiagnosticEntry 是单条诊断（CLI 上报与控制台查询共用同一 JSON 形态）。
type SyncDiagnosticEntry struct {
	ID        string          `json:"id,omitempty"`
	SyncRunID string          `json:"sync_run_id"`
	Stage     string          `json:"stage"`
	RelPath   *string         `json:"rel_path"`
	Level     string          `json:"level"`
	Message   string          `json:"message"`
	Detail    json.RawMessage `json:"detail"`
	CreatedAt string          `json:"created_at,omitempty"`
}

// PostArchiveSyncDiagnostics 处理 POST /api/projects/{id}/archive/sync-diagnostics。
// CLI 每次 sync 生成 sync_run_id，按阶段批量上报；失败项不阻塞其余入库（§4.9.6）。
func (h *Handler) PostArchiveSyncDiagnostics(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}

	var req struct {
		SyncRunID string                `json:"sync_run_id"`
		Entries   []SyncDiagnosticEntry `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.SyncRunID = strings.TrimSpace(req.SyncRunID)
	if req.SyncRunID == "" {
		writeError(w, http.StatusBadRequest, "sync_run_id is required")
		return
	}
	if len(req.Entries) == 0 {
		writeError(w, http.StatusBadRequest, "entries is required")
		return
	}
	for i, e := range req.Entries {
		if !validDiagStages[e.Stage] {
			writeError(w, http.StatusBadRequest, "entries["+strconv.Itoa(i)+"].stage must be one of scan|parse|upload|index|recount")
			return
		}
		if !validDiagLevels[e.Level] {
			writeError(w, http.StatusBadRequest, "entries["+strconv.Itoa(i)+"].level must be one of error|warning|info")
			return
		}
		if strings.TrimSpace(e.Message) == "" {
			writeError(w, http.StatusBadRequest, "entries["+strconv.Itoa(i)+"].message is required")
			return
		}
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx)

	inserted := 0
	for _, e := range req.Entries {
		detail := e.Detail
		if len(detail) == 0 {
			detail = json.RawMessage(`{}`)
		}
		// 条目级 sync_run_id 允许缺省（继承请求头级）；显式给出时必须一致，
		// 否则一次上报混入两次运行的诊断，控制台按 run 分组会错位。
		runID := req.SyncRunID
		if e.SyncRunID != "" && e.SyncRunID != req.SyncRunID {
			writeError(w, http.StatusBadRequest, "entries[].sync_run_id must match the request-level sync_run_id")
			return
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO sync_diagnostics
    (workspace_id, project_id, sync_run_id, stage, rel_path, level, message, detail)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			project.WorkspaceID, project.ID, runID, e.Stage, e.RelPath, e.Level, e.Message, detail,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to insert diagnostic")
			return
		}
		inserted++
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit diagnostics")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"inserted": inserted, "sync_run_id": req.SyncRunID})
}

// ListArchiveSyncDiagnostics 处理 GET /api/projects/{id}/archive/sync-diagnostics
// ?sync_run_id=&stage=&level=&limit= —— 同步控制台（画面 3）的分阶段流水数据源。
func (h *Handler) ListArchiveSyncDiagnostics(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}

	q := r.URL.Query()
	limit := 200
	if raw := q.Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}

	// 过滤条件全部可选；sync_run_id 精确匹配，stage/level 走枚举白名单（非法值直接空集）。
	var conds []string
	var args []any
	args = append(args, project.ID)
	conds = append(conds, "project_id = $1")
	if runID := strings.TrimSpace(q.Get("sync_run_id")); runID != "" {
		args = append(args, runID)
		conds = append(conds, "sync_run_id = $"+strconv.Itoa(len(args)))
	}
	if stage := q.Get("stage"); stage != "" {
		if !validDiagStages[stage] {
			writeJSON(w, http.StatusOK, map[string]any{"diagnostics": []SyncDiagnosticEntry{}})
			return
		}
		args = append(args, stage)
		conds = append(conds, "stage = $"+strconv.Itoa(len(args)))
	}
	if level := q.Get("level"); level != "" {
		if !validDiagLevels[level] {
			writeJSON(w, http.StatusOK, map[string]any{"diagnostics": []SyncDiagnosticEntry{}})
			return
		}
		args = append(args, level)
		conds = append(conds, "level = $"+strconv.Itoa(len(args)))
	}
	args = append(args, limit)

	rows, err := h.DB.Query(r.Context(), `
SELECT id, sync_run_id, stage, rel_path, level, message, detail, created_at
FROM sync_diagnostics
WHERE `+strings.Join(conds, " AND ")+`
ORDER BY created_at DESC
LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list diagnostics")
		return
	}
	defer rows.Close()

	entries := []SyncDiagnosticEntry{}
	for rows.Next() {
		var e SyncDiagnosticEntry
		var id pgtype.UUID
		var relPath pgtype.Text
		var createdAt pgtype.Timestamptz
		if err := rows.Scan(&id, &e.SyncRunID, &e.Stage, &relPath, &e.Level, &e.Message, &e.Detail, &createdAt); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan diagnostic")
			return
		}
		e.ID = uuidToString(id)
		e.RelPath = textToPtr(relPath)
		e.CreatedAt = timestampToString(createdAt)
		entries = append(entries, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"diagnostics": entries})
}

// ──────────────────────────────────────────────────────────────────────────
// 批量绑定候选（§4.9.3 anno③）—— 标题相似度 + key 后缀 + 时间窗三因子
// ──────────────────────────────────────────────────────────────────────────

// BindCandidate 是一条「待绑定 artifact → 候选 issue」的评分结果。
type BindCandidate struct {
	ArtifactID      string  `json:"artifact_id"`
	RelPath         string  `json:"rel_path"`
	RequirementKey  string  `json:"requirement_key"`
	IssueID         string  `json:"issue_id"`
	IssueTitle      string  `json:"issue_title"`
	IssueNumber     int32   `json:"issue_number"`
	Confidence      float64 `json:"confidence"`
	AutoBindable    bool    `json:"auto_bindable"` // conf ≥ batch_bind_threshold
	SuggestNewIssue bool    `json:"suggest_new_issue"` // conf < 0.6（§4.9.3：建议新建需求）
}

// bindScoreInput 是 scoreBindCandidate 的纯输入（从 DB 行拆解，便于单测）。
type bindScoreInput struct {
	RequirementKey  string // artifact 侧，形如 REQ-20260811-02
	ArtifactHint    string // artifact 侧标题提示（rel_path 去扩展名的 basename 与需求目录名）
	ArtifactCreated time.Time
	IssueNumber     int32
	IssueTitle      string
	IssueCreated    time.Time
}

// scoreBindCandidate 计算三因子加权置信度：
//
//	key 后缀匹配（0.5）：requirement_key 尾号与 issue.number 相等 → 1，否则 0
//	标题相似度（0.35）：issue 标题 vs artifact 路径提示的规范化 token Jaccard 系数
//	时间窗（0.15）：artifact 与 issue 创建时间差 ≤ 7 天 → 1，≤ 30 天线性衰减，否则 0
//
// 权重与阈值来自原型 #f3 anno③（「标题相似度 + key 后缀 + 时间窗」，conf < 60% 建议新建）。
func scoreBindCandidate(in bindScoreInput) float64 {
	keyScore := 0.0
	if n, ok := requirementKeySuffixNumber(in.RequirementKey); ok && n == int(in.IssueNumber) {
		keyScore = 1
	}
	titleScore := jaccardTokens(in.IssueTitle, in.ArtifactHint)
	timeScore := 0.0
	if !in.ArtifactCreated.IsZero() && !in.IssueCreated.IsZero() {
		days := in.ArtifactCreated.Sub(in.IssueCreated).Hours() / 24
		if days < 0 {
			days = -days
		}
		switch {
		case days <= 7:
			timeScore = 1
		case days <= 30:
			timeScore = 1 - (days-7)/23
		}
	}
	return 0.5*keyScore + 0.35*titleScore + 0.15*timeScore
}

// requirementKeySuffixNumber 提取 REQ-YYYYMMDD-NN 的尾号 NN。
func requirementKeySuffixNumber(key string) (int, bool) {
	key = strings.TrimSpace(key)
	idx := strings.LastIndex(key, "-")
	if idx < 0 || idx == len(key)-1 {
		return 0, false
	}
	n, err := strconv.Atoi(key[idx+1:])
	if err != nil {
		return 0, false
	}
	return n, true
}

// artifactTitleHint 从 rel_path 提取标题提示：需求目录名（REQ-KEY 后的可读
// slug）+ 文件 basename（去扩展名）。需求目录形如 REQ-20260811-02 或带 slug 的
// REQ-20260811-02-配置投影；文件名常携带主题（如「配置投影与可视化编排.md」）。
func artifactTitleHint(relPath string) string {
	parts := strings.Split(relPath, "/")
	var hints []string
	for _, p := range parts {
		if strings.HasPrefix(p, "REQ-") {
			// 去掉 REQ-YYYYMMDD-NN 前缀，留下可读 slug（若有）。
			segs := strings.Split(p, "-")
			if len(segs) > 3 {
				hints = append(hints, strings.Join(segs[3:], "-"))
			}
			continue
		}
		hints = append(hints, p)
	}
	base := hints[len(hints)-1]
	if dot := strings.LastIndex(base, "."); dot > 0 {
		hints[len(hints)-1] = base[:dot]
	}
	return strings.Join(hints, " ")
}

// jaccardTokens 计算两个字符串规范化 token 集合的 Jaccard 系数。
func jaccardTokens(a, b string) float64 {
	ta := tokenize(a)
	tb := tokenize(b)
	if len(ta) == 0 || len(tb) == 0 {
		return 0
	}
	inter := 0
	for tok := range ta {
		if tb[tok] {
			inter++
		}
	}
	union := len(ta) + len(tb) - inter
	if union == 0 {
		return 0
	}
	return float64(inter) / float64(union)
}

func tokenize(s string) map[string]bool {
	out := make(map[string]bool)
	for _, tok := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9') && r < 0x80
	}) {
		if tok != "" {
			out[tok] = true
		}
	}
	// 中文按整串入词（无分词器时的保守近似），保证中文标题之间有匹配可能。
	var cjk strings.Builder
	for _, r := range s {
		if r >= 0x4e00 && r <= 0x9fff {
			cjk.WriteRune(r)
		} else if cjk.Len() > 0 {
			out[cjk.String()] = true
			cjk.Reset()
		}
	}
	if cjk.Len() > 0 {
		out[cjk.String()] = true
	}
	return out
}

// ListArtifactBindCandidates 处理 GET /api/projects/{id}/artifacts/bind-candidates。
// 对待绑定 artifact（requirement_key 非空、issue_id 为空、未软删）× 项目内 issue
// 计算置信度，写回 project_artifact.confidence，返回按 conf 降序的候选列表。
// 数据全部在 DB 内（§4.9.3：server 可自算，不必等 CLI）。
func (h *Handler) ListArtifactBindCandidates(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := requireUserID(w, r); !ok {
		return
	}

	threshold := 0.85
	if cfg, found, err := h.loadArchiveSyncConfig(r.Context(), project); err == nil && found {
		threshold = cfg.BatchBindThreshold
	}

	ctx := r.Context()
	artifactRows, err := h.DB.Query(ctx, `
SELECT id, requirement_key, rel_path, created_at
FROM project_artifact
WHERE project_id = $1
  AND issue_id IS NULL
  AND deleted_at IS NULL
  AND requirement_key IS NOT NULL`, project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list unbound artifacts")
		return
	}
	type artifactLite struct {
		id      pgtype.UUID
		key     string
		relPath string
		created time.Time
	}
	var artifacts []artifactLite
	for artifactRows.Next() {
		var a artifactLite
		var createdAt pgtype.Timestamptz
		if err := artifactRows.Scan(&a.id, &a.key, &a.relPath, &createdAt); err != nil {
			artifactRows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan artifact")
			return
		}
		a.created = createdAt.Time
		artifacts = append(artifacts, a)
	}
	artifactRows.Close()

	issueRows, err := h.DB.Query(ctx, `
SELECT id, title, number, created_at
FROM issue
WHERE project_id = $1`, project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list issues")
		return
	}
	type issueLite struct {
		id      pgtype.UUID
		title   string
		number  int32
		created time.Time
	}
	var issues []issueLite
	for issueRows.Next() {
		var it issueLite
		var createdAt pgtype.Timestamptz
		if err := issueRows.Scan(&it.id, &it.title, &it.number, &createdAt); err != nil {
			issueRows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan issue")
			return
		}
		it.created = createdAt.Time
		issues = append(issues, it)
	}
	issueRows.Close()

	// 每个 artifact 只保留最高分的 issue 候选（控制台「一键匹配」语义）；
	// 无候选（项目无 issue）时 artifact 不出现在结果里，由 unbound 列表承载。
	candidates := make([]BindCandidate, 0, len(artifacts))
	bestConf := make(map[string]float64, len(artifacts))
	for _, a := range artifacts {
		var best *BindCandidate
		for _, it := range issues {
			conf := scoreBindCandidate(bindScoreInput{
				RequirementKey:  a.key,
				ArtifactHint:    artifactTitleHint(a.relPath),
				ArtifactCreated: a.created,
				IssueNumber:     it.number,
				IssueTitle:      it.title,
				IssueCreated:    it.created,
			})
			if conf <= 0 {
				continue
			}
			if best == nil || conf > best.Confidence {
				best = &BindCandidate{
					ArtifactID:     uuidToString(a.id),
					RelPath:        a.relPath,
					RequirementKey: a.key,
					IssueID:        uuidToString(it.id),
					IssueTitle:     it.title,
					IssueNumber:    it.number,
					Confidence:     conf,
				}
			}
		}
		if best != nil {
			best.AutoBindable = best.Confidence >= threshold
			best.SuggestNewIssue = best.Confidence < 0.6
			candidates = append(candidates, *best)
			bestConf[uuidToString(a.id)] = best.Confidence
		}
	}

	// 置信度写回 project_artifact.confidence（§4.9.3：批量绑定算法评估痕迹）。
	// 写失败不阻塞读取——conf 列是缓存，候选列表才是本次请求的产物。
	for id, conf := range bestConf {
		if _, err := h.DB.Exec(ctx,
			`UPDATE project_artifact SET confidence = $2 WHERE id = $1`, id, conf); err != nil {
			break
		}
	}

	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Confidence > candidates[j].Confidence })
	writeJSON(w, http.StatusOK, map[string]any{
		"candidates": candidates,
		"threshold":  threshold,
	})
}

// numericToFloat 把 pgtype.Numeric 转为 float64（NUMERIC(5,4) 精度足够）。
func numericToFloat(n pgtype.Numeric) float64 {
	f, err := n.Float64Value()
	if err != nil || !f.Valid {
		return 0
	}
	return f.Float64
}
