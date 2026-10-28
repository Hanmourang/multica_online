-- 功能模块原型中枢（07 §3.1 · M-02）：模块变更审计 + 时间线事件。
-- 纯新表；保留 90 天由定时任务清理，不写进迁移（07 §3.1 486 行）。

CREATE TABLE IF NOT EXISTS module_change_event (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    module_id    UUID NOT NULL REFERENCES project_module(id) ON DELETE CASCADE,
    event_type   TEXT NOT NULL,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_type   TEXT NOT NULL DEFAULT 'member'
        CHECK (actor_type IN ('member', 'agent', 'system')),
    actor_id     UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mce_ws_module_created
    ON module_change_event(workspace_id, module_id, created_at DESC);
