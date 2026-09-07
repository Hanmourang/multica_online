# 项目档案库（Artifact Archive）— 系统设计文档

- 日期：2026-09-05
- 状态：Draft（schema 对齐定稿 2026-09-05）
- 原型：`2026-09-05-project-archive-prototype.html`（12 画面，同目录）
- 关联文档：`2026-09-04-requirement-calendar-design.md`（需求日历 stage / 角色班底）、`2026-09-04-task-deliverables-design.md`（交付物卡片墙）、`2026-09-04-module-dependency-scheduling-design.md`（模块互斥）

## 1. 背景与目标

项目文档散落在 `projects_mgmt/`、`change_logs/`、`ai_workspace/` 等多个目录，无统一索引；需求产出物（原型 / plan / 验收报告）只在动态流中瞬时可见，被后续消息淹没后难以检索；软著 / 专利申报时就绪度靠人工盘点，常漏件。

**目标**：建立以 **Git 目录契约为事实源** 的项目档案库，通过 CLI sync 把文档索引搬进 multica，在项目详情提供五部分阅读流：

1. **Ⅰ 契约与同步管道**（画面 1–3）：目录契约 ↔ 数据模型映射、CLI 同步与存量回填、同步控制台与手动关联
2. **Ⅱ 档案主视图**（画面 4–6）：项目档案 Tab 矩阵全景、档案预览弹窗、交付物归档动作
3. **Ⅲ 需求级下钻**（画面 7–9）：需求动态汇总、交付概览 Tab、进度追踪
4. **Ⅳ 全局分析视角**（画面 10–11）：产品功能（图谱 + 本体）、数据模型总线矩阵
5. **Ⅴ 申报产出**（画面 12）：申报就绪度看板（必备 / 条件必备 / 辅助三档契约）

## 2. 已确认的产品决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 图谱存储 | **JSONB 快照入库**：`project_graph_snapshot` 存 nodes / edges / communities / stats，server 不读文件系统 |
| 2 | 本体层策略 | **降级先行**：GitNexus `src/core/ontology/strategies/` 为空目录，ontology 表先建、UI 以图谱层为地基先跑通，本体抽取就绪后自动点亮 |
| 3 | 文档事实源 | **Git 是唯一事实源**：DB 只存指针（`rel_path` + `blob_sha`）与元数据，渲染走 `attachment/content` 快照，不依赖 daemon 在线 |
| 4 | 模块桥接 | **`project_module.graph_node_id`** 同名自动匹配 Community / BizObject，匹不上的进「未绑定」列表而非静默丢弃 |
| 5 | 快照保留 | **保留最近 5 份** `project_graph_snapshot`（按 `scan_id` 排序），超出自动清理；artifact 快照 >100MB 只索引不上传 |
| 6 | API 分层 | **sync 全量清单 diff**：CLI 提交全量清单，server 事务内 diff → upsert 命中行、软删缺席行，不维护批次状态，重跑幂等 |
| 7 | todo.status 不扩枚举 | **stuck/orphan 为跨表派生诊断态，不落列**：维持 migration 459 的五值 `pending/in_progress/done/skipped/failed`；stuck 语义由 `agent_run.status='stalled'` + `stall_reason` 承载，orphan 由 `GET /progress` 派生返回（详见 §4.5 决策记录） |

## 3. 总体架构

### 3.1 数据流

```
┌─ CLI 层：multica archive sync（cmd_archive.go）
│   ① 扫描档案目录 → 路径契约解析 → 算 blob_sha
│   ② 差量上传快照（POST /api/upload-file）
│   ③ 全量清单提交（POST /projects/{id}/artifacts/sync）
│   ④ 图谱快照按 git_sha 判重
│
├─ Server 层：handler/archive.go + service/artifact.go
│   ⑤ 事务内 diff → upsert / 软删
│   ⑥ 投影校验（issue_prototype_version ↔ artifact）
│   ⑦ 就绪度重算（filing 必备件校验）
│   ⑧ 模块桥接（Community 同名匹配 project_module）
│
├─ 数据层：Postgres
│   project_artifact（455）· project_graph_snapshot（456）
│   ontology_object / _link / _changelog（457）
│   filing_item / _check_run / _export_log（458）
│   agent_run / _todo / _event（459）
│   + 既有表扩展：project（+1 列）、project_module（+1 列）
│
└─ 前端层：web / desktop / mobile
    档案 Tab · 需求交付概览 · 产品功能 Tab · 数据模型 Tab · 申报就绪度
    预览走 attachment/content → RichContent，三端可用
```

### 3.2 核心不变量（来自原型画面 1）

1. **Git 是文档实体的唯一事实源**，DB 只存指针与元数据
2. **`issue_prototype_version` 是原型的唯一权威**，artifact 行是它的单向投影
3. **图谱 / 本体同样是快照入库**（`project_graph_snapshot`），server 永不读文件系统、不依赖 daemon 在线

## 4. 数据模型

migration 编号顺延现有序号（当前最大 454）。所有新表 / 新列均带 `workspace_id`，与既有 RLS / 索引风格一致。

### 4.1 migration 455_project_artifact.up.sql — 档案条目

```sql
CREATE TABLE project_artifact (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    resource_id     UUID NOT NULL REFERENCES project_resource(id) ON DELETE CASCADE,
    issue_id        UUID REFERENCES issue(id) ON DELETE SET NULL,
    task_id         UUID REFERENCES agent_task_queue(task_id) ON DELETE SET NULL,

    scope           TEXT NOT NULL CHECK (scope IN ('shared','project','requirement')),
    stage           INT CHECK (stage IN (1,2,3,4)),
    doc_type        TEXT NOT NULL,
    version         INT NOT NULL DEFAULT 1,
    rel_path        TEXT NOT NULL,
    requirement_key TEXT,

    blob_sha        TEXT NOT NULL,
    attachment_id   UUID REFERENCES attachment(id) ON DELETE SET NULL,
    size_bytes      BIGINT NOT NULL DEFAULT 0,

    source          TEXT NOT NULL DEFAULT 'sync'
                        CHECK (source IN ('sync','agent','server','manual')),
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (resource_id, rel_path, version)
);

CREATE INDEX idx_artifact_project ON project_artifact(project_id)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_artifact_issue ON project_artifact(issue_id)
    WHERE deleted_at IS NULL AND issue_id IS NOT NULL;
CREATE INDEX idx_artifact_scope_stage ON project_artifact(project_id, scope, stage)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_artifact_requirement_key ON project_artifact(requirement_key)
    WHERE deleted_at IS NULL AND requirement_key IS NOT NULL;
CREATE INDEX idx_artifact_blob ON project_artifact(blob_sha);
```

**语义**：
- `scope` 由路径契约推导：`overview/` → project，`requirements/` → requirement，`_shared/` → shared
- `stage` 由 `s<N>-<slug>/` 路径片段解析，N ∈ 1..4，越界拒绝入库
- `version` 由文件名 `v<N>.*` 或 `*-r<N>.md` 解析，缺省 = 1
- `source` 标记写入通道：sync = CLI 同步，agent = 归档动作，server = 原型投影，manual = 手动关联
- `deleted_at` 软删：sync 全量清单 diff 时缺席行置 `deleted_at=now()`，不物理删除
- `UNIQUE(resource_id, rel_path, version)` 保证同一文件同一版本只有一行

