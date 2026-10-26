-- 资产「阶段 × 输入/产物 × 标签 × 需求/Bug 关联」（原型 v2 assets-stage-archive-prototype-v2.html）。
-- spec: change_logs/multica/plans/20261024-coco对标-工作流迭代资产/06_资产文档线上存储解析预览实施规划.md §2
--
-- 阶段口径与需求日历（452）既有 4 阶段一致：S1 原型 / S2 规划 / S3 执行 / S4 验收，
-- general = 跨阶段通用。角色 input=消费它的前置材料，output=该阶段交付物。
-- 需求/Bug 关联是多对多（一个资产可服务多个需求、修复多个 Bug），471 的单列
-- issue_id 只表达「主归属作用域」，语义关联另立 asset_issue_link；Bug 在 multica
-- 即 issue（resolves 链型近似表达"修复"），不建独立 bug 表。

ALTER TABLE project_asset_binding
    ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT
        CHECK (lifecycle_stage IN ('S1', 'S2', 'S3', 'S4', 'general')),
    ADD COLUMN IF NOT EXISTS asset_role TEXT
        CHECK (asset_role IN ('input', 'output')),
    ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_asset_binding_stage
    ON project_asset_binding (project_id, lifecycle_stage) WHERE lifecycle_stage IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asset_binding_tags
    ON project_asset_binding USING GIN (tags);

CREATE TABLE IF NOT EXISTS asset_issue_link (
    asset_binding_id UUID NOT NULL REFERENCES project_asset_binding (id) ON DELETE CASCADE,
    issue_id         UUID NOT NULL REFERENCES issue (id) ON DELETE CASCADE,
    -- depends_on=资产是该工作项的前置输入；produces=资产是该工作项的产出；
    -- resolves=产物用于修复/验证该 Bug 类工作项。
    link_type        TEXT NOT NULL DEFAULT 'produces'
        CHECK (link_type IN ('depends_on', 'produces', 'resolves')),
    created_by_type  TEXT NOT NULL DEFAULT 'member' CHECK (created_by_type IN ('member', 'agent')),
    created_by_id    UUID NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_binding_id, issue_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_asset_issue_link_issue ON asset_issue_link (issue_id);
