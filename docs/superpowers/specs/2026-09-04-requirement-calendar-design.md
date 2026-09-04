# 需求日历与角色化流水线 — 产品架构与数据模型设计

- 日期：2026-09-04
- 状态：待评审
- 原型：`2026-09-04-requirement-calendar-prototype.html`（7 画面，同目录）
- 架构图：`2026-09-04-requirement-calendar-architecture.html`（同目录）
- 关联文档：`2026-09-04-module-dependency-scheduling-design.md`（组间互斥语义需并入修订，见 §7.4）、`2026-09-04-task-deliverables-design.md`（原型 HTML 产物复用其展示管道）

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
| 任务组 Group | `issue.root_requirement_id`（新增列） | 需求 + 全部子孙；**无 parent 的独立 issue root = 自身，自成一组**参与同模块互斥（默认值，待用户确认） |
| 阶段 stage | `issue.stage`（123，1-based） | 1=原型（可选）/ 2=plan+拆解 / 3=执行 / 4=验收 |
| 角色班底 Roster | `project_role_default`（项目默认）+ `issue_role_assignment`（需求快照） | role ∈ pm / prototyper / developer / data / tester |
| 功能点 FeaturePoint | 子任务 `issue.feature_points` JSONB | `[{title, kind:'new'\|'modify', code_objects[], detail}]` |
| 图谱上下文 | 子任务 `issue.graph_context` JSONB | PM agent 经 MCP 查询后落库的四要素 + 风险 |
| 验收代码 | 子任务 `issue.acceptance_spec` JSONB | `{path, version, base_version, assertions[], note}`，实体在业务仓 `acceptance/` |
| 原型版本 | `issue_prototype_version` 表 | HTML 路径 + 组装提示词 + 逐项标记 + 状态 |

## 5. 数据模型

migration 编号顺延现有序号（当前最大 451）。所有新列/新表均带 `workspace_id` 与既有 RLS/索引风格一致。

### 5.1 migration 452_requirement_calendar.up.sql — issue 扩展 + 需求触发字段

```sql
-- ① 需求扩展字段（顶层 issue 才有意义；子 issue 上为 inert，与 stage 同语义）
ALTER TABLE issue
    ADD COLUMN start_at TIMESTAMPTZ,                       -- 开始时间（分钟粒度）
    ADD COLUMN goal TEXT,                                  -- 目标：原型/拆解/验收的统一基准
    ADD COLUMN repo_resource_id UUID REFERENCES project_resource(id) ON DELETE SET NULL,
    ADD COLUMN decompose_mode TEXT NOT NULL DEFAULT 'confirm'
        CHECK (decompose_mode IN ('auto', 'confirm', 'manual')),
    ADD COLUMN auto_trigger BOOLEAN NOT NULL DEFAULT true, -- 到达 start_at 自动触发
    ADD COLUMN decomposition_confirmed_at TIMESTAMPTZ,     -- 拆解确认时间（三种模式殊途同归）
    ADD COLUMN triggered_at TIMESTAMPTZ,                   -- 调度触发时间（防重）
    ADD COLUMN root_requirement_id UUID REFERENCES issue(id) ON DELETE SET NULL;

-- ② 子任务结构化明细（内置固定模板的三要素）
ALTER TABLE issue
    ADD COLUMN feature_points JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN graph_context JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN acceptance_spec JSONB NOT NULL DEFAULT '{}';

-- ③ 存量回填 root_requirement_id：沿 parent_issue_id 链向上取根；无 parent → 自身
WITH RECURSIVE root AS (
    SELECT id, id AS root_id, parent_issue_id FROM issue WHERE parent_issue_id IS NULL
    UNION ALL
    SELECT i.id, r.root_id, i.parent_issue_id
    FROM issue i JOIN root r ON i.parent_issue_id = r.root_id
)
UPDATE issue i SET root_requirement_id = root.root_id FROM root WHERE i.id = root.id;

-- ④ 索引
CREATE INDEX idx_issue_trigger_sweep ON issue(start_at)
    WHERE auto_trigger = true AND triggered_at IS NULL AND decomposition_confirmed_at IS NOT NULL;
CREATE INDEX idx_issue_root_requirement ON issue(root_requirement_id);
CREATE INDEX idx_issue_repo_resource ON issue(repo_resource_id);
```

**`due_date` 语义变更**：列保持 `TIMESTAMPTZ` 不变；API 序列化从 date-only（`YYYY-MM-DD`）改为**全量 ISO 时间戳**以承载分钟粒度。前端 gantt/calendar 渲染按日 floor（`startOfDayUTC` 已有），详情/hover 显示分钟。这是本设计**唯一的既有行为变更**，影响面见 §11。

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

## 6. 需求状态机（8 态派生投影）

`requirement_status` **不落列**，由 list 端点 SQL 投影派生（与 `issue_effective_status` 同一思路），保证永远与事实一致；日历量纲（数百需求/工作区）下子查询成本可接受，性能不足时再物化。

派生优先级（自上而下，命中即返回）：

