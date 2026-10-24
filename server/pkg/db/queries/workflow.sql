-- 工作流模块（CoCo 对标 plan 20261024 §01 B，Agent-W 独占）。
-- 读查询一律带 workspace_id 过滤（对照 ListProjectResourcesInWorkspace 的防串租契约）。

-- name: ListWorkflowTemplates :many
SELECT * FROM workflow_template
WHERE workspace_id = $1
  AND (project_id = $2 OR project_id IS NULL OR official = true)
  AND status <> 'archived'
ORDER BY official DESC, updated_at DESC;

-- name: GetWorkflowTemplate :one
SELECT * FROM workflow_template
WHERE id = $1 AND workspace_id = $2;

-- name: CreateWorkflowTemplate :one
INSERT INTO workflow_template (
    workspace_id, project_id, name, description, status, nodes,
    created_by_type, created_by_id, source_project_id
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9
) RETURNING *;

-- name: UpdateWorkflowTemplate :one
UPDATE workflow_template
SET name = $3, description = $4, nodes = $5, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: PublishWorkflowTemplate :one
UPDATE workflow_template
SET status = 'published', published_at = now(), version = version + 1, updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND status <> 'archived'
RETURNING *;

-- name: ArchiveWorkflowTemplate :one
UPDATE workflow_template
SET status = 'archived', archived_at = now(), updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: ShareWorkflowTemplate :exec
INSERT INTO workflow_template_share (template_id, project_id, shared_by)
VALUES ($1, $2, $3)
ON CONFLICT (template_id, project_id) DO NOTHING;

-- name: ListWorkflowTemplateShares :many
SELECT * FROM workflow_template_share
WHERE template_id = $1;

-- name: CreateWorkflowInstance :one
INSERT INTO workflow_instance (
    workspace_id, project_id, template_id, template_version, root_issue_id,
    workitem_snapshot, status, started_by_type, started_by_id
) VALUES (
    $1, $2, $3, $4, $5, $6, 'waiting', $7, $8
) RETURNING *;

-- name: GetWorkflowInstance :one
SELECT * FROM workflow_instance
WHERE id = $1 AND workspace_id = $2;

-- name: ListWorkflowInstancesByProject :many
SELECT wi.*,
       (SELECT COUNT(*) FROM workflow_instance c
         WHERE c.workspace_id = wi.workspace_id AND c.project_id = wi.project_id
           AND c.status = 'waiting')   AS waiting_count,
       (SELECT COUNT(*) FROM workflow_instance c
         WHERE c.workspace_id = wi.workspace_id AND c.project_id = wi.project_id
           AND c.status = 'running')   AS running_count,
       (SELECT COUNT(*) FROM workflow_instance c
         WHERE c.workspace_id = wi.workspace_id AND c.project_id = wi.project_id
           AND c.status = 'paused')    AS paused_count,
       (SELECT COUNT(*) FROM workflow_instance c
         WHERE c.workspace_id = wi.workspace_id AND c.project_id = wi.project_id
           AND c.status = 'done')      AS done_count,
       (SELECT COUNT(*) FROM workflow_instance c
         WHERE c.workspace_id = wi.workspace_id AND c.project_id = wi.project_id
           AND c.status = 'failed')    AS failed_count,
       (SELECT COUNT(*) FROM workflow_instance c
         WHERE c.workspace_id = wi.workspace_id AND c.project_id = wi.project_id
           AND c.status = 'cancelled') AS cancelled_count
FROM workflow_instance wi
WHERE wi.workspace_id = $1
  AND wi.project_id = $2
  AND ($3::text IS NULL OR wi.started_by_id = $4)
  AND (array_length($5::text[], 1) IS NULL OR wi.status = ANY($5::text[]))
ORDER BY wi.created_at DESC
LIMIT $6;

-- name: ListWorkflowInstancesByIssue :many
SELECT * FROM workflow_instance
WHERE workspace_id = $1 AND root_issue_id = $2
ORDER BY created_at DESC;

