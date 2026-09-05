# 需求日历与角色化流水线 — 产品架构与数据模型设计

- 日期：2026-09-04（初稿）· 2026-09-06（校订至最终态）
- 状态：**唯一事实源（已定稿）** — 与 `server/migrations/451–460` 实际实现逐条对齐
- 原型：`2026-09-04-requirement-calendar-prototype.html`（7 画面，同目录）
- 架构图：`2026-09-04-requirement-calendar-architecture.html`（同目录）
- 关联文档：`2026-09-04-module-dependency-scheduling-design.md`（组间互斥语义需并入修订，见 §7.4）、`2026-09-04-task-deliverables-design.md`（原型 HTML 产物复用其展示管道）、`2026-09-05-project-archive-design.md`（相邻 migrations 455–460 的归属 spec，见 §5.4）

### 校订记录

**2026-09-06 校订至 migrations 451–460 最终态**（只改文档，未改任何代码）。以 `server/migrations/*.up.sql`、`server/pkg/db/queries/{issue,requirement,module,agent}.sql`、`server/internal/handler/issue.go`、`server/internal/daemon/module_locker.go` 为实证源，修正的关键偏差：

| # | 偏差（校订前） | 最终态（实证） | 证据 |
|---|----------------|----------------|------|
| 1 | §5.1 DDL 缺 `acceptance_round` 列 | 补入 `acceptance_round INT NOT NULL DEFAULT 0`（**默认值 0**，位于 452 第 15 行；此前设计既未列该列、口传默认值「1/15」均不实） | `452:15` |
| 2 | §5.1 把 452 拆成多条 `ALTER TABLE` | 实为**单条 `ALTER TABLE issue`**（452:6–19）一次性加 13 列 | `452:6-19` |
| 3 | §5.1/§11 称 `due_date` 保持 `TIMESTAMPTZ` 且序列化改全 ISO | `due_date` 最终态是 **`DATE`（日历日）**；分钟粒度时间轴由 `start_at TIMESTAMPTZ` 承载（见 §5.1 定稿说明） | `112:14-16`、`issue.go:3575-3601` |
| 4 | 未提 `graph_context` 默认值 / 递归回填 | `graph_context JSONB NOT NULL DEFAULT '{}'`（452:18）；`root_requirement_id` 递归 CTE 回填在 452:21–28 | `452:18,21-28` |
| 5 | 未覆盖 456/457/458/460 | 新增 §5.4 校准：456 `module_summary`/`bus_matrix`、457 `entity_type`/`source_id`/`target_id`、458 `source_path` 死列、460 唯一键重构 + **8 条种子规则** | `456:19-20`、`457:12,30-31`、`458:21`、`460:45-50,68-82` |
| 6 | §6 标题「8 态」但表列 9 行 | **10 态已落地**（`issue.sql` CASE 实时投影，含第 10 态「验收失败」= `acceptance_round>3`，WS4） | `issue.sql` ListIssues CASE |
| 7 | §14 仅 2 条待确认 | 扩为**开放问题定稿裁决**（逐条给最终决策） | 见 §14 |
| 8 | 缺运行时机制数据契约 | 新增 §7.5：到点触发 loop / ModuleLocker v2 / 验收 verdict / agent_run 投影 / 依赖 DAG 闸门 | 见 §7.5 |

## 1. 背景与目标

把「需求」从普通 issue 升级为**带时间窗口、目标、git 库与角色班底的一等公民**：用户在日历上按周/月俯瞰全部需求；需求按四阶段角色化流水线（原型 → PM plan+拆解 → 执行 → 验收）自动流转；同模块跨需求组互斥防冲突；到达开始时间自动触发执行。

**目标**：
1. 日历视图（周/月）承载需求全生命周期可视化（原型画面 1/2）
2. 创建需求时配置目标、git 库、分钟粒度时间窗口、角色班底（横向启停）、拆解模式、自动触发（画面 3）
3. 原型师一键构建可视化原型 + 实现细节逐项标记 + 提示词回流重生成（画面 4）
4. PM 先出 plan 再拆解，子任务携带功能点明细（新增/改造）+ GitNexus 图谱影响面 + 验收代码；左基础信息右子任务明细，确认后自动生成自动化任务（画面 5）
5. 定时触发与执行调度（DAG + 组间互斥）独立成画面（画面 6）
6. 测试 agent 系统化验收 + 不通过自动打回 + 轮次上限（画面 7）

## 2. 已确认的产品决策（汇总，全部来自原型评审）

| # | 决策 | 结论 |
|---|------|------|
| 1 | PM 承担者 | agent 与人类成员皆可 |
| 2 | 拆解模式 | 三种：全自动 / 拆解+人工确认 / 纯人工 |
| 3 | 执行触发 | 到达开始时间自动触发（可关，手动触发兜底） |
| 4 | 日历交互 | 只读展示 + 点击进详情 + 拖拽调期 + 色块内显示进度 |
| 5 | 拆解模板 | 系统内置固定模板（功能点/图谱影响面/验收代码/执行人/依赖） |
| 6 | 角色配置 | 项目默认班底 + 需求级覆盖；PM/研发必选，原型师/数据/测试可启停 |
| 7 | 图谱集成 | **agent 端 MCP 自主查询** GitNexus（非 server 端快照入库） |
| 8 | 验收代码 | 业务仓 `acceptance/` 目录，版本随功能调整才升版 |
| 9 | 验收阶段 | 独立验收 stage + 不通过自动打回（上限 3 轮转人工） |
| 10 | 组间互斥 | 同模块跨需求组自动互斥；**终态即释放**（含 failed/cancelled） |
| 11 | 时间粒度 | 开始/截止时间精确到分钟（`datetime-local · step=60`）；日历按日聚合，hover/详情到分钟；自动触发以开始时间为基准 |
| 12 | 原型阶段 | 一键生成按钮 + 实现细节逐项标记（✓/✗/○）+ ✗ 项回流提示词重生成（版本+1）；存在未处理 ✗ 禁止确认 |
| 13 | 拆解阶段 | 模块只做拆解：左=任务基础信息，右=子任务明细；功能点必须标注新增/改造；执行人可微调（限班底内）；确认后自动生成自动化任务 |

