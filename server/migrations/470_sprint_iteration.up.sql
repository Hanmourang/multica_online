-- 迭代（Sprint）：项目下的时间盒工作集合（CoCo 对标 02_迭代模块.md §A）。
-- spec: change_logs/multica/plans/20261024-coco对标-工作流迭代资产/02_迭代模块.md
-- issue.sprint_id 加列带 NULL：存量 issue 零回填，不进任何迭代 = backlog。
CREATE TABLE sprint (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id   UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    goal         TEXT,
    status       TEXT NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned','active','completed')),
    -- 与 issue.start_at(TIMESTAMPTZ) 区分：迭代按日粒度时间盒。
    start_date   DATE,
    end_date     DATE,
    -- 可选容量（点数/条数）；派生进度不落列，capacity 是唯一显式存储列。
    capacity     INT CHECK (capacity IS NULL OR capacity > 0),
    created_by_type TEXT NOT NULL CHECK (created_by_type IN ('member','agent')),
    created_by_id   UUID NOT NULL,
    started_at   TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name),
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX idx_sprint_project ON sprint(project_id, status);
CREATE INDEX idx_sprint_workspace ON sprint(workspace_id);

ALTER TABLE issue ADD COLUMN sprint_id UUID REFERENCES sprint(id) ON DELETE SET NULL;
CREATE INDEX idx_issue_sprint ON issue(sprint_id) WHERE sprint_id IS NOT NULL;
