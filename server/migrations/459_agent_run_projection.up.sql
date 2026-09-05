-- 运行追踪（spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §4.5）
-- 会话流（task_message）是事实源，agent_run / _todo / _event 是单向投影

CREATE TABLE agent_run (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    task_queue_id     UUID REFERENCES agent_task_queue(id) ON DELETE SET NULL,
    issue_id          UUID REFERENCES issue(id) ON DELETE SET NULL,
    root_issue_id     UUID REFERENCES issue(id) ON DELETE SET NULL,

    agent_id          TEXT NOT NULL,
    model             TEXT,
    cli_kind          TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','completed','failed','cancelled','stalled')),

    last_heartbeat_at TIMESTAMPTZ,
    stall_reason      TEXT CHECK (stall_reason IN (
                          'rate_limited','network_lost','crashed','waiting_module_lock',
                          'waiting_local_directory')),
    token_used        BIGINT NOT NULL DEFAULT 0,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_run_issue ON agent_run(issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX idx_agent_run_task ON agent_run(task_queue_id) WHERE task_queue_id IS NOT NULL;
CREATE INDEX idx_agent_run_heartbeat ON agent_run(last_heartbeat_at)
    WHERE status = 'running';

CREATE TABLE agent_run_todo (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    run_id            UUID NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,

    todo_key          TEXT NOT NULL,
    phase             TEXT,
    title             TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','in_progress','done','skipped','failed')),
    seq               INT NOT NULL DEFAULT 0,

    source            TEXT NOT NULL DEFAULT 'tool_trace'
                          CHECK (source IN ('tool_trace','reply','manual')),
    superseded_by     UUID REFERENCES agent_run_todo(id) ON DELETE SET NULL,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (run_id, todo_key)
);

CREATE INDEX idx_run_todo_run ON agent_run_todo(run_id, seq);
CREATE INDEX idx_run_todo_status ON agent_run_todo(status) WHERE status IN ('in_progress','failed');

CREATE TABLE agent_run_event (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    run_id            UUID NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,

    event_type        TEXT NOT NULL CHECK (event_type IN (
                          'heartbeat','todo_change','rate_limit','net_err','crash')),
    detail            JSONB NOT NULL DEFAULT '{}',

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_event_run ON agent_run_event(run_id, created_at DESC);