## 3. 总体架构

详见架构图 HTML。逻辑分层：

```
┌─ 客户端层：apps/web · apps/desktop · apps/mobile（calendar-view + 详情四面板 + 创建弹窗）
├─ 接入层：server REST API（handler：calendar / roles / decompose / prototype / trigger / accept）
├─ 领域服务层：server/internal/service + scheduler（需求触发 loop、stage barrier 唤醒、组间互斥闸门）
├─ 执行层：daemon（agent 运行时、ModuleLocker v2、acceptance 脚本执行环境）
├─ 数据层：Postgres（issue 扩展 + 3 张新表 + 既有 project_module / issue_dependency / autopilot）
└─ 外部系统：GitNexus（agent 端 MCP 查询）、业务 git 仓（docs/prototypes/ 与 acceptance/）
```

**端到端流水线**（stage 复用 migration 123 的 `issue.stage`，1-based）：

```
创建需求（stage 未定）
  → [启用原型师] stage 1 原型：原型师一键生成 → 细节标记 → 确认门
  → stage 2 拆解：PM plan → 子任务草稿 → 人工确认（confirm 模式）→ 批量生效
  → 到达 start_at → scheduler 触发
  → stage 3 执行：子任务按 issue_dependency DAG + 组间互斥派发
  → stage 4 验收：测试 agent 依据 原型/plan/验收代码/图谱 出报告 → 通过=需求 done / 不通过=打回 stage 3
```

每个 stage 的开启依赖上一个 stage 的 **barrier 关闭**（`stageBarrierClosed`，issue_child_done.go），已有机制直接复用。

## 4. 核心概念模型

| 概念 | 载体 | 说明 |
|------|------|------|
| 需求 Requirement | 顶层 `issue`（`parent_issue_id IS NULL`）+ 扩展字段 | 目标/时间窗口/git 库/班底/拆解模式/触发方式 |
| 任务组 Group | `issue.root_requirement_id`（新增列） | 需求 + 全部子孙；**无 parent 的独立 issue root = 自身，自成一组**参与同模块互斥（§14 #1 定稿，`452:21-28` 递归回填） |
| 阶段 stage | `issue.stage`（123，1-based） | 1=原型（可选）/ 2=plan+拆解 / 3=执行 / 4=验收 |
| 角色班底 Roster | `project_role_default`（项目默认）+ `issue_role_assignment`（需求快照） | role ∈ pm / prototyper / developer / data / tester |
| 功能点 FeaturePoint | 子任务 `issue.feature_points` JSONB | `[{title, kind:'new'\|'modify', code_objects[], detail}]` |
| 图谱上下文 | 子任务 `issue.graph_context` JSONB | PM agent 经 MCP 查询后落库的四要素 + 风险 |
| 验收代码 | 子任务 `issue.acceptance_spec` JSONB | `{path, version, base_version, assertions[], note}`，实体在业务仓 `acceptance/` |
| 原型版本 | `issue_prototype_version` 表 | HTML 路径 + 组装提示词 + 逐项标记 + 状态 |

## 5. 数据模型

migration 编号顺延现有序号。本 spec 直接拥有 **452–454**（需求日历/角色班底/原型版本）；相邻的 **455–460**（artifact / graph_snapshot / ontology / filing / agent_run / stage_gate_rule）归属 `2026-09-05-project-archive-design.md`，但因其与本流水线共享 `issue`/`project_*` 事实表，§5.4 给出最终态字段名校准以防漂移。所有新列/新表均带 `workspace_id`，与既有 RLS/索引风格一致。

### 5.1 migration 452_requirement_calendar.up.sql — issue 扩展 + 需求触发字段

实际落地的 452 是**单条 `ALTER TABLE issue`**（一次性加 13 列），非初稿设想的多条 ALTER。逐列如下（行号指 452_requirement_calendar.up.sql）：

```sql
-- ①+② 需求级字段 + 子任务结构化明细三要素（单条 ALTER，452:6-19）
ALTER TABLE issue
    ADD COLUMN start_at TIMESTAMPTZ,                       -- L7  开始时间（分钟粒度时间轴）
    ADD COLUMN goal TEXT,                                  -- L8  目标：原型/拆解/验收的统一基准
    ADD COLUMN repo_resource_id UUID REFERENCES project_resource(id) ON DELETE SET NULL, -- L9
    ADD COLUMN decompose_mode TEXT NOT NULL DEFAULT 'confirm'
        CHECK (decompose_mode IN ('auto', 'confirm', 'manual')),  -- L10-11
    ADD COLUMN auto_trigger BOOLEAN NOT NULL DEFAULT true, -- L12 到达 start_at 自动触发
    ADD COLUMN decomposition_confirmed_at TIMESTAMPTZ,     -- L13 拆解确认时间（三模式殊途同归）
    ADD COLUMN triggered_at TIMESTAMPTZ,                   -- L14 调度触发时间（防重）
    ADD COLUMN acceptance_round INT NOT NULL DEFAULT 0,    -- L15 验收轮次计数（默认 0）
    ADD COLUMN root_requirement_id UUID REFERENCES issue(id) ON DELETE SET NULL, -- L16 任务组标识
    ADD COLUMN feature_points JSONB NOT NULL DEFAULT '[]',  -- L17
    ADD COLUMN graph_context JSONB NOT NULL DEFAULT '{}',   -- L18
    ADD COLUMN acceptance_spec JSONB NOT NULL DEFAULT '{}';  -- L19

-- ③ 存量回填 root_requirement_id（452:21-28）：沿 parent_issue_id 链向上取根；
--    无 parent 的独立 issue root = 自身（自成一组参与同模块互斥，§14 #1 定稿）。
WITH RECURSIVE root AS (
    SELECT id, id AS root_id FROM issue WHERE parent_issue_id IS NULL
    UNION ALL
    SELECT i.id, r.root_id FROM issue i JOIN root r ON i.parent_issue_id = r.id
)
UPDATE issue i SET root_requirement_id = r.root_id FROM root r WHERE i.id = r.id;

-- ④ 索引（452:31-34）
CREATE INDEX idx_issue_trigger_sweep ON issue(start_at)
    WHERE auto_trigger = true AND triggered_at IS NULL AND decomposition_confirmed_at IS NOT NULL;
CREATE INDEX idx_issue_root_requirement ON issue(root_requirement_id);
CREATE INDEX idx_issue_repo_resource ON issue(repo_resource_id);
```

