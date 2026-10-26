DROP TABLE IF EXISTS asset_issue_link;
DROP INDEX IF EXISTS idx_asset_binding_tags;
DROP INDEX IF EXISTS idx_asset_binding_stage;
ALTER TABLE project_asset_binding
    DROP COLUMN IF EXISTS tags,
    DROP COLUMN IF EXISTS asset_role,
    DROP COLUMN IF EXISTS lifecycle_stage;
