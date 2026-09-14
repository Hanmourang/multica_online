DROP INDEX IF EXISTS idx_artifact_doc_module;
ALTER TABLE project_artifact DROP COLUMN IF EXISTS doc_module;