> 校准要点：① `acceptance_round`（L15）此前设计漏列，**默认值是 `0`**（不是口传的 1 或 15），供 §7.5③ 验收 verdict 递增与第 10 派生态判定使用；② `graph_context`（L18）`DEFAULT '{}'`、`feature_points`（L17）`DEFAULT '[]'`、`acceptance_spec`（L19）`DEFAULT '{}'`；③ 递归回填 CTE（L21-28）锚点/递归成员均**不再选 `parent_issue_id`**（初稿多选了该列），`root=自身`语义由 `WHERE parent_issue_id IS NULL` 锚点保证。

**`due_date` / `start_at` 口径定稿**（本节为最终裁决，替代初稿「due_date 改全 ISO 时间戳」的错误表述）：

- `due_date` 的最终态类型是 **`DATE`**，由 migration `112_issue_dates_to_date.up.sql:14-16` 从 `TIMESTAMPTZ` 改写而来，承载**「日历日截止」语义**——用户选一天（picker 无时分输入），「Mar 1」对任意时区观察者都是 Mar 1，不带 time-of-day / timezone。
- 分钟粒度时间轴由 **`start_at TIMESTAMPTZ`**（452:7）独立承载：自动触发、倒计时、改期联动全部以 `start_at` 为基准。
- 这是**有意的双列分工设计，非未完成项**：`start_at`(timestamptz)=分钟粒度时间轴、`due_date`(date)=日历日截止，二者语义正交，不存在「due_date 待升级为时间戳」的遗留。
- 相关 API 契约**不变**：`due_date` 走 `util.ParseCalendarDate`（`handler/issue.go:3575-3585`，`YYYY-MM-DD` → `pgtype.Date`）；`start_at` 走 `util.ParseTimestamp`（`handler/issue.go:3587-3601`，RFC3339 → `pgtype.Timestamptz`，含 §7.2 已触发改期 409 联动）。前端 gantt/calendar 对 `due_date` 按日渲染，对 `start_at` 详情/hover 显示到分钟。

### 5.2 migration 453_requirement_roles.up.sql — 角色班底

```sql
CREATE TABLE project_role_default (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('pm','prototyper','developer','data','tester')),
    assignee_type TEXT NOT NULL CHECK (assignee_type IN ('member','agent')),
    assignee_id   UUID NOT NULL,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    ordinal       INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, role, assignee_type, assignee_id)
);

CREATE TABLE issue_role_assignment (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id      UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('pm','prototyper','developer','data','tester')),
    assignee_type TEXT NOT NULL CHECK (assignee_type IN ('member','agent')),
    assignee_id   UUID NOT NULL,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    ordinal       INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (issue_id, role, assignee_type, assignee_id)
);
CREATE INDEX idx_issue_role_assignment_issue ON issue_role_assignment(issue_id);
```

**语义**：
- 创建需求时把 `project_role_default` **拷贝快照**到 `issue_role_assignment`（项目默认的后续变更不影响已建需求）；需求级修改只影响当前需求。
- `pm` / `developer` 为必选角色：`enabled=false` 的请求被 server 拒绝（409）。
- `enabled=false` 的角色：不产生对应 stage 子任务、不可被指派（拆解确认校验）。
- `developer` 允许同 role 多行（多 agent 并行）；其余角色单行（UNIQUE 约束天然支持：developer 多行不同 assignee，其余角色 UI 层单选）。
- 停用 `prototyper` → 流水线跳过 stage 1；停用 `tester` → stage 4 验收责任人回落给 PM。

### 5.3 migration 454_requirement_prototype.up.sql — 原型版本

```sql
CREATE TABLE issue_prototype_version (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id        UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    version         INT NOT NULL,
    html_path       TEXT NOT NULL,              -- 业务仓内路径 docs/prototypes/<KEY>-<slug>.html
    prompt          TEXT NOT NULL,              -- 当轮完整组装提示词（含〔本轮修正〕段）
    marks           JSONB NOT NULL DEFAULT '[]', -- [{detail_id, verdict:'ok'|'no'|'pending', note}]
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','confirmed','superseded')),
    created_by_type TEXT NOT NULL CHECK (created_by_type IN ('member','agent')),
    created_by_id   UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (issue_id, version)
);
```

**流转**：`pending`（当前待评审）→ 确认后 `confirmed`；生成新版本时旧版本置 `superseded`。确认门校验：当前 `pending` 版本的 marks 中不得存在 `verdict='no'` 且未处理的项（`note` 为空视为未处理）。

### 5.4 相邻 migrations 455–460 最终态字段校准（归属 project-archive spec）

以下五表归属 `2026-09-05-project-archive-design.md`，但与本流水线共享 `issue`/`project_*` 事实表且被验收/阶段门/运行追踪复用。本节把**最终态字段名/DDL/种子**钉死，防止旧名回流（行号指各 up.sql）：