-- name: MarkWorkflowStarted :one
-- 幂等锚点：仅 waiting → running（sweep 并发 / 手动启动共用 CAS）。
UPDATE workflow_instance
SET status = 'running', triggered_at = now(), updated_at = now()
WHERE id = $1 AND status = 'waiting'
RETURNING *;

-- name: UpdateWorkflowInstanceState :one
-- 全部状态迁移走 CAS（WHERE status = expected）：0 行 → pgx.ErrNoRows → handler 409，
-- 杜绝并发把终态抹回（对照 IncrementAcceptanceRoundIfExpected 范式）。
UPDATE workflow_instance
SET status = $3,
    completed_at = CASE WHEN $3 IN ('done','failed','cancelled') THEN now() ELSE completed_at END,
    updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND status = $4
RETURNING *;

-- name: ListWaitingWorkflowInstances :many
-- 30s sweep 扫依赖满足的 waiting 实例（对照 ListTriggerableRequirements：SQL 过滤，
-- handler 只 StartWorkflowInstance，幂等由 MarkWorkflowStarted 的 execrows 守卫挡下）。
SELECT * FROM workflow_instance
WHERE status = 'waiting'
ORDER BY created_at ASC
LIMIT 100;

-- name: CreateWorkflowStageRun :one
INSERT INTO workflow_stage_run (
    instance_id, workspace_id, seq, node_id, name, mode, agent_id, prompt,
    state, inputs, outputs
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10
) RETURNING *;

-- name: GetWorkflowStageRun :one
SELECT * FROM workflow_stage_run
WHERE id = $1 AND workspace_id = $2;

-- name: ListWorkflowStageRuns :many
SELECT * FROM workflow_stage_run
WHERE instance_id = $1
ORDER BY seq ASC;

-- name: GetWorkflowStageRunByTask :one
SELECT * FROM workflow_stage_run
WHERE task_id = $1;

-- name: UpdateWorkflowStageRunState :one
-- CAS：仅当处于期望态才迁移（并发 complete/fail/skip 只有一方命中）。
UPDATE workflow_stage_run
SET state = $3, updated_at = now(),
    task_id = COALESCE($4, task_id),
    outputs = COALESCE($5, outputs)
WHERE id = $1 AND state = $2
RETURNING *;

-- name: CreateWorkflowGateRun :one
INSERT INTO workflow_gate_run (
    instance_id, stage_run_id, workspace_id, round, mode, state, generation, parent_id
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8
) RETURNING *;

-- name: GetWorkflowGateRun :one
SELECT * FROM workflow_gate_run
WHERE id = $1 AND workspace_id = $2;

-- name: ListWorkflowGateRuns :many
SELECT * FROM workflow_gate_run
WHERE instance_id = $1
ORDER BY created_at ASC;

-- name: GetWaitingGateByStageRun :one
SELECT * FROM workflow_gate_run
WHERE stage_run_id = $1 AND state = 'waiting'
ORDER BY generation DESC
LIMIT 1;

-- name: DecideWorkflowGate :one
-- 仅 waiting 态可裁决：0 行 = 并发裁决抢先 → handler 409（对照 acceptance round CAS）。
UPDATE workflow_gate_run
SET decision = $2::text, state = 'decided', decided_at = now(),
    decided_by_type = $3, decided_by_id = $4
WHERE id = $1 AND state = 'waiting'
RETURNING *;

-- name: CancelWorkflowGateRun :one
UPDATE workflow_gate_run
SET state = 'cancelled', decided_by_type = 'system', decided_at = now()
WHERE id = $1 AND state = 'waiting'
RETURNING *;

-- name: IncrGateRoundLoopBack :one
-- loop 回退：基于旧门开新 generation 的门（round+1），旧门由调用方先行 CancelWorkflowGateRun
-- 标 cancelled（superseded 语义用 generation 递增表达，对齐 acceptance_round 计数）。
INSERT INTO workflow_gate_run (
    instance_id, stage_run_id, workspace_id, round, mode, state, generation, parent_id
)
SELECT g.instance_id, g.stage_run_id, g.workspace_id, g.round + 1, g.mode, 'waiting',
       g.generation + 1, g.id
FROM workflow_gate_run g
WHERE g.id = $1
RETURNING *;