| 序 | 条件 | 状态 |
|----|------|------|
| 1 | issue 自身终态（done/cancelled） | `已完成` / `已取消` |
| 2 | 存在 stage 1 子任务未终态 | `原型待确认` |
| 3 | `decomposition_confirmed_at IS NULL` 且存在 stage 2 子任务 | `拆解待确认` |
| 4 | `decomposition_confirmed_at IS NULL` | `未拆解` |
| 5 | `triggered_at IS NULL` | `待触发` |
| 6 | 存在子孙任务 `agent_task_queue.status='waiting_module_lock'` | `等待模块释放` |
| 7 | stage 3 子任务未全部终态 | `执行中`（附 N/M 进度） |
| 8 | stage 4 子任务未终态 | `验收中` |
| 9 | 其余 | `已完成` |

进度 N/M 同为投影：`stage 3 子任务中 done 数 / 总数`。

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

现状：`ModuleLocker` 以 `module_id` 为 key 双计数（total/exclusive），同模块不互斥。升级为：

- **锁 key = `(module_id, root_requirement_id)`**：同组内（含同需求的并行研发子任务）互不阻塞；**同模块跨组互斥**——组 B 的子任务 claim 时发现同模块有组 A 的非终态持有 → 入队 `waiting_module_lock`，`wait_reason` 注明 held by 哪个需求。
- **终态即释放**：root 需求到达终态（done/cancelled，含 failed）→ daemon 释放该 root 全部 hold，server 唤醒该模块的等待队列（按 `start_at` 升序）。
- `module_id IS NULL` 的子任务不参与模块锁（与现状一致）。
- Claim 闸门（`issuestatus` 包 + claim 查询）同步加 `root` 维度判断。

### 7.4 对 module-dependency spec 的语义修订

`2026-09-04-module-dependency-scheduling-design.md` §1/§2 现写「相同模块内无依赖关系的任务并发执行」，与本设计 §7.3 **相反**。本设计落地时同步修订该文档：相同模块内——同组任务按 DAG + 并发；**跨组任务自动互斥串行**；`avoid_conflict` 开关语义保留（勾选后跨模块也互斥，锁 key 退化为 module 级）。

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
| PATCH | `/issues/{id}` | 扩展 start_at/due_date 分钟粒度 + goal/repo/decompose_mode/auto_trigger |
| GET | `/issues` | list 投影增加 `requirement_status`、`stage_progress`、`start_at` |

## 10. 前端架构

- **日历视图**：`packages/views/issues/components/calendar-view.tsx`（新），月/周双粒度；复用 gantt 的 `computeRange` 与 UTC-day 对齐工具（分钟时间渲染时 floor 到日，tooltip 显分钟）；view-store 新增 view type `'calendar'`，偏好存 `issue_view_preference`。
- **创建弹窗**：扩展现有 issue 表单——目标 textarea、git 库选择（project_resource）、分钟粒度 datetime-local、**role-strip 横向班底卡**（启停开关）、拆解模式三卡、自动触发开关。
- **需求详情四面板**（对应画面 4-7）：原型确认（一键生成+标记+版本历史）、拆解确认（左 kv 基础信息 + 右子任务 fp 表/asg 微调）、执行调度（倒计时+进度+互斥等待）、验收报告（四板块+打回链）。
- 模块色沿用 `project_module.color`（451 已有）。

## 11. 兼容与迁移

1. **`due_date` 序列化变更**（唯一行为变更）：API 从 date-only → 全时间戳。`dateOnlyToUTCDate` 解析全 ISO 仍正确（取 UTC 日），gantt 现有数据（00:00:00Z）渲染不变；需改 `packages/core/issues/date.ts` 的序列化方向（写入时保留时间分量）。
2. **存量回填**：`root_requirement_id` 由 452 递归 CTE 一次性回填；后续 issue 创建/改 parent 时由 server 写入（不接受客户端传值）。
3. **存量 issue**：新列全部可空/有默认值，老 issue = 无目标/无班底/手动模式，行为不变。
4. **migration 回滚**：三张 down.sql 按逆序 drop/落列。

## 12. 测试方案

- **migration**：up/down 对称性 + 回填正确性（含多级 parent 链）。
- **server（go test）**：班底快照/必选校验；拆解确认三类校验；原型确认门 ✗ 拦截；触发 sweep 幂等（triggered_at 防重）；组间互斥闸门（同组并发/跨组串行/终态释放）；状态机 8 态派生。
- **前端（vitest）**：calendar 渲染（跨月条/分钟 tooltip）、拖拽 PATCH 负载、班底卡启停交互、fp 表编辑校验。
- **e2e（playwright）**：创建需求→原型确认→拆解确认→触发→执行→验收 全链路。

## 13. 非目标（YAGNI）

- 不做资源负载均衡（agent 排期仅按依赖+互斥，不做容量规划）
- 不做需求模板市场（系统内置固定模板即可）
- 不做 GitNexus server 端快照入库（agent 端 MCP 已选定）
- 不做验收代码的在线编辑器（业务仓内编辑 + PR）
- 不做跨项目依赖（`issue_dependency` 仍要求同 module）

## 14. 待确认事项

1. **任务组界定（默认值待确认）**：无 `parent_issue_id` 的独立 issue 自成一组（root=自身），参与同模块互斥。若改为「独立 issue 不参与互斥」，§7.3 锁 key 需加 `root_requirement_id IS NOT NULL` 条件。
2. **组间互斥语义并入** `2026-09-04-module-dependency-scheduling-design.md` 的修订时机：随本设计 Phase 5 一并落地（见执行方案）。
