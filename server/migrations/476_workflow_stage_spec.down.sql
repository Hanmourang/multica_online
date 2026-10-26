-- 回滚 476：移除阶段 spec 快照列（列内仅存 authoring 快照，无其他派生数据）。
ALTER TABLE workflow_stage_run DROP COLUMN IF EXISTS spec;
