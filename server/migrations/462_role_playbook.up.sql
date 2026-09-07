-- 角色执行标准（项目默认 + 需求快照）。
-- 与班底指派解耦：同一角色多名研发共享一份 playbook。
-- 空字段 = 回落服务端内置专业标准（service.BuiltinRolePlaybook）。
-- 创建需求时把项目默认拷贝为需求快照，之后改项目默认不影响已建需求。

CREATE TABLE project_role_playbook (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('pm','prototyper','developer','data','tester')),
    background    TEXT NOT NULL DEFAULT '',
    standards     TEXT NOT NULL DEFAULT '',
    process       TEXT NOT NULL DEFAULT '',
    init_mode     TEXT NOT NULL DEFAULT 'brief'
        CHECK (init_mode IN ('brief', 'checklist')),
    init_content  TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, role)
);
CREATE INDEX idx_project_role_playbook_workspace ON project_role_playbook(workspace_id);

CREATE TABLE issue_role_playbook (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id      UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('pm','prototyper','developer','data','tester')),
    background    TEXT NOT NULL DEFAULT '',
    standards     TEXT NOT NULL DEFAULT '',
    process       TEXT NOT NULL DEFAULT '',
    init_mode     TEXT NOT NULL DEFAULT 'brief'
        CHECK (init_mode IN ('brief', 'checklist')),
    init_content  TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (issue_id, role)
);
CREATE INDEX idx_issue_role_playbook_issue ON issue_role_playbook(issue_id);
CREATE INDEX idx_issue_role_playbook_workspace ON issue_role_playbook(workspace_id);