### 4.2 migration 456_project_graph_snapshot.up.sql — 图谱快照

```sql
CREATE TABLE project_graph_snapshot (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id       UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    resource_id      UUID NOT NULL REFERENCES project_resource(id) ON DELETE CASCADE,
    scan_id          TEXT NOT NULL,

    gitnexus_version TEXT NOT NULL,
    git_sha          TEXT NOT NULL,

    nodes            JSONB NOT NULL DEFAULT '[]',
    edges            JSONB NOT NULL DEFAULT '[]',
    communities      JSONB NOT NULL DEFAULT '[]',
    stats            JSONB NOT NULL DEFAULT '{}',

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (project_id, scan_id)
);

CREATE INDEX idx_graph_snapshot_project ON project_graph_snapshot(project_id, created_at DESC);
```

**语义**：
- 每次 sync 按 `git_sha` 判重：未变则不重传
- 保留最近 5 份（按 `scan_id` 排序），超出由 server 在 sync 事务尾部自动清理
- `nodes` / `edges` / `communities` 存 GitNexus 图谱的完整快照，供画面 10/11 消费

### 4.3 migration 457_ontology.up.sql — 本体层（降级先行）

```sql
CREATE TABLE ontology_object (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    snapshot_id     UUID NOT NULL REFERENCES project_graph_snapshot(id) ON DELETE CASCADE,

    node_id         TEXT NOT NULL,
    entity_4e       TEXT NOT NULL CHECK (entity_4e IN ('code','semantic','table','biz')),
    name            TEXT NOT NULL,
    qualified_name  TEXT,
    domain          TEXT,
    lifecycle       TEXT,
    impl_status     TEXT,

    properties      JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (snapshot_id, node_id)
);

CREATE TABLE ontology_link (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    snapshot_id     UUID NOT NULL REFERENCES project_graph_snapshot(id) ON DELETE CASCADE,

    source_node_id  TEXT NOT NULL,
    target_node_id  TEXT NOT NULL,
    link_type       TEXT NOT NULL CHECK (link_type IN (
                        'QUERIES','ACCESSES','MEMBER_OF','CALLS',
                        'HANDLES_ROUTE','STEP_IN_PROCESS','FETCHES')),

    weight          INT NOT NULL DEFAULT 1,
    properties      JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ontology_link_snapshot ON ontology_link(snapshot_id);
CREATE INDEX idx_ontology_link_source ON ontology_link(snapshot_id, source_node_id);
CREATE INDEX idx_ontology_link_target ON ontology_link(snapshot_id, target_node_id);

CREATE TABLE ontology_changelog (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    snapshot_id     UUID NOT NULL REFERENCES project_graph_snapshot(id) ON DELETE CASCADE,

    change_type     TEXT NOT NULL CHECK (change_type IN ('added','modified','removed','status_change')),
    entity_4e       TEXT NOT NULL CHECK (entity_4e IN ('code','semantic','table','biz')),
    node_id         TEXT NOT NULL,
    name            TEXT NOT NULL,
    detail          JSONB NOT NULL DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ontology_changelog_snapshot ON ontology_changelog(snapshot_id, created_at DESC);
```

**降级策略**：GitNexus `src/core/ontology/` 目前只有 types.ts（extractors / strategies 为空），所以 `ontology_object` / `ontology_link` / `ontology_changelog` 三张表先建但暂为空表。画面 10 的「模块策略」子 TAB 和画面 11 的「迭代视角」以 migration / 代码实证降级展示，本体抽取就绪后自动接管，无需改 UI。

### 4.4 migration 458_filing.up.sql — 申报就绪度

```sql
CREATE TABLE filing_item (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,

    track           TEXT NOT NULL CHECK (track IN ('software_copyright','patent')),
    tier            TEXT NOT NULL CHECK (tier IN ('must','conditional','aux')),
    item_name       TEXT NOT NULL,
    item_key        TEXT NOT NULL,

    rule_expr       JSONB NOT NULL DEFAULT '{}',
    rule_result     JSONB NOT NULL DEFAULT '{}',
    blocking        BOOLEAN NOT NULL DEFAULT false,
    status          TEXT NOT NULL DEFAULT 'missing'
                        CHECK (status IN ('missing','partial','ready')),

    artifact_id     UUID REFERENCES project_artifact(id) ON DELETE SET NULL,
    source_path     TEXT,
    checked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (project_id, track, item_key)
);

CREATE TABLE filing_check_run (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    filing_item_id  UUID NOT NULL REFERENCES filing_item(id) ON DELETE CASCADE,

    check_type      TEXT NOT NULL,
    page_count      INT,
    lines_per_page  INT,
    header_consistency BOOLEAN,
    detail          JSONB NOT NULL DEFAULT '{}',
    verdict         TEXT NOT NULL CHECK (verdict IN ('pass','fail','warning')),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_filing_check_item ON filing_check_run(filing_item_id, created_at DESC);

CREATE TABLE filing_export_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,

    export_type     TEXT NOT NULL CHECK (export_type IN ('full','diagnostic')),
    readiness_snapshot JSONB NOT NULL DEFAULT '{}',
    exported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    exported_by_type TEXT NOT NULL CHECK (exported_by_type IN ('member','agent')),
    exported_by_id  UUID NOT NULL
);

CREATE INDEX idx_filing_export_project ON filing_export_log(project_id, exported_at DESC);
```

**语义**：
- `tier` 三档：must（缺则不予受理）、conditional（权属情形触发）、aux（不影响受理）
- `blocking` 判定：`tier='must'` 且 `status != 'ready'` 时 blocking=true，导出申报包被拒绝，仅允许导出诊断包
  <!-- 定稿依据：458:17-18 CHECK 为 missing/partial/ready；project_filing.go:388-390 判定为 row.Tier=="must" && newStatus!="ready"；旧文档 status='fail' 是 verdict 值域混入 item 值域的 bug -->
- `filing_check_run` 记录每次校验明细（页数 / 每页行数 / 页眉一致性等）
- `filing_export_log` 记录导出历史；申报包被拒时降级为诊断包

### 4.5 migration 459_agent_run.up.sql — 运行追踪

```sql
CREATE TABLE agent_run (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    task_queue_id     UUID REFERENCES agent_task_queue(id) ON DELETE SET NULL,
    issue_id          UUID REFERENCES issue(id) ON DELETE SET NULL,
    root_issue_id     UUID REFERENCES issue(id) ON DELETE SET NULL,

    agent_id          TEXT NOT NULL,
    model             TEXT,
    cli_kind          TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','completed','failed','cancelled','stalled')),

    last_heartbeat_at TIMESTAMPTZ,
    stall_reason      TEXT CHECK (stall_reason IN (
                          'rate_limited','network_lost','crashed','waiting_module_lock',
                          'waiting_local_directory')),
    token_used        BIGINT NOT NULL DEFAULT 0,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_run_issue ON agent_run(issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX idx_agent_run_task ON agent_run(task_queue_id) WHERE task_queue_id IS NOT NULL;
CREATE INDEX idx_agent_run_heartbeat ON agent_run(last_heartbeat_at)
    WHERE status = 'running';

CREATE TABLE agent_run_todo (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    run_id            UUID NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,

    todo_key          TEXT NOT NULL,
    phase             TEXT,
    title             TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','in_progress','done','skipped','failed')),
    seq               INT NOT NULL DEFAULT 0,

    source            TEXT NOT NULL DEFAULT 'tool_trace'
                          CHECK (source IN ('tool_trace','reply','manual')),
    superseded_by     UUID REFERENCES agent_run_todo(id) ON DELETE SET NULL,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (run_id, todo_key)
);

CREATE INDEX idx_run_todo_run ON agent_run_todo(run_id, seq);
CREATE INDEX idx_run_todo_status ON agent_run_todo(status) WHERE status IN ('in_progress','failed');

CREATE TABLE agent_run_event (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    run_id            UUID NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,

    event_type        TEXT NOT NULL CHECK (event_type IN (
                          'heartbeat','todo_change','rate_limit','net_err','crash')),
    detail            JSONB NOT NULL DEFAULT '{}',

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_event_run ON agent_run_event(run_id, created_at DESC);
```

