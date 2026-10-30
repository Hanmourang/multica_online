package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// 资产管理（对标 CoCo /projects/:id/assets，migration 471）。
// spec: change_logs/multica/plans/20261024-coco对标-工作流迭代资产/03_资产管理模块.md
//
// 设计核心：不复制 project_resource(065)，而是「指向」它。project_asset_binding 是业务
// 目录条目（分类 / 推荐 / 工作项作用域 / 展示元数据），resource_id 复用 065 物理指针；
// 解绑只删 binding，永不删 resource（可被多 binding 引用）。
//
// 与 project_archive_sync_config.go 同源约定：471 晚于 sqlc 快照，本文件全部使用 h.DB
// 原生 SQL，不触碰 pkg/db/queries 与 generated（避开 sqlc 门禁 + 并行会话的在途重生）。
// 复用 h.Queries 里 065 既有的资源读写方法（GetProjectResourceInWorkspace /
// CreateProjectResource / ListProjectResources）与 graph/workspace 表做搜索候选源。

// 6 类资产分类（对齐 CoCo TCe，去阿里专有名落通用枚举）。
var validAssetCategories = map[string]bool{
	"code_repository": true,
	"application":     true,
	"package":         true,
	"knowledge_repo":  true,
	"knowledge_group": true,
	"other":           true,
}

// 阶段/角色/链型枚举（migration 473，原型 v2：阶段×输入产物×需求/Bug 关联）。
var (
	validAssetStages    = map[string]bool{"S0": true, "S1": true, "S2": true, "S3": true, "S4": true, "S5": true, "general": true}
	validAssetRoles     = map[string]bool{"input": true, "output": true}
	validAssetLinkTypes = map[string]bool{"depends_on": true, "produces": true, "resolves": true}
)

// AssetIssueLink 是 asset_issue_link 行的 JSON 形态（多对多：资产↔需求/Bug）。
type AssetIssueLink struct {
	IssueID  string `json:"issue_id"`
	LinkType string `json:"link_type"`
}

// AssetBindingResponse 是 project_asset_binding 行的 JSON 形态。
type AssetBindingResponse struct {
	ID              string          `json:"id"`
	WorkspaceID     string          `json:"workspace_id"`
	ProjectID       string          `json:"project_id"`
	IssueID         *string         `json:"issue_id"`
	AssetCategory   string          `json:"asset_category"`
	ResourceID      *string         `json:"resource_id"`
	ExternalRef     json.RawMessage `json:"external_ref"`
	AssetName       string          `json:"asset_name"`
	AssetSubtype    *string         `json:"asset_subtype"`
	Source          string          `json:"source"`
	Recommended     bool            `json:"recommended"`
	RecommendReason *string         `json:"recommend_reason"`
	// 473 扩展：阶段 / 输入产物角色 / 自由标签 / 需求・Bug 多对多关联。
	// Links 仅在带关联的读面（overview / meta 保存回显）填充；普通分页列表
	// 省略（omitempty），避免老前端形状变化。
	LifecycleStage *string          `json:"lifecycle_stage,omitempty"`
	AssetRole      *string          `json:"asset_role,omitempty"`
	Tags           []string         `json:"tags,omitempty"`
	Links          []AssetIssueLink `json:"links,omitempty"`
	CreatedByType  string           `json:"created_by_type"`
	CreatedByID    string           `json:"created_by_id"`
	CreatedAt      string           `json:"created_at"`
}

// AssetPage 是分页信封（对齐 CoCo 面 C {items,totalCount,page,pageSize,totalPages}，
// 在 handler 层归一，前端 zod .catch 降级）。
type AssetPage struct {
	Items      []AssetBindingResponse `json:"items"`
	Page       int                    `json:"page"`
	PageSize   int                    `json:"pageSize"`
	TotalCount int                    `json:"totalCount"`
	TotalPages int                    `json:"totalPages"`
}

// assetBindingRow 承载原生扫描的 pgtype 列，toResponse 负责转 JSON 形态。
type assetBindingRow struct {
	id              pgtype.UUID
	workspaceID     pgtype.UUID
	projectID       pgtype.UUID
	issueID         pgtype.UUID
	assetCategory   string
	resourceID      pgtype.UUID
	externalRef     []byte
	assetName       string
	assetSubtype    pgtype.Text
	source          string
	recommended     bool
	recommendReason pgtype.Text
	lifecycleStage  pgtype.Text
	assetRole       pgtype.Text
	tags            []string
	createdByType   string
	createdByID     pgtype.UUID
	createdAt       pgtype.Timestamptz
}

const assetBindingColumns = `id, workspace_id, project_id, issue_id, asset_category, resource_id,
       external_ref, asset_name, asset_subtype, source, recommended, recommend_reason,
       lifecycle_stage, asset_role, tags, created_by_type, created_by_id, created_at`

func (a assetBindingRow) toResponse() AssetBindingResponse {
	ref := json.RawMessage(a.externalRef)
	if len(ref) == 0 {
		ref = json.RawMessage(`{}`)
	}
	return AssetBindingResponse{
		ID:              uuidToString(a.id),
		WorkspaceID:     uuidToString(a.workspaceID),
		ProjectID:       uuidToString(a.projectID),
		IssueID:         uuidToPtr(a.issueID),
		AssetCategory:   a.assetCategory,
		ResourceID:      uuidToPtr(a.resourceID),
		ExternalRef:     ref,
		AssetName:       a.assetName,
		AssetSubtype:    textToPtr(a.assetSubtype),
		Source:          a.source,
		Recommended:     a.recommended,
		RecommendReason: textToPtr(a.recommendReason),
		LifecycleStage:  textToPtr(a.lifecycleStage),
		AssetRole:       textToPtr(a.assetRole),
		Tags:            a.tags,
		CreatedByType:   a.createdByType,
		CreatedByID:     uuidToString(a.createdByID),
		CreatedAt:       timestampToString(a.createdAt),
	}
}

func (h *Handler) scanAssetBindingRow(scan func(dest ...any) error) (assetBindingRow, error) {
	var a assetBindingRow
	err := scan(&a.id, &a.workspaceID, &a.projectID, &a.issueID, &a.assetCategory,
		&a.resourceID, &a.externalRef, &a.assetName, &a.assetSubtype, &a.source,
		&a.recommended, &a.recommendReason, &a.lifecycleStage, &a.assetRole, &a.tags,
		&a.createdByType, &a.createdByID, &a.createdAt)
	return a, err
}

// ──────────────────────────────────────────────────────────────────────────
// 项目级：分页清单
// ──────────────────────────────────────────────────────────────────────────

// ListProjectAssets 处理 GET /api/projects/{id}/assets/page
// ?toPage=&pageSize=&category=&name=&issueId=。
// issueId 非空时把作用域降到某工作项（复用同套查询，对齐 CoCo 工作项「绑定资产」Tab）。
func (h *Handler) ListProjectAssets(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	page, pageSize := parseAssetPaging(r)
	category, nameQ, issueID := parseAssetFilters(r)

	items, total, err := h.queryAssetBindings(r.Context(), project.WorkspaceID, project.ID, issueID, category, nameQ, page, pageSize)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list assets")
		return
	}
	totalPages := 0
	if pageSize > 0 {
		totalPages = (total + pageSize - 1) / pageSize
	}
	writeJSON(w, http.StatusOK, AssetPage{
		Items:      items,
		Page:       page,
		PageSize:   pageSize,
		TotalCount: total,
		TotalPages: totalPages,
	})
}

// ListIssueAssets 处理 GET /api/issues/{id}/assets —— 工作项作用域，同信封。
func (h *Handler) ListIssueAssets(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if !issue.ProjectID.Valid {
		writeJSON(w, http.StatusOK, AssetPage{Items: []AssetBindingResponse{}, Page: 1, PageSize: 20, TotalCount: 0, TotalPages: 0})
		return
	}
	page, pageSize := parseAssetPaging(r)
	category, nameQ, _ := parseAssetFilters(r)
	items, total, err := h.queryAssetBindings(r.Context(), issue.WorkspaceID, issue.ProjectID, issue.ID, category, nameQ, page, pageSize)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list issue assets")
		return
	}
	totalPages := 0
	if pageSize > 0 {
		totalPages = (total + pageSize - 1) / pageSize
	}
	writeJSON(w, http.StatusOK, AssetPage{
		Items: items, Page: page, PageSize: pageSize, TotalCount: total, TotalPages: totalPages,
	})
}

