-- 档案条目（spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §4.1）
-- Git 是唯一事实源，DB 只存指针（rel_path + blob_sha）与元数据

CREATE TABLE project_artifact (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    resource_id     UUID NOT NULL REFERENCES project_resource(id) ON DELETE CASCADE,
    issue_id        UUID REFERENCES issue(id) ON DELETE SET NULL,
    task_id         UUID REFERENCES agent_task_queue(id) ON DELETE SET NULL,

    scope           TEXT NOT NULL CHECK (scope IN ('shared', 'project', 'requirement')),
    stage           INT CHECK (stage IN (1,2,3,4)),
    doc_type        TEXT NOT NULL,
    version         INT NOT NULL DEFAULT 1,
    rel_path        TEXT NOT NULL,
    requirement_key TEXT,

    blob_sha        TEXT NOT NULL,
    attachment_id   UUID REFERENCES attachment(id) ON DELETE SET NULL,
    size_bytes      BIGINT NOT NULL DEFAULT 0,

    source          TEXT NOT NULL DEFAULT 'sync'
                        CHECK (source IN ('sync','agent','server','manual')),
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (resource_id, rel_path, version)
);

CREATE INDEX idx_artifact_project ON project_artifact(project_id)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_artifact_issue ON project_artifact(issue_id)
    WHERE deleted_at IS NULL AND issue_id IS NOT NULL;
CREATE INDEX idx_artifact_scope_stage ON project_artifact(project_id, scope, stage)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_artifact_requirement_key ON project_artifact(requirement_key)
    WHERE deleted_at IS NULL AND requirement_key IS NOT NULL;
CREATE INDEX idx_artifact_blob ON project_artifact(blob_sha);

-- project 扩展：档案目录资源指针（对称于 issue.repo_resource_id (452)）
ALTER TABLE project
    ADD COLUMN archive_resource_id UUID REFERENCES project_resource(id) ON DELETE SET NULL;

-- project_module 扩展：图谱桥接（同名自动匹配 Community / BizObject）
ALTER TABLE project_module
    ADD COLUMN graph_node_id TEXT;
