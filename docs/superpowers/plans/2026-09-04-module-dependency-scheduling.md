# 模块 + 依赖调度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 multica 引入「模块（Module）」与「依赖（Dependency）」：同模块任务按依赖 DAG 拓扑执行、无依赖并发；跨模块默认互不阻塞，勾选「避免冲突」后按模块互斥；废弃目录级强制互斥（保留 prepare 窗口短锁）。

**Architecture:** server 端在 `ClaimAgentTask` 加依赖闸门（前置全部 `done` 才放行，用 `issue_effective_status` 判定）；daemon 端新增 `ModuleLocker`（total/exclusive 双计数读写模型）取代 `LocalPathLocker` 的全生命周期互斥，per-路径短锁收缩到 prepare 写入窗口；前端 packages/core + packages/views 增加模块管理、徽章、过滤与依赖配置 UI。

**Tech Stack:** Go（chi / sqlc / pgx v5）、PostgreSQL migrations（golang-migrate，`server/cmd/migrate`）、React + TypeScript（pnpm + turbo monorepo，vitest）。

**Spec:** `docs/superpowers/specs/2026-09-04-module-dependency-scheduling-design.md`（含原型 `2026-09-04-module-dependency-scheduling-prototype.html`）

**术语定稿：** 模块 / Module（曾用名「场景/Scene」，已全量改名）。表 `project_module`、列 `issue.module_id` / `issue.avoid_conflict`、锁 `ModuleLocker`、状态 `waiting_module_lock`、API `/api/projects/{id}/modules`。

---

## File Structure

| 动作 | 文件 | 职责 |
| --- | --- | --- |
| Create | `server/migrations/451_module_dependency_scheduling.{up,down}.sql` | project_module 表、issue 两列、issue_dependency 约束、队列状态 CHECK |
| Create | `server/pkg/db/queries/module.sql` | 模块 CRUD、依赖读写、模块信息投影查询 |
| Modify | `server/pkg/db/queries/agent.sql` | ClaimAgentTask 依赖闸门 + waiting_module_lock 纳入活跃集；StartAgentTask / CountRunningTasks 同步；新增 MarkAgentTaskWaitingModuleLock |
| Regen | `server/pkg/db/generated/` | `sqlc generate` 产物 |
| Create | `server/internal/handler/project_module.go` + `_test.go` | 模块 CRUD API |
| Create | `server/internal/handler/issue_dependency.go` + `_test.go` | 依赖 PUT/GET API（同模块校验 + DFS 防环） |
| Modify | `server/internal/handler/issue.go`（UpdateIssue，L3331） | module_id / avoid_conflict 字段与校验 |
| Modify | `server/internal/handler/agent.go`（AgentTaskResponse，L342） | claim payload 三个模块字段 |
| Modify | `server/internal/handler/daemon.go`（buildClaimedTaskResponse L2049；MarkTaskWaiting* L3641 旁） | claim 投影组装 + wait-module-lock handler |
| Modify | `server/internal/service/task.go`（L4192 旁） | MarkTaskWaitingModuleLock service |
| Modify | `server/pkg/protocol/events.go`（L37 旁） | EventTaskWaitingModuleLock |
| Modify | `server/cmd/server/router.go`（L1469、L1969-1982） | 新路由注册 |
| Create | `server/internal/daemon/module_locker.go` + `_test.go` | ModuleLocker 双计数锁 |
| Modify | `server/internal/daemon/types.go`（Task，L70） | ModuleID / ModuleName / AvoidConflict |
| Modify | `server/internal/daemon/daemon.go`（L5391、L7640） | 模块锁接线 + prepare 短锁 |
| Modify | `server/internal/daemon/client.go`（L421 旁） | MarkTaskWaitingModuleLock 客户端方法 |
| Modify | `packages/core/types/issue.ts`（L160）、`types/api.ts`（L50） | Issue / UpdateIssueRequest 扩展 + ProjectModule / IssueDependency 类型 |
| Modify | `packages/core/api/client.ts`（L1200 旁） | 模块与依赖 API client |
| Create | `packages/views/issues/components/module-badge.tsx` | 模块徽章（色点+名称+盾牌） |
| Create | `packages/views/issues/components/module-filter-bar.tsx` | 看板模块过滤条 |
| Create | `packages/views/issues/components/pickers/module-picker.tsx` | 模块单选 picker（可就地新建） |
| Create | `packages/views/issues/components/pickers/dependency-picker.tsx` | 前置依赖多选 picker（仅同模块、防环提示） |
| Create | `packages/views/projects/components/project-modules-section.tsx` | 项目详情内模块管理 section |
| Modify | `packages/views/modals/create-issue.tsx` | 模块下拉 + 避免冲突勾选 + 依赖多选 |
| Modify | `packages/views/issues/components/issue-detail.tsx` | 依赖区块 + 阻塞提示 |
| Modify | `packages/views/issues/components/board-card.tsx` | 卡片模块徽章 |
| Modify | `packages/views/issues/components/task-run-labels.ts`（L48） | waiting_module_lock 状态标签 |
| Modify | `packages/views/issues/surface/activity.ts`（L25） | waiting_module_lock 归入排队态 |
| Modify | `packages/views/locales/{en,zh-Hans,ja,ko}/{issues,agents,chat}.json` | 四语言文案 |

---

### Task 1: migration 451 —— project_module 表、issue 扩展、队列新状态

**Files:**
- Create: `server/migrations/451_module_dependency_scheduling.up.sql`
- Create: `server/migrations/451_module_dependency_scheduling.down.sql`

- [ ] **Step 1: 写 up migration**

```sql
-- ① 模块表：项目下的轻量单选枚举（项目即产品，模块即产品模块）
CREATE TABLE project_module (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    color        TEXT NOT NULL DEFAULT '#8A8F98',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

-- ② issue 扩展：模块单选 + 跨模块避免冲突开关
ALTER TABLE issue
    ADD COLUMN module_id UUID REFERENCES project_module(id) ON DELETE SET NULL,
    ADD COLUMN avoid_conflict BOOLEAN NOT NULL DEFAULT false;

-- ③ 激活存量 issue_dependency 表（migration 001 建表后从未接线）
ALTER TABLE issue_dependency
    ADD CONSTRAINT uq_issue_dependency UNIQUE (issue_id, depends_on_issue_id),
    ADD CONSTRAINT no_self_dependency CHECK (issue_id <> depends_on_issue_id);
-- 依赖记录统一写 type = 'blocked_by'；'blocks' / 'related' 不在本期范围。

-- ④ 任务队列新状态 waiting_module_lock
ALTER TABLE agent_task_queue DROP CONSTRAINT agent_task_queue_status_check;
ALTER TABLE agent_task_queue ADD CONSTRAINT agent_task_queue_status_check
    CHECK (status IN ('queued','dispatched','running','waiting_local_directory',
                      'waiting_module_lock','deferred','completed','failed','cancelled'));
```

- [ ] **Step 2: 写 down migration（注意顺序与存量行）**

