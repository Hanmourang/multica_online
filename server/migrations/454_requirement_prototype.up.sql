-- 需求原型版本（spec: docs/superpowers/specs/2026-09-04-requirement-calendar-design.md §5.3）
-- 每次生成一个版本行（version 单调递增）；pending → confirmed / superseded。
-- 确认门：当前 pending 版本 marks 中不得存在 verdict='no' 且 note 为空的项（server 侧校验）。
CREATE TABLE issue_prototype_version (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id        UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    version         INT NOT NULL,
    html_path       TEXT NOT NULL,
    prompt          TEXT NOT NULL,
    marks           JSONB NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','confirmed','superseded')),
    created_by_type TEXT NOT NULL CHECK (created_by_type IN ('member','agent')),
    created_by_id   UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (issue_id, version)
);
CREATE INDEX idx_issue_prototype_version_workspace ON issue_prototype_version(workspace_id);