**语义**：
- 会话流（`task_message`）是事实源，`agent_run` / `agent_run_todo` / `agent_run_event` 是单向投影
- `todo_key`（如 `P0-T1`）跨 run 稳定，是合并主键；同 key 多轮执行以 `superseded_by` 串血缘
- `stall_reason` 复用 `agent_task_queue` 已有的真实等待态，不另造调度器
- **stuck 语义由 run 层承载**：`agent_run.status='stalled'` + `stall_reason` 描述卡死成因（rate_limited / network_lost / crashed / waiting_module_lock / waiting_local_directory）；todo 层不设 stuck 枚举值
  <!-- 定稿依据：459:14-15 run status 含 stalled；459:18-20 stall_reason CHECK；archive.json:179/241/246-247 前端已渲染 stall；issue_archive.go:670-678 stallDistribution 聚合 -->
- **孤儿检测（派生，不落列）**：关联 `agent_task_queue` 任务已终态（completed/cancelled）但该 run 下仍有 todo 为 pending/in_progress → 由 `GET /api/issues/{id}/progress` 响应的 `orphans` 字段返回
  <!-- 定稿依据：issue_archive.go:698-700 TODO 注释已描述该判据；:680-688 taskIndex 可直接派生；原型 f8 卡1 标题「派生状态（不落列）」(:1981)；issue.sql:13-14「不落列，永远与事实一致」-->

> **决策记录：为何 todo.status 不扩枚举加 stuck/orphan**
>
> 1. **三表无生产写入方**：`agent_run` / `agent_run_todo` / `agent_run_event` 的写入端点（`router.go:2043-2054`）虽已就绪，但投影器尚未实现（全仓 `INSERT INTO` 仅 `agent_run.go:279/586/767` 三处即端点自身），扩枚举只是给空表加两个永远为空的取值，收益为零。
> 2. **stuck/orphan 本质是跨表派生诊断态**：原型 `:2345` 的 stuck 文案「心跳 14min，429 ×3，自动重试排队中」描述的是 run 级事实（stall_reason + last_heartbeat_at），orphan 判据「task done 但 todo in_progress」是跨表条件 —— 落列会制造第二事实源。
> 3. **与仓内既定原则同构**：`issue.sql:13-14`「不落列，永远与事实一致」、原型 f8 卡1 标题「派生状态（不落列）」(`:1981`)。
> 4. **可逆**：将来若确需持久化，走 `451:29-40` 的 DROP/ADD CONSTRAINT 先例即可，表近 0 行无回填负担。

### 4.6 既有表扩展

```sql
-- migration 455 内附带：project 表新增档案资源指针
ALTER TABLE project
    ADD COLUMN archive_resource_id UUID REFERENCES project_resource(id) ON DELETE SET NULL;
-- 对称于 issue.repo_resource_id (452)；指向档案目录的 project_resource 行

-- migration 456 内附带：project_module 新增图谱桥接列
ALTER TABLE project_module
    ADD COLUMN graph_node_id TEXT;
-- 桥接 Community / BizObject：同名自动匹配，匹不上的进「未绑定」列表
```

### 4.7 表间关系

```
project ── archive_resource_id ──→ project_resource（档案目录）
project ── 1:N ──→ project_artifact ──→ issue（可选绑定）
project ── 1:N ──→ project_artifact ──→ attachment（快照）
project ── 1:N ──→ project_graph_snapshot ──→ ontology_object / _link / _changelog
project ── 1:N ──→ filing_item ──→ project_artifact（可选绑定）
project ── 1:1 ──→ project_archive_sync_config（同步策略配置）
project_module ── graph_node_id ──→ ontology_object.node_id（桥接）
issue ── 1:N ──→ agent_run ──→ agent_run_todo / agent_run_event
issue ── 1:N ──→ project_artifact（需求级档案）
filing_item ── 1:N ──→ filing_check_run
stage_gate_rule ── (project_id, stage, required_doc_type) ──→ project_artifact（存在性校验）
```

### 4.8 migration 460_stage_gate_rule（待建）— 阶段门规则

> **实现状态：实现中（migration 460）**，本轮另一 agent 正在新建。

原型 f8 卡4「阶段门与档案」(`:1997-1999`) 要求「6/8 齐备，缺 `test-plan` · `report-r2`，S3 门未闭合 → 阻止进 S4」；缺件行 (`:2076-2078`) 提供两个修复入口（「＋ 从模板创建」/「✨ 让 tester agent 补写」）；右栏档案完整度环 (`:2168-2172`) 用 conic-gradient 展示 6/8。anno② (`:2205`) 明确「阶段带只做聚合，下钻复用需求日历的四面板，避免两套阶段 UI」；anno⑤ (`:2208`)「环只算必备件」。

全仓 grep `stage_gate` 代码 0 命中（仅 `issue_archive.go:424-431` 的 TODO 注释、`deliverables-overview.tsx:66-72` 的 TODO 注释、原型 `:2620` 的示例文本 `StageGateGuard`）。**判定侧数据已有**（`project_artifact.stage` CHECK 1-4 + `doc_type` 开放式 TEXT 无 CHECK，`455:12-14`），**缺的是规则载体**。

```sql
-- migration 460_stage_gate_rule.up.sql
CREATE TABLE stage_gate_rule (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id        UUID REFERENCES project(id) ON DELETE CASCADE,
        -- NULL = workspace 级默认规则；非 NULL = 项目级覆盖
    track             TEXT NOT NULL DEFAULT 'default'
                          CHECK (track IN ('default','software_copyright','patent')),
    stage             INT NOT NULL CHECK (stage IN (1,2,3,4)),
    required_doc_type TEXT NOT NULL,
        -- 对应 project_artifact.doc_type；开放式字符串，不另建枚举
    blocking          BOOLEAN NOT NULL DEFAULT true,
        -- blocking=true：缺件阻止进入下一阶段；false：仅警告
    sort_order        INT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid), stage, required_doc_type)
);

CREATE INDEX idx_stage_gate_project ON stage_gate_rule(project_id, stage)
    WHERE project_id IS NOT NULL;
CREATE INDEX idx_stage_gate_workspace ON stage_gate_rule(workspace_id, stage)
    WHERE project_id IS NULL;
```