// queryAssetBindings 执行项目 / 工作项两种作用域的分页读取。issueID.Valid 时只取该
// 工作项的绑定，否则取项目级（issue_id IS NULL）。全部带 workspace_id 过滤防串租。
func (h *Handler) queryAssetBindings(ctx context.Context, workspaceID, projectID, issueID pgtype.UUID, category, nameQ string, page, pageSize int) ([]AssetBindingResponse, int, error) {
	var conds []string
	var args []any
	args = append(args, workspaceID)
	conds = append(conds, "workspace_id = $1")
	args = append(args, projectID)
	conds = append(conds, "project_id = $2")
	if issueID.Valid {
		args = append(args, issueID)
		conds = append(conds, "issue_id = $"+strconv.Itoa(len(args)))
	} else {
		conds = append(conds, "issue_id IS NULL")
	}
	if category != "" {
		args = append(args, category)
		conds = append(conds, "asset_category = $"+strconv.Itoa(len(args)))
	}
	if nameQ != "" {
		args = append(args, "%"+nameQ+"%")
		conds = append(conds, "asset_name ILIKE $"+strconv.Itoa(len(args)))
	}
	where := strings.Join(conds, " AND ")

	var total int
	if err := h.DB.QueryRow(ctx, "SELECT count(*) FROM project_asset_binding WHERE "+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * pageSize
	if offset < 0 {
		offset = 0
	}
	listArgs := append(append([]any{}, args...), pageSize, offset)
	rows, err := h.DB.Query(ctx, `SELECT `+assetBindingColumns+`
FROM project_asset_binding WHERE `+where+`
ORDER BY created_at DESC
LIMIT $`+strconv.Itoa(len(listArgs)-1)+` OFFSET $`+strconv.Itoa(len(listArgs)), listArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := []AssetBindingResponse{}
	for rows.Next() {
		a, err := h.scanAssetBindingRow(rows.Scan)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, a.toResponse())
	}
	return items, total, rows.Err()
}

// ──────────────────────────────────────────────────────────────────────────
// 工作区级：跨项目资产聚合清单（左侧栏「资产管理」独立模块）
// ──────────────────────────────────────────────────────────────────────────

// WorkspaceAssetBinding 在项目/工作项作用域响应之上，附带归属项目 / 工作项标题，
// 供工作区级管理页直接展示并生成跳转链接（串联 项目 / 需求 / 任务 动线）。
type WorkspaceAssetBinding struct {
	AssetBindingResponse
	ProjectTitle *string `json:"project_title"`
	IssueTitle   *string `json:"issue_title"`
}

// WorkspaceAssetPage 复用 CoCo 面 C 信封，items 为富化行。
type WorkspaceAssetPage struct {
	Items      []WorkspaceAssetBinding `json:"items"`
	Page       int                     `json:"page"`
	PageSize   int                     `json:"pageSize"`
	TotalCount int                     `json:"totalCount"`
	TotalPages int                     `json:"totalPages"`
}

// ListWorkspaceAssets 处理 GET /api/assets/page —— 跨当前 workspace 所有项目的绑定
// 聚合（项目级 + 工作项级都列出），供左侧栏「资产管理」系统化管理。作用域过滤仅按
// workspace_id（防串租），可选 category / name / projectId（侧栏的项目下拉过滤，
// 非法 uuid 直接 400 而非静默降级成全域，避免用户误以为「该项目无资产」）/ stage /
// role（阶段与对象在 SQL 内过滤，这样分页总数与筛选结果一致）；解绑复用
// 项目级 DELETE（binding 行自带 project_id，unbind SQL 只按 workspace+project+id 匹配，
// 故工作项级绑定亦可经此路径解绑）。
func (h *Handler) ListWorkspaceAssets(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return
	}
	page, pageSize := parseAssetPaging(r)
	category, nameQ, _ := parseAssetFilters(r)
	stage, role, ok := parseAssetMetaFilters(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid stage or role")
		return
	}

	var projectID pgtype.UUID
	if raw := strings.TrimSpace(r.URL.Query().Get("projectId")); raw != "" {
		u, err := parseUUIDLoose(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid projectId")
			return
		}
		projectID = u
	}

	items, total, err := h.queryWorkspaceAssetBindings(r.Context(), wsUUID, category, nameQ, stage, role, projectID, page, pageSize)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list workspace assets")
		return
	}
	totalPages := 0
	if pageSize > 0 {
		totalPages = (total + pageSize - 1) / pageSize
	}
	writeJSON(w, http.StatusOK, WorkspaceAssetPage{
		Items: items, Page: page, PageSize: pageSize, TotalCount: total, TotalPages: totalPages,
	})
}

