-- 资产 → 档案自动映射（spec: change_logs/multica/daily_logs/20261024-22 后续需求）。
-- 知识 / 文档类资产 binding 在绑定与元信息更新时自动落一条 project_artifact 档案行
-- （source='asset'，asset_binding_id 反向持链），解绑经 ON DELETE CASCADE 自动清档。
-- 档案行不依赖项目的 archive_resource_id（纯线上资产无档案目录也能入档）。
ALTER TABLE project_artifact
    ADD COLUMN asset_binding_id UUID REFERENCES project_asset_binding(id) ON DELETE CASCADE;

-- 资产同步行的去重：一个 binding 恒一条当前档案行（重同步走 UPDATE，不 bump version）。
-- 表级 UNIQUE(resource_id, rel_path, version) 对 NULL resource_id 不设防，必须补部分索引。
CREATE UNIQUE INDEX uq_artifact_asset_binding
    ON project_artifact(asset_binding_id) WHERE asset_binding_id IS NOT NULL;
CREATE INDEX idx_artifact_asset_binding ON project_artifact(asset_binding_id)
    WHERE asset_binding_id IS NOT NULL;

-- 资产行没有档案资源指针：放宽 NOT NULL（档案读路径按 project_id 过滤，不受影响）。
ALTER TABLE project_artifact ALTER COLUMN resource_id DROP NOT NULL;

-- 新增 'asset' 来源：档案矩阵 / 列表据此渲染「资产同步」徽标并区分 sync 语义
-- （sync 行的 blob_sha / rel_path 由 git 驱动会被下轮 sync 冲掉，asset 行不参与）。
ALTER TABLE project_artifact DROP CONSTRAINT IF EXISTS project_artifact_source_check;
ALTER TABLE project_artifact
    ADD CONSTRAINT project_artifact_source_check
    CHECK (source IN ('sync', 'agent', 'server', 'manual', 'asset'));