**规则来源优先级**：
1. 项目级（`project_id IS NOT NULL`）覆盖 workspace 级
2. 同项目同阶段的规则按 `sort_order` 排序
3. 查询逻辑：`SELECT * FROM stage_gate_rule WHERE (project_id = $1 OR (project_id IS NULL AND workspace_id = $2)) AND stage = $3`

**判定 SQL 思路**（与 `project_filing.go:358-390` 的 must 项判定同构）：
```sql
-- 阶段门闭合判定：某阶段所有 blocking 规则是否有对应 artifact
SELECT
    sgr.required_doc_type,
    sgr.blocking,
    EXISTS (
        SELECT 1 FROM project_artifact pa
        WHERE pa.project_id = $project_id
          AND pa.stage = sgr.stage
          AND pa.doc_type = sgr.required_doc_type
          AND pa.deleted_at IS NULL
    ) AS satisfied
FROM stage_gate_rule sgr
WHERE (sgr.project_id = $project_id
       OR (sgr.project_id IS NULL AND sgr.workspace_id = $workspace_id))
  AND sgr.stage = $stage
ORDER BY sgr.sort_order;
```

**两个修复入口的职责边界**：
| 入口 | 原型位置 | 归属 | 说明 |
|------|----------|------|------|
| 「✨ 让 agent 补写」 | `:2078` | **server** | 走既有 `agent_task_queue` 派发链路，创建一条 doc_type=required_doc_type 的任务 |
| 「＋ 从模板创建」 | `:2078` | **CLI** | 需在 git 目录落盘（读模板 + 写文件 + commit），server 不读文件系统 |

### 4.9 待建 schema 扩展 — f3 同步配置与档案覆盖

> 来源：原型 f3 画面 3 标注 (`:862-867`) 与导语 (`:708`, `:775`, `:786`, `:854`)。

#### 4.9.1 anno① 三种同步模式

原型文案：「hook 走增量（只算变动文件）、定时走全量校对（治漂移）、手动兆底；三者共用同一条幂等管道」。

**职责边界**：
- 增量/全量的差异发生在**扫描端**（CLI 决定扫哪些文件），server 只见清单（POST `/projects/{id}/artifacts/sync`），无需感知模式
- hook/定时触发器属 CLI（`cmd_archive.go` 的 `--mode=incremental|full|manual` 参数）
- server 侧只需存配置（供前端同步控制台渲染当前策略）

#### 4.9.2 anno② 冲突策略可配

原型文案：「默认路径优先（契约可预测）；选『进待审』则不自作主张，全部落到待绑定队列」。

**职责边界**：
- 判定发生在 CLI 解析阶段（设计文档 §10 已否决 server 直读文件系统）
- 「进待审」= CLI 不上报 `issue_id`，行落到 unbound 队列，server 已天然支持（`GET /projects/{id}/artifacts/unbound`）
- server 侧只需存配置（`conflict_policy` 列）

#### 4.9.3 anno③ 批量绑定阈值 conf ≥ 85%

原型文案 (`:786`)：「标题相似度 + key 后缀 + 时间窗」给候选，conf < 60% 建议新建需求。

**职责边界**：
- 候选算法所需数据（issue 标题 + requirement_key + 时间窗）**全在 DB 内，server 可自算，不必等 CLI**
- 但 `project_artifact.confidence` 列当前不存在，需 DDL

**待建列**：
```sql
ALTER TABLE project_artifact
    ADD COLUMN confidence NUMERIC(5,4);
    -- 范围 0.0000..1.0000；server 批量绑定时写入；NULL = 未经算法评估
```

#### 4.9.4 anno④ 写回优先于改库

原型文案：「保持 Git 为事实源的不变量；override 是逃生门而非常态」。

**职责边界**：
- git commit 只能本地做，属 CLI
- 「不被冲掉」是纯 server SQL 改动（软删语句加 `AND source <> 'manual'`、`ON CONFLICT DO UPDATE` 不覆盖 manual 行的 `issue_id`）

> **实现状态：修复中**。本轮另一 agent 正在作为 P0 数据丢失缺陷修复此不变量。

**不变量定义**：
1. `source='manual'` 的 artifact 行在全量清单 diff 时**不被软删**，即使文件已从磁盘消失
2. `ON CONFLICT (resource_id, rel_path, version) DO UPDATE` 时，若既有行 `source='manual'`，则**不覆盖** `issue_id` / `scope` / `stage` / `doc_type`
3. 仅当用户显式 PATCH 并填写 `override_reason` 时才可改动 manual 行的契约推导结果

**当前 `project_artifact.source`** (`455:23-24`, CHECK `sync/agent/server/manual`) **只能表达「谁是写入方」，不能表达优先级，更不能阻止覆盖** —— 这是 anno④⑤ 必须新增列而非复用 source 的根本原因。

#### 4.9.5 anno⑤ override 必须填原因

原型文案：「否则下一次 sync 无法区分『人工修正』与『路径写错』，会反复覆盖」。

**待建列**：
```sql
ALTER TABLE project_artifact
    ADD COLUMN override_reason TEXT;
    -- source='manual' 且改动了契约推导结果时必填；其余情况为 NULL
```

**server 校验规则**：PATCH `/projects/{id}/artifacts/{artifact_id}` 请求体中，若 `source` 将被置为 `'manual'` 且改动涉及 `issue_id` / `scope` / `stage` / `doc_type`，则 `override_reason` 非空，否则返回 400。

#### 4.9.6 sync_diagnostics 表（待建）

原型文案 (`:775`)：「失败项不阻塞其余入库，错误进 `sync_diagnostics`」。

**写入方只能是 CLI**：server 只收到一次 HTTP 请求（全量清单 POST），无法区分扫描/解析/上传三阶段；各阶段错误由 CLI 逐条上报。

前端已如实记录当前缺失（4 语 `archive.json:67` 「各阶段状态由最近一次同步结果推断——真实分阶段回报需 CLI 侧支持（暂无 sync_diagnostics 表）」；`sync-console.tsx:59-64` TODO）。

```sql
-- 待建 migration（建议 461 或合并入 460）
CREATE TABLE sync_diagnostics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,

    sync_run_id     TEXT NOT NULL,
        -- CLI 每次 sync 生成的唯一标识（如 UUID 或 timestamp-based）
    stage           TEXT NOT NULL CHECK (stage IN ('scan','parse','upload','index','recount')),
        -- 对应原型五阶段流水线（sync-console.tsx 已渲染）
    rel_path        TEXT,
        -- 失败的文件路径（全量校对时可为 NULL）
    level           TEXT NOT NULL CHECK (level IN ('error','warning','info')),
    message         TEXT NOT NULL,
    detail          JSONB NOT NULL DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_diag_project ON sync_diagnostics(project_id, created_at DESC);
CREATE INDEX idx_sync_diag_run ON sync_diagnostics(sync_run_id);
```

#### 4.9.7 project_archive_sync_config 表（待建）

原型 f3 导语 (`:708`) 要求「同步必须可配（模式 / 范围 / 冲突策略）」。

**配置存放点结论**：
- `project` 表 (`034_projects.up.sql:2-14`) **无任何 JSONB 配置列**，后续 ALTER 只有 `035_project_priority` 与 `455:45-46`（archive_resource_id）
- `project_resource.resource_ref` 虽是 JSONB (`065:10`)，但参与 `UNIQUE (project_id, resource_type, resource_ref)` (`:15`)，**改它等于改身份，不可用**
- → **必须新建独立配置表**