| migration | 表 | 最终态校准点（实证） |
|-----------|----|----------------------|
| **456** `project_graph_snapshot` | 图谱快照 | 除 `nodes/edges/communities/stats` 外，补 **`module_summary JSONB NOT NULL DEFAULT '[]'`（456:19）** 与 **`bus_matrix JSONB NOT NULL DEFAULT '[]'`（456:20）**；`UNIQUE (project_id, scan_id)`；CLI sync 一次性导入，server 只存不解析 |
| **457** `ontology_object` / `ontology_link` / `ontology_changelog` | 本体层 | 字段名是 **`entity_type`**（457:12，`CHECK IN ('code','semantic','table','biz')`；changelog 同名 457:51）、**`source_id`**（457:30）、**`target_id`**（457:31）——非初稿/旧名的 `type`/`from`/`to`。`ontology_link.link_type` CHECK 含 `QUERIES/ACCESSES/MEMBER_OF/CALLS/HANDLES_ROUTE/STEP_IN_PROCESS/FETCHES`。表先建为空（GitNexus ontology strategies 尚为空目录，就绪后自动接管） |
| **458** `filing_item` | 申报就绪度 | **`source_path TEXT`（458:21）为死列**：全仓无写入方，恒为 NULL。`handler/project_filing.go:85,111` 注释明确「revived dead column — no writer exists yet, so it is always null」；保留占位以待后续接入，读取方不得依赖其非空 |
| **459** `agent_run` / `agent_run_todo` / `agent_run_event` | 运行追踪 | 会话流（`task_message`）是事实源，三表是**单向投影**（459:1-2）。`agent_run.status ∈ running/completed/failed/cancelled/stalled`；`stall_reason ∈ rate_limited/network_lost/crash/waiting_module_lock/waiting_local_directory`。详见 §7.5④ |
| **460** `stage_gate_rule` | 阶段门规则 | 见下方专述 |

**460 `stage_gate_rule` 唯一键重构 + 种子实为 8 条规则**（初稿「4 阶段」表述不完整）：

- **唯一键重构**：§4.8 定稿曾写表级 `UNIQUE (COALESCE(project_id, zero), stage, required_doc_type)`，但 PostgreSQL 表级 UNIQUE 不接受表达式，故落地为 **UNIQUE INDEX `uq_stage_gate_rule_scope`（460:45-50）= `(workspace_id, COALESCE(project_id, '00000000-…'::uuid), stage, required_doc_type)`**。相较 §4.8 元组**强制补入 `workspace_id`**（否则 3 个 workspace 的 `project_id=NULL` 默认行会在 `(zero, stage, doc_type)` 上互相冲突，per-workspace 种子无法干净落地）。`track` **不入唯一键**（沿用 nullable，NULL=交付默认轨道）；暂不加 `updated_at`，以守住 sqlc CI 门禁（列结构与已生成的 `StageGateRule` 一致）。
- **种子实为 8 条规则**（460:68-82 的 `INSERT … CROSS JOIN workspace … VALUES`，8 行 VALUES 在 460:73-80），按 stage 分布：
  - S1 原型：`prototype`（blocking）
  - S2 plan+拆解：`plan`（blocking）、`decomposition`（blocking）
  - S3 执行：`design`（blocking）、`test-plan`（blocking）、`deliverables`（**blocking=FALSE**，归档动作自动产出的清单，aux 不计入完整度环、不阻断门）
  - S4 验收：`acceptance`（blocking）、`report`（blocking；轮次是 `project_artifact.version`，doc_type 统一为 `report`）
  - 合计 **7 项 blocking=true**（= 档案完整度环分母）+ 1 项 non-blocking（deliverables）。种子 `CROSS JOIN workspace` 使每个工作区各得一份默认规则集，`ON CONFLICT DO NOTHING` 保证幂等。
  - 规则来源优先级：project 级（`project_id` 非空）覆盖 workspace 级默认（`project_id IS NULL`）；判定 SQL 在 `handler/issue_archive.go:loadDeliverablesStageGates`（handler 内原生 SQL，不触碰 `pkg/db/queries/*.sql` 以免触发 sqlc 门禁）。

## 6. 需求状态机（10 态派生投影，含验收失败终态）

`requirement_status` **不落列**，由 list 端点 SQL 投影派生（与 `issue_effective_status` 同一思路），保证永远与事实一致；日历量纲（数百需求/工作区）下子查询成本可接受，性能不足时再物化。

**实现定位**：`pkg/db/queries/issue.sql` 的 `ListIssues` 中，`requirement_status` 由 **`issue.sql` ListIssues 的 CASE 实时投影**（自上而下 10 条规则命中即返，第 10 态验收失败由 WS4 落地）；stage 聚合量（`has_open_stage1`/`has_stage2`/`has_open_stage3`/`has_open_stage4`/`stage3_total`/`stage3_done`）由 **`LEFT JOIN LATERAL (…) prog`** 一次算出（只扫直接子级 `parent_issue_id = i.id`）。子任务终态判定统一用 `issue_effective_status(workspace_id, status) IN ('done','cancelled')`，与 stage barrier 同语义（自定义 done-category 状态不会永久阻塞后继）。

派生优先级（自上而下，命中即返回；与 `issue.sql` ListIssues 的 10 条 CASE 分支 1:1 对应，WS4 落地）：

| 序 | 条件 | 状态 |
|----|------|------|
| 1 | issue 自身 `issue_effective_status = 'done'` | `已完成` |
| 2 | issue 自身 `issue_effective_status = 'cancelled'` | `已取消` |
| 3 | `acceptance_round > 3`（WS4：累计 4 轮打回仍未过，置于 stage 态之前） | `验收失败` |
| 4 | 存在 stage 1 子任务未终态 | `原型待确认` |
| 5 | `decomposition_confirmed_at IS NULL` 且存在 stage 2 子任务 | `拆解待确认` |
| 6 | `decomposition_confirmed_at IS NULL` | `未拆解` |
| 7 | `triggered_at IS NULL` | `待触发` |
| 8 | 无 stage3 子任务在 `dispatched/running` **且** 存在子孙 `waiting_module_lock` | `等待模块释放` |
| 9 | stage 3 子任务未全部终态 | `执行中`（附 N/M 进度） |
| 10 | stage 4 子任务未终态 | `验收中` |
| ELSE | 其余 | `已完成` |

