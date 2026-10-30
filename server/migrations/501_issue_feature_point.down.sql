DROP INDEX IF EXISTS idx_issue_module_feature;

ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_feature_code_requires_module;

ALTER TABLE issue DROP COLUMN IF EXISTS feature_code;