// queryWorkspaceAssetBindings 联表 project / issue 标题，按 workspace 聚合分页读取。
// 用 LEFT JOIN：孤儿 binding（项目已删）仍出现但标题为空，前端降级展示原始 id。
// projectID.Valid 时把作用域收窄到单项目（侧栏项目下拉过滤）。stage / role 在 SQL
// 内过滤（"none" = NULL 或空串），前端不再对当前页做二次过滤，于是每页行数稳定、
// 末页不会因为筛掉大半行而留白。
func (h *Handler) queryWorkspaceAssetBindings(ctx context.Context, workspaceID pgtype.UUID, category, nameQ, stage, role string, projectID pgtype.UUID, page, pageSize int) ([]WorkspaceAssetBinding, int, error) {
	var conds []string
	var args []any
	args = append(args, workspaceID)
	conds = append(conds, "b.workspace_id = $1")
	if projectID.Valid {
		args = append(args, projectID)
		conds = append(conds, "b.project_id = $"+strconv.Itoa(len(args)))
	}
	if category != "" {
		args = append(args, category)
		conds = append(conds, "b.asset_category = $"+strconv.Itoa(len(args)))
	}
	if nameQ != "" {
		args = append(args, "%"+nameQ+"%")
		conds = append(conds, "b.asset_name ILIKE $"+strconv.Itoa(len(args)))
	}
	for _, meta := range []struct {
		column string
		value  string
	}{
		{"lifecycle_stage", stage},
		{"asset_role", role},
	} {
		switch meta.value {
		case "":
			// 不过滤
		case "none":
			conds = append(conds, "NULLIF(b."+meta.column+", '') IS NULL")
		default:
			args = append(args, meta.value)
			conds = append(conds, "b."+meta.column+" = $"+strconv.Itoa(len(args)))
		}
	}
	where := strings.Join(conds, " AND ")

	var total int
	if err := h.DB.QueryRow(ctx, "SELECT count(*) FROM project_asset_binding b WHERE "+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * pageSize
	if offset < 0 {
		offset = 0
	}
	listArgs := append(append([]any{}, args...), pageSize, offset)
	rows, err := h.DB.Query(ctx, `SELECT
	b.id, b.workspace_id, b.project_id, b.issue_id, b.asset_category, b.resource_id,
	b.external_ref, b.asset_name, b.asset_subtype, b.source, b.recommended, b.recommend_reason,
	b.lifecycle_stage, b.asset_role, b.tags,
	b.created_by_type, b.created_by_id, b.created_at,
	p.title, i.title
FROM project_asset_binding b
LEFT JOIN project p ON p.id = b.project_id
LEFT JOIN issue i ON i.id = b.issue_id
WHERE `+where+`
ORDER BY b.created_at DESC
LIMIT $`+strconv.Itoa(len(listArgs)-1)+` OFFSET $`+strconv.Itoa(len(listArgs)), listArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := []WorkspaceAssetBinding{}
	for rows.Next() {
		var a assetBindingRow
		var projectTitle, issueTitle pgtype.Text
		if err := rows.Scan(&a.id, &a.workspaceID, &a.projectID, &a.issueID, &a.assetCategory,
			&a.resourceID, &a.externalRef, &a.assetName, &a.assetSubtype, &a.source,
			&a.recommended, &a.recommendReason, &a.lifecycleStage, &a.assetRole, &a.tags,
			&a.createdByType, &a.createdByID, &a.createdAt,
			&projectTitle, &issueTitle); err != nil {
			return nil, 0, err
		}
		items = append(items, WorkspaceAssetBinding{
			AssetBindingResponse: a.toResponse(),
			ProjectTitle:         textToPtr(projectTitle),
			IssueTitle:           textToPtr(issueTitle),
		})
	}
	return items, total, rows.Err()
}

// ──────────────────────────────────────────────────────────────────────────
// bind / unbind
// ──────────────────────────────────────────────────────────────────────────

type bindAssetRequest struct {
	AssetCategory   string          `json:"asset_category"`
	AssetName       string          `json:"asset_name"`
	AssetSubtype    *string         `json:"asset_subtype"`
	Source          string          `json:"source"`
	ExternalRef     json.RawMessage `json:"external_ref"`
	ResourceID      string          `json:"resource_id"`
	IssueID         string          `json:"issue_id"`
	Recommended     *bool           `json:"recommended"`
	RecommendReason *string         `json:"recommend_reason"`
	// 473 扩展：绑定时可直接打标阶段/角色/标签并关联需求・Bug。
	LifecycleStage string              `json:"lifecycle_stage"`
	AssetRole      string              `json:"asset_role"`
	Tags           []string            `json:"tags"`
	Links          []AssetIssueLinkReq `json:"links"`
}

// AssetIssueLinkReq 是写入态的关联条目（issue_id + 链型）。
type AssetIssueLinkReq struct {
	IssueID  string `json:"issue_id"`
	LinkType string `json:"link_type"`
}

// BindProjectAsset 处理 POST /api/projects/{id}/assets。
func (h *Handler) BindProjectAsset(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var req bindAssetRequest
	var issueID pgtype.UUID // 项目级：issue_id NULL
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// 项目级 endpoint 允许 body 带 issue_id 直接落工作项作用域（对齐 CoCo 双入口）。
	if req.IssueID != "" {
		issue, ok := h.loadIssueForUser(w, r, req.IssueID)
		if !ok {
			return
		}
		if uuidToString(issue.ProjectID) != uuidToString(project.ID) {
			writeError(w, http.StatusBadRequest, "issue does not belong to this project")
			return
		}
		issueID = issue.ID
	}
	h.bindAsset(w, r, project, issueID, req)
}

// BindIssueAsset 处理 POST /api/issues/{id}/assets —— 作用域锁定到该 issue。
func (h *Handler) BindIssueAsset(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if !issue.ProjectID.Valid {
		writeError(w, http.StatusBadRequest, "issue is not attached to a project")
		return
	}
	project, err := h.Queries.GetProjectInWorkspace(r.Context(), db.GetProjectInWorkspaceParams{
		ID: issue.ProjectID, WorkspaceID: issue.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	var req bindAssetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.IssueID = "" // 作用域由路径决定，忽略 body
	h.bindAsset(w, r, project, issue.ID, req)
}

// bindAsset 是项目级 / 工作项级共用的落库逻辑。
func (h *Handler) bindAsset(w http.ResponseWriter, r *http.Request, project db.Project, issueID pgtype.UUID, req bindAssetRequest) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	req.AssetCategory = strings.TrimSpace(req.AssetCategory)
	if !validAssetCategories[req.AssetCategory] {
		writeError(w, http.StatusBadRequest, "asset_category must be one of code_repository|application|package|knowledge_repo|knowledge_group|other")
		return
	}
	req.AssetName = strings.TrimSpace(req.AssetName)
	if req.AssetName == "" {
		writeError(w, http.StatusBadRequest, "asset_name is required")
		return
	}
	source := strings.TrimSpace(req.Source)
	if source == "" {
		source = "manual"
	}
	externalRef := req.ExternalRef
	if len(externalRef) == 0 || !json.Valid(externalRef) {
		externalRef = json.RawMessage(`{}`)
	}

	createdBy, ok := h.parseUserUUIDOrZero(userID)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}

	// resource_id 解析：显式给定 → 校验同 workspace/project 防串租；未给但 external_ref
	// 能定位仓库 URL → best-effort 建 / 复用 065 github_repo 资源并回填（复用
	// validateAndNormalizeResourceRef）。失败不阻断 bind（binding 自带 external_ref）。
	resourceID, err := h.resolveBindResourceRef(r, project, req, externalRef, userID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	recommended := false
	if req.Recommended != nil {
		recommended = *req.Recommended
	}
	var reason pgtype.Text
	if req.RecommendReason != nil && strings.TrimSpace(*req.RecommendReason) != "" {
		reason = pgtype.Text{String: strings.TrimSpace(*req.RecommendReason), Valid: true}
	}
	var subtype pgtype.Text
	if req.AssetSubtype != nil && strings.TrimSpace(*req.AssetSubtype) != "" {
		subtype = pgtype.Text{String: strings.TrimSpace(*req.AssetSubtype), Valid: true}
	}

	ctx := r.Context()
	// 473 字段归一：空串=NULL，非法枚举直接 400。
	stage, stageErr := assetEnumText(req.LifecycleStage, validAssetStages, "lifecycle_stage")
	if stageErr != "" {
		writeError(w, http.StatusBadRequest, stageErr)
		return
	}
	role, roleErr := assetEnumText(req.AssetRole, validAssetRoles, "asset_role")
	if roleErr != "" {
		writeError(w, http.StatusBadRequest, roleErr)
		return
	}
	tags := normalizeAssetTags(req.Tags)

	// 五阶段对齐 plan §4.2：binding、links、档案 upsert 同一事务；
	// 任一失败整体回滚，提交后才广播。
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to bind asset")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var out assetBindingRow
	// issue_id 允许 NULL：pgtype.UUID 零值直接作为参数传入即落 NULL。
	insertArgs := []any{project.WorkspaceID, project.ID, issueID, req.AssetCategory, resourceID, externalRef, req.AssetName, subtype, source, recommended, reason, stage, role, tags, "member", createdBy}
	query := `INSERT INTO project_asset_binding
    (workspace_id, project_id, issue_id, asset_category, resource_id, external_ref,
     asset_name, asset_subtype, source, recommended, recommend_reason,
     lifecycle_stage, asset_role, tags, created_by_type, created_by_id)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
RETURNING ` + assetBindingColumns
	err = tx.QueryRow(ctx, query, insertArgs...).Scan(
		&out.id, &out.workspaceID, &out.projectID, &out.issueID, &out.assetCategory,
		&out.resourceID, &out.externalRef, &out.assetName, &out.assetSubtype, &out.source,
		&out.recommended, &out.recommendReason, &out.lifecycleStage, &out.assetRole, &out.tags,
		&out.createdByType, &out.createdByID, &out.createdAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "this asset is already bound",
				"code":  "asset_already_bound",
			})
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to bind asset")
		return
	}
	// 关联需求・Bug：同事务校验后批量插入，非法链型整体回滚（不留半截 binding）。
	resp := out.toResponse()
	if len(req.Links) > 0 {
		if errMsg := h.replaceAssetLinks(ctx, tx, out.id, project.WorkspaceID, createdBy, req.Links); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
	}
	// 知识/文档类资产同事务自动映射到项目档案（五阶段唯一映射 plan §4.2）：
	// 同步失败 → binding/links/档案全部回滚，不再 best-effort 分叉。
	if err := h.syncAssetToArchive(ctx, tx, out); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to sync asset into archive")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to bind asset")
		return
	}
	if len(req.Links) > 0 {
		resp.Links, _ = h.fetchAssetLinks(ctx, h.DB, out.id)
	}
	// plan 20261025 §B3c：补齐外部必检资产后立刻复评该项目下 blocked 阶段
	// （best-effort，不阻断绑定响应）。
	h.reevaluateWorkflowBlocked(ctx, project.ID)
	h.publish(protocol.EventAssetBound, uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"binding": resp, "project_id": uuidToString(project.ID)})
	writeJSON(w, http.StatusCreated, resp)
}

