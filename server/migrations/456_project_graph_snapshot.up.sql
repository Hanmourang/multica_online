-- 图谱快照（spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §4.2）
-- CLI sync 一次性导入，server 只存不解析文件系统
-- 保留策略：同一 project 最多 5 份，sync 时由 server 事务内清理最旧

CREATE TABLE project_graph_snapshot (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id       UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    resource_id      UUID NOT NULL REFERENCES project_resource(id) ON DELETE CASCADE,
    scan_id          TEXT NOT NULL,

    gitnexus_version TEXT NOT NULL,
    git_sha          TEXT NOT NULL,

    nodes            JSONB NOT NULL DEFAULT '[]',
    edges            JSONB NOT NULL DEFAULT '[]',
    communities      JSONB NOT NULL DEFAULT '[]',
    stats            JSONB NOT NULL DEFAULT '{}',
    module_summary   JSONB NOT NULL DEFAULT '[]',
    bus_matrix       JSONB NOT NULL DEFAULT '[]',

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (project_id, scan_id)
);

CREATE INDEX idx_graph_snapshot_project ON project_graph_snapshot(project_id, created_at DESC);
