-- 工作流模板（对标 CoCo coco-server workflow Template schema；plan 20261024-coco对标 §01 A1）。
-- 五层状态机的第一层：Template → Instance → StageRun(mode auto|human) → GateRun(loop|exit) → Artifact。
-- 执行复用 agent_task_queue、产物复用 project_artifact（stage_run.outputs 即其指针），不新造引擎。
CREATE TABLE workflow_template (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id        UUID REFERENCES project(id) ON DELETE CASCADE,   -- NULL = workspace 官方模板
    name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','published','archived')),
    version           INT  NOT NULL DEFAULT 1,
    -- 节点图：[{id,name,mode:'auto'|'human',agent_ref,prompt,
    --          inputs,outputs,next:[nodeId],gate_doc_types:[..],stage:int}]
    -- 结构校验在 handler validateWorkflowNodes（mode 合法 / next 引用存在 / 图无环）。
    nodes             JSONB NOT NULL DEFAULT '[]'::jsonb,
    official          BOOLEAN NOT NULL DEFAULT false,
    source_project_id UUID REFERENCES project(id) ON DELETE SET NULL,   -- 跨项目复制来源
    created_by_type   TEXT NOT NULL CHECK (created_by_type IN ('member','agent')),
    created_by_id     UUID NOT NULL,
    published_at      TIMESTAMPTZ,
    archived_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wf_tpl_workspace ON workflow_template(workspace_id);
CREATE INDEX idx_wf_tpl_project   ON workflow_template(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_wf_tpl_official  ON workflow_template(workspace_id) WHERE official = true;

-- 官方模板按 (workspace, name) 唯一：种子重放与并发创建共用该约束做幂等锚点。
CREATE UNIQUE INDEX uq_wf_tpl_official_name ON workflow_template(workspace_id, name)
    WHERE official = true AND project_id IS NULL;

-- 模板共享范围（CoCo shared_project_ids）：一张模板可放开给多个项目可见。
CREATE TABLE workflow_template_share (
    template_id UUID NOT NULL REFERENCES workflow_template(id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    shared_by   UUID NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (template_id, project_id)
);

-- ── 种子：官方「需求日历标准流水线」模板（§E，单一事实源）──────────────────────
-- nodes 复刻现有硬编码 4-stage（原型→拆解→执行→验收，ARCHITECTURE §2）；
-- doc_type 取值与 460 stage_gate_rule 种子一致，不凭空发明。
-- CROSS JOIN workspace：每个工作区各得一份官方模板；ON CONFLICT DO NOTHING 幂等。
-- created_by：'member' + 零 UUID = 既有「非真人发起」妥协约定（对照 requirement_acceptance.go L-5，
-- creator_type CHECK 不含 'system'，同 postAcceptanceFailedComment 的 author_id 零 UUID 同源）。
INSERT INTO workflow_template (workspace_id, project_id, name, description, status, version, nodes, official, created_by_type, created_by_id, published_at)
SELECT w.id, NULL,
       '需求日历标准流水线',
       '官方模板：原型 → 拆解 → 执行 → 验收 四阶段人机协同流水线（复刻需求日历 4-stage）。',
       'published', 1,
       '[{"id":"s1","name":"原型","mode":"human","stage":1,"gate_doc_types":["prototype"],"next":["s2"],"inputs":[],"outputs":[]},
         {"id":"s2","name":"拆解","mode":"human","stage":2,"gate_doc_types":["plan","decomposition"],"next":["s3"],"inputs":[],"outputs":[]},
         {"id":"s3","name":"执行","mode":"auto","stage":3,"gate_doc_types":["design","test-plan"],"next":["s4"],"inputs":[],"outputs":[]},
         {"id":"s4","name":"验收","mode":"human","stage":4,"gate_doc_types":["acceptance","report"],"next":[],"inputs":[],"outputs":[]}]'::jsonb,
       true, 'member', '00000000-0000-0000-0000-000000000000'::uuid, now()
FROM workspace w
ON CONFLICT (workspace_id, name) WHERE official = true AND project_id IS NULL DO NOTHING;