```sql
-- 先把处于新状态的任务退回 dispatched，否则恢复的 CHECK 会拒绝存量行
UPDATE agent_task_queue SET status = 'dispatched' WHERE status = 'waiting_module_lock';

ALTER TABLE agent_task_queue DROP CONSTRAINT agent_task_queue_status_check;
ALTER TABLE agent_task_queue ADD CONSTRAINT agent_task_queue_status_check
    CHECK (status IN ('queued','dispatched','running','waiting_local_directory',
                      'deferred','completed','failed','cancelled'));

ALTER TABLE issue DROP COLUMN module_id, DROP COLUMN avoid_conflict;
ALTER TABLE issue_dependency DROP CONSTRAINT uq_issue_dependency,
    DROP CONSTRAINT no_self_dependency;
DROP TABLE project_module;
```

- [ ] **Step 3: 跑迁移测试验证 up/down**

Run: `cd server && go test ./cmd/migrate/ -v -count=1`
Expected: PASS（迁移测试会把全部 migration 应用到测试库；451 语法错误会在此暴露）

- [ ] **Step 4: Commit**

```bash
git add server/migrations/451_module_dependency_scheduling.up.sql server/migrations/451_module_dependency_scheduling.down.sql
git commit -m "feat(server): migration 451 project_module + issue module fields + waiting_module_lock"
```

---

### Task 2: sqlc 查询 —— module.sql（模块 CRUD + 依赖读写 + 投影）

**Files:**
- Create: `server/pkg/db/queries/module.sql`
- Regen: `server/pkg/db/generated/`（sqlc generate）

- [ ] **Step 1: 写 module.sql**

```sql
-- name: ListProjectModules :many
SELECT * FROM project_module WHERE project_id = $1 ORDER BY created_at ASC;

-- name: CreateProjectModule :one
INSERT INTO project_module (project_id, workspace_id, name, color)
VALUES (@project_id, @workspace_id, @name, @color)
RETURNING *;

-- name: GetProjectModule :one
SELECT * FROM project_module WHERE id = $1;

-- name: UpdateProjectModule :one
-- 全字段写回（handler 先读旧值做合并）；UNIQUE(project_id, name) 冲突由 handler 转 409。
UPDATE project_module SET name = @name, color = @color WHERE id = @id RETURNING *;

-- name: DeleteProjectModule :exec
-- issue.module_id 经 FK ON DELETE SET NULL 自动回落为无模块。
DELETE FROM project_module WHERE id = $1;

-- name: GetIssueModuleInfo :one
-- claim 投影：模块 id/名称 + 避免冲突标志。无模块时 module_id/module_name 为 NULL。
SELECT i.module_id, i.avoid_conflict, m.name AS module_name
FROM issue i
LEFT JOIN project_module m ON m.id = i.module_id
WHERE i.id = $1;

-- name: ListIssueDependencies :many
-- 任务的前置列表（含各前置状态，供详情页渲染阻塞来源）。
SELECT d.depends_on_issue_id, pre.title, pre.status, pre.workspace_id
FROM issue_dependency d
JOIN issue pre ON pre.id = d.depends_on_issue_id
WHERE d.issue_id = $1 AND d.type = 'blocked_by'
ORDER BY d.depends_on_issue_id ASC;

-- name: DeleteIssueDependencies :exec
-- 全量置换语义的第一步：清空本任务的 blocked_by 边（在同一事务内配合插入）。
DELETE FROM issue_dependency WHERE issue_id = $1 AND type = 'blocked_by';

-- name: InsertIssueDependency :exec
INSERT INTO issue_dependency (issue_id, depends_on_issue_id, type)
VALUES (@issue_id, @depends_on_issue_id, 'blocked_by');

-- name: ListDependencyEdgesForProject :many
-- 拉取项目内全部 blocked_by 边，供写入时 DFS 防环。
SELECT d.issue_id, d.depends_on_issue_id
FROM issue_dependency d
JOIN issue i ON i.id = d.issue_id
WHERE i.project_id = $1 AND d.type = 'blocked_by';

-- name: GetIssuesModuleIDs :many
-- 批量取 issue 的模块归属，用于「依赖双方必须同模块」校验。
SELECT id, module_id FROM issue WHERE id = ANY(@issue_ids::uuid[]);
```

- [ ] **Step 2: sqlc generate**

Run: `cd server && sqlc generate`（若无 sqlc：`go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest`）
Expected: 无输出即成功；`pkg/db/generated/module.sql.go` 出现

- [ ] **Step 3: 编译验证**

Run: `cd server && go build ./...`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add server/pkg/db/queries/module.sql server/pkg/db/generated/
git commit -m "feat(server): sqlc queries for project modules and issue dependencies"
```

---

### Task 3: 模块 CRUD API

**Files:**
- Create: `server/internal/handler/project_module.go`
- Create: `server/internal/handler/project_module_test.go`
- Modify: `server/cmd/server/router.go:1969-1982`（projects 块内加子路由）

- [ ] **Step 1: 写失败测试**（模式照抄 `project_resource_test.go` 的 `newRequest` / `withURLParam` 帮手）

```go
package handler

import (
	"net/http"
	"testing"
)