// reevaluateWorkflowBlocked 是资产绑定/解绑写路径的旁路复评（plan 20261025 §B3c）：
// 外部必检资产补齐后，工作流 blocked 阶段得有人叫醒——改造前完全没有这个触发，
// 阶段会永久卡死。WorkflowService 未注入或 asset gate 关闭时 no-op（零回归）。
func (h *Handler) reevaluateWorkflowBlocked(ctx context.Context, projectID pgtype.UUID) {
	if h.WorkflowService == nil {
		return
	}
	n, err := h.WorkflowService.ReevaluateProjectBlocked(ctx, projectID)
	if err != nil {
		slog.Warn("asset change: workflow blocked reevaluation failed",
			"project_id", uuidToString(projectID), "error", err)
		return
	}
	if n > 0 {
		slog.Info("asset change: reevaluated workflow instances with blocked stages",
			"project_id", uuidToString(projectID), "instances", n)
	}
}

// resolveBindResourceRef 决定 binding 指向的 065 资源（pgtype.UUID，可零值 = 不指向）。
func (h *Handler) resolveBindResourceRef(r *http.Request, project db.Project, req bindAssetRequest, externalRef json.RawMessage, userID string) (pgtype.UUID, error) {
	ctx := r.Context()
	if req.ResourceID != "" {
		ruuid, err := parseUUIDLoose(req.ResourceID)
		if err != nil {
			return pgtype.UUID{}, badRequest("invalid resource id")
		}
		res, err := h.Queries.GetProjectResourceInWorkspace(ctx, db.GetProjectResourceInWorkspaceParams{
			ID: ruuid, WorkspaceID: project.WorkspaceID,
		})
		if err != nil {
			return pgtype.UUID{}, badRequest("resource not found in this workspace")
		}
		if uuidToString(res.ProjectID) != uuidToString(project.ID) {
			return pgtype.UUID{}, badRequest("resource does not belong to this project")
		}
		return res.ID, nil
	}

	// 未显式给 resource_id：若 external_ref 携带可用 git url，best-effort 建 / 复用资源。
	url := extractRefURL(externalRef)
	if url == "" {
		return pgtype.UUID{}, nil
	}
	normalized, err := validateAndNormalizeResourceRef("github_repo", externalRefForURL(externalRef, url))
	if err != nil {
		return pgtype.UUID{}, nil // 不是可定位仓库的 ref，不阻断 bind
	}
	existing, found := h.findProjectResourceByURL(ctx, project.ID, url)
	if found {
		return existing, nil
	}
	count, _ := h.Queries.CountProjectResources(ctx, project.ID)
	creator, _ := h.parseUserUUIDOrZero(userID)
	created, err := h.Queries.CreateProjectResource(ctx, db.CreateProjectResourceParams{
		ProjectID:    project.ID,
		WorkspaceID:  project.WorkspaceID,
		ResourceType: "github_repo",
		ResourceRef:  normalized,
		Label:        pgtype.Text{},
		Position:     int32(count),
		CreatedBy:    creator,
	})
	if err != nil {
		if isUniqueViolation(err) {
			if id, ok := h.findProjectResourceByURL(ctx, project.ID, url); ok {
				return id, nil
			}
		}
		return pgtype.UUID{}, nil // 建资源失败不阻断 bind（降级：binding 无指针）
	}
	return created.ID, nil
}

// findProjectResourceByURL 在项目的 github_repo 资源里按 url 命中（best-effort 复用）。
func (h *Handler) findProjectResourceByURL(ctx context.Context, projectID pgtype.UUID, wantURL string) (pgtype.UUID, bool) {
	rows, err := h.Queries.ListProjectResources(ctx, projectID)
	if err != nil {
		return pgtype.UUID{}, false
	}
	for _, row := range rows {
		if row.ResourceType != "github_repo" {
			continue
		}
		var payload struct {
			URL string `json:"url"`
		}
		if json.Unmarshal(row.ResourceRef, &payload) == nil && payload.URL == wantURL {
			return row.ID, true
		}
	}
	return pgtype.UUID{}, false
}

// UnbindProjectAsset 处理 DELETE /api/projects/{id}/assets/{bindingId}。
// 只删 binding，绝不删 resource（保留可被多 binding 复用的物理指针）。
func (h *Handler) UnbindProjectAsset(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	h.unbindAsset(w, r, project.WorkspaceID, project.ID, true)
}

// UnbindIssueAsset 处理 DELETE /api/issues/{id}/assets/{bindingId}。
func (h *Handler) UnbindIssueAsset(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if !issue.ProjectID.Valid {
		writeError(w, http.StatusNotFound, "asset binding not found")
		return
	}
	h.unbindAsset(w, r, issue.WorkspaceID, issue.ProjectID, false)
}

func (h *Handler) unbindAsset(w http.ResponseWriter, r *http.Request, workspaceID, projectID pgtype.UUID, _ bool) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	bindingUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "bindingId"), "binding id")
	if !ok {
		return
	}
	ctx := r.Context()
	tag, err := h.DB.Exec(ctx, `
DELETE FROM project_asset_binding
WHERE id = $1 AND workspace_id = $2 AND project_id = $3`,
		bindingUUID, workspaceID, projectID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unbind asset")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "asset binding not found")
		return
	}
	h.publish(protocol.EventAssetUnbound, uuidToString(workspaceID), "member", userID,
		map[string]any{"binding_id": uuidToString(bindingUUID), "project_id": uuidToString(projectID)})
	// 解绑同样可能改变准入判定（如同名资产被重建），顺手复评一次（§B3c）。
	h.reevaluateWorkflowBlocked(ctx, projectID)
	w.WriteHeader(http.StatusNoContent)
}

// ──────────────────────────────────────────────────────────────────────────
// 搜索候选 + 智能推荐（复用 scoreBindCandidate 三因子范式）
// ──────────────────────────────────────────────────────────────────────────

// AssetCandidate 是搜索候选条目（对标 CoCo ECe）。
type AssetCandidate struct {
	AssetCategory   string          `json:"asset_category"`
	AssetName       string          `json:"asset_name"`
	Subtype         string          `json:"subtype,omitempty"`
	Source          string          `json:"source"`
	ResourceID      *string         `json:"resource_id"`
	ExternalRef     json.RawMessage `json:"external_ref"`
	AlreadyBound    bool            `json:"already_bound"`
	Recommended     bool            `json:"recommended"`
	RecommendReason string          `json:"recommend_reason"`
	Score           float64         `json:"score"`
}

// assetScoreInput 是 scoreAssetCandidate 的纯输入（从候选信号拆解，便于单测）。
type assetScoreInput struct {
	RelatedToMe bool    // 因子1 相关性：当前 member 创建 / 参与
	UsageRatio  float64 // 因子2 协作频率：项目内引用该资产的 issue 占比 0..1
	GraphHeat   float64 // 因子3 图谱扇入：该资产对应 graph 节点热度 0..1
}

// scoreAssetCandidate 三因子加权置信度（镜像 scoreBindCandidate，纯函数便于单测）。
//
//	相关性（0.5）：member 参与 / 创建 → 1，否则 0
//	协作频率（0.3）：项目内使用该资产的需求占比
//	图谱热度（0.2）：graph snapshot 对应节点数量归一化
//
// 返回分值 + 主导因子的推荐理由键（recent / joint / hot）。
func scoreAssetCandidate(in assetScoreInput) (float64, string) {
	rel := 0.0
	if in.RelatedToMe {
		rel = 1
	}
	usage := clampUnit(in.UsageRatio)
	heat := clampUnit(in.GraphHeat)
	score := 0.5*rel + 0.3*usage + 0.2*heat

	contribs := []struct {
		v   float64
		key string
	}{
		{0.5 * rel, "recent"},
		{0.3 * usage, "joint"},
		{0.2 * heat, "hot"},
	}
	best := contribs[0]
	for _, c := range contribs[1:] {
		if c.v > best.v {
			best = c
		}
	}
	reason := ""
	if best.v > 0 {
		reason = best.key
	}
	return score, reason
}

func clampUnit(f float64) float64 {
	if f < 0 {
		return 0
	}
	if f > 1 {
		return 1
	}
	return f
}