进度 N/M 同为投影：`stage 3 子任务中 done 数 / 总数`（`issue.sql:35-38`；无 stage 3 子任务时为空串，响应层映射为 null）。

### 6.1 第 10 派生态「验收失败」（WS4 已落地）

初版设计为 **9 态**，缺少一个明确的**验收失败终态**：CASE 末尾 `ELSE '已完成'` 把「验收通过→issue 转 done」与「多轮打回后仍未通过」混同为 `已完成`/`验收中`，无法向用户表达「需转人工」的失败终局。**WS4 已增补并落地第 10 态**：

- **态名**：`验收失败`（终态，与 `已完成`/`已取消` 并列）。
- **触发条件（落地）**：`acceptance_round > 3`（超过 §2 决策 #9 的 3 轮上限）。round 由 `RecordAcceptanceVerdict`（WS4）在 verdict=fail 时 `IncrementAcceptanceRound` 驱动，故 `acceptance_round>3` 本身即蕴含「最新 verdict=fail 且已耗尽 3 轮自动打回」，转人工仲裁。（初版提案曾要求额外 join stage4 verdict=fail，落地时简化掉了——见下）
- **与「验收通过」区分**：验收通过走序 1（issue 自身 `issue_effective_status = 'done'` → `已完成`）；验收失败是 issue **未** done、但轮次超限且最新 verdict=fail 的独立终态。
- **落地的 CASE 规则（WS4，与 §6 表序 3 一致）**：实现最终采用**简洁判据**并**前置到序 3**（done/cancelled 之后、所有 stage 态之前），而非初版提案的序 8.5 + verdict join：

```sql
-- 序 3（WS4 落地）：验收失败终态，前置于所有 stage 态。
-- round 计数由 RecordAcceptanceVerdict 在 verdict=fail 时 IncrementAcceptanceRound 驱动，
-- acceptance_round>3 即蕴含「已耗尽 3 轮自动打回且最新 verdict=fail」，无需再 join stage4 verdict。
WHEN i.acceptance_round > 3 THEN '验收失败'
```

> **初版提案（历史记录，未采用）**：曾建议插入序 8（验收中）之后、序 9 `ELSE` 之前，判据为 `acceptance_round > 3 AND NOT has_open_stage4 AND EXISTS(stage4 c.properties->>'acceptance_verdict'='fail')`，并要求 `prog` LATERAL 暴露 stage4 verdict。落地时简化为上述序 3 单条件。该态属 **§14 #4 定稿**；`requirement_status` 枚举与前端色块映射已同步（第 10 态）。

## 7. 调度与互斥

### 7.1 定时触发 loop（server 端）

新文件 `server/internal/scheduler/jobs_requirement_trigger.go`，复用 `jobs_autopilot.go` 的 scheduler 注册模式：每 30s 一轮，扫描 `idx_issue_trigger_sweep`：

```
auto_trigger=true AND triggered_at IS NULL AND decomposition_confirmed_at IS NOT NULL
  AND start_at <= now() AND issue 非终态
```

命中后同事务：写 `triggered_at=now()` → 把 stage 3 中**无未完成依赖**的子任务推进 `agent_task_queue`（status='queued'）；剩余子任务由既有 Claim 依赖闸门（`issue_dependency` + `issue_effective_status<>'done'`）陆续放行。手动触发 `POST /issues/{id}/trigger` 走同一函数（忽略 start_at）。

### 7.2 改期联动

PATCH issue 修改 `start_at` 且 `triggered_at IS NULL` 时无需处理（sweep 自然按新时间）；若已触发则拒绝改期（409，提示先取消运行）。拖拽调期（画面 2）即 PATCH `start_at`/`due_date`。

### 7.3 组间互斥（ModuleLocker v2）

初版（v1·451）：`ModuleLocker` 以 `module_id` 为 key 双计数（total/exclusive），同模块不互斥。**WS3 已升级为 v2（已落地）**：

- **锁 key = `(module_id, root_requirement_id)`**：同组内（含同需求的并行研发子任务）互不阻塞；**同模块跨组互斥**——组 B 的子任务 claim 时发现同模块有组 A 的非终态持有 → 入队 `waiting_module_lock`，`wait_reason` 注明 held by 哪个需求。
- **终态即释放**：root 需求到达终态（done/cancelled，含 failed）→ daemon `ReleaseGroup` 释放该 root 全部 hold + `cond.Broadcast()` 唤醒等待者。
  > **v1 实现说明**：不做 server 侧唤醒队列；等待方靠 daemon `ModuleLocker.Acquire` cond 重试 + 30s 轮询自足，**不保证 start_at 升序/严格 FIFO**（原设计「server 唤醒该模块等待队列按 start_at 升序」已 descope）。
- `module_id IS NULL` 的子任务不参与模块锁（与现状一致）。
- Claim 闸门（`issuestatus` 包 + claim 查询）同步加 `root` 维度判断。

### 7.4 对 module-dependency spec 的语义修订

`2026-09-04-module-dependency-scheduling-design.md` §1/§2 初版写「相同模块内无依赖关系的任务并发执行」，与本设计 §7.3 **相反**。**已随 WS3 落地同步修订该文档**（§1/§2 语义改为 v2 + §5 加 v1 历史标注）：相同模块内——同组任务按 DAG + 并发；**跨组任务自动互斥串行**；`avoid_conflict` 开关语义保留（勾选后跨模块也互斥，锁 key 退化为 module 级）。

