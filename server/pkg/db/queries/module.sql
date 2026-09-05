-- 模块（project_module）与依赖（issue_dependency）查询。
-- spec: docs/superpowers/specs/2026-09-04-module-dependency-scheduling-design.md

-- name: ListProjectModules :many
-- 附带每个模块的任务数（模块管理表格的「任务数」列）；issue 无软删除，直接计数。
SELECT m.*, COUNT(i.id)::int AS task_count
FROM project_module m
LEFT JOIN issue i ON i.module_id = m.id
WHERE m.project_id = $1
GROUP BY m.id
ORDER BY m.created_at ASC;

-- name: CreateProjectModule :one
INSERT INTO project_module (project_id, workspace_id, name, color)
VALUES (@project_id, @workspace_id, @name, @color)
RETURNING *;

-- name: GetProjectModule :one
SELECT * FROM project_module WHERE id = $1;

-- name: UpdateProjectModule :one
-- 全字段写回（handler 先读旧值合并）；UNIQUE(project_id, name) 冲突由 handler 转 409。
UPDATE project_module SET name = @name, color = @color WHERE id = @id RETURNING *;

-- name: DeleteProjectModule :exec
-- issue.module_id 经 FK ON DELETE SET NULL 自动回落为无模块。
DELETE FROM project_module WHERE id = $1;

-- name: GetIssueModuleInfo :one
-- claim 投影：模块 id/名称 + 避免冲突标志 + 需求组 root（ModuleLocker v2 组级互斥，
-- spec §7.5②）。无模块时 module_id/module_name 为 NULL；root_requirement_id 由 452
-- 回填恒非空（独立 issue = 自身），root 标题供 daemon 等待文案「held by 需求组」。
SELECT i.module_id, i.avoid_conflict, i.root_requirement_id,
       m.name AS module_name, ri.title AS root_requirement_title
FROM issue i
LEFT JOIN project_module m ON m.id = i.module_id
LEFT JOIN issue ri ON ri.id = i.root_requirement_id
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