// SearchAssetCandidates 处理 GET /api/projects/{id}/assets/search-candidates
// ?category=&q=&relatedToMe=。候选源全部走库内既有数据（project github_repo 资源 +
// workspace.repos），**不新建外部连接**；外部源不可用时降级返回 200 空列表（防御式契约）。
func (h *Handler) SearchAssetCandidates(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	category := strings.TrimSpace(q.Get("category"))
	if category == "" {
		category = "code_repository"
	}
	if !validAssetCategories[category] {
		writeJSON(w, http.StatusOK, map[string]any{"candidates": []AssetCandidate{}})
		return
	}
	nameQ := strings.ToLower(strings.TrimSpace(q.Get("q")))
	relatedOnly := strings.EqualFold(q.Get("relatedToMe"), "true") || q.Get("relatedToMe") == "1"

	// knowledge_* 不再短路：候选池 = 项目档案（见下方 archive 分支）。这里只挡
	// 非法分类，合法分类即使没有候选也返回空列表而不是错误。
	ctx := r.Context()
	candidates, err := h.buildAssetCandidates(ctx, project, userID, category, nameQ, relatedOnly)
	if err != nil {
		// 外部 / 库内源故障：降级空列表（200），绝不回吐 DB 原文（M-6）。
		writeJSON(w, http.StatusOK, map[string]any{"candidates": []AssetCandidate{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"candidates": candidates})
}

// categoryUsesGithubCandidates 判定分类是否消费仓库类候选（项目 github_repo
// 资源 + workspace.repos）。知识 / 文档分类只看档案，避免仓库混进知识列表。
func categoryUsesGithubCandidates(category string) bool {
	switch category {
	case "code_repository", "application", "package":
		return true
	}
	return false
}

// categoryUsesArchiveCandidates 判定分类是否消费项目档案候选。资产五分类里
// 知识仓库 / 知识分组 / 其他 都是文档语义，候选池就是项目档案。
func categoryUsesArchiveCandidates(category string) bool {
	return archiveAssetCategories[category]
}

// archiveAssetCandidate 由档案行构造候选：名称取 rel_path 末段，subtype 取扩展名，
// external_ref 带 artifact_id / attachment_id / rel_path，绑定后预览直接走档案分支。
func archiveAssetCandidate(category, relPath, artifactID, attachmentID string, alreadyBound bool) AssetCandidate {
	name := relPath
	if i := strings.LastIndex(relPath, "/"); i >= 0 {
		name = relPath[i+1:]
	}
	subtype := ""
	if i := strings.LastIndex(name, "."); i >= 0 && i+1 < len(name) {
		subtype = strings.ToLower(name[i+1:])
	}
	ref := map[string]string{"artifact_id": artifactID, "rel_path": relPath}
	if attachmentID != "" {
		ref["attachment_id"] = attachmentID
	}
	return AssetCandidate{
		AssetCategory: category,
		AssetName:     name,
		Subtype:       subtype,
		Source:        "archive",
		ExternalRef:   mustJSON(ref),
		AlreadyBound:  alreadyBound,
	}
}

// buildAssetCandidates 聚合 github_repo 资源 + workspace.repos 两个源，去重、打标、评分。
func (h *Handler) buildAssetCandidates(ctx context.Context, project db.Project, userID, category, nameQ string, relatedOnly bool) ([]AssetCandidate, error) {
	resources, err := h.Queries.ListProjectResources(ctx, project.ID)
	if err != nil {
		return nil, err
	}

	// 已绑定集（项目级 + 工作项级）：resource_id + asset_name 双维去重。
	boundResourceIDs := map[string]bool{}
	boundNames := map[string]bool{}
	if rows, err := h.DB.Query(ctx, `SELECT resource_id, asset_name FROM project_asset_binding
        WHERE project_id = $1 AND workspace_id = $2`, project.ID, project.WorkspaceID); err == nil {
		for rows.Next() {
			var rid pgtype.UUID
			var name string
			if rows.Scan(&rid, &name) == nil {
				if rid.Valid {
					boundResourceIDs[uuidToString(rid)] = true
				}
				boundNames[strings.ToLower(name)] = true
			}
		}
		rows.Close()
	}

	// 协作频率分母 + per-repo 使用计数。
	var totalIssues int
	_ = h.DB.QueryRow(ctx, `SELECT count(*) FROM issue WHERE project_id = $1`, project.ID).Scan(&totalIssues)
	usageByResource := h.countIssuesByRepoResource(ctx, project.ID)

	// 图谱热度：每资源最新快照节点数。
	graphHeat := h.loadGraphHeatByResource(ctx, project.ID)

	seenURL := map[string]bool{}
	out := []AssetCandidate{}
	creator, _ := h.parseUserUUIDOrZero(userID)

	for _, res := range resources {
		if !categoryUsesGithubCandidates(category) {
			break
		}
		if res.ResourceType != "github_repo" {
			continue
		}
		var payload struct {
			URL string `json:"url"`
		}
		if json.Unmarshal(res.ResourceRef, &payload) != nil || payload.URL == "" {
			continue
		}
		seenURL[payload.URL] = true
		rid := uuidToString(res.ID)

		usageRatio := 0.0
		if totalIssues > 0 {
			usageRatio = float64(usageByResource[rid]) / float64(totalIssues)
		}
		related := res.CreatedBy.Valid && uuidToString(res.CreatedBy) == uuidToString(creator)
		heat := graphHeat[rid]
		score, reason := scoreAssetCandidate(assetScoreInput{RelatedToMe: related, UsageRatio: usageRatio, GraphHeat: heat})

		name := payload.URL
		if res.Label.Valid && strings.TrimSpace(res.Label.String) != "" {
			name = res.Label.String
		}
		if nameQ != "" && !strings.Contains(strings.ToLower(name+" "+payload.URL), nameQ) {
			continue
		}
		if relatedOnly && !related {
			continue
		}
		out = append(out, AssetCandidate{
			AssetCategory:   category,
			AssetName:       name,
			Source:          "github",
			ResourceID:      &rid,
			ExternalRef:     json.RawMessage(res.ResourceRef),
			AlreadyBound:    boundResourceIDs[rid] || boundNames[strings.ToLower(name)],
			Recommended:     score >= 0.5,
			RecommendReason: reason,
			Score:           score,
		})
	}

	// workspace.repos：项目尚未挂为资源、但工作区可达的仓库 → 候选（无指针，评分低）。
	if ws, err := h.Queries.GetWorkspace(ctx, project.WorkspaceID); err == nil && len(ws.Repos) > 0 && categoryUsesGithubCandidates(category) {
		var repos []struct {
			URL   string `json:"url"`
			Label string `json:"label"`
		}
		if json.Unmarshal(ws.Repos, &repos) == nil {
			for _, rp := range repos {
				if rp.URL == "" || seenURL[rp.URL] {
					continue
				}
				name := rp.Label
				if name == "" {
					name = rp.URL
				}
				if nameQ != "" && !strings.Contains(strings.ToLower(name+" "+rp.URL), nameQ) {
					continue
				}
				if relatedOnly {
					continue // 工作区级来源无法归属到个人，「只看与我相关」下不展示
				}
				ref, _ := json.Marshal(map[string]string{"url": rp.URL})
				out = append(out, AssetCandidate{
					AssetCategory: category,
					AssetName:     name,
					Source:        "github",
					ExternalRef:   ref,
					AlreadyBound:  boundNames[strings.ToLower(name)],
				})
			}
		}
	}

	// 项目档案文档 → 知识类 / 其他类候选（migration 474 双向映射的反向源）。
	// external_ref 携 artifact_id：syncAssetToArchive 对此类 binding 跳过入档，防循环；
	// source='asset' 的档案行本身就是资产同步产物，不再重复当候选。
	if categoryUsesArchiveCandidates(category) {
		rows, err := h.DB.Query(ctx, `
			SELECT DISTINCT ON (rel_path) id, rel_path, attachment_id
			FROM project_artifact
			WHERE project_id = $1 AND workspace_id = $2 AND deleted_at IS NULL AND source <> 'asset'
			ORDER BY rel_path, version DESC
			LIMIT 200`, project.ID, project.WorkspaceID)
		if err == nil {
			for rows.Next() {
				var artifactID, attachmentID pgtype.UUID
				var relPath string
				if rows.Scan(&artifactID, &relPath, &attachmentID) != nil {
					continue
				}
				name := relPath
				if i := strings.LastIndex(relPath, "/"); i >= 0 {
					name = relPath[i+1:]
				}
				if nameQ != "" && !strings.Contains(strings.ToLower(name+" "+relPath), nameQ) {
					continue
				}
				if relatedOnly {
					continue // 档案文档无个人归属信号，「只看与我相关」下不展示
				}
				attachID := ""
				if attachmentID.Valid {
					attachID = uuidToString(attachmentID)
				}
				out = append(out, archiveAssetCandidate(
					category, relPath, uuidToString(artifactID), attachID,
					boundNames[strings.ToLower(name)],
				))
			}
			rows.Close()
		}
	}

	// 推荐项优先、分值降序（对齐 CoCo 候选列表观感）。
	sortAssetCandidates(out)
	return out, nil
}

// sortAssetCandidates 候选排序：未绑定在前，其次推荐，再次分值降序。
// 项目档案全部已绑定时，候选列表仍会列出这些行（置灰），如果不把未绑定项提上来，
// 用户只会看到一整列灰按钮，误以为「绑定坏了」。
func sortAssetCandidates(out []AssetCandidate) {
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].AlreadyBound != out[j].AlreadyBound {
			return !out[i].AlreadyBound
		}
		if out[i].Recommended != out[j].Recommended {
			return out[i].Recommended
		}
		return out[i].Score > out[j].Score
	})
}