### 7.5 五大运行时机制的数据契约（design 层，不写实现代码）

本节把五个运行时机制的**数据契约**（读/写哪些列、状态如何流转、谁是写入方）钉死到最终态，作为实现与测试的契约基准。

#### ① 到点触发 loop（trigger 状态流转）

- **无独立 `trigger_status` 列**：触发状态由 `auto_trigger`(bool,452:12) + `triggered_at`(timestamptz,452:14) + `decomposition_confirmed_at`(452:13) 三列**派生流转**：未确认拆解（`decomposition_confirmed_at IS NULL`）→ 待触发（已确认 + `triggered_at IS NULL` + `auto_trigger=true`）→ 已触发（`triggered_at` 非空）。
- **扫描语义**：`ListTriggerableRequirements`（`requirement.sql:89-100`）命中 `idx_issue_trigger_sweep`，筛选 `parent_issue_id IS NULL AND auto_trigger=TRUE AND triggered_at IS NULL AND decomposition_confirmed_at IS NOT NULL AND start_at IS NOT NULL AND start_at <= now() AND issue_effective_status NOT IN ('done','cancelled')`，`ORDER BY start_at ASC`。`start_at IS NULL` = 无计划，不自动触发。
- **触发写入**：`MarkRequirementTriggered`（`requirement.sql:102-105`）`UPDATE issue SET triggered_at=now() WHERE id=$1 AND triggered_at IS NULL`（`:execrows`）——**幂等**：影响 0 行 = 已被并发触发，调用方跳过。同事务把 stage 3 中**无未完成依赖**的子任务推进 `agent_task_queue`（status='queued'），剩余由 §7.5⑤ 依赖闸门陆续放行。
- **手动触发**：`POST /issues/{id}/trigger` 走同一函数（忽略 `start_at <= now()` 条件，仍写 `triggered_at` 防重）。scheduler 作业文件（`jobs_requirement_trigger.go`，每 30s 一轮）**已落地（WS2）**：`RequirementTriggerJob`（`JobNameRequirementTrigger = "requirement_trigger_dispatch"`）注册到 `scheduler.Manager`、写 `sys_cron_executions`，与手动触发共用 `triggerOneRequirement`；查询层（requirement.sql）同步就绪。

#### ② ModuleLocker v2（锁 key = (module_id, root_requirement_id)）

- **初版 v1（历史记录，已被 v2 取代）**（`daemon/module_locker.go`）：锁 key = `moduleID`，`holders map[taskID]→{moduleID,moduleName,exclusive}`；`blockerLocked` 规则 = 异模块持有 ×（本请求 `exclusive` 或持有方 `exclusive`）⇒ 阻塞；同模块永不互斥（`avoid_conflict` 驱动）。`Acquire(ctx,moduleID,moduleName,taskID,exclusive,onWait)` 返回幂等 release；`onWait`（上报 `waiting_module_lock`）锁外调用。
- **v2 契约（WS3 已落地）**：锁 key 升级为 **`(module_id, root_requirement_id)`**——同组内（同 `root_requirement_id`，含同需求的并行研发子任务）**互不阻塞**；**同模块跨组无条件互斥**（组 B claim 时发现同模块有组 A 的非终态持有 → 入队 `waiting_module_lock`，`wait_reason` 注明 held by 哪个需求组标题）。`module_id IS NULL` 不参与模块锁；任一方 root 为空则同模块维度退化为 v1（不互斥）。
- **终态 ReleaseGroup**：root 需求到达终态（done/cancelled，含 failed）→ daemon 释放该 root 全部 hold（`ReleaseGroup(root_requirement_id)`）+ `cond.Broadcast()`。
  > **v1 实现说明**：不做 server 侧唤醒队列/重排；等待方靠 daemon `ModuleLocker.Acquire` cond 重试 + 30s 轮询自足，**不保证 start_at 升序/严格 FIFO**。
- **数据契约**：等待行挂在 stage 子任务的 `agent_task_queue.status='waiting_module_lock'` + `wait_reason`（migration 451 状态枚举、109 加列）；`HasWaitingModuleLockDescendant`（`requirement.sql:118-126`）供派生态「等待模块释放」判定（10 态 CASE 中为序 8，因新增验收失败态而后移）。

#### ③ 验收 verdict（acceptance_round 递增 / stage3 修复子任务 / 验收失败终态）

- **轮次计数**：`issue.acceptance_round`（452:15，`DEFAULT 0`）每发起一轮验收递增；随 agent 任务 payload 透传（`service/task.go:7390` 的 `"acceptance_round": issue.AcceptanceRound`）。
- **verdict 不落列**：stage 4 tester 产出验收报告评论 + `verdict ∈ {pass, fail}`（由 stage 4 子任务 `properties->>'acceptance_verdict'` / 评论 / agent_run 投影承载）。
- **流转**：`pass` → 需求转 `done`（派生态序 1 `已完成`）；`fail` → `acceptance_round += 1` + 建 **stage 3 修复子任务** + 打回 stage 3（重跑依赖/互斥闸门）。
- **失败终态**：`acceptance_round > 3` 且最新 verdict=`fail` → §6.1 第 10 态 `验收失败`（转人工仲裁）。
- **验收代码版本约束**：功能缺陷 → 验收代码不动（继续当前版本）；需求变更 → agent 不得自行改断言，回退 PM 确认后同 PR 升版并记录原因（§8）。

#### ④ agent_run 投影（run/todo/event 生命周期，daemon 写入方）

