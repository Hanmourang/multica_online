-- 472 逆序：先删依赖新列的索引，再删列（DROP COLUMN 会自动带走仅含该列的索引，
-- 但 uq_wf_tpl_enforce_published 同时引用 status/project_id，显式 DROP 更稳）。
DROP INDEX IF EXISTS uq_wf_tpl_enforce_published;
ALTER TABLE workflow_template DROP COLUMN IF EXISTS enforce;
ALTER TABLE workflow_template DROP COLUMN IF EXISTS definition;