// mustJSON 序列化辅助（候选构造用；失败返回空对象，不阻断列表）。
func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}

func (h *Handler) countIssuesByRepoResource(ctx context.Context, projectID pgtype.UUID) map[string]int {
	out := map[string]int{}
	rows, err := h.DB.Query(ctx, `SELECT repo_resource_id, count(*) FROM issue
        WHERE project_id = $1 AND repo_resource_id IS NOT NULL GROUP BY repo_resource_id`, projectID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var rid pgtype.UUID
		var c int
		if rows.Scan(&rid, &c) == nil {
			out[uuidToString(rid)] = c
		}
	}
	return out
}

func (h *Handler) loadGraphHeatByResource(ctx context.Context, projectID pgtype.UUID) map[string]float64 {
	out := map[string]float64{}
	rows, err := h.DB.Query(ctx, `SELECT DISTINCT ON (resource_id) resource_id, jsonb_array_length(nodes)
        FROM project_graph_snapshot WHERE project_id = $1
        ORDER BY resource_id, created_at DESC`, projectID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var rid pgtype.UUID
		var n int
		if rows.Scan(&rid, &n) == nil {
			out[uuidToString(rid)] = clampUnit(float64(n) / 100)
		}
	}
	return out
}

// ──────────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────────

// badRequest 是一个仅携带 message 的轻量错误，供 bindAsset 内层返回 400 文案。
type badRequestError struct{ msg string }

func (e badRequestError) Error() string { return e.msg }
func badRequest(msg string) error       { return badRequestError{msg} }

func parseAssetPaging(r *http.Request) (int, int) {
	page := 1
	if raw := r.URL.Query().Get("toPage"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			page = n
		}
	}
	pageSize := 20
	if raw := r.URL.Query().Get("pageSize"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 200 {
			pageSize = n
		}
	}
	return page, pageSize
}

func parseAssetFilters(r *http.Request) (category, nameQ string, issueID pgtype.UUID) {
	q := r.URL.Query()
	category = strings.TrimSpace(q.Get("category"))
	nameQ = strings.TrimSpace(q.Get("name"))
	if raw := strings.TrimSpace(q.Get("issueId")); raw != "" {
		if u, err := parseUUIDLoose(raw); err == nil {
			issueID = u
		}
	}
	return
}

// assetStageFilterValues / assetRoleFilterValues 是工作区级阶段与对象过滤的合法取值，
// 与前端 AssetLifecycleStage / AssetRole（packages/core/types/asset.ts）对齐。
var assetStageFilterValues = map[string]struct{}{
	"S0": {}, "S1": {}, "S2": {}, "S3": {}, "S4": {}, "S5": {}, "general": {},
}

var assetRoleFilterValues = map[string]struct{}{
	"input": {}, "output": {},
}

// parseAssetMetaFilters 解析工作区级清单的阶段 / 对象过滤（与分页同一次查询，
// 以便 totalCount / totalPages 与筛选结果一致）。空串与 "all" 表示不过滤，
// "none" 表示「未分阶 / 未定对象」（NULL 或空串）。非法值返回 400，
// 与 projectId 同策略——静默降级成全量会让用户误以为筛选生效。
func parseAssetMetaFilters(r *http.Request) (stage, role string, ok bool) {
	q := r.URL.Query()
	for _, spec := range []struct {
		key     string
		allowed map[string]struct{}
		dst     *string
	}{
		{"stage", assetStageFilterValues, &stage},
		{"role", assetRoleFilterValues, &role},
	} {
		raw := strings.TrimSpace(q.Get(spec.key))
		if raw == "" || raw == "all" {
			continue
		}
		if raw == "none" {
			*spec.dst = raw
			continue
		}
		if _, valid := spec.allowed[raw]; !valid {
			return "", "", false
		}
		*spec.dst = raw
	}
	return stage, role, true
}

// extractRefURL 读取 external_ref 里的仓库 url（若有）。
func extractRefURL(ref json.RawMessage) string {
	var payload struct {
		URL string `json:"url"`
	}
	if json.Unmarshal(ref, &payload) != nil {
		return ""
	}
	return strings.TrimSpace(payload.URL)
}

// externalRefForURL 保证 ref 至少带一个合法 url 供 validateAndNormalizeResourceRef 校验。
func externalRefForURL(ref json.RawMessage, url string) json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(ref, &fields) != nil {
		fields = map[string]json.RawMessage{}
	}
	enc, err := json.Marshal(url)
	if err != nil {
		return ref
	}
	fields["url"] = enc
	out, err := json.Marshal(fields)
	if err != nil {
		return ref
	}
	return out
}

// ──────────────────────────────────────────────────────────────────────────────
// 473：阶段/角色/标签/需求关联 meta + 工作区级 overview（阶段矩阵、需求×资产视图数据面）
// ──────────────────────────────────────────────────────────────────────────────

// assetDB 抽象让 helper 同时接受 *pgxpool.Pool 与 pgx 事务。
type assetDB interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// assetEnumText 把写入态枚举归一为 pgtype.Text：空串=NULL（清除打标），非法值返回错误文案。
func assetEnumText(val string, valid map[string]bool, field string) (pgtype.Text, string) {
	v := strings.TrimSpace(val)
	if v == "" {
		return pgtype.Text{}, ""
	}
	if !valid[v] {
		return pgtype.Text{}, field + " is not a valid choice"
	}
	return pgtype.Text{String: v, Valid: true}, ""
}

// normalizeAssetTags 去空/去重/截断（≤20 个、每个≤ 32 字符）；永不返回 nil（列 NOT NULL）。
func normalizeAssetTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := make(map[string]bool, len(tags))
	for _, raw := range tags {
		t := strings.TrimSpace(raw)
		if t == "" || seen[t] {
			continue
		}
		if len(t) > 32 {
			t = t[:32]
		}
		seen[t] = true
		out = append(out, t)
		if len(out) >= 20 {
			break
		}
	}
	return out
}

// replaceAssetLinks 全量替换某 binding 的关联集：逐条校验 issue 属于本 workspace
// 后插入；按 (issue_id, link_type) 去重。返回非空字符串 = 错误文案（调用方 400）。
func (h *Handler) replaceAssetLinks(ctx context.Context, store assetDB, bindingID, workspaceID, createdBy pgtype.UUID, links []AssetIssueLinkReq) string {
	if _, err := store.Exec(ctx, `DELETE FROM asset_issue_link WHERE asset_binding_id = $1`, bindingID); err != nil {
		return "failed to update asset links"
	}
	seen := make(map[string]bool, len(links))
	for _, l := range links {
		iid, err := parseUUIDLoose(l.IssueID)
		if err != nil {
			return "invalid issue_id"
		}
		lt := strings.TrimSpace(l.LinkType)
		if lt == "" {
			lt = "produces"
		}
		if !validAssetLinkTypes[lt] {
			return "link_type must be depends_on|produces|resolves"
		}
		key := uuidToString(iid) + "|" + lt
		if seen[key] {
			continue
		}
		seen[key] = true
		var one int
		if err := store.QueryRow(ctx, `SELECT 1 FROM issue WHERE id = $1 AND workspace_id = $2`, iid, workspaceID).Scan(&one); err != nil {
			return "issue does not belong to this workspace"
		}
		if _, err := store.Exec(ctx, `INSERT INTO asset_issue_link
				(asset_binding_id, issue_id, link_type, created_by_id) VALUES ($1,$2,$3,$4)`,
			bindingID, iid, lt, createdBy); err != nil {
			return "failed to link issue"
		}
	}
	return ""
}

