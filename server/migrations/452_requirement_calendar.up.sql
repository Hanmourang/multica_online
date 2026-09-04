-- 需求日历与角色化流水线（spec: docs/superpowers/specs/2026-09-04-requirement-calendar-design.md）
-- 把「需求」升级为带目标/git 库/分钟粒度时间窗口/角色班底的一等公民。
-- ① 需求级字段（顶层 issue 才有意义；子 issue 上为 inert，与 stage 同语义）
-- ② 子任务结构化明细三要素（内置固定拆解模板）
-- ③ root_requirement_id 递归回填 + 索引
ALTER TABLE issue
    ADD COLUMN start_at TIMESTAMPTZ,
    ADD COLUMN goal TEXT,
    ADD COLUMN repo_resource_id UUID REFERENCES project_resource(id) ON DELETE SET NULL,
    ADD COLUMN decompose_mode TEXT NOT NULL DEFAULT 'confirm'
        CHECK (decompose_mode IN ('auto', 'confirm', 'manual')),
    ADD COLUMN auto_trigger BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN decomposition_confirmed_at TIMESTAMPTZ,
    ADD COLUMN triggered_at TIMESTAMPTZ,
    ADD COLUMN acceptance_round INT NOT NULL DEFAULT 0,
    ADD COLUMN root_requirement_id UUID REFERENCES issue(id) ON DELETE SET NULL,
    ADD COLUMN feature_points JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN graph_context JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN acceptance_spec JSONB NOT NULL DEFAULT '{}';

-- root_requirement_id = 任务组标识：沿 parent_issue_id 链向上取根；无 parent 的独立
-- issue root = 自身（自成一组参与同模块互斥，spec §14 默认值）。
WITH RECURSIVE root AS (
    SELECT id, id AS root_id FROM issue WHERE parent_issue_id IS NULL
    UNION ALL
    SELECT i.id, r.root_id FROM issue i JOIN root r ON i.parent_issue_id = r.id
)
UPDATE issue i SET root_requirement_id = r.root_id FROM root r WHERE i.id = r.id;

-- 触发 sweep 部分索引：已确认拆解 + 未触发 + 自动触发的需求按开始时间扫描
CREATE INDEX idx_issue_trigger_sweep ON issue(start_at)
    WHERE auto_trigger = true AND triggered_at IS NULL AND decomposition_confirmed_at IS NOT NULL;
CREATE INDEX idx_issue_root_requirement ON issue(root_requirement_id);
CREATE INDEX idx_issue_repo_resource ON issue(repo_resource_id);
