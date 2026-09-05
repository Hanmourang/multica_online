-- 阶段门规则（spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §4.8；
-- 原型 docs/superpowers/specs/2026-09-05-project-archive-prototype.html #f8 卡4「阶段门与档案」:1996-2000）
--
-- 背景：project_artifact.stage（455，CHECK 1..4）+ doc_type（455，开放式 TEXT 无 CHECK）
-- 只能证明「某已进入阶段的档案架为空」，无法断言「缺哪份文档 / 门是否闭合」。
-- 缺的是规则载体 ——「每个 stage 要求哪些 doc_type 齐备」无处存放。本表补齐该载体。
--
-- 规则来源优先级（§4.8）：project 级（project_id 非空）覆盖 workspace 级默认（project_id 为 NULL）。
-- 判定 SQL 见 handler issue_archive.go:loadDeliverablesStageGates —— stage_gate_rule 对
-- project_artifact 按 (stage, doc_type) 做 EXISTS 存在性检查，与 project_filing.go:358-390 的
-- must 项判定同构；用 handler 内原生 SQL，不触碰 server/pkg/db/queries/*.sql，以免触发 sqlc 门禁。
--
-- ── 与 §4.8 定稿 DDL 的对齐说明 ───────────────────────────────────────────────
-- 1) UNIQUE：§4.8 写作表级约束 `UNIQUE (COALESCE(project_id, zero), stage, required_doc_type)`。
--    PostgreSQL 的表级 UNIQUE 约束不接受表达式（只能列名），故必须落地为 UNIQUE INDEX。
--    又：活库现有 3 个 workspace，而 §4.8 自己的解析查询按 workspace 过滤默认规则
--    （`project_id IS NULL AND workspace_id = $2`）；若唯一键不含 workspace_id，3 个 workspace 的
--    project_id=NULL 默认行会在 (zero, stage, doc_type) 上互相冲突，per-workspace 种子无法干净落地。
--    故唯一键在 §4.8 元组基础上补入 workspace_id（唯一一处为「可干净应用 + 每工作区默认」所必需的
--    偏离），语义仍是「一个 (工作区, 项目, 阶段, 必备文档类型) 只有一条规则」。track 不入唯一键，与 §4.8 一致。
-- 2) 列：§4.8 另含 `track TEXT NOT NULL DEFAULT 'default' CHECK(...)` 与 `updated_at`。本表沿用既有
--    nullable track（NULL = 交付默认轨道）且暂不加 updated_at —— 因为 sqlc 以 migrations/ 为 schema 源
--    生成 pkg/db/generated/models.go 的 StageGateRule，改动列类型 / 新增列会要求同步 `make sqlc` 重生
--    generated（任务界定为超出本任务所有权，且会牵动 455-459 的 generated 文件）。为守住 sqlc CI 门禁
--    （make sqlc && git diff --exit-code -- server/pkg/db/generated），列结构保持与已生成的 StageGateRule
--    一致。若 schema owner 要落 §4.8 的 track NOT NULL / updated_at：改本表列后运行 `make sqlc`，
--    并把 handler loadDeliverablesStageGates 里的 `track IS NULL` 同步改为 `track = 'default'`。

CREATE TABLE stage_gate_rule (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    -- NULL 表示 workspace 级默认规则；非空表示 project 级覆盖规则。
    project_id        UUID REFERENCES project(id) ON DELETE CASCADE,
    -- 可空，区分不同申报 / 交付轨道；交付阶段门走 NULL 默认轨道（见上方对齐说明 2）。
    track             TEXT,
    stage             INT NOT NULL CHECK (stage IN (1,2,3,4)),
    required_doc_type TEXT NOT NULL,
    -- blocking=true 的规则项计入档案完整度环（anno②「环只算必备件」）并参与门闭合判定。
    blocking          BOOLEAN NOT NULL DEFAULT true,
    sort_order        INT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 一个 (工作区, 项目, 阶段, 必备文档类型) 只允许一条规则（§4.8 UNIQUE 元组 + 强制 workspace_id）。
CREATE UNIQUE INDEX uq_stage_gate_rule_scope ON stage_gate_rule (
    workspace_id,
    COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
    stage,
    required_doc_type
);

-- §4.8 的两条查找索引：project 级覆盖探测（NOT EXISTS 子查询）与 workspace 级默认解析。
CREATE INDEX idx_stage_gate_project ON stage_gate_rule (project_id, stage)
    WHERE project_id IS NOT NULL;
CREATE INDEX idx_stage_gate_workspace ON stage_gate_rule (workspace_id, stage)
    WHERE project_id IS NULL;

-- ── 种子：workspace 级默认规则（project_id NULL / track NULL）──────────────────
-- doc_type 取值全部来自原型 f8 的档案行（唯一事实源），未凭空发明：
--   S1 原型    : prototype            (f8:2024 prototype-v1.html)
--   S2 plan+拆解: plan (f8:2040 plan.md) · decomposition (f8:2047 decomposition.md)
--   S3 执行    : design (f8:2064 design.md) · test-plan (f8:2077 test-plan.md，缺失项)
--                deliverables (f8:2071 deliverables.md，归档动作自动产出的清单 → 非必备 blocking=false)
--   S4 验收    : acceptance (f8:2092 acceptance.spec.ts) · report (f8:2099/2106 report-r1/r2.md，
--                轮次是 project_artifact.version，doc_type 统一为 report)
-- blocking=true 共 7 项 → 档案完整度环分母；deliverables 为 aux，不计入环、不阻断门。
-- CROSS JOIN workspace：每个工作区各得一份默认规则集；ON CONFLICT DO NOTHING 保证幂等。
INSERT INTO stage_gate_rule (workspace_id, project_id, track, stage, required_doc_type, blocking, sort_order)
SELECT w.id, NULL, NULL, v.stage, v.required_doc_type, v.blocking, v.sort_order
FROM workspace w
CROSS JOIN (
    VALUES
        (1, 'prototype',     TRUE,  10),
        (2, 'plan',          TRUE,  20),
        (2, 'decomposition', TRUE,  21),
        (3, 'design',        TRUE,  30),
        (3, 'test-plan',     TRUE,  31),
        (3, 'deliverables',  FALSE, 32),
        (4, 'acceptance',    TRUE,  40),
        (4, 'report',        TRUE,  41)
) AS v(stage, required_doc_type, blocking, sort_order)
ON CONFLICT DO NOTHING;