func TestProjectModuleCRUD(t *testing.T) {
	// 创建项目 → POST modules 创建模块 → GET 列表含该模块 →
	// PATCH 改名 → DELETE 删除后列表为空
	project := createTestProject(t) // 复用 project_resource_test.go 内现有帮手；若名为 createProjectForTest 则以它为准

	createReq := newRequest("POST", "/api/projects/"+project.ID+"/modules", map[string]any{
		"name": "内核与配置", "color": "#5B7FFF",
	})
	createReq = withURLParam(createReq, "id", project.ID)
	createRec := serveRequest(createReq) // 同上，以测试文件现有帮手名为准
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create module: got %d", createRec.Code)
	}

	// 项目内重名 → 409
	dupReq := withURLParam(newRequest("POST", "/api/projects/"+project.ID+"/modules", map[string]any{
		"name": "内核与配置",
	}), "id", project.ID)
	if rec := serveRequest(dupReq); rec.Code != http.StatusConflict {
		t.Fatalf("duplicate name: got %d, want 409", rec.Code)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/handler/ -run TestProjectModuleCRUD -v`
Expected: FAIL —— 404（路由未注册）

- [ ] **Step 3: 实现 handler（`project_module.go`，结构对齐 `project_resource.go`）**

```go
package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type ProjectModuleResponse struct {
	ID          string `json:"id"`
	ProjectID   string `json:"project_id"`
	WorkspaceID string `json:"workspace_id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	CreatedAt   string `json:"created_at"`
}

func projectModuleToResponse(m db.ProjectModule) ProjectModuleResponse {
	return ProjectModuleResponse{
		ID:          uuidToString(m.ID),
		ProjectID:   uuidToString(m.ProjectID),
		WorkspaceID: uuidToString(m.WorkspaceID),
		Name:        m.Name,
		Color:       m.Color,
		CreatedAt:   timestampToString(m.CreatedAt),
	}
}

type CreateProjectModuleRequest struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

type UpdateProjectModuleRequest struct {
	Name  *string `json:"name"`
	Color *string `json:"color"`
}

// ListProjectModules handles GET /api/projects/{id}/modules.
func (h *Handler) ListProjectModules(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	// 权限校验复用 project_resource.go 中 GET resources 的同款检查
	//（requireProjectAccess 或等价帮手，以该文件实际函数名为准）
	mods, err := h.Queries.ListProjectModules(r.Context(), parseUUID(projectID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]ProjectModuleResponse, 0, len(mods))
	for _, m := range mods {
		out = append(out, projectModuleToResponse(m))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateProjectModule handles POST /api/projects/{id}/modules.
// name 项目内唯一；违反 UNIQUE(project_id, name) → 409。
func (h *Handler) CreateProjectModule(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	var req CreateProjectModuleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.Color == "" {
		req.Color = "#8A8F98"
	}
	// 查项目拿 workspace_id（复用 GetProject 查询），再插入
	project, err := h.Queries.GetProject(r.Context(), parseUUID(projectID))
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	m, err := h.Queries.CreateProjectModule(r.Context(), db.CreateProjectModuleParams{
		ProjectID:   parseUUID(projectID),
		WorkspaceID: project.WorkspaceID,
		Name:        req.Name,
		Color:       req.Color,
	})
	if err != nil {
		if isUniqueViolation(err) { // 若 handler 包内无此帮手，用 strings.Contains(err.Error(), "unique") 或 pgconn.PgError.Code == "23505"
			writeError(w, http.StatusConflict, "module name already exists in this project")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, projectModuleToResponse(m))
}

// UpdateProjectModule handles PATCH /api/projects/{id}/modules/{moduleId}。
// 先读旧值合并再全字段写回；重名 → 409。
// DeleteProjectModule handles DELETE /api/projects/{id}/modules/{moduleId}；
// issue.module_id 由 FK ON DELETE SET NULL 级联清空，依赖边不受模块删除影响
//（依赖仅同模块可配，模块删除后相关任务变为无模块、其依赖边由 Task 5 的
// GET 过滤自然失效——见该任务说明）。
```

- [ ] **Step 4: 注册路由（`router.go` projects 块，`resources` 四行之后追加）**

```go
r.Get("/modules", h.ListProjectModules)
r.Post("/modules", h.CreateProjectModule)
r.Patch("/modules/{moduleId}", h.UpdateProjectModule)
r.Delete("/modules/{moduleId}", h.DeleteProjectModule)
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && go test ./internal/handler/ -run TestProjectModule -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/internal/handler/project_module.go server/internal/handler/project_module_test.go server/cmd/server/router.go
git commit -m "feat(server): project module CRUD API"
```

---

### Task 4: issue 字段扩展 —— module_id / avoid_conflict

**Files:**
- Modify: `server/internal/handler/issue.go:3331`（UpdateIssue）
- Modify: `server/internal/service/issue.go`（UpdateIssue 的 service 实现，字段透传 + 校验；以实际文件名为准）
- Test: `server/internal/handler/issue_test.go`（或现有 update 测试文件）

- [ ] **Step 1: 写失败测试**

```go
func TestUpdateIssueModuleFields(t *testing.T) {
	// 准备：项目 P、模块 M（属于 P）、模块 Other（属于另一项目 P2）、issue I（属于 P）
	// 1) PATCH I {module_id: M.id, avoid_conflict: true} → 200，响应含 module_id/avoid_conflict
	// 2) PATCH I {module_id: Other.id} → 409（模块必须属于 issue 所在项目）
	// 3) PATCH I {module_id: null} → 200，module_id 清空（无模块）
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/handler/ -run TestUpdateIssueModuleFields -v`
Expected: FAIL —— 响应不含 module_id 字段（未知字段被忽略）

- [ ] **Step 3: 实现**

UpdateIssueRequest（server 侧结构体，issue.go 内）增加：

```go
ModuleID      *string `json:"module_id"`      // "" 或省略=不动；显式 null 语义用 "clear" 约定见下
AvoidConflict *bool   `json:"avoid_conflict"`
```

校验逻辑（service 层，写库前）：

```go
if req.ModuleID != nil && *req.ModuleID != "" {
    mod, err := s.Queries.GetProjectModule(ctx, parseUUID(*req.ModuleID))
    if err != nil || mod.ProjectID != issue.ProjectID {
        return nil, errModuleProjectMismatch // handler 转 409 "module must belong to the issue's project"
    }
}
// avoid_conflict=true 但 module_id 为空 → 允许（字段静默无效，daemon 对无模块任务不取锁，
// 与 spec §5「无模块不取锁」一致），不额外报错。
```

Update 查询：`issue` 的 UPDATE 走现有 sqlc UpdateIssue（需在对应 .sql 的 SET 列表加 `module_id`、`avoid_conflict` 两个 sqlc.narg 可空参数后重新 `sqlc generate`）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd server && sqlc generate && go test ./internal/handler/ -run 'TestUpdateIssue' -v && go build ./...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/internal/handler/issue.go server/internal/service/ server/pkg/db/
git commit -m "feat(server): issue module_id and avoid_conflict fields"
```

---

### Task 5: 依赖 API —— PUT/GET /issues/{id}/dependencies

**Files:**
- Create: `server/internal/handler/issue_dependency.go`
- Create: `server/internal/handler/issue_dependency_test.go`
- Modify: `server/cmd/server/router.go:1865`（/api/issues 块）

- [ ] **Step 1: 写失败测试**

```go
func TestIssueDependencies(t *testing.T) {
	// 准备：项目 P、模块 M、同模块 issue A/B/C、异模块 issue X、无模块 issue N
	// 1) PUT A.dependencies [B] → 200；GET A.dependencies → 含 B（带 status）
	// 2) PUT A.dependencies [X] → 409 "dependencies must be in the same module"
	// 3) PUT N.dependencies [B] → 409（无模块任务不支持配置依赖）
	// 4) PUT B.dependencies [A] 后 PUT A.dependencies [B] → 409 "dependency cycle"
	// 5) PUT A.dependencies [] → 200 清空（全量置换语义）
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/handler/ -run TestIssueDependencies -v`
Expected: FAIL —— 404

- [ ] **Step 3: 实现 `issue_dependency.go`**

```go
package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type IssueDependencyItem struct {
	IssueID string `json:"issue_id"`
	Title   string `json:"title"`
	Status  string `json:"status"` // 原始 status key；前端用 catalog 映射 category
}

type PutIssueDependenciesRequest struct {
	DependsOn []string `json:"depends_on"` // 前置 issue id 全量列表（置换语义）
}

// GetIssueDependencies handles GET /api/issues/{id}/dependencies
func (h *Handler) GetIssueDependencies(w http.ResponseWriter, r *http.Request) {
	issueID := chi.URLParam(r, "id")
	rows, err := h.Queries.ListIssueDependencies(r.Context(), parseUUID(issueID))
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

// PutIssueDependencies handles PUT /api/issues/{id}/dependencies
// 全量置换；校验：同模块（双方 module_id 相同且非空）+ 防环（DFS），违反 409。
func (h *Handler) PutIssueDependencies(w http.ResponseWriter, r *http.Request) {
	issueID := chi.URLParam(r, "id")
	var req PutIssueDependenciesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ctx := r.Context()
	issue, err := h.Queries.GetIssue(ctx, parseUUID(issueID)) // 以现有查询名为准
	if err != nil {
		writeError(w, http.StatusNotFound, "issue not found")
		return
	}
	if len(req.DependsOn) > 0 && !issue.ModuleID.Valid {
		writeError(w, http.StatusConflict, "issue without a module cannot have dependencies")
		return
	}

	// 同模块校验
	if len(req.DependsOn) > 0 {
		ids := make([]pgtype.UUID, 0, len(req.DependsOn))
		for _, s := range req.DependsOn {
			ids = append(ids, parseUUID(s))
		}
		rows, err := h.Queries.GetIssuesModuleIDs(ctx, db.GetIssuesModuleIDsParams{IssueIDs: ids /* 类型以 sqlc 生成为准 */})
		if err != nil || len(rows) != len(ids) {
			writeError(w, http.StatusBadRequest, "unknown dependency issue")
			return
		}
		for _, row := range rows {
			if !row.ModuleID.Valid || row.ModuleID != issue.ModuleID {
				writeError(w, http.StatusConflict, "dependencies must be in the same module")
				return
			}
		}
	}

	// 防环：加入新边后，从每个前置沿既有边 DFS，能回到本 issue 则成环
	edges, err := h.Queries.ListDependencyEdgesForProject(ctx, issue.ProjectID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	adj := map[pgtype.UUID][]pgtype.UUID{}
	for _, e := range edges {
		adj[e.IssueID] = append(adj[e.IssueID], e.DependsOnIssueID)
	}
	self := parseUUID(issueID)
	for _, s := range req.DependsOn {
		if reachesTarget(adj, parseUUID(s), self) {
			writeError(w, http.StatusConflict, "dependency cycle detected")
			return
		}
	}

	// 事务内置换（用 h.DB 的 Begin；句柄字段名以 Handler 实际持有的 pgxpool 为准）
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	if err := qtx.DeleteIssueDependencies(ctx, self); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, s := range req.DependsOn {
		if err := qtx.InsertIssueDependency(ctx, db.InsertIssueDependencyParams{
			IssueID:          self,
			DependsOnIssueID: parseUUID(s),
		}); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.GetIssueDependencies(w, r) // 复用 GET 输出最新列表
}

// reachesTarget：沿「issue → 其前置」边 DFS，判断 from 是否能到达 target。
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
```

- [ ] **Step 4: 注册路由（/api/issues 块内追加）**

```go
r.Get("/{id}/dependencies", h.GetIssueDependencies)
r.Put("/{id}/dependencies", h.PutIssueDependencies)
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && go test ./internal/handler/ -run TestIssueDependencies -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/internal/handler/issue_dependency.go server/internal/handler/issue_dependency_test.go server/cmd/server/router.go
git commit -m "feat(server): issue dependency PUT/GET API with same-module and cycle checks"
```

---

### Task 6: Claim 依赖闸门 + 模块投影

**Files:**
- Modify: `server/pkg/db/queries/agent.sql`（ClaimAgentTask L738-806；StartAgentTask L961；CountRunningTasks L1720 附近）
- Regen: `server/pkg/db/generated/`
- Modify: `server/internal/handler/agent.go:342`（AgentTaskResponse）
- Modify: `server/internal/handler/daemon.go:2049`（buildClaimedTaskResponse）
- Modify: `server/internal/daemon/types.go:70`（Task 镜像字段）
- Test: `server/internal/handler/daemon_test.go`（沿用 claimTaskRaw 帮手）

- [ ] **Step 1: 写失败测试**

```go
func TestClaimBlockedByDependency(t *testing.T) {
	// 准备：同模块 issue A（前置，status=in_progress）与 B（依赖 A），B 已有 queued 任务
	// claim → 返回 204/无任务（依赖未满足）
	// 把 A 置为 done（含自定义 done-category 状态各跑一遍）→ 再 claim → 拿到 B 的任务
	// 响应 JSON 含 module_id / module_name / avoid_conflict 三字段
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/handler/ -run TestClaimBlockedByDependency -v`
Expected: FAIL —— 依赖未满足时仍 claim 到任务

- [ ] **Step 3: 改 ClaimAgentTask（agent.sql L785 的 NOT EXISTS 之后追加闸门；L788 活跃状态集加 waiting_module_lock）**

```sql
      AND NOT EXISTS (
          SELECT 1 FROM agent_task_queue active
          WHERE active.agent_id = atq.agent_id
            AND active.status IN ('dispatched', 'running', 'waiting_local_directory', 'waiting_module_lock')
            AND ( ... 原有三个 OR 分支不变 ... )
      )
      -- 依赖闸门：前置 issue 全部达到 done（含自定义 done-category 状态）才可被领取。
      -- 用 issue_effective_status 而非裸 status 比较，custom done 状态否则永久阻塞。
      AND NOT EXISTS (
          SELECT 1
          FROM issue_dependency d
          JOIN issue pre ON pre.id = d.depends_on_issue_id
          WHERE d.issue_id = atq.issue_id
            AND d.type = 'blocked_by'
            AND issue_effective_status(pre.workspace_id, pre.status) <> 'done'
      )
```

同步修改：

```sql
-- StartAgentTask（L966）：允许从 waiting_module_lock 恢复 running
WHERE id = $1 AND status IN ('dispatched', 'waiting_local_directory', 'waiting_module_lock')

-- CountRunningTasks（L1720 附近）：waiting_module_lock 与 waiting_local_directory 同样占 agent 配额
-- 在原状态列表中追加 'waiting_module_lock'
```

- [ ] **Step 4: 模块投影 —— AgentTaskResponse 加字段 + buildClaimedTaskResponse 组装**

`agent.go` AgentTaskResponse 追加：

```go
// 模块调度投影（MUL-模块依赖）：claim 时实时取自 issue，不在任务表落快照，
// 编辑模块/勾选即时生效。旧 server 不下发时 daemon 视为无模块（安全退化）。
ModuleID      string `json:"module_id,omitempty"`
ModuleName    string `json:"module_name,omitempty"`
AvoidConflict bool   `json:"avoid_conflict,omitempty"`
```

`daemon.go` buildClaimedTaskResponse 在 issue 非空分支追加：

```go
if task.IssueID.Valid {
    if info, err := h.Queries.GetIssueModuleInfo(r.Context(), task.IssueID); err == nil {
        if info.ModuleID.Valid {
            resp.ModuleID = uuidToString(info.ModuleID)
            resp.ModuleName = info.ModuleName.String
        }
        resp.AvoidConflict = info.AvoidConflict
    }
}
```

`daemon/types.go` Task 镜像（omitempty，旧 server 不下发即空值=无模块）：

```go
ModuleID      string `json:"module_id,omitempty"`
ModuleName    string `json:"module_name,omitempty"`
AvoidConflict bool   `json:"avoid_conflict,omitempty"`
```

- [ ] **Step 5: sqlc generate + 跑测试确认通过**

Run: `cd server && sqlc generate && go build ./... && go test ./internal/handler/ -run 'TestClaim' -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/pkg/db/ server/internal/handler/ server/internal/daemon/types.go
git commit -m "feat(server): dependency gate in ClaimAgentTask + module projection in claim payload"
```

---

### Task 7: waiting_module_lock 上报管道

**Files:**
- Modify: `server/pkg/protocol/events.go:37`（旁加新事件）
- Modify: `server/pkg/db/queries/agent.sql:969`（旁加新查询）
- Modify: `server/internal/service/task.go:4192`（旁加 service 方法）
- Modify: `server/internal/handler/daemon.go:3641`（旁加 handler）
- Modify: `server/cmd/server/router.go:1469`（旁加路由）
- Modify: `server/internal/daemon/client.go:421`（旁加 client 方法）
- Test: `server/internal/service/task_test.go`（或对应现有文件）

- [ ] **Step 1: 写失败测试**

```go
func TestMarkTaskWaitingModuleLock(t *testing.T) {
	// dispatched 任务 → MarkTaskWaitingModuleLock("模块「内核与配置」") →
	// 行状态=waiting_module_lock、wait_reason 落库、广播事件 task:waiting_module_lock 带 wait_reason
	// 再 StartAgentTask → 可转 running（依赖 Task 6 的 WHERE 扩展）
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/service/ -run TestMarkTaskWaitingModuleLock -v`
Expected: FAIL —— 方法不存在（编译错误）

- [ ] **Step 3: 实现（六处全部镜像 waiting_local_directory 管道）**

`protocol/events.go`：

```go
EventTaskWaitingModuleLock = "task:waiting_module_lock" // dispatched → waiting_module_lock (daemon parked on a cross-module conflict-avoidance lock)
```

`agent.sql`（L984 后追加）：

```sql
-- name: MarkAgentTaskWaitingModuleLock :one
-- Transitions a freshly-dispatched task into 'waiting_module_lock' while the
-- daemon waits for a cross-module conflict-avoidance lock. Same transition
-- contract as MarkAgentTaskWaitingLocalDirectory.
UPDATE agent_task_queue
SET status = 'waiting_module_lock',
    wait_reason = $2,
    prepare_lease_expires_at = now() + make_interval(secs => @prepare_lease_secs::double precision)
WHERE id = $1 AND status = 'dispatched'
RETURNING *;
```

`service/task.go`（镜像 L4192，差异仅状态/事件名）：

```go
func (s *TaskService) MarkTaskWaitingModuleLock(ctx context.Context, taskID pgtype.UUID, reason string) (*db.AgentTaskQueue, error) {
	reason = sanitizeWaitReason(reason)
	task, err := s.Queries.MarkAgentTaskWaitingModuleLock(ctx, db.MarkAgentTaskWaitingModuleLockParams{
		ID:               taskID,
		WaitReason:       pgtype.Text{String: reason, Valid: reason != ""},
		PrepareLeaseSecs: prepareLeaseDuration.Seconds(),
	})
	if err != nil {
		return nil, fmt.Errorf("mark task waiting_module_lock: %w", err)
	}
	s.forgetTaskReclaim(task)
	slog.Info("task waiting_module_lock",
		"task_id", util.UUIDToString(task.ID),
		"issue_id", util.UUIDToString(task.IssueID),
		"reason", reason,
	)
	s.ReconcileAgentStatus(ctx, task.AgentID)
	extra := map[string]any{}
	if reason != "" {
		extra["wait_reason"] = reason
	}
	s.broadcastTaskEvent(ctx, protocol.EventTaskWaitingModuleLock, task, extra)
	return &task, nil
}
```

`handler/daemon.go`（镜像 L3641）：

```go
type TaskWaitModuleLockRequest struct {
	Reason string `json:"reason"`
}

func (h *Handler) MarkTaskWaitingModuleLock(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "taskId")
	_, workspaceID, ok := h.requireDaemonTaskAccessWithWorkspace(w, r, taskID)
	if !ok {
		return
	}
	var req TaskWaitModuleLockRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}
	task, err := h.TaskService.MarkTaskWaitingModuleLock(r.Context(), parseUUID(taskID), req.Reason)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, taskToResponse(*task, workspaceID))
}
```

`router.go`（L1469 旁）：

```go
r.Post("/tasks/{taskId}/wait-module-lock", h.MarkTaskWaitingModuleLock)
```

`daemon/client.go`（L425 后）：

```go
// MarkTaskWaitingModuleLock parks a freshly-dispatched task in the
// waiting_module_lock state on the server while the daemon waits for a
// cross-module conflict-avoidance lock. Same idempotency contract as
// MarkTaskWaitingLocalDirectory.
func (c *Client) MarkTaskWaitingModuleLock(ctx context.Context, taskID, reason string) error {
	return c.postJSON(ctx, fmt.Sprintf("/api/daemon/tasks/%s/wait-module-lock", taskID), map[string]any{
		"reason": reason,
	}, nil)
}
```

- [ ] **Step 4: sqlc generate + 跑测试确认通过**

Run: `cd server && sqlc generate && go build ./... && go test ./internal/service/ -run TestMarkTaskWaiting -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/pkg/protocol/events.go server/pkg/db/ server/internal/service/task.go server/internal/handler/daemon.go server/cmd/server/router.go server/internal/daemon/client.go
git commit -m "feat(server): waiting_module_lock reporting pipeline"
```

---

### Task 8: daemon ModuleLocker —— 双计数读写锁

**Files:**
- Create: `server/internal/daemon/module_locker.go`
- Test: `server/internal/daemon/module_locker_test.go`

- [ ] **Step 1: 写失败测试**

```go
package daemon

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestModuleLocker_SameModuleNeverBlocks(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "t1", true, nil) // 勾选方
	if err != nil { t.Fatal(err) }
	defer rel1()
	// 同模块再来一个（无论是否勾选）都应立即成功
	rel2, err := l.Acquire(context.Background(), "m1", "t2", false, nil)
	if err != nil { t.Fatal(err) }
	defer rel2()
}

func TestModuleLocker_ExclusiveBlocksOtherModules(t *testing.T) {
	l := NewModuleLocker()
	rel1, _ := l.Acquire(context.Background(), "m1", "t1", true, nil)
	defer rel1()
	// 异模块未勾选方被勾选方挡住
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	waited := false
	_, err := l.Acquire(ctx, "m2", "t2", false, func(string) { waited = true })
	if err == nil { t.Fatal("expected ctx deadline") }
	if !waited { t.Fatal("onWait not fired") }
}

func TestModuleLocker_SharedDoesNotBlockShared(t *testing.T) {
	l := NewModuleLocker()
	rel1, _ := l.Acquire(context.Background(), "m1", "t1", false, nil)
	defer rel1()
	// 异模块未勾选方：另一个未勾选方不构成阻塞
	rel2, err := l.Acquire(context.Background(), "m2", "t2", false, nil)
	if err != nil { t.Fatal(err) }
	defer rel2()
}

func TestModuleLocker_ExclusiveWaitsForSharedDrain(t *testing.T) {
	l := NewModuleLocker()
	rel1, _ := l.Acquire(context.Background(), "m1", "t1", false, nil)
	acquired := make(chan struct{})
	go func() {
		rel2, err := l.Acquire(context.Background(), "m2", "t2", true, nil)
		if err == nil { rel2(); close(acquired) }
	}()
	select {
	case <-acquired:
		t.Fatal("exclusive acquired while another module still active")
	case <-time.After(50 * time.Millisecond):
	}
	rel1() // 异模块归零后放行
	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("exclusive not released after drain")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/daemon/ -run TestModuleLocker -v`
Expected: FAIL —— NewModuleLocker 未定义

- [ ] **Step 3: 实现 `module_locker.go`**

```go
package daemon

import (
	"context"
	"errors"
	"sync"
)

// ModuleLocker 实现跨模块的「避免冲突」互斥（spec §5）。
//
// 锁模型：每个模块记两组计数 —— total（本模块全部持有数）与
// exclusive（其中勾选「避免冲突」的持有数）。
//
//	勾选方（排他）：等待「异模块 total 全归零」；计入本模块 total+exclusive
//	未勾选方（共享）：等待「异模块 exclusive 全归零」；计入本模块 total
//	同模块之间永不互斥（同模块顺序由依赖 DAG 表达）
//	无模块任务不参与（调用方直接跳过 Acquire）
//
// 由此「一方勾选即锁」双向成立。判定与计入在同一临界区内完成，
// 防止两个异模块勾选方同时判定通过。onWait（上报 waiting_module_lock）
// 在锁外调用，网络上报不阻塞其他任务的获取路径。不保证严格 FIFO，
// 与 LocalPathLocker 的公平性约定一致。
type ModuleLocker struct {
	mu      sync.Mutex
	cond    *sync.Cond
	holders map[string]moduleHold   // taskID → hold
	names   map[string]string       // taskID → 模块名（wait_reason 用）
}

type moduleHold struct {
	moduleID   string
	moduleName string
	exclusive  bool
}

func NewModuleLocker() *ModuleLocker {
	l := &ModuleLocker{
		holders: make(map[string]moduleHold),
		names:   make(map[string]string),
	}
	l.cond = sync.NewCond(&l.mu)
	return l
}

// Acquire 以 moduleID 名义为 taskID 取锁；返回幂等 release。
// ctx 取消时返回 ctx.Err() 且未取锁。onWait 在首次判定受阻时于锁外调用一次，
// 参数是挡住本任务的持有者模块名（可为空字符串表示未知）。
func (l *ModuleLocker) Acquire(ctx context.Context, moduleID, moduleName, taskID string, exclusive bool, onWait func(holderModule string)) (func(), error) {
	if moduleID == "" {
		return nil, errors.New("module_locker: moduleID required")
	}
	if taskID == "" {
		return nil, errors.New("module_locker: taskID required")
	}
	// ctx 取消 → Broadcast 唤醒等待循环重查 ctx.Err()。
	stop := context.AfterFunc(ctx, func() {
		l.mu.Lock()
		l.cond.Broadcast()
		l.mu.Unlock()
	})
	defer stop()

	waited := false
	for {
		l.mu.Lock()
		if err := ctx.Err(); err != nil {
			l.mu.Unlock()
			return nil, err
		}
		blocker, blocked := l.blockerLocked(moduleID, exclusive)
		if !blocked {
			l.holders[taskID] = moduleHold{moduleID: moduleID, moduleName: moduleName, exclusive: exclusive}
			l.mu.Unlock()
			var once sync.Once
			return func() { once.Do(func() { l.release(taskID) }) }, nil
		}
		if !waited {
			waited = true
			if onWait != nil {
				l.mu.Unlock()
				onWait(blocker) // 锁外：可能是一次 HTTP 上报
				continue
			}
		}
		l.cond.Wait()
		l.mu.Unlock()
	}
}

// blockerLocked 返回挡住本次获取的持有者的模块名。
// 规则：异模块持有 ×（本请求排他 或 持有方为排他）⇒ 阻塞。
func (l *ModuleLocker) blockerLocked(moduleID string, exclusive bool) (string, bool) {
	for _, h := range l.holders {
		if h.moduleID == moduleID {
			continue
		}
		if exclusive || h.exclusive {
			return h.moduleName, true
		}
	}
	return "", false
}

func (l *ModuleLocker) release(taskID string) {
	l.mu.Lock()
	delete(l.holders, taskID)
	l.cond.Broadcast()
	l.mu.Unlock()
}
```

（注：计数等价于 `holders` 映射的派生量，直接遍历求判定即可——任务量级 ≤ daemon 并发上限 20，O(n) 判定足够；显式 total/exclusive 计数是 spec 的语义表述，实现用 holders 单事实源避免计数漂移。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && go test ./internal/daemon/ -run TestModuleLocker -v -count=1`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add server/internal/daemon/module_locker.go server/internal/daemon/module_locker_test.go
git commit -m "feat(daemon): ModuleLocker dual-count cross-module lock"
```

---

### Task 9: daemon 接线 —— 模块锁替换目录互斥，prepare 短锁保留

**Files:**
- Modify: `server/internal/daemon/daemon.go:5391`（调用点）、`5659`（原函数改造）、`7640`（in-place prepare 分支）
- Test: `server/internal/daemon/daemon_test.go`（或新建 `module_lock_integration_test.go`）

- [ ] **Step 1: 写失败测试**

```go
func TestTaskWaitsOnModuleLock(t *testing.T) {
	// daemon 内造两个任务：A（模块 m1，avoid_conflict=true）先占锁；
	// B（模块 m2）进入执行 → 断言 B 上报了 waiting_module_lock 且
	// wait_reason 含模块名；释放 A 后 B 继续。
	// 对照：C（无模块）在 A 持锁期间直接执行，不上报等待。
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/daemon/ -run TestTaskWaitsOnModuleLock -v`
Expected: FAIL —— 行为还是目录锁语义

- [ ] **Step 3: 实现**

**3a. Daemon 结构体加字段**（`daemon.go` 内 `Daemon` struct，与 `localPathLocks` 相邻）：

```go
moduleLocks *ModuleLocker
```

构造函数（`New`/`NewDaemon`，与 `NewLocalPathLocker()` 初始化处并列）：

```go
moduleLocks: NewModuleLocker(),
```

**3b. 原 `acquireLocalDirectoryLockIfNeeded`（L5659）拆分改造**：

- 保留其「资源解析 + 模式校验 + 路径校验」三段 fail-fast 逻辑，提炼为 `resolveLocalDirectoryAssignment(ctx, task, taskLog) (*localDirectoryRef, bool)`（返回 abort 语义不变；路径校验失败仍 fail-fast）。
- 删除其中「全生命周期取互斥锁」的部分（L5731 起的 onWait/Acquire 段）。
- 新增模块锁函数：

```go
// acquireModuleLockIfNeeded 实现 spec §5：有模块任务按 avoid_conflict 参与
// 跨模块互斥；无模块任务、worktree 模式、聊天任务不取锁直接执行。
func (d *Daemon) acquireModuleLockIfNeeded(ctx context.Context, task Task, assignment *localDirectoryRef, taskLog *slog.Logger) (release func(), abort bool) {
	if task.ModuleID == "" {
		return nil, false // 无模块：不锁
	}
	if assignment != nil && assignment.UsesWorktree() {
		return nil, false // worktree：物理隔离，维持现状豁免
	}
	if localDirectoryLockExempt(task) {
		return nil, false // 聊天任务：维持 #7344 豁免
	}
	// onWait / 取消轮询 / prepare 租约续期 / resourceWaitTasks 计数：
	// 复用原 acquireLocalDirectoryLockIfNeeded L5738-5810 的同一套脚手架，
	// 仅把上报调用换成 MarkTaskWaitingModuleLock，reason 换成模块文案：
	//   reason := fmt.Sprintf("模块「%s」", task.ModuleName)
	//   if holder != "" { reason += fmt.Sprintf(" (held by 模块「%s」)", holder) }
	releaseFn, err := d.moduleLocks.Acquire(ctx, task.ModuleID, task.ModuleName, task.ID, task.AvoidConflict, onWait)
	if err != nil {
		// 与原锁的 ctx 取消分支一致：fail 任务并 abort
		if failErr := d.reportTerminalTask(ctx, terminalTaskReport{
			kind:          terminalTaskReportFail,
			taskID:        task.ID,
			errorMessage:  err.Error(),
			failureReason: "module_lock_cancelled",
		}); failErr != nil {
			taskLog.Error("fail task after module lock cancel", "error", failErr)
		}
		return nil, true
	}
	return releaseFn, false
}
```

**3c. L5391 调用点替换**：

```go
assignment, abort := d.resolveLocalDirectoryAssignment(ctx, task, taskLog)
if abort {
	return
}
moduleRelease, abort := d.acquireModuleLockIfNeeded(ctx, task, assignment, taskLog)
if abort {
	return
}
if moduleRelease != nil {
	defer moduleRelease()
}
```

**3d. prepare 短锁（L7640 else 分支，镜像 worktree 快照锁 L7596-7636 的现有模式）**：

```go
} else {
	if localAssignment != nil {
		prepParams.LocalWorkDir = localAssignment.AbsPath
		// prepare 短锁：仅覆盖上下文文件/skills 暂存的写入窗口，
		// 防同目录并发任务的写入撕裂；执行期放开（spec §5）。
		// 等待上报复用 MarkTaskWaitingLocalDirectory，与 worktree 快照锁一致。
		release, lockErr := d.localPathLocks.Acquire(prepareCtx, localAssignment.RealPath, task.ID, onPrepareWait)
		if lockErr != nil {
			return TaskResult{}, fmt.Errorf("local_directory prepare: %w", lockErr)
		}
		env, err = d.prepareExecutionEnvironment(prepareCtx, prepParams)
		release()
		if err != nil {
			return TaskResult{}, asEnvironmentSetupFailure(fmt.Errorf("prepare execution environment: %w", err))
		}
	} else {
		env, err = d.prepareExecutionEnvironment(prepareCtx, prepParams)
		if err != nil {
			return TaskResult{}, asEnvironmentSetupFailure(fmt.Errorf("prepare execution environment: %w", err))
		}
	}
}
```

（`onPrepareWait` 直接提取 L7605-7627 的回调为包级小函数，worktree 快照与本分支共用。）

- [ ] **Step 4: 跑测试确认通过 + daemon 全量回归**

Run: `cd server && go test ./internal/daemon/ -count=1`
Expected: PASS（含旧目录锁用例中对「全生命周期互斥」断言的更新——这些断言改为针对 prepare 短锁/模块锁）

- [ ] **Step 5: Commit**

```bash
git add server/internal/daemon/
git commit -m "feat(daemon): module lock replaces lifecycle directory mutex; prepare short lock retained"
```

---

### Task 10: 前端 core —— 类型、API client、i18n

**Files:**
- Modify: `packages/core/types/issue.ts:160`（Issue）
- Modify: `packages/core/types/api.ts:50`（UpdateIssueRequest 旁）
- Modify: `packages/core/api/client.ts:1200`（旁加方法）
- Modify: `packages/views/locales/en/issues.json`、`zh-Hans/issues.json`、`ja/issues.json`、`ko/issues.json`（各加 3 key）
- Test: `packages/core/api/client.test.ts`（若存在；否则随 Task 11 组件测试覆盖）

- [ ] **Step 1: 类型扩展**

`types/issue.ts` Issue 接口加：

```ts
/** 所属模块（项目级单选标签）；null/缺省 = 无模块，不参与任何锁 */
module_id?: string | null;
/** 跨模块避免冲突：勾选后本任务与异模块任务互斥执行 */
avoid_conflict?: boolean;
```

`types/api.ts`：

```ts
// UpdateIssueRequest 内追加：
module_id?: string | null;
avoid_conflict?: boolean;

// 新类型：
export interface ProjectModule {
  id: string;
  project_id: string;
  workspace_id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface IssueDependencyItem {
  issue_id: string;
  title: string;
  status: string;
}
```

- [ ] **Step 2: API client 方法（`client.ts` updateIssue 旁）**

```ts
async listProjectModules(projectId: string): Promise<ProjectModule[]> {
  return this.request("GET", `/api/projects/${projectId}/modules`);
}
async createProjectModule(projectId: string, data: { name: string; color?: string }): Promise<ProjectModule> {
  return this.request("POST", `/api/projects/${projectId}/modules`, data);
}
async updateProjectModule(projectId: string, moduleId: string, data: { name?: string; color?: string }): Promise<ProjectModule> {
  return this.request("PATCH", `/api/projects/${projectId}/modules/${moduleId}`, data);
}
async deleteProjectModule(projectId: string, moduleId: string): Promise<void> {
  return this.request("DELETE", `/api/projects/${projectId}/modules/${moduleId}`);
}
async getIssueDependencies(issueId: string): Promise<IssueDependencyItem[]> {
  return this.request("GET", `/api/issues/${issueId}/dependencies`);
}
async putIssueDependencies(issueId: string, dependsOn: string[]): Promise<IssueDependencyItem[]> {
  return this.request("PUT", `/api/issues/${issueId}/dependencies`, { depends_on: dependsOn });
}
```

（`request` 以 client.ts 内现有私有方法签名为准。）

- [ ] **Step 3: i18n 四语言 key**

`issues.json`（execution_log 节点内，与 `status_waiting_local_directory` 并列）：

| key | en | zh-Hans | ja | ko |
| --- | --- | --- | --- | --- |
| `status_waiting_module_lock` | `Waiting for module lock` | `等待模块锁释放` | `モジュールロック待機中` | `모듈 잠금 대기 중` |
| `is_waiting_module_lock` | `{{name}} is waiting for a module lock` | `{{name}} 正在等待模块锁` | `{{name}} がモジュールロックを待機中` | `{{name}} 모듈 잠금 대기 중` |
| `waiting_module_lock`（chat.json 内） | `Waiting for module lock` | `等待模块锁` | `モジュールロック待機中` | `모듈 잠금 대기 중` |

- [ ] **Step 4: typecheck**

Run: `cd packages/core && pnpm typecheck`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add packages/core/ packages/views/locales/
git commit -m "feat(core): module & dependency types, API client, i18n keys"
```

---

### Task 11: 前端 UI —— 徽章、过滤条、表单、详情、模块管理

**Files:**
- Create: `packages/views/issues/components/module-badge.tsx`
- Create: `packages/views/issues/components/pickers/module-picker.tsx`
- Create: `packages/views/issues/components/pickers/dependency-picker.tsx`
- Create: `packages/views/issues/components/module-filter-bar.tsx`
- Create: `packages/views/projects/components/project-modules-section.tsx`
- Modify: `packages/views/modals/create-issue.tsx`
- Modify: `packages/views/issues/components/issue-detail.tsx`
- Modify: `packages/views/issues/components/board-card.tsx`
- Modify: `packages/views/issues/components/task-run-labels.ts:48`
- Modify: `packages/views/issues/surface/activity.ts:25`
- Test: 每个新组件配 `*.test.tsx`（vitest，模式参照相邻组件测试）

- [ ] **Step 1: ModuleBadge（视觉以原型画面 E 图例为准）**

```tsx
// 色点 + 模块名；avoid_conflict 时追加盾牌图标（lucide Shield）
export function ModuleBadge({ name, color, avoidConflict }: { name: string; color: string; avoidConflict?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: `color-mix(in oklch, ${color} 10%, transparent)`, color }}
    >
      <i className="size-1.5 rounded-full" style={{ background: color }} />
      {name}
      {avoidConflict && <Shield className="size-2.5" />}
    </span>
  );
}
```

- [ ] **Step 2: task-run-labels.ts + activity.ts 接入新状态**

```ts
// task-run-labels.ts useStatusLabel switch 内：
case "waiting_module_lock":
  return t(($) => $.execution_log.status_waiting_module_lock);

// activity.ts L25 的 queued 归组条件：
status === "waiting_local_directory" || status === "waiting_module_lock"
```

同时检查 `AgentTask["status"]` 联合类型定义处（`packages/core/types`），把 `"waiting_module_lock"` 加入字面量联合。

- [ ] **Step 3: ModulePicker + DependencyPicker（模式照 `pickers/label-picker.tsx`）**

- ModulePicker：单选下拉，列出项目模块（色点+名称），首项「无模块（不参与锁定）」，末项「+ 新建模块」就地输入创建（调 createProjectModule）。
- DependencyPicker：多选，**仅列同模块 issue**（用 listIssues 按 project 过滤后 module_id 相等）；已在依赖链上会形成环的选项 disabled + 文案「会成环」（环判定在前端做一次 DFS 预检，服务端 409 兜底）；异模块选项不列出。

- [ ] **Step 4: create-issue.tsx 表单接入**

模块下拉选择后显示：「避免与其他模块冲突」勾选框（说明文案：勾选后本任务将与其他模块的任务互斥执行）+「前置依赖」多选器；提交时带上 `module_id` / `avoid_conflict`，创建成功后调 `putIssueDependencies` 写依赖。

- [ ] **Step 5: board-card.tsx 卡片徽章 + module-filter-bar.tsx**

- 卡片：在 labels 行渲染 ModuleBadge（issue.module_id 查项目模块表得名/色；用 react-query 缓存 `["project-modules", projectId]`）。
- 过滤条：看板/列表顶部一行 chip（全部模块 / 各模块 / 无模块），写入 view store 的过滤条件（参照 `filter-chips-bar.tsx` 现有过滤写入方式）。
- 等待徽标：卡片上 issue 有排队任务且 wait 状态为 waiting_module_lock 时显示蓝色「等待模块锁释放」（复用现有 agent 活动指示的数据源 `issue-agent-activity-indicator.tsx`）。

- [ ] **Step 6: issue-detail.tsx 依赖区块 + project-modules-section.tsx**

- 详情页：标题旁 ModuleBadge；「前置依赖」区块列出各前置（状态图标 + 标题），可增删（调 PUT）；有未完成前置时顶部提示条「前置未完成时任务将保持排队；前置失败/取消时需人工处理后自动放行」。
- 项目详情（`project-detail.tsx`，参照 `project-resources-section.tsx` 的 section 模式）：模块管理表格（色点/名称/任务数/操作），新建/改名/改色/删除（删除确认文案：删除后相关任务回落为「无模块」）。

- [ ] **Step 7: typecheck + 组件测试**

Run: `cd packages/views && pnpm typecheck && pnpm test -- module`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/views/
git commit -m "feat(views): module badge, filter bar, pickers, issue detail dependencies, project modules section"
```

---

### Task 12: 全量验证

- [x] **Step 1: server 全量**

Run: `cd server && go build ./... && go test ./... -count=1`
Expected: PASS
Result: `go build`✓；序列化全量（`-p 1`，正确 DATABASE_URL 指向 dev 库 55433）除 1 个探针测试外全 ok。该失败（`TestProbeAgentCLIs_QoderResolvesViaLoginShell`）经 stash 隔离法证明源自 wukong_bridge 功能的未提交脏 WIP（`agents_probe.go`），换 HEAD 版后 3 个探针测试全过——与本任务无关。

- [x] **Step 2: 前端全量**

Run: `pnpm typecheck && pnpm test`
Expected: PASS
Result: `pnpm typecheck` 9/9✓；各包全绿（core / docs / views 414文件4892 / web 266 / desktop 621）。views 那个 Escape 时序用例经基线双加压对照实验证明为既有负载敏感 flake（未含本任务改动的基线在同等负载下同样挂，HEAD 全量反而全绿）。

- [x] **Step 3: 手动冒烟（本地环境）** — 按决策走 API/DB 级冒烟（重启 api，不消耗 LLM token 跑真实 agent）

1. ✅ 创建项目模块「内核与配置」「Flow 与编排」：模块 CRUD 全过（建×2 含自定义/默认色、列表带 task_count、改名 200、重名 409）；
2. ✅ 依赖闸门（DB 级双向复现 `ClaimAgentTask` 精确谓词）：A=todo 时闸门子查询返回 A → B 被阻塞不可 claim；PUT A=done 后闸门无行 → B 放开。依赖 API 同模块 PUT 200 / 跨模块 409 / 无模块 409 / 成环 409 / GET 三字段契约全过；issue 字段持久化经 API GET + DB 核实（module_id/avoid_conflict）；
3. ✅ 场景 3-5 服务端支撑到位：`waiting_module_lock` 状态入 `agent_task_queue_status_check` 约束、`MarkAgentTaskWaitingModuleLock` 转换查询（dispatched→waiting_module_lock 带 wait_reason）存在。daemon ModuleLocker 运行时行为（跨模块锁/短锁/自动续跑）由 Task 8 单测 + Task 9 接线 + Task 6/7 集成测试覆盖，均已通过。

- [x] **Step 4: Final commit**

全部代码已分布于 13 个提交（Task 1→12）；e2e 验证为纯测试/API 校验，无代码改动。`git add -A` 在本工作树会扫入约 40 个无关脏文件（wukong_bridge/reply_language/deliverables/dev-auto-login/mobile/MEMORY.md 等 WIP），故改为选择性提交本任务规划文档。

```bash
git add docs/superpowers/plans/2026-09-04-module-dependency-scheduling.md \
        docs/superpowers/specs/2026-09-04-module-dependency-scheduling-design.md \
        docs/superpowers/specs/2026-09-04-module-dependency-scheduling-prototype.html
git commit -m "docs: module dependency scheduling plan, spec & e2e verification record"
```

---

## Self-Review 记录（已完成）

- **Spec 覆盖**：§3→Task 1/2；§4→Task 5/6；§5→Task 8/9；§6→Task 3/5/7；§7→Task 10/11；§8→各 Task 测试步 + Task 12；§9→Task 6 Step 4（版本错位退化）、Task 9 3b（worktree/chat 豁免保留）。
- **对 spec 的一处实现级修正**：spec §4 闸门 SQL 写的是 `pre.status <> 'done'`，实现改用 `issue_effective_status(pre.workspace_id, pre.status) <> 'done'`（migration 340 的函数），否则自定义 done-category 状态会永久阻塞后继。spec 已同步更新。
- **实现简化记录**：ModuleLocker 用 holders 映射单事实源替代显式 total/exclusive 计数（语义等价，O(n) 判定在 daemon 并发上限 20 下足够，避免计数漂移）；模块投影用独立 `GetIssueModuleInfo` 查询替代改写 ClaimAgentTask 的 RETURNING（避免改动 UPDATE...RETURNING 结构）。