- **事实源 vs 投影**：会话流 `task_message` 是事实源；`agent_run`/`agent_run_todo`/`agent_run_event`（migration 459）是**单向投影**（459:1-2），写入方 = **daemon（agent 运行时）**，server 只读不反写。
- **`agent_run`**（459:4-25）：关联 `task_queue_id`/`issue_id`/`root_issue_id`；`status ∈ running/completed/failed/cancelled/stalled`（创建默认 `running`）；`last_heartbeat_at` + `stall_reason ∈ rate_limited/network_lost/crash/waiting_module_lock/waiting_local_directory`；`token_used`。`idx_agent_run_heartbeat WHERE status='running'` 供 stall 扫描。
- **`agent_run_todo`**（459:32-52）：`run_id` + `todo_key`（`UNIQUE(run_id,todo_key)`）+ `phase`/`title`/`seq`；`status ∈ pending/in_progress/done/skipped/failed`；`source ∈ tool_trace/reply/manual`；`superseded_by` 自引用（重规划时旧 todo 被新 todo 取代）。
- **`agent_run_event`**（459:57-67）：`event_type ∈ heartbeat/todo_change/rate_limit/net_err/crash` + `detail JSONB`，按 `created_at DESC` 追加（只增不改）。
- **生命周期**：run 创建(running) → 心跳/todo_change 事件追加 + todo 状态推进 → 终态(completed/failed/cancelled)；heartbeat 超时 → stalled + stall_reason。

#### ⑤ 依赖 DAG 闸门（blocked_by 限同模块、前置需 done）

- **边载体**：`issue_dependency`，`type='blocked_by'`（`module.sql:44-50` 全量置换：`DeleteIssueDependencies` + `InsertIssueDependency`）。
- **前置需 done**：claim 闸门（`agent.sql:805-812`）`NOT EXISTS (… blocked_by 前置 pre WHERE issue_effective_status(pre.workspace_id, pre.status) <> 'done')`——前置全部达 `done` 才可被领取；用 `issue_effective_status` 而非裸 `status`，否则自定义 done-category 状态会永久阻塞后继。
- **限同模块**：写入时校验「依赖双方必须同模块」（`GetIssuesModuleIDs`，`module.sql:59-60`）；跨项目/跨模块依赖不建（§13 非目标）。
- **无环**：写入前 `ListDependencyEdgesForProject`（`module.sql:52-57`）拉项目内全部 `blocked_by` 边做 **DFS 防环**；拆解确认时依赖无环是触发前置之一（§14 #10）。

## 8. Agent 协议

| 角色 | stage | 输入 | 工具 | 输出 |
|------|-------|------|------|------|
| 原型师 | 1 | 自动组装提示词（需求描述+目标+git 库+产出约定+〔本轮修正〕） | 业务仓写权限 | `docs/prototypes/*.html` + `issue_prototype_version` 记录 |
| PM | 2 | 需求描述+目标+班底+git 库+（已确认原型） | **GitNexus MCP**：`/graph`、`/by-file`、`/impact-analysis` | plan 评论 + 子任务草稿（feature_points/graph_context/acceptance_spec/依赖/指派） |
| 研发 | 3 | 子任务三要素 + 图谱上下文 | 常规执行 | 代码 + 交付物（复用交付物管道） |
| 测试 | 4 | 已确认原型 + plan + acceptance_spec + graph_context | 业务仓执行 `acceptance/*.spec.ts` | 验收报告评论 + verdict；不通过→建 stage 3 修复子任务 |

**提示词组装（server 端，一键生成）**：固定模板五段 `〔需求〕〔目标〕〔仓库〕〔产出〕〔风格〕`；重新生成时追加 `〔本轮修正〕` 段 = 所有 `verdict='no'` 的标记项 + 用户填写的修正诉求。版本 +1。

**验收代码版本约束**（画面 7 语义）：功能缺陷 → 验收代码不动（继续当前版本）；需求变更 → agent 不得自行改断言，回退 PM 确认后同 PR 升版并记录原因。

## 9. API 一览（server/internal/handler）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/projects/{id}/role-defaults` | 项目默认班底 |
| GET/PUT | `/issues/{id}/roles` | 需求班底（创建时快照初始化） |
| POST | `/issues/{id}/decompose` | 发起拆解（建 stage 2 PM 子任务） |
| GET | `/issues/{id}/decomposition` | plan + 子任务草稿列表 |
| POST | `/issues/{id}/decomposition/confirm` | 校验（功能点无 pending / 执行人在班底内且角色启用 / 依赖双方同 module）→ 批量生效子任务（写 parent/stage/dependency/assignee）→ 写 `decomposition_confirmed_at` |
| POST | `/issues/{id}/prototype/generate` | 一键生成/重生成（body 可带 marks + prompt 追加段） |
| GET | `/issues/{id}/prototypes` | 版本列表 |
| POST | `/issues/{id}/prototypes/{version}/marks` | 逐项标记 |
| POST | `/issues/{id}/prototypes/{version}/confirm` | 确认门（校验无未处理 ✗）→ 关 stage 1 barrier |
| POST | `/issues/{id}/trigger` | 手动触发 |
| PATCH | `/issues/{id}` | 扩展 `start_at`（分钟粒度 timestamptz，RFC3339 → `ParseTimestamp`）/ `due_date`（日历日 date，`YYYY-MM-DD` → `ParseCalendarDate`）+ goal/repo/decompose_mode/auto_trigger；已触发改 `start_at` 返回 409（§7.2） |
| GET | `/issues` | list 投影增加 `requirement_status`、`stage_progress`、`start_at` |

## 10. 前端架构

- **日历视图**：`packages/views/issues/components/calendar-view.tsx`（新），月/周双粒度；复用 gantt 的 `computeRange` 与 UTC-day 对齐工具（分钟时间渲染时 floor 到日，tooltip 显分钟）；view-store 新增 view type `'calendar'`，偏好存 `issue_view_preference`。
- **创建弹窗**：扩展现有 issue 表单——目标 textarea、git 库选择（project_resource）、分钟粒度 datetime-local、**role-strip 横向班底卡**（启停开关）、拆解模式三卡、自动触发开关。
- **需求详情四面板**（对应画面 4-7）：原型确认（一键生成+标记+版本历史）、拆解确认（左 kv 基础信息 + 右子任务 fp 表/asg 微调）、执行调度（倒计时+进度+互斥等待）、验收报告（四板块+打回链）。
- 模块色沿用 `project_module.color`（451 已有）。

