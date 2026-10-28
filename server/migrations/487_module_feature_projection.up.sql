-- 功能模块原型中枢（07 §3.1 · M-02）：功能点投影表 + 模块↔需求关联。
-- project_module_feature 为 spec 的派生投影（D-C 非真源），由 spec 事务内重建；
-- 供覆盖率 SQL、列表徽标、聊天侧摘要使用。

CREATE TABLE IF NOT EXISTS project_module_feature (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id    UUID NOT NULL REFERENCES project_module(id) ON DELETE CASCADE,
    code         TEXT NOT NULL,
    title        TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'core' CHECK (kind IN ('core', 'edge')),
    priority     TEXT,
    spec_version INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (module_id, code)
);

CREATE INDEX IF NOT EXISTS idx_pmf_module ON project_module_feature(module_id);

CREATE TABLE IF NOT EXISTS module_requirement_link (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id      UUID NOT NULL REFERENCES project_module(id) ON DELETE CASCADE,
    requirement_id UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    feature_code   TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (module_id, requirement_id, feature_code)
);

CREATE INDEX IF NOT EXISTS idx_mrl_module ON module_requirement_link(module_id);
CREATE INDEX IF NOT EXISTS idx_mrl_requirement ON module_requirement_link(requirement_id);

-- 存量回填：从 484 的 spec.features 投影出功能点（当前默认 spec.features 为空数组 → 0 行，
-- 待 handler 写 spec 后由 PublishModuleSpec 事务内重建，这里只是首次建表时的对齐）。
INSERT INTO project_module_feature (module_id, code, title, kind, priority, spec_version)
SELECT m.id,
       f ->> 'code',
       f ->> 'title',
       COALESCE(f ->> 'kind', 'core'),
       f ->> 'priority',
       m.spec_version
  FROM project_module m
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(m.spec -> 'features', '[]'::jsonb)) AS f
 WHERE COALESCE(f ->> 'code', '') <> ''
ON CONFLICT (module_id, code) DO UPDATE
    SET title = EXCLUDED.title,
        kind = EXCLUDED.kind,
        priority = EXCLUDED.priority,
        spec_version = EXCLUDED.spec_version;
