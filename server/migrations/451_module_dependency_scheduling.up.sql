-- 模块 + 依赖调度（spec: docs/superpowers/specs/2026-09-04-module-dependency-scheduling-design.md）
-- 核心理念：一个项目通常就是一个产品——同一模块下的修改通过显式依赖串行编排，
-- 跨模块的修改默认互不阻塞（勾选「避免冲突」后按模块互斥），取代目录级强制互斥。

-- ① 模块表：项目下的轻量单选枚举
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
-- 依赖记录统一写 type = 'blocked_by'；'blocks' / 'related' 不在本期范围。
ALTER TABLE issue_dependency
    ADD CONSTRAINT uq_issue_dependency UNIQUE (issue_id, depends_on_issue_id),
    ADD CONSTRAINT no_self_dependency CHECK (issue_id <> depends_on_issue_id);

-- ④ 任务队列新状态 waiting_module_lock（跨模块避免冲突锁的等待态）
ALTER TABLE agent_task_queue
    DROP CONSTRAINT agent_task_queue_status_check,
    ADD CONSTRAINT agent_task_queue_status_check
        CHECK (status IN (
            'queued',
            'dispatched',
            'running',
            'completed',
            'failed',
            'cancelled',
            'waiting_local_directory',
            'waiting_module_lock',
            'deferred'
        ));