```sql
-- 待建 migration（建议 461 或合并入 460）
CREATE TABLE project_archive_sync_config (
    project_id      UUID PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,

    sync_mode       TEXT NOT NULL DEFAULT 'manual'
                        CHECK (sync_mode IN ('hook','scheduled','manual')),
        -- hook = git post-commit 增量；scheduled = 定时全量校对；manual = 手动触发
    conflict_policy TEXT NOT NULL DEFAULT 'path_first'
                        CHECK (conflict_policy IN ('path_first','review_queue')),
        -- path_first = 路径契约优先；review_queue = 不确定时全部进待绑定队列
    scope_filter    JSONB NOT NULL DEFAULT '{}',
        -- 范围过滤：{ "include": ["requirements/", "overview/"], "exclude": ["_shared/legacy/"] }
    batch_bind_threshold NUMERIC(5,4) NOT NULL DEFAULT 0.85,
        -- anno③ 批量绑定阈值；conf < 此值的候选必须人工确认
    cron_expr       TEXT,
        -- sync_mode='scheduled' 时的 cron 表达式

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### 4.9.8 解绑语义

原型文案 (`:854`)：「解除关联 = 软删 artifact 行（`deleted_at`），不删 git 文件；下次 sync 若文件仍在且契约命中，会重新入库并提示“曾手动解除”避免反复拉扯。」

实现方式：既有 `deleted_at` 软删已足够；「提示曾手动解除」需 CLI 在 sync 时检查 `deleted_at IS NOT NULL AND source='manual'` 的行，若重新命中则在 `sync_diagnostics` 中记录 warning。

## 5. API 契约

按 5 大模块分组。所有端点遵循既有 `/api/` 前缀与 workspace RLS 约定。

### 5.1 档案同步（Archive Sync）

| 方法 | 路径 | 请求类型 | 响应类型 | 说明 |
|------|------|---------|---------|------|
| POST | `/projects/{id}/artifacts/sync` | `ArtifactSyncRequest` | `ArtifactSyncResponse` | 全量清单 diff：upsert 命中行、软删缺席行，重跑幂等 |
| GET | `/projects/{id}/artifacts` | query: `scope?, stage?, issue_id?, page, limit` | `PaginatedResponse<ArtifactDTO>` | 档案列表（排除 `deleted_at IS NOT NULL`） |
| GET | `/projects/{id}/artifacts/{artifact_id}` | — | `ArtifactDTO` | 单条详情（含 attachment 快照状态） |
| PATCH | `/projects/{id}/artifacts/{artifact_id}` | `ArtifactPatchRequest` | `ArtifactDTO` | 手动修改 scope / stage / issue_id / doc_type；记 `source='manual'` |
| POST | `/projects/{id}/artifacts/{artifact_id}/archive` | `ArchiveActionRequest` | `ArtifactDTO` | 从交付物卡片归档：选 scope / stage / doc_type，CLI 写入档案目录并上传快照 |
| GET | `/projects/{id}/artifacts/unbound` | query: `page, limit` | `PaginatedResponse<UnboundArtifact>` | 待绑定列表（有 requirement_key 但无 issue_id） |
| POST | `/projects/{id}/artifacts/{artifact_id}/bind` | `BindIssueRequest` | `ArtifactDTO` | 手动绑定到 issue |

**关键类型**：

```typescript
interface ArtifactSyncRequest {
  items: Array<{
    relPath: string;
    blobSha: string;
    scope: 'shared' | 'project' | 'requirement';
    stage?: 1 | 2 | 3 | 4;
    docType: string;
    version: number;
    requirementKey?: string;
    issueId?: string;
    sizeBytes: number;
    attachmentId?: string;
  }>;
}

interface ArtifactSyncResponse {
  upserted: number;
  created: number;
  updated: number;
  softDeleted: number;
  unchanged: number;
  rejected: Array<{ path: string; reason: string }>;
  prototypeConsistency: { versions: number; artifacts: number; match: boolean };
}
```

### 5.2 图谱与本体（Graph & Ontology）

| 方法 | 路径 | 请求类型 | 响应类型 | 说明 |
|------|------|---------|---------|------|
| POST | `/projects/{id}/graph/sync` | `GraphSyncRequest` | `GraphSyncResponse` | 图谱快照入库（git_sha 判重） |
| GET | `/projects/{id}/graph/latest` | — | `GraphSnapshotDTO` | 最新一份快照（画面 10/11 数据源） |
| GET | `/projects/{id}/graph/history` | query: `limit?` | `GraphSnapshotDTO[]` | 最近 5 份快照列表 |
| GET | `/projects/{id}/graph/communities` | — | `CommunityDTO[]` | 从最新快照提取 Community 列表 |
| GET | `/projects/{id}/ontology/objects` | query: `entity_4e?, domain?` | `OntologyObjectDTO[]` | 本体对象列表（本体未抽取时返回空） |
| GET | `/projects/{id}/ontology/links` | query: `source_node_id?, link_type?` | `OntologyLinkDTO[]` | 本体边列表 |
| GET | `/projects/{id}/ontology/changelog` | query: `limit?` | `OntologyChangelogDTO[]` | 迭代变更记录 |

**关键类型**：

```typescript
interface GraphSyncRequest {
  scanId: string;
  gitSha: string;
  gitnexusVersion: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: Community[];
  stats: GraphStats;
}

interface GraphSyncResponse {
  inserted: boolean;   // false = git_sha 未变，跳过
  snapshotId: string;
  cleanedUp: number;   // 超出 5 份被清理的数量
}

interface GraphSnapshotDTO {
  id: string;
  scanId: string;
  gitSha: string;
  gitnexusVersion: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: Community[];
  stats: GraphStats;
  createdAt: string;
}
```

### 5.3 模块桥接（Module Bridge）

| 方法 | 路径 | 请求类型 | 响应类型 | 说明 |
|------|------|---------|---------|------|
| GET | `/projects/{id}/modules` | — | `ModuleDTO[]` | 模块列表（含 graph_node_id 桥接状态） |
| PATCH | `/projects/{id}/modules/{module_id}` | `ModulePatchRequest` | `ModuleDTO` | 手动绑定 / 解绑 graph_node_id |
| GET | `/projects/{id}/modules/{module_id}/detail` | query: `sub_tab` | `ModuleDetailDTO` | 模块详情（变更概览 / 模块对象 / 模块策略 / 图谱邻域） |
| GET | `/projects/{id}/modules/unbound` | — | `UnboundCommunityDTO[]` | 未绑定的图谱 Community 列表 |

**关键类型**：

```typescript
interface ModuleDTO {
  id: string;
  name: string;
  color: string;
  taskCount: number;
  graphNodeId: string | null;
  boundCommunity: string | null;
  objectCount: number;
  strategyCount: number;
  requirementCount: number;
  taskProgress: { done: number; total: number };
}

