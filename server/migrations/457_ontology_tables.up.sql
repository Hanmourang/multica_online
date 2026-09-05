-- 本体层（降级先行）（spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §4.3）
-- GitNexus ontology strategies 为空目录，表先建暂为空表
-- 画面 10/11 以 migration / 代码实证降级展示，本体抽取就绪后自动接管

CREATE TABLE ontology_object (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    snapshot_id     UUID NOT NULL REFERENCES project_graph_snapshot(id) ON DELETE CASCADE,

    node_id         TEXT NOT NULL,
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('code','semantic','table','biz')),
    name            TEXT NOT NULL,
    qualified_name  TEXT,
    domain          TEXT,
    lifecycle       TEXT,
    impl_status     TEXT,

    properties      JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (snapshot_id, node_id)
);

CREATE TABLE ontology_link (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    snapshot_id     UUID NOT NULL REFERENCES project_graph_snapshot(id) ON DELETE CASCADE,

    source_id       TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    link_type       TEXT NOT NULL CHECK (link_type IN (
                        'QUERIES','ACCESSES','MEMBER_OF','CALLS',
                        'HANDLES_ROUTE','STEP_IN_PROCESS','FETCHES')),

    weight          INT NOT NULL DEFAULT 1,
    properties      JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ontology_link_snapshot ON ontology_link(snapshot_id);
CREATE INDEX idx_ontology_link_source ON ontology_link(snapshot_id, source_id);
CREATE INDEX idx_ontology_link_target ON ontology_link(snapshot_id, target_id);

CREATE TABLE ontology_changelog (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    snapshot_id     UUID NOT NULL REFERENCES project_graph_snapshot(id) ON DELETE CASCADE,

    change_type     TEXT NOT NULL CHECK (change_type IN ('added','modified','removed','status_change')),
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('code','semantic','table','biz')),
    node_id         TEXT NOT NULL,
    name            TEXT NOT NULL,
    detail          JSONB NOT NULL DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ontology_changelog_snapshot ON ontology_changelog(snapshot_id, created_at DESC);