// fetchAssetLinks 读回一个 binding 的全部关联（按创建时间稳定序）。
func (h *Handler) fetchAssetLinks(ctx context.Context, store assetDB, bindingID pgtype.UUID) ([]AssetIssueLink, error) {
	rows, err := store.Query(ctx, `SELECT issue_id, link_type FROM asset_issue_link
		WHERE asset_binding_id = $1 ORDER BY created_at`, bindingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	links := []AssetIssueLink{}
	for rows.Next() {
		var issueID pgtype.UUID
		var linkType string
		if err := rows.Scan(&issueID, &linkType); err != nil {
			return nil, err
		}
		links = append(links, AssetIssueLink{IssueID: uuidToString(issueID), LinkType: linkType})
	}
	return links, rows.Err()
}

type updateAssetMetaRequest struct {
	LifecycleStage *string              `json:"lifecycle_stage"`
	AssetRole      *string              `json:"asset_role"`
	AssetCategory  *string              `json:"asset_category"`
	Tags           *[]string            `json:"tags"`
	Links          *[]AssetIssueLinkReq `json:"links"`
}

// UpdateAssetMeta 处理 PUT /api/projects/{id}/assets/{bindingId}/meta —— 打标阶段/角色/
// 标签与全量替换需求·Bug 关联。指针字段：null=不动，""=清除，值=设置；links 非 null=整集替换。
func (h *Handler) UpdateAssetMeta(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	createdBy, ok := h.parseUserUUIDOrZero(userID)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	bindingID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "bindingId"), "binding_id")
	if !ok {
		return
	}
	var req updateAssetMetaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var sets []string
	args := []any{bindingID, project.WorkspaceID, project.ID}
	next := func(v any) string {
		s := "$" + strconv.Itoa(len(args)+1)
		args = append(args, v)
		return s
	}
	if req.LifecycleStage != nil {
		st, errMsg := assetEnumText(*req.LifecycleStage, validAssetStages, "lifecycle_stage")
		if errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
		sets = append(sets, "lifecycle_stage = "+next(st))
	}
	if req.AssetRole != nil {
		r2, errMsg := assetEnumText(*req.AssetRole, validAssetRoles, "asset_role")
		if errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
		sets = append(sets, "asset_role = "+next(r2))
	}
	if req.AssetCategory != nil {
		// 分类列 NOT NULL：空串视为非法，只接受六类枚举值。
		c := strings.TrimSpace(*req.AssetCategory)
		if !validAssetCategories[c] {
			writeError(w, http.StatusBadRequest, "asset_category is not a valid choice")
			return
		}
		sets = append(sets, "asset_category = "+next(c))
	}
	if req.Tags != nil {
		sets = append(sets, "tags = "+next(normalizeAssetTags(*req.Tags)))
	}
	if len(sets) == 0 && req.Links == nil {
		writeError(w, http.StatusBadRequest, "nothing to update")
		return
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update asset")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var out assetBindingRow
	query := `SELECT ` + assetBindingColumns + `
FROM project_asset_binding
WHERE id = $1 AND workspace_id = $2 AND project_id = $3`
	queryArgs := []any{bindingID, project.WorkspaceID, project.ID}
	if len(sets) > 0 {
		query = `UPDATE project_asset_binding SET ` + strings.Join(sets, ", ") + `
WHERE id = $1 AND workspace_id = $2 AND project_id = $3
RETURNING ` + assetBindingColumns
		queryArgs = args
	}
	// 只改关联（links）时 sets 为空：此时不能拼 UPDATE，否则得到空 SET 子句的
	// 非法 SQL；改为纯读回一行，仅做归属校验，再加下断言 404 语义一致。
	err = tx.QueryRow(ctx, query, queryArgs...).Scan(
		&out.id, &out.workspaceID, &out.projectID, &out.issueID, &out.assetCategory,
		&out.resourceID, &out.externalRef, &out.assetName, &out.assetSubtype, &out.source,
		&out.recommended, &out.recommendReason, &out.lifecycleStage, &out.assetRole, &out.tags,
		&out.createdByType, &out.createdByID, &out.createdAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "asset binding not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update asset")
		return
	}
	if req.Links != nil {
		if errMsg := h.replaceAssetLinks(ctx, tx, out.id, project.WorkspaceID, createdBy, *req.Links); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
	}
	links, err := h.fetchAssetLinks(ctx, tx, out.id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load asset links")
		return
	}
	// 阶段/标签变化回写档案行（stage/doc_type 按五阶段唯一映射，同事务；
	// 失败整体回滚，不允许接口成功但两侧分叉）。
	if err := h.syncAssetToArchive(ctx, tx, out); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to sync asset into archive")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update asset")
		return
	}

	resp := out.toResponse()
	resp.Links = links
	h.publish(protocol.EventAssetUpdated, uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"binding": resp, "project_id": uuidToString(project.ID)})
	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// 批量打标（POST /api/projects/{id}/assets/batch-meta）
// ---------------------------------------------------------------------------

// batchUpdateAssetMetaRequest 对一批 binding 应用同一套 patch：指针字段 nil=不动、
// ""=清除（分类除外，分类 NOT NULL 只接受枚举值）；tags_mode 控制标签写法。
type batchUpdateAssetMetaRequest struct {
	BindingIDs     []string  `json:"binding_ids"`
	LifecycleStage *string   `json:"lifecycle_stage"`
	AssetRole      *string   `json:"asset_role"`
	AssetCategory  *string   `json:"asset_category"`
	Tags           *[]string `json:"tags"`
	TagsMode       string    `json:"tags_mode"` // replace(默认) | add | remove
}

// batchMetaPlan 是校验 + 归一后的「要改哪些列」中间态，与 SQL 占位符编号解耦，便于单测。
type batchMetaPlan struct {
	setStage    pgtype.Text
	hasStage    bool
	setRole     pgtype.Text
	hasRole     bool
	setCategory string
	hasCategory bool
	setTags     []string
	hasTags     bool
	tagsMode    string
}

// planBatchAssetMeta 校验枚举与标签模式，产出可直接拼 SQL 的计划；返回非空 errStr=400。
func planBatchAssetMeta(req batchUpdateAssetMetaRequest) (batchMetaPlan, string) {
	var plan batchMetaPlan
	if req.LifecycleStage != nil {
		v, errMsg := assetEnumText(*req.LifecycleStage, validAssetStages, "lifecycle_stage")
		if errMsg != "" {
			return plan, errMsg
		}
		plan.setStage, plan.hasStage = v, true
	}
	if req.AssetRole != nil {
		v, errMsg := assetEnumText(*req.AssetRole, validAssetRoles, "asset_role")
		if errMsg != "" {
			return plan, errMsg
		}
		plan.setRole, plan.hasRole = v, true
	}
	if req.AssetCategory != nil {
		c := strings.TrimSpace(*req.AssetCategory)
		if !validAssetCategories[c] {
			return plan, "asset_category is not a valid choice"
		}
		plan.setCategory, plan.hasCategory = c, true
	}
	if req.Tags != nil {
		mode := strings.TrimSpace(req.TagsMode)
		if mode == "" {
			mode = "replace"
		}
		switch mode {
		case "replace", "add", "remove":
		default:
			return plan, "tags_mode must be replace, add or remove"
		}
		plan.setTags, plan.hasTags, plan.tagsMode = normalizeAssetTags(*req.Tags), true, mode
	}
	return plan, ""
}

// hasAnyUpdate 判定计划是否至少改动一列（否则 400 nothing to update）。
func (p batchMetaPlan) hasAnyUpdate() bool {
	return p.hasStage || p.hasRole || p.hasCategory || p.hasTags
}

