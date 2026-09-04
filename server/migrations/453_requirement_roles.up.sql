-- 需求角色班底（spec: docs/superpowers/specs/2026-09-04-requirement-calendar-design.md §5.2）
-- 项目默认班底 + 需求级快照：创建需求时把项目默认拷贝快照到需求级表，
-- 项目默认的后续变更不影响已建需求；pm/developer 为必选角色（server 侧校验 enabled）。
CREATE TABLE project_role_default (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('pm','prototyper','developer','data','tester')),
    assignee_type TEXT NOT NULL CHECK (assignee_type IN ('member','agent')),
    assignee_id   UUID NOT NULL,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    ordinal       INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, role, assignee_type, assignee_id)
);
CREATE INDEX idx_project_role_default_workspace ON project_role_default(workspace_id);

CREATE TABLE issue_role_assignment (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id      UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('pm','prototyper','developer','data','tester')),
    assignee_type TEXT NOT NULL CHECK (assignee_type IN ('member','agent')),
    assignee_id   UUID NOT NULL,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    ordinal       INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (issue_id, role, assignee_type, assignee_id)
);
CREATE INDEX idx_issue_role_assignment_issue ON issue_role_assignment(issue_id);
CREATE INDEX idx_issue_role_assignment_workspace ON issue_role_assignment(workspace_id);
