-- 申报就绪度（spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §4.4）
-- 三档契约：must（缺则不予受理）/ conditional（权属情形触发）/ aux（不影响受理）

CREATE TABLE filing_item (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,

    track           TEXT NOT NULL CHECK (track IN ('software_copyright','patent')),
    tier            TEXT NOT NULL CHECK (tier IN ('must','conditional','aux')),
    item_name       TEXT NOT NULL,
    item_key        TEXT NOT NULL,

    rule_expr       JSONB NOT NULL DEFAULT '{}',
    rule_result     JSONB NOT NULL DEFAULT '{}',
    blocking        BOOLEAN NOT NULL DEFAULT false,
    status          TEXT NOT NULL DEFAULT 'missing'
                        CHECK (status IN ('missing','partial','ready')),

    artifact_id     UUID REFERENCES project_artifact(id) ON DELETE SET NULL,
    source_path     TEXT,
    checked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (project_id, track, item_key)
);

CREATE TABLE filing_check_run (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    filing_item_id  UUID NOT NULL REFERENCES filing_item(id) ON DELETE CASCADE,

    check_type      TEXT NOT NULL,
    page_count      INT,
    lines_per_page  INT,
    header_consistency BOOLEAN,
    detail          JSONB NOT NULL DEFAULT '{}',
    verdict         TEXT NOT NULL CHECK (verdict IN ('pass','fail','warning')),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_filing_check_item ON filing_check_run(filing_item_id, created_at DESC);

CREATE TABLE filing_export_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,

    export_type     TEXT NOT NULL CHECK (export_type IN ('full','diagnostic')),
    readiness_snapshot JSONB NOT NULL DEFAULT '{}',
    exported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    exported_by_type TEXT NOT NULL CHECK (exported_by_type IN ('member','agent')),
    exported_by_id  UUID NOT NULL
);

CREATE INDEX idx_filing_export_project ON filing_export_log(project_id, exported_at DESC);
