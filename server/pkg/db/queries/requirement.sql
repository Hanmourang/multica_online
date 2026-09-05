-- 需求日历与角色化流水线查询。
-- spec: docs/superpowers/specs/2026-09-04-requirement-calendar-design.md

-- name: ListProjectRoleDefaults :many
SELECT * FROM project_role_default
WHERE project_id = $1
ORDER BY role ASC, ordinal ASC, created_at ASC;

-- name: DeleteProjectRoleDefaults :exec
-- whole-document replace 的前半；必须与 InsertProjectRoleDefaults 同事务先后执行。
-- （不能合并为单语句 CTE：WITH 内数据修改语句与主查询共享快照，INSERT 看不到
--  同语句 DELETE 的效果，重写已有行会触唯一约束冲突。）
DELETE FROM project_role_default WHERE project_id = $1;

-- name: InsertProjectRoleDefaults :exec
-- entries 为 JSONB 数组：[{role, assignee_type, assignee_id, enabled, ordinal}, ...]
INSERT INTO project_role_default (project_id, workspace_id, role, assignee_type, assignee_id, enabled, ordinal)
SELECT @project_id, @workspace_id, r.role, r.assignee_type, r.assignee_id, r.enabled, r.ordinal
FROM jsonb_to_recordset(@entries::jsonb)
    AS r(role text, assignee_type text, assignee_id uuid, enabled boolean, ordinal int);

-- name: ListIssueRoleAssignments :many
SELECT * FROM issue_role_assignment
WHERE issue_id = $1
ORDER BY role ASC, ordinal ASC, created_at ASC;

-- name: DeleteIssueRoleAssignments :exec
-- 需求级班底同样是 whole-document replace；同 DeleteProjectRoleDefaults 的快照原因，
-- 必须与 InsertIssueRoleAssignments 同事务先后执行。
DELETE FROM issue_role_assignment WHERE issue_id = $1;

-- name: InsertIssueRoleAssignments :exec
-- entries 结构同 InsertProjectRoleDefaults。
INSERT INTO issue_role_assignment (issue_id, workspace_id, role, assignee_type, assignee_id, enabled, ordinal)
SELECT @issue_id, @workspace_id, r.role, r.assignee_type, r.assignee_id, r.enabled, r.ordinal
FROM jsonb_to_recordset(@entries::jsonb)
    AS r(role text, assignee_type text, assignee_id uuid, enabled boolean, ordinal int);

-- name: CopyProjectRoleDefaultsToIssue :exec
-- 创建需求时把项目默认班底拷贝为需求快照；项目默认的后续变更不影响已建需求。
INSERT INTO issue_role_assignment (issue_id, workspace_id, role, assignee_type, assignee_id, enabled, ordinal)
SELECT @issue_id, d.workspace_id, d.role, d.assignee_type, d.assignee_id, d.enabled, d.ordinal
FROM project_role_default d
WHERE d.project_id = @project_id;

-- name: CreatePrototypeVersion :one
-- version = COALESCE(MAX(version),0)+1；旧 pending 版本置 superseded 由调用方同事务做
-- （SupersedePendingPrototypeVersions）。
INSERT INTO issue_prototype_version (issue_id, workspace_id, version, html_path, prompt, created_by_type, created_by_id)
VALUES (
    @issue_id, @workspace_id,
    (SELECT COALESCE(MAX(v.version), 0) + 1 FROM issue_prototype_version v WHERE v.issue_id = @issue_id),
    @html_path, @prompt, @created_by_type, @created_by_id
)
RETURNING *;

-- name: GetLatestPrototypeVersion :one
SELECT * FROM issue_prototype_version
WHERE issue_id = $1
ORDER BY version DESC
LIMIT 1;

-- name: GetPrototypeVersion :one
-- 按版本号取单行（marks 写入与确认门都按 {version} 定位）。
SELECT * FROM issue_prototype_version
WHERE issue_id = $1 AND version = $2;

-- name: ListPrototypeVersions :many
SELECT * FROM issue_prototype_version
WHERE issue_id = $1
ORDER BY version DESC;

-- name: UpdatePrototypeMarks :one
UPDATE issue_prototype_version
SET marks = @marks::jsonb
WHERE issue_id = @issue_id AND version = @version
RETURNING *;

-- name: SetPrototypeStatus :exec
UPDATE issue_prototype_version
SET status = @status
WHERE issue_id = @issue_id AND version = @version;

-- name: SupersedePendingPrototypeVersions :exec
UPDATE issue_prototype_version
SET status = 'superseded'
WHERE issue_id = @issue_id AND status = 'pending';

-- name: ListTriggerableRequirements :many
-- 触发 sweep 扫描（命中 idx_issue_trigger_sweep）：已到点的已确认、未触发、自动触发、
-- 非终态顶层需求。start_at IS NULL = 无计划，不自动触发。
SELECT * FROM issue i
WHERE i.parent_issue_id IS NULL
  AND i.auto_trigger = TRUE
  AND i.triggered_at IS NULL
  AND i.decomposition_confirmed_at IS NOT NULL
  AND i.start_at IS NOT NULL
  AND i.start_at <= now()
  AND issue_effective_status(i.workspace_id, i.status) NOT IN ('done', 'cancelled')
ORDER BY i.start_at ASC;

-- name: MarkRequirementTriggered :execrows
-- 幂等：仅当未触发时写入；影响 0 行 = 已被并发触发，调用方跳过。
UPDATE issue SET triggered_at = now()
WHERE id = $1 AND triggered_at IS NULL;

-- name: ConfirmDecomposition :execrows
-- 幂等：仅当未确认时写入；影响 0 行 = 重复确认，调用方转 409。
UPDATE issue SET decomposition_confirmed_at = now()
WHERE id = $1 AND decomposition_confirmed_at IS NULL;

-- name: ListRequirementChildren :many
-- 按 parent 取子任务（stage 升序；stage NULL 的自然排在最后），派生状态与详情面板共用。
SELECT * FROM issue
WHERE parent_issue_id = $1
ORDER BY stage ASC, created_at ASC;

-- name: HasWaitingModuleLockDescendant :one
-- 队列等待行挂在 stage 子任务（直接子级）上，无需递归整棵子孙树。
SELECT EXISTS (
    SELECT 1
    FROM issue c
    JOIN agent_task_queue q ON q.issue_id = c.id
    WHERE c.parent_issue_id = @issue_id
      AND q.status = 'waiting_module_lock'
) AS waiting;
