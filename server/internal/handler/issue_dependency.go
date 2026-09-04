package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// IssueDependencyItem 是 GET/PUT /issues/{id}/dependencies 的响应元素：
// 一个前置 issue 的投影（状态供前端渲染阻塞来源）。
type IssueDependencyItem struct {
	IssueID string `json:"issue_id"`
	Title   string `json:"title"`
	Status  string `json:"status"` // 原始 status key；前端用 catalog 映射 category
}

// PutIssueDependenciesRequest 是 PUT 的请求体。PUT 为全量置换语义：
// 传空数组即清空全部前置。
type PutIssueDependenciesRequest struct {
	DependsOn []string `json:"depends_on"`
}

// GetIssueDependencies handles GET /api/issues/{id}/dependencies.
func (h *Handler) GetIssueDependencies(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.Queries.ListIssueDependencies(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]IssueDependencyItem, 0, len(rows))
	for _, row := range rows {
		out = append(out, IssueDependencyItem{
			IssueID: uuidToString(row.DependsOnIssueID),
			Title:   row.Title,
			Status:  row.Status,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// PutIssueDependencies handles PUT /api/issues/{id}/dependencies.
// 全量置换；校验（spec §3/§6）：
//   - 依赖双方必须同模块（且双方都必须挂模块）——跨模块的串行由「避免冲突」
//     锁表达，依赖 DAG 只刻画同模块内的顺序；
//   - 写入前 DFS 防环，违反 409。
func (h *Handler) PutIssueDependencies(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var req PutIssueDependenciesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ctx := r.Context()

	// 去重 + 解析；重复 id 在置换语义下无意义，静默收敛避免主键冲突。
	seen := map[pgtype.UUID]bool{}
	depIDs := make([]pgtype.UUID, 0, len(req.DependsOn))
	for _, s := range req.DependsOn {
		depUUID, ok := parseUUIDOrBadRequest(w, s, "depends_on")
		if !ok {
			return
		}
		if seen[depUUID] {
			continue
		}
		seen[depUUID] = true
		depIDs = append(depIDs, depUUID)
	}

	if len(depIDs) > 0 {
		if !issue.ModuleID.Valid {
			writeError(w, http.StatusConflict, "issue without a module cannot have dependencies")
			return
		}
		// 同模块校验：双方 module_id 相同且非空。模块唯一属于一个项目
		// （Task 4 不变式），同模块即同项目同工作区，无需再查工作区。
		rows, err := h.Queries.GetIssuesModuleIDs(ctx, depIDs)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if len(rows) != len(depIDs) {
			writeError(w, http.StatusBadRequest, "unknown dependency issue")
			return
		}
		for _, row := range rows {
			if !row.ModuleID.Valid || row.ModuleID != issue.ModuleID {
				writeError(w, http.StatusConflict, "dependencies must be in the same module")
				return
			}
		}

		// 防环：加入新边 self→dep 后，若从 dep 沿既有「issue→其前置」边能
		// 回到 self 则成环。自依赖（dep == self）也被这条规则天然覆盖。
		edges, err := h.Queries.ListDependencyEdgesForProject(ctx, issue.ProjectID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		adj := map[pgtype.UUID][]pgtype.UUID{}
		for _, e := range edges {
			adj[e.IssueID] = append(adj[e.IssueID], e.DependsOnIssueID)
		}
		for _, depID := range depIDs {
			if reachesTarget(adj, depID, issue.ID) {
				writeError(w, http.StatusConflict, "dependency cycle detected")
				return
			}
		}
	}

	if h.TxStarter == nil {
		writeError(w, http.StatusInternalServerError, "dependency update requires transaction starter")
		return
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	if err := qtx.DeleteIssueDependencies(ctx, issue.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, depID := range depIDs {
		if err := qtx.InsertIssueDependency(ctx, db.InsertIssueDependencyParams{
			IssueID:          issue.ID,
			DependsOnIssueID: depID,
		}); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	h.GetIssueDependencies(w, r) // 复用 GET 输出置换后的最新列表
}

// reachesTarget 沿「issue → 其前置」边 DFS，判断 from 是否能到达 target。
func reachesTarget(adj map[pgtype.UUID][]pgtype.UUID, from, target pgtype.UUID) bool {
	seen := map[pgtype.UUID]bool{}
	stack := []pgtype.UUID{from}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if n == target {
			return true
		}
		if seen[n] {
			continue
		}
		seen[n] = true
		stack = append(stack, adj[n]...)
	}
	return false
}
