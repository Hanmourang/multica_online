-- 项目使用的工作流（移植自 multica-main MUL-7420）。
-- NULL = 隐式 Default 工作流（整份 issue_status 目录、无交接），既有项目保持该行为，
-- 因此加列为纯元数据变更。
ALTER TABLE project ADD COLUMN IF NOT EXISTS workflow_id UUID;
