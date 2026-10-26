-- 工作流模板扩展（CoCo 对标 plan 20261024 §01 增量，Agent-W）：
-- 支撑「工作区侧边栏工作流模块 + 项目专属模板编辑 + 需求首门强门控」。
--
-- 1) definition：CoCo 嵌套 authoring 原文 {schemaVersion,kind,name,description,
--    nodes:[iteration|parallel|branch|stage],roleNames:{}}。现有 nodes（扁平）保留
--    为引擎编译产物，由 service.FlattenWorkflowDefinition 在 create/publish 时写入，
--    运行时状态机（Instance/StageRun/GateRun）完全不动。
ALTER TABLE workflow_template
    ADD COLUMN definition JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2) enforce：项目专属强制门控模板。为 true 时，该项目顶层需求在「触发执行
--    （stage3 入队）」前必须有一个已发起且首个 human 门已放行（decided exit）的
--    workflow 实例，否则 scheduler.triggerOneRequirement 预检返回
--    workflow_gate_not_satisfied（409）。默认 false → 存量需求触发零回归。
ALTER TABLE workflow_template
    ADD COLUMN enforce BOOLEAN NOT NULL DEFAULT false;

-- 同一项目下至多一个「已发布 + enforce」模板：避免多套强制门互相冲突、语义唯一。
-- draft 态可暂设 enforce（编辑中），发布时由 handler 复核 + 本索引兜底并发。
CREATE UNIQUE INDEX uq_wf_tpl_enforce_published
    ON workflow_template(project_id)
    WHERE enforce = true AND project_id IS NOT NULL AND status = 'published';
