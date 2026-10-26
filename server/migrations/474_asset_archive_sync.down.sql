ALTER TABLE project_artifact DROP CONSTRAINT IF EXISTS project_artifact_source_check;
ALTER TABLE project_artifact
    ADD CONSTRAINT project_artifact_source_check
    CHECK (source IN ('sync', 'agent', 'server', 'manual'));
ALTER TABLE project_artifact ALTER COLUMN resource_id SET NOT NULL;
DROP INDEX IF EXISTS idx_artifact_asset_binding;
DROP INDEX IF EXISTS uq_artifact_asset_binding;
ALTER TABLE project_artifact DROP COLUMN IF EXISTS asset_binding_id;
