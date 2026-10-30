-- 500 down：S0 回退为 general（档案侧 placement 由同步重新推导），再收紧 CHECK。
UPDATE project_asset_binding
SET    lifecycle_stage = 'general'
WHERE  lifecycle_stage = 'S0';

ALTER TABLE project_asset_binding
    DROP CONSTRAINT IF EXISTS project_asset_binding_lifecycle_stage_check;
ALTER TABLE project_asset_binding
    ADD CONSTRAINT project_asset_binding_lifecycle_stage_check
    CHECK (lifecycle_stage IN ('S1', 'S2', 'S3', 'S4', 'S5', 'general'));
