-- 回滚 451：先把处于新状态的任务退回 dispatched，否则恢复的 CHECK 会拒绝存量行。
UPDATE agent_task_queue SET status = 'dispatched' WHERE status = 'waiting_module_lock';

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
            'deferred'
        ));

-- issue.module_id 持有指向 project_module 的 FK，先 drop 列再 drop 表。
ALTER TABLE issue
    DROP COLUMN module_id,
    DROP COLUMN avoid_conflict;

ALTER TABLE issue_dependency
    DROP CONSTRAINT uq_issue_dependency,
    DROP CONSTRAINT no_self_dependency;

DROP TABLE project_module;
