-- 回滚 475：把遗留 blocked 阶段回落 pending（避免违反收缩后的 CHECK），再恢复原值域。
UPDATE workflow_stage_run SET state = 'pending' WHERE state = 'blocked';
ALTER TABLE workflow_stage_run DROP CONSTRAINT IF EXISTS workflow_stage_run_state_check;
ALTER TABLE workflow_stage_run ADD CONSTRAINT workflow_stage_run_state_check
    CHECK (state IN ('pending','running','waiting_gate','done','failed','skipped'));
