-- 工作流阶段 spec 快照（plan 20261025 §B1）：把 authoring 层的阶段目标 / 达成判定 /
-- 输入模板 / 输出模板（goal|criteria|inputTpl|outputTpl）随实例创建一并物化进
-- workflow_stage_run.spec，运行期（prompt 渲染、流程把控视图、门禁佐证）只读快照、
-- 不回读模板，保证 template_version 一致性。
--
-- 可空列：旧模板/旧实例为 NULL，读写路径与既有实现逐字一致（零回归）。
ALTER TABLE workflow_stage_run ADD COLUMN IF NOT EXISTS spec jsonb;
