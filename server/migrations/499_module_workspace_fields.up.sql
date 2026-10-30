-- 功能模块工作区（plan 20261030 · 原型图 TAB v2 画面 7 · migration 499）
--
-- 右栏「功能点详解」由字段字典驱动渲染，服务端工具面（MCP）的 inputSchema 也照着
-- 同一份字典生成 —— 一份定义两处用，杜绝「界面能改但后台改不了」或反之。
--
--   ① module_field_def        字段字典（key / scope / label / kind / owner / 可写方）
--   ② module_brief_version    说明版本（一行一版，append-only）
--   ③ module_release          成对发布（说明版本 ⨯ 原型版本），唯一改指针的入口
--   ④ project_module 增 brief_version / release_version 两个指针列
--
-- 全部 ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS：既有读写路径逐字不变。

CREATE TABLE IF NOT EXISTS module_field_def (
    key         TEXT PRIMARY KEY,
    scope       TEXT NOT NULL CHECK (scope IN ('module', 'feature_point')),
    label       TEXT NOT NULL,
    ord         INT  NOT NULL DEFAULT 0,
    kind        TEXT NOT NULL DEFAULT 'text'
                     CHECK (kind IN ('text', 'longtext', 'list', 'refs', 'acceptance')),
    -- owner=system 的 key 没有写入口：版本号、覆盖率、功能点编号与进退场由写入动作
    -- 顺带产生或必须由人发起，写它们直接 422（不靠文档约束）。
    owner       TEXT NOT NULL DEFAULT 'user' CHECK (owner IN ('system', 'user')),
    writable_by TEXT[] NOT NULL DEFAULT '{human,agent}',
    versioned   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 模块说明 7 个可填字段（右栏「模块说明」一段一行）。
INSERT INTO module_field_def (key, scope, label, ord, kind, owner) VALUES
    ('brief.position',        'module', '模块定位', 10, 'text',     'user'),
    ('brief.goal',            'module', '目标',     20, 'longtext', 'user'),
    ('brief.scope',           'module', '范围',     30, 'longtext', 'user'),
    ('brief.non_goal',        'module', '非目标',   40, 'longtext', 'user'),
    ('brief.roles',           'module', '角色',     50, 'list',     'user'),
    ('brief.flow',            'module', '关键流程', 60, 'longtext', 'user'),
    ('brief.acceptance_goal', 'module', '验收目标', 70, 'longtext', 'user')
ON CONFLICT (key) DO NOTHING;

-- 功能点四段详情的字段模板（code 段为通配，实际 key 形如 fp.FP-02.interaction）。
INSERT INTO module_field_def (key, scope, label, ord, kind, owner) VALUES
    ('fp.*.desc',        'feature_point', '1 · 功能描述',    110, 'longtext',   'user'),
    ('fp.*.loc',         'feature_point', '1 · 原型位置',    120, 'text',       'user'),
    ('fp.*.req',         'feature_point', '2 · 细节要求',    130, 'list',       'user'),
    ('fp.*.interaction', 'feature_point', '3 · 交互',        140, 'longtext',   'user'),
    ('fp.*.deps',        'feature_point', '3 · 依赖',        150, 'text',       'user'),
    ('fp.*.acceptance',  'feature_point', '4 · 验收标准',    160, 'acceptance', 'user')
ON CONFLICT (key) DO NOTHING;

-- 只读（system）key：写它们 422 read_only_field，而不是默默忽略。
INSERT INTO module_field_def (key, scope, label, ord, kind, owner, writable_by, versioned) VALUES
    ('fp.code',                       'feature_point', '功能点编号',   900, 'text', 'system', '{human}', true),
    ('fp.since',                      'feature_point', '新增于版本',   910, 'text', 'system', '{human}', true),
    ('fp.removed',                    'feature_point', '退场于版本',   920, 'text', 'system', '{human}', true),
    ('module.spec_version',           'module',        '规格版本号',   930, 'text', 'system', '{}',      true),
    ('module.canonical_prototype_version', 'module',   '权威原型版本', 940, 'text', 'system', '{}',      true),
    ('module.coverage',               'module',        '覆盖率',       950, 'text', 'system', '{}',      true)
ON CONFLICT (key) DO NOTHING;

-- ② 说明版本：一行一版，append-only。fields 里每个 key 自带 {v, by, at, actor}，
-- 所以「这一行值是谁、哪个版本写的」不需要再查历史。
CREATE TABLE IF NOT EXISTS module_brief_version (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id       UUID NOT NULL REFERENCES project_module(id) ON DELETE CASCADE,
    version         INT  NOT NULL,
    base_version    INT,
    fields          JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'superseded')),
    source          TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual', 'agent', 'mcp', 'extract', 'rollback')),
    source_issue_id UUID REFERENCES issue(id) ON DELETE SET NULL,
    agent_run_id    TEXT,
    diff_summary    TEXT,
    changes         JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by      UUID,
    created_by_type TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (module_id, version)
);

CREATE INDEX IF NOT EXISTS idx_mbv_module_version
    ON module_brief_version(module_id, version DESC);

-- ③ 成对发布：说明版本 ⨯ 原型版本。项目模块的两个指针只由这里推进。
CREATE TABLE IF NOT EXISTS module_release (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id         UUID NOT NULL REFERENCES project_module(id) ON DELETE CASCADE,
    version           INT  NOT NULL,
    brief_version     INT  NOT NULL,
    prototype_version INT  NOT NULL,
    diff              JSONB NOT NULL DEFAULT '{}'::jsonb,
    released_by       UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (module_id, version)
);

CREATE INDEX IF NOT EXISTS idx_mr_module_version
    ON module_release(module_id, version DESC);

-- ④ 模块级指针：当前说明版本 / 当前成对版本。canonical_prototype_version 已在 484。
ALTER TABLE project_module
    ADD COLUMN IF NOT EXISTS brief_version   INT,
    ADD COLUMN IF NOT EXISTS release_version INT;

-- 首次建档：把已存在的模块补一条 v0 空版本，右栏不必区分「没有版本行」与「版本为空」。
INSERT INTO module_brief_version (module_id, version, base_version, fields, status, source, diff_summary)
SELECT m.id, 0, NULL, '{}'::jsonb, 'draft', 'manual', '首次建档'
  FROM project_module m
 WHERE NOT EXISTS (
       SELECT 1 FROM module_brief_version v WHERE v.module_id = m.id
 );

-- 指针同时指到 v0：读路径（workspace / 发布）一律以指针为准，不再回落到 max(version)。
UPDATE project_module m
   SET brief_version = 0
 WHERE m.brief_version IS NULL
   AND EXISTS (
       SELECT 1 FROM module_brief_version v
        WHERE v.module_id = m.id AND v.version = 0
   );
