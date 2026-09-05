-- 档案同步配置与诊断（spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §4.9；
-- 原型 docs/superpowers/specs/2026-09-05-project-archive-prototype.html #f2 五阶段流水线、#f3 同步控制台标注①-⑤）
--
-- 本迁移一次性补齐 §4.9 的四个待建 schema 对象：
--   1) sync_diagnostics 表（§4.9.6）——CLI 分阶段诊断日志；server 只收到一次全量清单 POST，
--      无法区分扫描/解析/上传三阶段，各阶段错误只能由 CLI 逐条上报，本表是其载体。
--   2) project_archive_sync_config 表（§4.9.7）——同步模式/冲突策略/范围过滤配置；
--      project 表无 JSONB 配置列、project_resource.resource_ref 参与 UNIQUE 不可用，故独立建表。
--   3) project_artifact.confidence 列（§4.9.3）——批量绑定置信度 0..1，server 侧候选算法写入。
--   4) project_artifact.override_reason 列（§4.9.5）——source='manual' 且改动契约推导结果时必填。
--
-- ── sqlc 门禁对齐说明（沿用 460 同款决策）──────────────────────────────────
-- sqlc 以 migrations/ 为 schema 源生成 pkg/db/generated。455 的 graph_node_id 已使 committed
-- generated 落后（重生在并行会话工作区在途）。本迁移不触发 make sqlc，handler 一律使用原生 SQL
-- （同 issue_archive.go:loadDeliverablesStageGates 的模式）；待并行会话统一重生 generated 时
-- 本迁移的模型会一并生成，无需回头补。

-- 1) §4.9.6 sync_diagnostics ────────────────────────────────────────────────
CREATE TABLE sync_diagnostics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,

    -- CLI 每次 sync 生成的唯一标识（UUID 或 timestamp-based），同一次运行的所有阶段共享。
    sync_run_id     TEXT NOT NULL,
    -- 对应原型五阶段流水线（sync-console.tsx 已按此五值渲染）。
    stage           TEXT NOT NULL CHECK (stage IN ('scan','parse','upload','index','recount')),
    -- 失败的文件路径；整仓级事件（如全量校对）可为 NULL。
    rel_path        TEXT,
    level           TEXT NOT NULL CHECK (level IN ('error','warning','info')),
    message         TEXT NOT NULL,
    detail          JSONB NOT NULL DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_diag_project ON sync_diagnostics(project_id, created_at DESC);
CREATE INDEX idx_sync_diag_run ON sync_diagnostics(sync_run_id);

-- 2) §4.9.7 project_archive_sync_config ─────────────────────────────────────
CREATE TABLE project_archive_sync_config (
    project_id      UUID PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,

    -- anno① 三种同步模式：hook=git post-commit 增量；scheduled=定时全量校对；manual=手动触发。
    -- 增量/全量的差异发生在 CLI 扫描端，server 只见清单、无需感知模式；本列供控制台渲染与 CLI 读取。
    sync_mode       TEXT NOT NULL DEFAULT 'manual'
                        CHECK (sync_mode IN ('hook','scheduled','manual')),
    -- anno② 冲突策略：path_first=路径契约优先；review_queue=不确定时全部进待绑定队列
    -- （CLI 不上报 issue_id，行落 unbound，server 已天然支持）。
    conflict_policy TEXT NOT NULL DEFAULT 'path_first'
                        CHECK (conflict_policy IN ('path_first','review_queue')),
    -- 范围过滤：{ "include": ["requirements/", "overview/"], "exclude": ["_shared/legacy/"] }
    scope_filter    JSONB NOT NULL DEFAULT '{}',
    -- anno③ 批量绑定阈值；conf < 此值的候选必须人工确认。
    batch_bind_threshold NUMERIC(5,4) NOT NULL DEFAULT 0.85,
    -- sync_mode='scheduled' 时的 cron 表达式。
    cron_expr       TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3) §4.9.3 批量绑定置信度（0.0000..1.0000；NULL = 未经算法评估）──────────
ALTER TABLE project_artifact
    ADD COLUMN confidence NUMERIC(5,4);

-- 4) §4.9.5 人工覆盖原因（source='manual' 且改动契约推导结果时必填；其余为 NULL）
ALTER TABLE project_artifact
    ADD COLUMN override_reason TEXT;
