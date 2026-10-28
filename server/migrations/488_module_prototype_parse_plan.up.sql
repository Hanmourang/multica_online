-- 功能模块原型中枢（07 §3.1 · M-02）：原型解析缓存 + 发布计划。
-- module_prototype_parse 缓存前端解析出的 data-fp anchors（后端不解析 HTML，§2.3-4）；
-- module_prototype_plan 承载 §2.5 发布两段式状态机：draft →(apply) applying →(ok) applied
--   / →(error) failed →(retry) applying；draft →(expire 24h) expired。

CREATE TABLE IF NOT EXISTS module_prototype_parse (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id UUID NOT NULL REFERENCES project_module(id) ON DELETE CASCADE,
    version   INT NOT NULL,
    anchors   JSONB NOT NULL DEFAULT '{}'::jsonb,
    parsed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (module_id, version)
);

CREATE TABLE IF NOT EXISTS module_prototype_plan (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id        UUID NOT NULL REFERENCES project_module(id) ON DELETE CASCADE,
    status           TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'applying', 'applied', 'failed', 'expired')),
    candidate_version INT NOT NULL,
    base_version     INT,
    spec_version     INT NOT NULL DEFAULT 0,
    plan             JSONB NOT NULL DEFAULT '{}'::jsonb,
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- apply 只需命中一次：草稿/进行中计划按模块串行。
CREATE INDEX IF NOT EXISTS idx_mpp_module_status
    ON module_prototype_plan(module_id, status)
    WHERE status IN ('draft', 'applying', 'failed');
