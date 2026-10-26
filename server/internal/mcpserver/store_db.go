// project_asset_binding 的只读 DB Store（plan 101 P2）。
//
// 刻意不 import pgx：只依赖一个最小 Querier 接口，装配时由 router.go 传入 *pgxpool.Pool
// 的适配器。这样本模块可被 fake 驱动单测，也不把驱动细节耦合进门面。
// 只读语义：绝不写库；scope 由鉴权中间件注入，SQL 恒定按 workspace/project/issue 过滤，
// 跨租户资产无法被读出。
package mcpserver

import (
	"context"
	"encoding/json"
)

// Querier 是最小查询抽象（兼容 pgxpool.Pool / pgx.Conn）。
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (Rows, error)
}

// Rows 是最小行游标抽象（兼容 pgx.Rows）。
type Rows interface {
	Next() bool
	Scan(dest ...any) error
	Close()
	Err() error
}

// DBStore 用原生 SQL 读 project_asset_binding（471/473）。
type DBStore struct {
	q Querier
}

// NewDBStore 构造 DB Store。q 为 nil 时各方法返回空结果（安全降级）。
func NewDBStore(q Querier) *DBStore { return &DBStore{q: q} }

const assetSelect = `
SELECT id::text, asset_name, asset_category,
       COALESCE(lifecycle_stage, ''), COALESCE(asset_role, ''),
       COALESCE(tags, '{}')
FROM project_asset_binding
WHERE workspace_id = $1::uuid AND project_id = $2::uuid
  AND ($3::uuid IS NULL OR issue_id = $3::uuid)`

func (s *DBStore) ListAssets(ctx context.Context, scope Scope) ([]AssetView, error) {
	return s.queryAssets(ctx, assetSelect, scope, "")
}

func (s *DBStore) SearchAssets(ctx context.Context, scope Scope, query string) ([]AssetView, error) {
	sql := assetSelect + ` AND (asset_name ILIKE '%'||$4||'%' OR $4 = '')`
	return s.queryAssets(ctx, sql, scope, query)
}

func (s *DBStore) queryAssets(ctx context.Context, sql string, scope Scope, like string) ([]AssetView, error) {
	out := []AssetView{}
	if s.q == nil {
		return out, nil
	}
	issueArg := scopeIssueArg(scope)
	rows, err := s.q.Query(ctx, sql, scope.WorkspaceID, scope.ProjectID, issueArg, like)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v AssetView
		var tags []string
		if err := rows.Scan(&v.ID, &v.Name, &v.Category, &v.LifecycleStage, &v.AssetRole, &tags); err != nil {
			return nil, err
		}
		v.Tags = tags
		out = append(out, v)
	}
	return out, rows.Err()
}

// scopeIssueArg 把空 issue_id 归一为 nil（避免 ''::uuid 报错），非空原样传。
func scopeIssueArg(scope Scope) any {
	if scope.IssueID == "" {
		return nil
	}
	return scope.IssueID
}

// GetAsset 返回单条资产目录投影 + external_ref 指针；正文 blob（project_artifact）
// 的解析联查属 asset_document 下一迭代（06 号文档），此处先给出可读的资产指针与元信息。
func (s *DBStore) GetAsset(ctx context.Context, scope Scope, bindingID string) (AssetDetail, error) {
	if s.q == nil {
		return AssetDetail{}, nil
	}
	const sql = `
SELECT id::text, asset_name, asset_category,
       COALESCE(lifecycle_stage,''), COALESCE(asset_role,''), COALESCE(tags,'{}'),
       COALESCE(external_ref,'{}'::jsonb), COALESCE(resource_id::text,'')
FROM project_asset_binding
WHERE id = $1::uuid AND workspace_id = $2::uuid AND project_id = $3::uuid
  AND ($4::uuid IS NULL OR issue_id = $4::uuid OR issue_id IS NULL)`
	issueArg := scopeIssueArg(scope)
	rows, err := s.q.Query(ctx, sql, bindingID, scope.WorkspaceID, scope.ProjectID, issueArg)
	if err != nil {
		return AssetDetail{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return AssetDetail{}, nil // 未命中/越权：空返回
	}
	var d AssetDetail
	var tags []string
	var ext []byte
	var resourceID string
	if err := rows.Scan(&d.ID, &d.Name, &d.Category, &d.LifecycleStage, &d.AssetRole, &tags, &ext, &resourceID); err != nil {
		return AssetDetail{}, err
	}
	d.Tags = tags
	d.ExternalRef = json.RawMessage(ext)
	d.ContentSource = resourceID
	return d, rows.Err()
}
