-- 项目工作流（移植自 multica-main MUL-7420）。
--
-- 工作流 = 从 workspace 共享的 issue_status 目录里挑选并排序的一列状态，
-- 每个步骤可选一个「交接对象」：issue 进入该列时自动指派给它，并对 agent 启动
-- 一轮带该步骤说明的运行。状态本身仍是共享目录项，issue.status 继续存目录 key，
-- 因此跨项目筛选/排序/保存视图不受影响。
--
-- 项目通过 project.workflow_id 选择工作流（见 491）；未选择的项目使用
-- workspace 的 Default 工作流（is_default 行，唯一索引兜底）。
-- steps 用 JSONB：编辑器整份保存，没有按单步跨工作流的查询需求；
-- status key 与 handler id 在应用层校验，按库规不建外键。
CREATE TABLE IF NOT EXISTS issue_workflow (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id       UUID NOT NULL,
    name               TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    description        TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 256),
    initial_status_key TEXT NOT NULL,
    steps              JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
    -- Default 行每个 workspace 至多一条（见下方唯一索引）。
    is_default         BOOLEAN NOT NULL DEFAULT false,
    -- 工作流创建者，可编辑/删除它；Default 属于 workspace，无 owner。
    owner_id           UUID,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_issue_workflow_workspace
    ON issue_workflow(workspace_id);

-- ListIssueWorkflows 的排序键（is_default DESC, lower(name)）走索引。
CREATE INDEX IF NOT EXISTS idx_issue_workflow_workspace_name
    ON issue_workflow(workspace_id, lower(name));

-- CreateDefaultIssueWorkflow 的 ON CONFLICT (workspace_id) WHERE is_default 锚点。
CREATE UNIQUE INDEX IF NOT EXISTS uq_issue_workflow_default
    ON issue_workflow(workspace_id)
    WHERE is_default;
