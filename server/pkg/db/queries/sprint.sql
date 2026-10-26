-- 迭代（sprint）查询。CoCo 对标 02_迭代模块.md §B。
-- 状态迁移（start/complete/reopen）全部走 CAS（WHERE 带期望状态），
-- 0 行 = pgx.ErrNoRows，由 handler 转 409，杜绝并发重复启停。

-- name: ListSprints :many
-- 附带每个迭代已纳入的 issue 条数（迭代列表的「任务数」列）与已完成条数
-- （侧边栏进度环 done/total）。派生口径与 GetSprintProgress 一致：走
-- issue_effective_status 归一自定义状态，不走字面量 'done' 比较。
SELECT s.*, COUNT(i.id)::int AS issue_count,
  COUNT(i.id) FILTER (WHERE issue_effective_status(i.workspace_id, i.status) = 'done')::int AS done_count
FROM sprint s
LEFT JOIN issue i ON i.sprint_id = s.id
WHERE s.workspace_id = @workspace_id
  AND s.project_id = @project_id
  AND (sqlc.narg('status')::text IS NULL OR s.status = sqlc.narg('status'))
GROUP BY s.id
ORDER BY s.start_date NULLS LAST, s.created_at ASC;

-- name: GetSprint :one
SELECT * FROM sprint WHERE id = $1 AND workspace_id = $2;

-- name: CreateSprint :one
-- (project_id, name) 唯一冲突由 handler 转 409 sprint_name_exists。
INSERT INTO sprint (
    workspace_id, project_id, name, goal, status,
    start_date, end_date, capacity, created_by_type, created_by_id
) VALUES (
    @workspace_id, @project_id, @name, @goal, @status,
    @start_date, @end_date, @capacity, @created_by_type, @created_by_id
) RETURNING *;

-- name: UpdateSprint :one
-- 全字段写回（handler 先读旧值合并）；改名冲突 → 409。
UPDATE sprint SET
    name = @name,
    goal = @goal,
    start_date = @start_date,
    end_date = @end_date,
    capacity = @capacity,
    updated_at = now()
WHERE id = @id AND workspace_id = @workspace_id
RETURNING *;

-- name: StartSprint :one
-- CAS：仅 planned 可启动；0 行 = 非 planned，handler 转 409 sprint_not_planned。
UPDATE sprint SET status = 'active', started_at = now(), updated_at = now()
WHERE id = $1 AND status = 'planned'
RETURNING *;

-- name: CompleteSprint :one
-- CAS：仅 active 可完成。
UPDATE sprint SET status = 'completed', completed_at = now(), updated_at = now()
WHERE id = $1 AND status = 'active'
RETURNING *;

-- name: ReopenSprint :one
-- CAS：仅 completed 可重开（回到 active）。
UPDATE sprint SET status = 'active', completed_at = NULL, updated_at = now()
WHERE id = $1 AND status = 'completed'
RETURNING *;

-- name: DeleteSprint :exec
-- 仅 planned 可删；FK ON DELETE SET NULL 自动把 issue 回落 backlog。
DELETE FROM sprint WHERE id = $1 AND status = 'planned';

-- name: AssignIssuesToSprint :exec
-- 批量纳入：workspace 绑定防串租；「已完成迭代拒绝纳入」由 handler 前置校验。
UPDATE issue SET sprint_id = @sprint_id, updated_at = now()
WHERE workspace_id = @workspace_id AND id = ANY(@issue_ids::uuid[]);

-- name: RemoveIssuesFromSprint :exec
-- 批量移出（置 NULL）。限定 sprint_id 匹配：并发下别的迭代抢先纳入的 issue 不被误伤。
UPDATE issue SET sprint_id = NULL, updated_at = now()
WHERE workspace_id = @workspace_id
  AND id = ANY(@issue_ids::uuid[])
  AND sprint_id = @sprint_id;

-- name: ListSprintIssues :many
-- 服务端内部用的迭代成员查询（handler 事务校验等）。前端迭代内列表走
-- /api/issues?sprint_id= 复用既有 issue list 接口，不新造对外列表端点。
SELECT * FROM issue
WHERE sprint_id = @sprint_id AND workspace_id = @workspace_id
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status'))
ORDER BY position ASC, created_at DESC;

-- name: GetSprintProgress :one
-- ★ 派生不落列：完成度用 issue_effective_status CASE 聚合（含自定义状态归一）。
SELECT
  count(*) FILTER (WHERE issue_effective_status(workspace_id, status) = 'done')::int AS done_count,
  count(*) FILTER (WHERE issue_effective_status(workspace_id, status) = 'cancelled')::int AS cancelled_count,
  count(*)::int AS total_count
FROM issue
WHERE sprint_id = $1 AND workspace_id = $2;
