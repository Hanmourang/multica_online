-- 功能模块原型中枢（plans/20261026 07 §3.1 · M-01）：
--   ① project_module 增能力规格快照 spec(jsonb, module_spec/v1)、spec_version、
--      canonical_prototype_version 权威指针、spec_updated_at；
--   ② issue_prototype_version 增可空 module_id —— 解开「无需求即无原型」（硬伤 3）：
--      原型仍以 issue_prototype_version 为唯一存储（D-A 不新建表），module_id 为空是合法态。
--
-- 全部为增列（ADD COLUMN IF NOT EXISTS），既有读写路径逐字不变，零回归。
ALTER TABLE project_module
    ADD COLUMN IF NOT EXISTS spec JSONB NOT NULL DEFAULT '{"schema":"module_spec/v1","features":[]}'::jsonb,
    ADD COLUMN IF NOT EXISTS spec_version INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS canonical_prototype_version INT,
    ADD COLUMN IF NOT EXISTS spec_updated_at TIMESTAMPTZ;

-- ②-b 解开「无需求即无原型」的硬约束：454 的 issue_id 原为 NOT NULL，模块级原型
--   必须能在无 issue 的情况下登记（M-04/M-16）。放宽为可空，并以 CHECK 保证
--   每行至少挂需求或挂模块之一（两者皆空为非法态）。
ALTER TABLE issue_prototype_version
    ADD COLUMN IF NOT EXISTS module_id UUID REFERENCES project_module(id) ON DELETE SET NULL,
    ALTER COLUMN issue_id DROP NOT NULL;

ALTER TABLE issue_prototype_version
    DROP CONSTRAINT IF EXISTS issue_prototype_version_owner_check;
ALTER TABLE issue_prototype_version
    ADD CONSTRAINT issue_prototype_version_owner_check
    CHECK (issue_id IS NOT NULL OR module_id IS NOT NULL);

-- 模块级版本序列读路径按 (module_id, version desc) 聚合。
CREATE INDEX IF NOT EXISTS idx_ipv_module_version
    ON issue_prototype_version(module_id, version DESC);

-- 存量回填（只做一次）：已有 issue 且该 issue 挂了 module 的原型版本，补齐 module_id；
-- 其余保持 NULL —— 正是「无需求即无原型」那一列被解开的入口，NULL 是合法态。
UPDATE issue_prototype_version v
   SET module_id = i.module_id
  FROM issue i
 WHERE v.issue_id = i.id
   AND v.module_id IS NULL
   AND i.module_id IS NOT NULL;