// BatchUpdateAssetMeta 处理 POST /api/projects/{id}/assets/batch-meta —— 事务内对同项目
// 一批 binding 批量改阶段/角色/分类/标签，逐行回写档案并单次广播。命中集用
// (id = ANY(uuid[]) AND workspace_id AND project_id) 限定，跨项目/越权的 id 自然被过滤掉。
func (h *Handler) BatchUpdateAssetMeta(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req batchUpdateAssetMetaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.BindingIDs) == 0 {
		writeError(w, http.StatusBadRequest, "binding_ids is required")
		return
	}
	plan, errMsg := planBatchAssetMeta(req)
	if errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}
	if !plan.hasAnyUpdate() {
		writeError(w, http.StatusBadRequest, "nothing to update")
		return
	}
	ids := make([]pgtype.UUID, 0, len(req.BindingIDs))
	for _, raw := range req.BindingIDs {
		u, err := util.ParseUUID(strings.TrimSpace(raw))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid binding_id")
			return
		}
		ids = append(ids, u)
	}

	// 拼 SET：$1=ids, $2=workspace, $3=project，其后为各列值。
	var sets []string
	args := []any{ids, project.WorkspaceID, project.ID}
	next := func(v any) string {
		s := "$" + strconv.Itoa(len(args)+1)
		args = append(args, v)
		return s
	}
	if plan.hasStage {
		sets = append(sets, "lifecycle_stage = "+next(plan.setStage))
	}
	if plan.hasRole {
		sets = append(sets, "asset_role = "+next(plan.setRole))
	}
	if plan.hasCategory {
		sets = append(sets, "asset_category = "+next(plan.setCategory))
	}
	if plan.hasTags {
		switch plan.tagsMode {
		case "add":
			sets = append(sets, "tags = ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || "+next(plan.setTags)+"::text[]))")
		case "remove":
			sets = append(sets, "tags = COALESCE((SELECT array_agg(e) FROM unnest(COALESCE(tags, '{}'::text[])) e WHERE e <> ALL("+next(plan.setTags)+"::text[])), '{}'::text[])")
		default:
			sets = append(sets, "tags = "+next(plan.setTags)+"::text[]")
		}
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update assets")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	query := `UPDATE project_asset_binding SET ` + strings.Join(sets, ", ") + `
WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND project_id = $3
RETURNING ` + assetBindingColumns
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update assets")
		return
	}
	var updated []assetBindingRow
	for rows.Next() {
		b, err := h.scanAssetBindingRow(rows.Scan)
		if err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan asset binding")
			return
		}
		updated = append(updated, b)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update assets")
		return
	}
	for i := range updated {
		// 逐行同步档案：任一行失败整体回滚，全部成功才提交和广播。
		if err := h.syncAssetToArchive(ctx, tx, updated[i]); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to sync assets into archive")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update assets")
		return
	}

	responses := make([]AssetBindingResponse, 0, len(updated))
	for i := range updated {
		responses = append(responses, updated[i].toResponse())
	}
	h.publish(protocol.EventAssetUpdated, uuidToString(project.WorkspaceID), "member", userID,
		map[string]any{"project_id": uuidToString(project.ID), "count": len(updated)})
	writeJSON(w, http.StatusOK, map[string]any{
		"updated":  len(updated),
		"bindings": responses,
	})
}

// AssetOverviewIssue 是关联选择器/矩阵行的工作项条目。multica 里需求与任务同为
// issue：顶层（parent_issue_id 为空）= 需求，有父项 = 任务；is_requirement 直接
// 下发该判别，供前端把候选分成「需求 / 任务」两区并分色。
type AssetOverviewIssue struct {
	ID            string  `json:"id"`
	Title         string  `json:"title"`
	Status        string  `json:"status"`
	ProjectID     *string `json:"project_id"`
	IsRequirement bool    `json:"is_requirement"`
}

// AssetOverviewResponse 是阶段矩阵/需求×资产视图的聚合面：全量 binding（含打标与
// 关联，不分页，上限 1000）+ 候选工作项（未关闭 ∪ 已被关联的）。矩阵在前端内存
// 分组计算，避免 N+1 往返；与分页列表面（服务端分页）互补不互斥。
type AssetOverviewResponse struct {
	Bindings []AssetBindingResponse `json:"bindings"`
	Issues   []AssetOverviewIssue   `json:"issues"`
}

// ListAssetOverview 处理 GET /api/assets/overview?projectId= 。
func (h *Handler) ListAssetOverview(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return
	}
	ctx := r.Context()
	conds := []string{"b.workspace_id = $1"}
	args := []any{wsUUID}
	if pid := strings.TrimSpace(r.URL.Query().Get("projectId")); pid != "" {
		pu, err := parseUUIDLoose(pid)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid projectId")
			return
		}
		args = append(args, pu)
		conds = append(conds, "b.project_id = $"+strconv.Itoa(len(args)))
	}
	where := strings.Join(conds, " AND ")

	rows, err := h.DB.Query(ctx, `SELECT
	b.id, b.workspace_id, b.project_id, b.issue_id, b.asset_category, b.resource_id,
	b.external_ref, b.asset_name, b.asset_subtype, b.source, b.recommended, b.recommend_reason,
	b.lifecycle_stage, b.asset_role, b.tags, b.created_by_type, b.created_by_id, b.created_at,
	COALESCE(lk.links, '[]'::jsonb) AS links
FROM project_asset_binding b
LEFT JOIN LATERAL (
	SELECT jsonb_agg(jsonb_build_object('issue_id', l.issue_id, 'link_type', l.link_type)
		ORDER BY l.created_at) AS links
	FROM asset_issue_link l WHERE l.asset_binding_id = b.id
) lk ON TRUE
WHERE `+where+`
ORDER BY b.created_at DESC
LIMIT 1000`, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list asset overview")
		return
	}
	defer rows.Close()
	bindings := []AssetBindingResponse{}
	for rows.Next() {
		var a assetBindingRow
		var linksJSON []byte
		if err := rows.Scan(&a.id, &a.workspaceID, &a.projectID, &a.issueID, &a.assetCategory,
			&a.resourceID, &a.externalRef, &a.assetName, &a.assetSubtype, &a.source,
			&a.recommended, &a.recommendReason, &a.lifecycleStage, &a.assetRole, &a.tags,
			&a.createdByType, &a.createdByID, &a.createdAt, &linksJSON); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to list asset overview")
			return
		}
		resp := a.toResponse()
		if len(linksJSON) > 0 {
			var links []AssetIssueLink
			if err := json.Unmarshal(linksJSON, &links); err == nil && links != nil {
				resp.Links = links
			}
		}
		bindings = append(bindings, resp)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list asset overview")
		return
	}

	// 候选工作项：编辑面要求「展示全部的任务和需求」——不再按未关闭/已关联收窄，
	// 全量下发同 workspace（+可选 project）的 issue；顶层在前供分区渲染，上限 800。
	iconds := []string{"i.workspace_id = $1"}
	iargs := []any{wsUUID}
	if pid := strings.TrimSpace(r.URL.Query().Get("projectId")); pid != "" {
		pu, _ := parseUUIDLoose(pid)
		iargs = append(iargs, pu)
		iconds = append(iconds, "i.project_id = $"+strconv.Itoa(len(iargs)))
	}
	irows, err := h.DB.Query(ctx, `SELECT i.id, i.title, i.status, i.project_id,
	(i.parent_issue_id IS NULL) AS is_requirement FROM issue i
WHERE `+strings.Join(iconds, " AND ")+`
ORDER BY is_requirement DESC, i.updated_at DESC
LIMIT 800`, iargs...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list asset overview issues")
		return
	}
	defer irows.Close()
	issues := []AssetOverviewIssue{}
	for irows.Next() {
		var id, projectID pgtype.UUID
		var title, status string
		var isRequirement bool
		if err := irows.Scan(&id, &title, &status, &projectID, &isRequirement); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to list asset overview issues")
			return
		}
		issues = append(issues, AssetOverviewIssue{
			ID: uuidToString(id), Title: title, Status: status, ProjectID: uuidToPtr(projectID),
			IsRequirement: isRequirement,
		})
	}
	writeJSON(w, http.StatusOK, AssetOverviewResponse{Bindings: bindings, Issues: issues})
}
