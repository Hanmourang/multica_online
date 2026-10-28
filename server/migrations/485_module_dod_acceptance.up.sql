-- 功能模块原型中枢（07 §3.1 · M-02）：DoD 条目 + 验收运行记录。
-- 均为纯新表，不动既有读写；down 直接 drop。

CREATE TABLE IF NOT EXISTS module_dod (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id  UUID NOT NULL REFERENCES project_module(id) ON DELETE CASCADE,
    code       TEXT NOT NULL,
    text       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'criteria'
        CHECK (kind IN ('criteria', 'goal', 'nfr')),
    seq        INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (module_id, code)
);

CREATE TABLE IF NOT EXISTS module_acceptance_run (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id       UUID NOT NULL REFERENCES project_module(id) ON DELETE CASCADE,
    spec_version    INT NOT NULL,
    run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    result          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by_type TEXT NOT NULL DEFAULT 'member'
        CHECK (created_by_type IN ('member', 'agent')),
    created_by_id   UUID
);

CREATE INDEX IF NOT EXISTS idx_mar_module_run
    ON module_acceptance_run(module_id, run_at DESC);
