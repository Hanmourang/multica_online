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

-- name: ResetRequirementTrigger :execrows
-- 触发已 CAS 但 stage3 入队全部失败时回退 triggered_at，让下轮 sweep 重扫重试
--（否则需求永久卡「已触发/零任务」，sweep/手动/重试三通道全关闭）。仅回退已触发
-- 行；影响 0 行 = 该行未被本进程触发（或已被并发重置），无副作用。
UPDATE issue SET triggered_at = NULL
WHERE id = $1 AND triggered_at IS NOT NULL;

-- name: HasAcceptanceSpecMissingNotice :one
-- H-3 可见信号去重护栏：sweep 每 30s 重扫被 acceptance_spec_missing 阻断的需求，
-- 为避免评论刷屏，发系统评论前先查是否已有带固定标记前缀的系统评论。
SELECT EXISTS (
    SELECT 1 FROM comment
    WHERE issue_id = $1 AND author_type = 'system'
      AND content LIKE '[acceptance_spec_missing]%'
) AS noticed;

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

-- name: IncrementAcceptanceRound :one
-- 验收打回：acceptance_round + 1 并返回新值（DEFAULT 0，见 migration 452:15）。
-- 调用方据返回值判「> 3 = 验收失败终态」。updated_at 同步刷新以驱动列表重排。
UPDATE issue
SET acceptance_round = acceptance_round + 1, updated_at = now()
WHERE id = $1
RETURNING acceptance_round;

-- name: IncrementAcceptanceRoundIfExpected :one
-- M-1 幂等守卫：仅当 acceptance_round 仍等于调用方读到的期望值时才 +1 并返回新值。
-- 并发验收裁决下只有一个能命中（另一个 0 行 → pgx.ErrNoRows → 409），杜绝 round
-- 重复自增与重复修复子任务。与修复子任务创建同事务（见 requirement_acceptance.go）。
UPDATE issue
SET acceptance_round = acceptance_round + 1, updated_at = now()
WHERE id = @id AND acceptance_round = @expected
RETURNING acceptance_round;

-- name: ModuleBusyForOtherRoot :one
-- 触发窗口预检（plan 2026-09-06-requirement-calendar-phase1-completion §WS2 Task 2.3，
-- 开放问题 #10）：检测同 module_id 上是否存在「其它 root 需求组」的活动任务。
--
-- 与 WS3 ModuleLocker v2 的组级互斥语义严格对齐（daemon/module_locker.go
-- blockerLocked）：同模块跨组无条件互斥；同组内部并行不阻。本查询只看
-- 「其他组」，本组自己的活动任务不算 busy（否则同组多个 stage3 子任务
-- 会互相卡住触发）。
--
-- 活动任务状态 = CountRunningTasks 同口径（agent.sql:1749）：dispatched / running /
-- waiting_local_directory / waiting_module_lock —— waiting_* 也算占用（daemon
-- 已在等锁，触发新组只会加剧排队）；queued 不算（尚未占用互斥窗口）。
--
-- NULL 处理：
-- - module_id 为 NULL（无模块需求）→ 调用方直接跳过本查询（无模块不互斥）；
-- - root_requirement_id 为 NULL（回填前的存量行）→ 调用方跳过（WS3 语义：
--   任一方 rootID 为空则同模块维度退化为 451，不互斥）；
-- - SQL 层面 IS NOT NULL + <> 双重保护：避免 NULL <> x 返回 UNKNOWN 而漏检。
SELECT EXISTS (
    SELECT 1
    FROM agent_task_queue q
    JOIN issue ti ON ti.id = q.issue_id
    WHERE ti.module_id = @module_id
      AND ti.root_requirement_id IS NOT NULL
      AND ti.root_requirement_id <> @root_requirement_id
      AND q.status IN ('dispatched', 'running', 'waiting_local_directory', 'waiting_module_lock')
) AS busy;
