-- 工作流阶段资产准入强制门禁（plan 101 C5/C7）：给 workflow_stage_run.state 值域
-- 追加 'blocked'——阶段声明的必备输入资产（DefinitionInput{required,assetRole:in}
-- 展平进 stage_run.inputs）尚未就绪（上游产物未产出）时，dispatchStage 不入队执行，
-- 而是把阶段置 blocked，等补齐后由 sweep / 门决策重新派发。
--
-- 仅扩展 CHECK 值域、不改列/结构体字段 → 不触发 sqlc 重生（生成结构体 State 仍是 string）。
ALTER TABLE workflow_stage_run DROP CONSTRAINT IF EXISTS workflow_stage_run_state_check;
ALTER TABLE workflow_stage_run ADD CONSTRAINT workflow_stage_run_state_check
    CHECK (state IN ('pending','running','waiting_gate','done','failed','skipped','blocked'));