interface ModuleDetailDTO {
  overview: {
    requirements: Array<{ id: string; title: string; status: string }>;
    tasks: { done: number; doing: number; stuck: number; total: number };
    // stuck 为派生字段：run.status='stalled' 或 todo.status='in_progress' 且心跳超阈值，
    // 卡死成因由 agent_run.stall_reason 承载，不落列到 todo.status。
    acceptanceAvg: number;
    rollbackCount: number;
  };
  objects: Array<{ name: string; type: string; implStatus: string; tables: string[] }>;
  strategies: Array<{ key: string; value: string; source: string; status: string }>;
  graphNeighborhood: { nodes: GraphNode[]; edges: GraphEdge[] };
}
```

### 5.4 申报就绪度（Filing Readiness）

| 方法 | 路径 | 请求类型 | 响应类型 | 说明 |
|------|------|---------|---------|------|
| GET | `/projects/{id}/filing/readiness` | — | `FilingReadinessDTO` | 就绪度总览（三档聚合 + 阻塞项） |
| POST | `/projects/{id}/filing/check` | — | `FilingCheckResponse` | 触发全量校验（sync 时自动调用） |
| GET | `/projects/{id}/filing/items` | query: `track?, tier?` | `FilingItemDTO[]` | 清单项列表 |
| PATCH | `/projects/{id}/filing/items/{item_id}` | `FilingItemPatchRequest` | `FilingItemDTO` | 手动修改状态（**实现中**，router.go 尚未注册） |
| POST | `/projects/{id}/filing/export` | `FilingExportRequest` | `FilingExportResponse` | 导出申报包 / 诊断包；必备未齐时拒绝申报包 |
| POST | `/projects/{id}/filing/writeback` | — | `{ commitSha: string }` | 回写 READINESS.md 到档案目录 |
| GET | `/projects/{id}/filing/cross-project` | — | `CrossProjectReadinessDTO[]` | 跨项目必备件就绪对比 |

**关键类型**：

```typescript
interface FilingReadinessDTO {
  tracks: Array<{
    track: 'software_copyright' | 'patent';
    must: { total: number; passed: number; items: FilingItemDTO[] };
    conditional: { total: number; passed: number; items: FilingItemDTO[] };
    aux: { total: number; passed: number; items: FilingItemDTO[] };
  }>;
  blockingItems: Array<{ priority: 'P0' | 'P1' | 'P2'; message: string }>;
  canExportFiling: boolean;
}

interface FilingExportRequest {
  track?: 'software_copyright' | 'patent'; // 缺省 = 全部轨道
}
// 定稿依据：filing.ts:95-97 FilingExportRequest；project_filing.go:515-520 使用 full/diagnostic
// 实际导出类型由 server 根据 must 项就绪度自动决定，不由请求方指定

interface FilingExportResponse {
  success: boolean;
  export_type: 'full' | 'diagnostic'; // server 自动决定
  export_log_id: string;
  reason: string;            // must 未齐时列出缺失 item_key
  structure: string;         // 包目录树文本
  artifact_ids: string[];    // 勾选进包的档案 ID
}
```

### 5.5 运行追踪（Agent Run Tracking）

| 方法 | 路径 | 请求类型 | 响应类型 | 说明 |
|------|------|---------|---------|------|
| GET | `/api/issues/{id}/agent-runs` | — | `ListAgentRunsResponse` | 需求下全部运行记录（含子需求经 root_issue_id 汇入） |
| GET | `/api/agent-runs/{runId}/todos` | — | `ListAgentRunTodosResponse` | 单次运行的待办列表 |
| GET | `/api/agent-runs/{runId}/events` | query: `limit?` | `ListAgentRunEventsResponse` | 运行事件流（心跳 / 卡死 / 限流） |
| GET | `/api/issues/{id}/progress` | — | `IssueProgressResponse` | 三层 rollup（需求 → 任务 → 运行 → 待办） |
| POST | `/api/agent-runs/{runId}/todos/{todoKey}/override` | `TodoOverrideRequest` | `AgentRunTodoDTO` | 人工改判状态（`source=manual`）—— **未实现，待排期** |
| POST | `/api/agent-runs/{runId}/stuck/{todoKey}/reassign` | `ReassignRequest` | `AgentRunDTO` | 卡死任务改派 —— **未实现，待排期** |

<!-- 定稿依据：router.go:1931 GET /agent-runs；:2046 r.Route("/api/agent-runs")；:2049 GET /{runId}/todos；
     override/reassign 全仓 grep 0 命中，确认未实现 -->

**关键类型**：

```typescript
interface RequirementProgressDTO {
  requirement: { id: string; title: string; weighted: number };
  tasks: Array<{
    id: string;
    title: string;
    agent: string;
    status: string;
    runId: string | null;
    todos: { done: number; total: number };
  }>;
  runs: Array<{
    id: string;
    agentId: string;
    model: string;
    cliKind: string;
    status: string;
    heartbeatAge: string;
    stallReason: string | null;
    tokenUsed: number;
    todosProgress: { done: number; total: number };
  }>;
  stallDistribution: Record<string, number>;
  lineages: Array<{ todoKey: string; chain: string[] }>;
  orphans: Array<{ todoKey: string; reason: string }>;
}
```

## 6. 前端组件树

### 6.1 目录结构

```
packages/views/
├── archive/                          # 档案主视图（画面 4–6）
│   ├── archive-tab.tsx               # 项目详情「档案」Tab 入口
│   ├── archive-matrix.tsx            # 阶段 × 需求矩阵（上半 project + 下半 requirement）
│   ├── artifact-chip.tsx             # 文档 chip（版本 + 来源徽标）
│   ├── artifact-preview-dialog.tsx   # 预览弹窗（快照 → RichContent + ←→ 导航）
│   ├── artifact-metadata-drawer.tsx  # 底部元数据抽屉
│   ├── archive-action-dialog.tsx     # 交付物归档弹窗（选 scope/stage/doc_type）
│   └── unbound-list.tsx              # 待绑定列表
│
├── requirement-drill/                # 需求级下钻（画面 7–9）
│   ├── requirement-activity-tab.tsx  # 需求动态 Tab（子任务动态汇总）
│   ├── delivery-overview-tab.tsx     # 交付概览 Tab（状态卡 + 四阶段带 + 交付物）
│   ├── progress-tracking-tab.tsx     # 进度追踪 Tab（三层树 + 运行存活度）
│   ├── run-vitals-strip.tsx          # 运行存活度条
│   ├── todo-tree.tsx                 # 需求 → 任务 → 待办三层树
│   └── stall-distribution.tsx        # 卡死 / 等待原因分布图
│
├── graph/                            # 全局分析（画面 10–11）
│   ├── product-function-tab.tsx      # 产品功能 Tab（左右分栏）
│   ├── module-list-panel.tsx         # 左栏模块列表
│   ├── module-detail-panel.tsx       # 右栏四子 TAB
│   ├── module-overview-pane.tsx      # 子 TAB 1：变更概览
│   ├── module-objects-pane.tsx     # 子 TAB 2：模块对象
│   ├── module-strategies-pane.tsx    # 子 TAB 3：模块策略
│   ├── module-graph-pane.tsx         # 子 TAB 4：图谱邻域
│   ├── data-model-tab.tsx           # 数据模型 Tab（总线矩阵）
│   ├── bus-matrix-table.tsx          # 总线矩阵表格
│   ├── matrix-cell-drilldown.tsx     # 格子下钻弹窗
│   └── matrix-alerts-panel.tsx       # 矩阵告警面板
│
├── filing/                           # 申报产出（画面 12）
│   ├── filing-readiness-page.tsx     # 申报就绪度看板
│   ├── filing-item-card.tsx          # 单条清单项卡片
│   ├── filing-check-detail.tsx       # 校验详情（页数 / 行数 / 一致性）
│   ├── filing-export-dialog.tsx      # 导出弹窗（申报包 / 诊断包）
│   └── cross-project-readiness.tsx   # 跨项目就绪对比
│
└── common/
    └── archive/
        ├── use-artifacts.ts          # 档案查询 hook
        ├── use-graph-snapshot.ts     # 图谱快照 hook
        ├── use-module-detail.ts      # 模块详情 hook
        ├── use-filing-readiness.ts   # 申报就绪度 hook
        ├── use-requirement-progress.ts # 需求进度 hook
        └── archive-types.ts          # 公共类型定义