## 11. 兼容与迁移

1. **`due_date` 无序列化变更（定稿）**：`due_date` 最终态是 `DATE`（migration 112），**保持日历日语义与 `YYYY-MM-DD` 序列化不变**（`ParseCalendarDate` → `pgtype.Date`）；初稿「 API 从 date-only → 全时间戳」的表述**作废**。分钟粒度由**新列 `start_at`（timestamptz）**独立承载，不影响 gantt/calendar 对 `due_date` 的现有按日渲染（`startOfDayUTC` / `dateOnlyToUTCDate` 行为不变，`packages/core/issues/date.ts` 无需改 `due_date` 序列化方向）。因此本设计**不再引入对 `due_date` 的既有行为变更**；唯一新增行为是 `start_at` 分钟时间轴与自动触发。
2. **存量回填**：`root_requirement_id` 由 452 递归 CTE 一次性回填；后续 issue 创建/改 parent 时由 server 写入（不接受客户端传值）。
3. **存量 issue**：新列全部可空/有默认值，老 issue = 无目标/无班底/手动模式，行为不变。
4. **migration 回滚**：三张 down.sql 按逆序 drop/落列。

## 12. 测试方案

- **migration**：up/down 对称性 + 回填正确性（含多级 parent 链）。
- **server（go test）**：班底快照/必选校验；拆解确认三类校验；原型确认门 ✗ 拦截；触发 sweep 幂等（triggered_at 防重）；组间互斥闸门（同组并发/跨组串行/终态释放）；状态机 10 态派生（含第 10 态验收失败，§6.1）。
- **前端（vitest）**：calendar 渲染（跨月条/分钟 tooltip）、拖拽 PATCH 负载、班底卡启停交互、fp 表编辑校验。
- **e2e（playwright）**：创建需求→原型确认→拆解确认→触发→执行→验收 全链路。

## 13. 非目标（YAGNI）

- 不做资源负载均衡（agent 排期仅按依赖+互斥，不做容量规划）
- 不做需求模板市场（系统内置固定模板即可）
- 不做 GitNexus server 端快照入库（agent 端 MCP 已选定）
- 不做验收代码的在线编辑器（业务仓内编辑 + PR）
- 不做跨项目依赖（`issue_dependency` 仍要求同 module）

## 14. 开放问题定稿裁决

本节将原待确认开放问题（#1–#12）**逐条给出最终决策**，均与 migrations 451–460 / queries / handler 实证对齐。本表为唯一事实源，与 §2 已确认决策一致；若有冲突以本节为准。

| # | 开放问题 | 最终裁决 | 依据/落点 |
|---|----------|----------|----------|
| 1 | 无 `parent_issue_id` 的独立 issue 如何界定任务组 | **独立 issue root = 自身（保留现状）**，自成一组参与同模块互斥；§7.3 锁 key **不**加 `root_requirement_id IS NOT NULL` 条件 | `452:21-28` 递归回填锚点 `WHERE parent_issue_id IS NULL → root=自身` |
| 2 | 组间互斥语义并入 `module-dependency-scheduling-design.md` 的修订时机 | 随本设计落地同步修订（见 §7.4）：相同模块内同组并发/跨组互斥串行 | §7.4 |
| 3 | `due_date` 与 `start_at` 的时间口径 | **定稿**：`due_date`=`DATE`（日历日截止）、`start_at`=`TIMESTAMPTZ`（分钟粒度时间轴）；有意双列分工，非未完成项；API 契约不变 | §5.1、`112:14-16`、`issue.go:3575-3601` |
| 4 | 多轮验收不通过的终局如何表达 | **第 10 派生态「验收失败」已落地（WS4）**：`acceptance_round>3`（简洁判据，前置于 stage 态）；9 态扩为 10 态 | §6.1、`issue.sql` ListIssues CASE |
| 5 | 原型确认门的 ✗ 拦截口径 | **维持严格 ✗ 门**：覆盖率（所有细节项已标记、无 pending）**与**细节（任一 verdict 非 yes/ok）**任一未满足即阻断确认** | §5.3 确认门、§2 决策 #12 |
| 6 | 停用 `tester` 时 stage 4 验收责任人 | 回落给 PM（`tester` 停用不跳过 stage 4，仅换责任人） | §5.2 语义 |
| 7 | `data` 角色归属哪个 stage | **`data` 归 stage 3（执行）**，不单独成阶段；随研发子任务按 DAG 派发 | §4 角色班底、§8 |
| 8 | 是否新建里程碑表 | **不建里程碑表**；里程碑/日历配置复用 `project_calendar_config`（项目级日历配置载体；注：该表不在 migrations 451–460 批次内，属既有/后续 project 级配置） | §10 日历视图 |
| 9 | 验收轮次上限具体值 | **3 轮**（超过转人工，触发 #4 验收失败终态） | §2 决策 #9、§7.5③ |
| 10 | 是否做在线预检（触发前实时校验） | **v1 不做在线预检**；触发前置改为静态四件：**拆解生效 + 依赖无环 + 验收代码就绪 + 互斥窗口**（均命中才入队） | §7.5①⑤、`module.sql:52-57` DFS 防环 |
| 11 | agent 端图谱（GitNexus）缺失时如何降级 | **降级为「档案未就绪」**（不阻断流水线，标记待本体/快照就绪后自动接管） | §5.4（456/457 先建为空）、§2 决策 #7 |
| 12 | migration 归属与编号 | **452–454 属本 spec**（需求日历/角色班底/原型版本）；**455–460 属 `2026-09-05-project-archive-design.md`**，本文件 §5.4 仅做最终态字段名校准 | §5、§5.4 |
