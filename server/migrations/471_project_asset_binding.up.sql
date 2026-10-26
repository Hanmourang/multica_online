-- 资产管理（对标 CoCo /projects/:id/assets）：在 project_resource(065) 物理指针之上
-- 建「业务资产目录绑定层」。binding 只持分类/推荐/作用域/展示元数据，resource_id 复用
-- 065 指针；解绑只删 binding，永不删 resource（可被多 binding 引用）。
-- spec: change_logs/multica/plans/20261024-coco对标-工作流迭代资产/03_资产管理模块.md §B
CREATE TABLE project_asset_binding (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id       UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    -- 非空 = 工作项级绑定（CoCo 双形态）；为空 = 项目级绑定。
    issue_id         UUID REFERENCES issue(id) ON DELETE CASCADE,
    asset_category   TEXT NOT NULL CHECK (asset_category IN (
        'code_repository','application','package','knowledge_repo','knowledge_group','other')),
    -- ★ 复用 065 物理指针；解绑 binding 不级联删 resource。
    resource_id      UUID REFERENCES project_resource(id) ON DELETE SET NULL,
    -- 外部系统坐标（source 侧 id/url/name），未落到 065 指针时也能独立描述资产。
    external_ref     JSONB NOT NULL DEFAULT '{}'::jsonb,
    asset_name       TEXT NOT NULL,
    asset_subtype    TEXT,
    -- 来源系统标识（github/gitlab/kbase/manual/...）。
    source           TEXT NOT NULL DEFAULT 'manual',
    recommended      BOOLEAN NOT NULL DEFAULT false,
    recommend_reason TEXT,
    created_by_type  TEXT NOT NULL CHECK (created_by_type IN ('member','agent')),
    created_by_id    UUID NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 作用域 + 分类 + 名称 + 来源 去重。用两支部分唯一索引替代 PG15+ 的
-- UNIQUE NULLS NOT DISTINCT，兼容更低版本的 PG，同时精确区分项目级/工作项级两支语义。
CREATE UNIQUE INDEX uq_asset_binding_project
    ON project_asset_binding(project_id, asset_category, asset_name, source)
    WHERE issue_id IS NULL;
CREATE UNIQUE INDEX uq_asset_binding_issue
    ON project_asset_binding(issue_id, asset_category, asset_name, source)
    WHERE issue_id IS NOT NULL;

CREATE INDEX idx_asset_binding_project  ON project_asset_binding(project_id) WHERE issue_id IS NULL;
CREATE INDEX idx_asset_binding_issue    ON project_asset_binding(issue_id)   WHERE issue_id IS NOT NULL;
CREATE INDEX idx_asset_binding_category ON project_asset_binding(project_id, asset_category);
CREATE INDEX idx_asset_binding_workspace ON project_asset_binding(workspace_id);