```

### 6.2 数据层 hooks

| Hook | 查询键 | 数据源 | 消费画面 |
|------|--------|--------|---------|
| `useArtifacts(projectId, filters)` | `['artifacts', projectId, filters]` | `GET /projects/{id}/artifacts` | 4, 5, 6 |
| `useArtifactPreview(artifactId)` | `['artifact-preview', artifactId]` | `GET /attachments/{id}/content` | 5 |
| `useGraphSnapshot(projectId)` | `['graph-snapshot', projectId]` | `GET /projects/{id}/graph/latest` | 10, 11 |
| `useModules(projectId)` | `['modules', projectId]` | `GET /projects/{id}/modules` | 10, 11 |
| `useModuleDetail(projectId, moduleId, subTab)` | `['module-detail', projectId, moduleId, subTab]` | `GET /projects/{id}/modules/{mid}/detail` | 10 |
| `useFilingReadiness(projectId)` | `['filing-readiness', projectId]` | `GET /projects/{id}/filing/readiness` | 12 |
| `useRequirementProgress(issueId)` | `['req-progress', issueId]` | `GET /issues/{id}/progress` | 9 |
| `useAgentRuns(issueId)` | `['agent-runs', issueId]` | `GET /issues/{id}/runs` | 7, 9 |

### 6.3 project-detail.tsx Tab 注册

在既有 Tab 列表（看板 / 列表 / 甘特图 / 日历）之后追加：

```typescript
// packages/views/projects/project-detail.tsx
const TABS = [
  // ... 既有 tabs
  { key: 'archive',         label: '档案',     component: ArchiveTab },         // 画面 4
  { key: 'product-function', label: '产品功能', component: ProductFunctionTab }, // 画面 10
  { key: 'data-model',      label: '数据模型', component: DataModelTab },       // 画面 11
];
```

需求详情 `issue-detail.tsx` 在既有「动态」Tab 之上并列：

```typescript
// packages/views/issues/components/issue-detail.tsx
const DETAIL_TABS = [
  { key: 'delivery-overview',  label: '交付概览', component: DeliveryOverviewTab },  // 画面 8
  { key: 'activity',           label: '动态',     component: ActivityTab },          // 既有 + 画面 7 增强
  { key: 'progress-tracking',  label: '进度追踪', component: ProgressTrackingTab },  // 画面 9
];
```

## 7. 跨画面衔接

| # | 生产方 | 消费方 | 桥接键 | 说明 |
|---|--------|--------|--------|------|
| 1 | CLI sync → `project_artifact` | 画面 4 档案矩阵 | `project_id` + `scope` + `stage` | sync 写入全量 artifact 行，矩阵按 scope/stage 聚合渲染 |
| 2 | `issue_prototype_version`（454 既有） | 画面 4 原型列 + 画面 5 预览 | `html_path` → `artifact.rel_path` | 原型版本表是权威，artifact 行是单向投影；sync 校验 8↔8 一致 |
| 3 | 画面 6 归档动作 | `project_artifact` | `issue_id` + `stage` + `doc_type` | 交付物卡片归档写入 artifact 行（source='agent'），矩阵实时刷新 |
| 4 | `project_graph_snapshot`（456） | 画面 10 模块列表 + 画面 11 总线矩阵 | `project_id` + `scan_id` | 图谱快照是两 Tab 的共同数据源，Community 驱动模块列表 |
| 5 | `project_module.graph_node_id` | 画面 10 右栏四子 TAB | `graph_node_id` → `ontology_object.node_id` | 桥接 Community 到模块，驱动变更概览 / 模块对象 / 图谱邻域 |
| 6 | `agent_run` / `agent_run_todo`（459） | 画面 9 进度追踪 | `issue_id` → `root_issue_id` | 运行追踪投影到三层树，`todo_key` 跨 run 合并血缘 |
| 7 | `filing_item`（458） | 画面 12 就绪度看板 | `project_id` + `track` + `item_key` | sync 时重算规则，看板消费聚合结果 |
| 8 | 画面 12 导出 | `filing_export_log` | `project_id` + `export_type` | 导出结果写入日志；申报包被拒降级为诊断包 |
| 9 | 画面 4 矩阵选中 | 画面 5 预览弹窗 | `artifact_id` | 矩阵 chip 点击打开预览，弹窗内 ←→ 跨阶段导航 |

## 8. 执行分期

| Phase | 内容 | 依赖 | 产出 |
|-------|------|------|------|
| 0 | 目录契约 + 存量迁移脚本 | 无 | `CONTRACT.md` + `git mv` 一次性脚本 + dry-run 验证 |
| 1 | migration 455–459 DDL + down.sql | Phase 0 | 6 个 migration 文件 + 回填验证 |
| 2 | CLI sync 管道（`cmd_archive.go`） | Phase 1 | 扫描 + 路径解析 + blob_sha + 差量上传 + 全量清单 sync |
| 3 | Server artifact API + 图谱 sync API | Phase 1 | handler/archive.go + service/artifact.go + handler/graph.go |
| 4 | 前端档案 Tab（画面 4–6）| Phase 3 | archive/ 目录组件 + useArtifacts hook + 预览弹窗 |
| 5 | 前端需求下钻（画面 7–9）| Phase 3 + 459 | requirement-drill/ 目录 + 进度追踪 + 运行存活度 |
| 6 | 前端全局分析（画面 10–11）+ 申报（画面 12） | Phase 3 + 456/457/458 | graph/ + filing/ 目录 + 模块桥接 + 就绪度看板 |

Phase 0–2 可与需求日历（`2026-09-04-requirement-calendar-design.md`）并行推进；Phase 4–6 之间有共享组件依赖（`artifact-chip` / `archive-types`），需按序。

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 存量目录路径不规范 | 大量文件落「待绑定」 | Phase 0 的迁移映射表 + 一次性 `git mv` 脚本 + dry-run |
| GitNexus 本体层长期未实现 | 画面 10 策略 / 画面 11 迭代视角无数据 | 降级为 migration / 代码实证展示，本体就绪后自动接管无需改 UI |
| 图谱快照体积大 | DB 膨胀 | 保留最近 5 份 + >100MB 只索引不上传 + git_sha 判重 |
| 档案 Tab 成上帝模块 | 维护成本 | 严格只读聚合，不产生业务写；组件按 scope 隔离 |
| 多端快照渲染一致性 | web / desktop / mobile 显示差异 | 统一走 `attachment/content` → `RichContent`，不依赖 daemon |

## 10. 被否决的替代方案

| 方案 | 否决原因 |
|------|---------|
| server 端直接读文件系统 | 违反「零 daemon 改动」原则；web / mobile 无法直连本地文件 |
| 图谱数据实时查询 GitNexus MCP | 延迟不可控（大图 >5s）；快照入库可离线展示 |
| artifact 行持久化文档全文 | 与 Git 事实源冲突；DB 膨胀；版本管理复杂化 |
| 本体层完整实现后再出 UI | 阻塞画面 10/11 全部功能；降级方案可先跑通图谱层 |
| 申报就绪度纯人工维护 | 违背「关键信息系统化收集」目标；机器校验 + 三档契约是核心价值 |

## 11. 交付产出清单

| 产出 | 路径 | 说明 |
|------|------|------|
| 目录契约文档 | `projects_mgmt/CONTRACT.md` | CLI 与 agent 共读的机读契约 |
| 存量迁移脚本 | `scripts/migrate-archive-structure.sh` | 一次性 `git mv` + dry-run |
| migration 455–459 | `server/migrations/455-459.*.sql` | DDL + up + down |
| CLI archive sync | `server/cmd/multica/cmd_archive.go` | 扫描 + 上传 + sync |
| Server handler | `server/internal/handler/archive.go` + `graph.go` + `filing.go` + `run_tracking.go` | REST API |
| Server service | `server/internal/service/artifact.go` + `graph_bridge.go` + `filing_readiness.go` | 业务逻辑 |
| 前端 archive/ | `packages/views/archive/` | 画面 4–6 组件 |
| 前端 requirement-drill/ | `packages/views/requirement-drill/` | 画面 7–9 组件 |
| 前端 graph/ | `packages/views/graph/` | 画面 10–11 组件 |
| 前端 filing/ | `packages/views/filing/` | 画面 12 组件 |
| 数据层 hooks | `packages/views/common/archive/` | 查询 + 类型 |
| i18n | `packages/views/locales/*/archive.json` + `filing.json` | 四语言 |

## 12. 待建对象与交付物清单（实现状态跟踪）

> 本节记录所有已确认缺失的对象及其归属（server / CLI / schema），供实现者查阅。

### 12.1 schema 待建

| 对象 | 说明 | 归属 | 状态 |
|------|------|------|------|
| `stage_gate_rule` 表 | 阶段门规则载体（详见 §4.8） | schema | 实现中（migration 460） |
| `sync_diagnostics` 表 | CLI 分阶段诊断日志（详见 §4.9.6） | schema | 待建 |
| `project_archive_sync_config` 表 | 同步模式/冲突策略/范围过滤配置（详见 §4.9.7） | schema | 待建 |
| `project_artifact.confidence` 列 | 批量绑定置信度 0..1（详见 §4.9.3） | schema | 待建 |
| `project_artifact.override_reason` 列 | 人工覆盖原因（详见 §4.9.5） | schema | 待建 |
| `filing_export_log.artifact_ids` 列 | 勾选结果当前暂存于 `readiness_snapshot` JSONB (`project_filing.go:451-453`) | schema | 待建（低优先级） |

### 12.2 CLI 待建

| 对象 | 说明 | 状态 |
|------|------|------|
| `server/cmd/multica/cmd_archive.go` | 设计文档 §8 Phase 2「CLI sync 管道」整期未做。含：目录扫描 → 路径契约解析 → blob_sha → 差量上传 → 全量清单提交 → hook/定时触发 → **PDF 版面解析（页数/每页行数/页眉文本抽取）** → 分阶段 diagnostics 上报 | 未实现 |
| `projects_mgmt/CONTRACT.md` | §11 列入交付清单，但全 workspace grep 0 命中；`projects_mgmt/` 目录本身不存在，而路径契约解析依赖它 | 未实现 |
| `scripts/migrate-archive-structure.sh` | §11 列入交付清单，全 workspace grep 0 命中 | 未实现 |

### 12.3 投影器待建（f9 点不亮的根因）

`agent_run` / `agent_run_todo` / `agent_run_event` 三表的写入方不存在。

**证据**：
- 全仓非测试代码中 `INSERT INTO` 这三表仅 3 处，全在 `agent_run.go:279 / 586 / 767`（即三个 REST 写端点自身）
- `server/internal/daemon/` 与 `server/cmd/multica/` 对 `/api/agent-runs` **零调用**
- `router.go:2043-2054` 注释称其为「the projector's write endpoints」但**投影器本身不存在**
- 前端 `packages/core/agent-runs/mutations.ts:22,46` 的 `useUpsertAgentRunTodos` / `useAppendAgentRunEvents` 同样**零组件消费者**
- `archive.json:203` 已如实记录「进展/状态事件为空——agent_run_event 投影器尚未写入。当前仅展示 task_message 对话。」

**因果链**：投影器不存在 → 三表永远为空 → f9 进度追踪的「运行存活度」「待办三层树」「卡死分布」全部点不亮。**改 status 枚举解决不了这个问题** —— 枚举已正确，缺的是写入方。

**归属**：投影器属 CLI/daemon 层（会话流解析 → 调用 POST `/api/agent-runs` + POST `/{runId}/todos` + POST `/{runId}/events`）。

### 12.4 PDF 类规则的上报契约建议

`filing_check_run.page_count / lines_per_page / header_consistency` 三列当前为死列（`458:35-37`，从无写入）。

**server 侧不可行的原因**：
- `file.go:53` 附件预览硬上限 2 MB
- `isTextPreviewable` (`:1338-1385`) 白名单排除 PDF 故返回 415
- 设计文档 §10 已否决 server 直读文件系统

**建议方案**：`ArtifactSyncItemRequest` (`project_artifact.go:134-145`) 或新的 check 上报端点增加 `pageCount` / `linesPerPage` / `headerText` 字段，CLI 在本地解析 PDF 后上报，server 侧写入 `filing_check_run`。

### 12.5 空转资产清单（已就位但无人调用）

| 资产 | 位置 | 说明 |
|------|------|------|
| 8 个零消费者 query hook | `packages/core/` | `projectArtifactDetailOptions` / `projectArtifactMatrixOptions` / `graphSnapshotDetailOptions` / `busMatrixOptions` / `filingItemsOptions` / `agentRunsForIssueOptions` / `agentRunTodosOptions` / `agentRunEventsOptions` |
| `issueRolesOptions` | `packages/core/issues/queries.ts:199-206` | 后端表/handler/路由/client 五层全就绪但前端零消费者，且只返回裸 UUID 而全仓无 agent/member 名称解析 hook |
| `api.upsertAgentRun()` | `client.ts:4105` | 前端 API 封装已就绪，零组件调用 |
| `GET /artifacts/matrix` | `router.go:2004` | 零前端消费者，f4 矩阵由前端自算 |

### 12.6 归属分类统计

| 归属 | 数量 | 包含 |
|------|------|------|
| **server 可做** | 4 | 批量绑定候选算法、orphan 派生、stage_gate 判定 SQL、「让 agent 补写」派发 |
| **需 schema** | 6 | stage_gate_rule、sync_diagnostics、project_archive_sync_config、confidence 列、override_reason 列、artifact_ids 列 |
| **需 CLI** | 5 | cmd_archive.go 整期、CONTRACT.md、migrate-archive-structure.sh、投影器、「从模板创建」 |

