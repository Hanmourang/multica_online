-- 回滚 484：反向删除新增列与索引（列内仅存本模块新引入的快照/指针，无既有派生数据）。
DROP INDEX IF EXISTS idx_ipv_module_version;

-- 仅挂模块、无 issue 的原型版本无法回到 454 的 issue_id NOT NULL 态：
-- 先删除这类模块级新能力产生的行，再恢复约束（与 down 语义一致）。
ALTER TABLE issue_prototype_version DROP CONSTRAINT IF EXISTS issue_prototype_version_owner_check;
DELETE FROM issue_prototype_version WHERE issue_id IS NULL;
ALTER TABLE issue_prototype_version ALTER COLUMN issue_id SET NOT NULL;

ALTER TABLE issue_prototype_version
    DROP COLUMN IF EXISTS module_id;

ALTER TABLE project_module
    DROP COLUMN IF EXISTS spec_updated_at,
    DROP COLUMN IF EXISTS canonical_prototype_version,
    DROP COLUMN IF EXISTS spec_version,
    DROP COLUMN IF EXISTS spec;
