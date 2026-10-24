-- 工作流实例三层（plan 20261024-coco对标 §01 A2）：Instance → StageRun → GateRun。
-- 产物不建表：stage_run.outputs 元素即 project_artifact(455) 指针；
-- 会话消息复用 comment + task_message，不新建表。
CREATE TABLE workflow_instance (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id        UUID REFERENCES project(id) ON DELETE CASCADE,
    template_id       UUID NOT NULL REFERENCES workflow_template(id) ON DELETE RESTRICT,
    template_version  INT  NOT NULL,                          -- 实例锁定模板版本
    root_issue_id     UUID REFERENCES issue(id) ON DELETE SET NULL,   -- ★ 桥接需求/工作项
    sprint_id         UUID,                                   -- M2 联动：470 落地后由 F 收口补 FK（§G）
    workitem_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,     -- 发起时工作项快照
    status            TEXT NOT NULL DEFAULT 'waiting'
                          CHECK (status IN ('waiting','running','paused','done','failed','cancelled')),
    started_by_type   TEXT NOT NULL CHECK (started_by_type IN ('member','agent')),
    started_by_id     UUID NOT NULL,
    triggered_at      TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wf_inst_workspace ON workflow_instance(workspace_id, created_at DESC);
CREATE INDEX idx_wf_inst_project   ON workflow_instance(project_id, status) WHERE project_id IS NOT NULL;
CREATE INDEX idx_wf_inst_issue     ON workflow_instance(root_issue_id) WHERE root_issue_id IS NOT NULL;
CREATE INDEX idx_wf_inst_sprint    ON workflow_instance(sprint_id) WHERE sprint_id IS NOT NULL;

CREATE TABLE workflow_stage_run (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id  UUID NOT NULL REFERENCES workflow_instance(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    seq          INT  NOT NULL,                               -- 执行顺序
    node_id      TEXT NOT NULL,                               -- 对应 template.nodes[].id
    name         TEXT NOT NULL,
    mode         TEXT NOT NULL CHECK (mode IN ('auto','human')),
    agent_id     UUID REFERENCES agent(id) ON DELETE SET NULL, -- CoCo bot_id → Multica agent
    prompt       TEXT,
    task_id      UUID REFERENCES agent_task_queue(id) ON DELETE SET NULL, -- ★ auto 节点=一次 agent 执行
    state        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','running','waiting_gate','done','failed','skipped')),
    inputs       JSONB NOT NULL DEFAULT '[]'::jsonb,
    outputs      JSONB NOT NULL DEFAULT '[]'::jsonb,          -- 产物指针 → project_artifact
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (instance_id, seq)
);
CREATE INDEX idx_wf_stage_instance ON workflow_stage_run(instance_id, seq);
CREATE INDEX idx_wf_stage_task     ON workflow_stage_run(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE workflow_gate_run (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id  UUID NOT NULL REFERENCES workflow_instance(id) ON DELETE CASCADE,
    stage_run_id UUID NOT NULL REFERENCES workflow_stage_run(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    round        INT  NOT NULL DEFAULT 1,                     -- loop 计数（对齐 acceptance_round 语义）
    mode         TEXT NOT NULL CHECK (mode IN ('auto','human')),
    state        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','running','waiting','decided','cancelled')),
    decision     TEXT NOT NULL DEFAULT '' CHECK (decision IN ('','loop','exit')),
    generation   INT  NOT NULL DEFAULT 1,                     -- 门版本迭代（loop 回退时 +1）
    parent_id    UUID REFERENCES workflow_gate_run(id) ON DELETE SET NULL,
    decided_by_type TEXT CHECK (decided_by_type IN ('member','agent','system')),
    decided_by_id   UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at   TIMESTAMPTZ
);
CREATE INDEX idx_wf_gate_instance ON workflow_gate_run(instance_id);
CREATE INDEX idx_wf_gate_waiting ON workflow_gate_run(instance_id, state) WHERE state = 'waiting';
