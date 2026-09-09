# GitNexus × Multica 本体数据模型统一设计

- 日期：2026-09-07
- 状态：Draft（待评审）
- 上游：`2026-09-05-project-archive-design.md`（455–458）、`2026-09-06-requirement-calendar-er.md`、`2026-09-07-项目档案文档契约与产品联动.md`；GitNexus 侧《本体优化执行手册》、《2026-08-25-本体对象模型优化设计》、《2026-08-27-本体模型对齐与三栏联动设计》
- 范围：两套系统在**数据模型层面**的统一；不含 UI 重设计、不含 GitNexus 抽取管线重写

---

## 1. 诊断：本体对象为什么"没起到好效果"

GitNexus 4E10S 本体（含 18 型对象：4E 实体 + 13S 策略 + BLK 块对象）构建管线已成型，
但从"用产品功能模块视角理解代码"这个目标回看，问题不在抽取质量，而在**模型的组织轴心与消费闭环缺失**：

| # | 病灶 | 证据 |
|---|------|------|
| D1 | **对象按类型平铺，不按功能模块聚合** | 本体库主视图是 4E 四表 + 13S 策略表平铺；`biz module` 只是其中一种对象（且实证 147/180 为 ≤10 资产的小模块、目录机械映射），不是组织轴心 |
| D2 | **策略与代码对象断链** | 10S 策略经 `governance_scope`（字符串数组）弱关联；`ontology_link` 的 GOVERNS/AFFECTS 边极少生成；实证 65% 策略是结构镜像（M3 已收敛 event/action），剩下的策略"不知道管谁" |
| D3 | **构建产物不出 GitNexus 单机** | 本体落平台 SQLite（`entity_*` / `strategy_*` / `entity_block_object`）；multica 侧 `ontology_object/link/changelog`（457）建成即空表降级——画面 10「模块策略」只能把 `properties` KV 拍平冒充策略（`GetModuleStrategies`） |
| D4 | **与需求流水线无闭环** | `issue.graph_context`（452）从未被填充（默认 `'{}'` → 拆解 prompt 降级"档案未就绪"）；`feature_points` 与本体对象无关联；验收（S13 评测策略）与 stage_gate_rule（460）互不相识 |
| D5 | **读模型=写模型** | 两侧都只有"存储视角"的表结构，没有"分析视角"的投影：看一个模块有哪些对象/策略、看一个需求动了哪些对象、看一张表被哪些模块读写，都要现查现拼 |
| D6 | **图谱上行通道未贯通** | `graph/sync` 的生产者实际是前端 read-back 重传（`packages/core/graph/mutations.ts`），CLI projector 只做了 archive sync，未产出图谱/本体快照 |

**一句话**：GitNexus 把"代码→业务对象"的翻译层建出来了，但它停在了"对象清单"；
multica 有"功能模块 / 需求流水线 / 档案"的组织框架，但本体数据流没接上。
统一的方向 = **把模块从一种对象升级为轴心，把对象/策略/块挂到轴上，把轴接到需求流水线与档案**。

---

## 2. 现状数据模型对照（事实源：migration + types.ts）

### 2.1 实体/对象层

| 概念 | GitNexus（SQLite，platform/db） | Multica（Postgres，455–457） | 差距 |
|---|---|---|---|
| 代码实体 | `entity_code_object`（symbol_kind/tier/role/双含义/fingerprint） | `ontology_object(entity_type='code')` | 457 只有公共子集列，role/tier/含义进 `properties` 黑盒 |
| 语义结构 | `entity_semantic_object`（fields 数组） | `entity_type='semantic'` | 同上 |
| 数据表 | `entity_table_object`（columns/indexes/pk） | `entity_type='table'` | bus_matrix 有表名但**不回链** table 对象 |
| 业务对象 | `entity_biz_object`（biz_kind: module/process/page/api_domain/doc/config/tool） | `entity_type='biz'` | multica 的 `project_module` 与 biz module 两套"模块"只靠**同名字符串**桥（455 `graph_node_id`） |
| 伪代码块 | `entity_block_object`（0010：pseudocode/business_logic/code_type/biz_category/mount/lint/score，`blk://` URI + sig_fingerprint） | **无对应** | 业务伪代码是"看懂代码"的核心产物，multica 完全缺失 |
| 策略 | 13 张 `strategy_*` 表（term/lens/event/decision/praxis/action/playbook/model/architecture/acceptance/principle/invariant/evaluation_spec） | **无对应**（457 仅 4E CHECK） | 策略层无法上行 |

### 2.2 关联层

| 概念 | GitNexus | Multica | 差距 |
|---|---|---|---|
| 对象边 | `ontology_links`（16 型 LinkType，含 GOVERNS/AFFECTS/MONITORS/TRIGGERS/TESTS/DESCRIBES） | `ontology_link`（457，7 型 CHECK，全是图谱边口径） | multica 边集**不含策略语义边**；且 457 边引用 `node_id` 文本，不挂对象 UUID |
| 图谱↔模块 | `entity_*.graph_node_id` 回填 LadybugDB node id | `project_module.graph_node_id` ← Community 同名匹配 | 方向相反但可对接：同一 `graph_node_id` 命名空间 |
| 对象↔需求 | 无 | `issue.graph_context`（空壳） | 完全断 |
| 对象↔档案 | 无 | `project_artifact`（scope/stage/doc_type） | 完全断（架构原则 strategy_architecture 与 `architecture` 档案本该同源） |

### 2.3 快照与演进层

| 概念 | GitNexus | Multica | 差距 |
|---|---|---|---|
| 快照 | `ontology_snapshots(project_id, scan_id, stats)` | `project_graph_snapshot`（456，nodes/edges/communities/module_summary/bus_matrix，留 5 份） | multica 快照不含本体段 |
| 变更 | `ontology_changelog`（added/modified/removed/status_change + before/after） | `ontology_changelog`（457，结构已对齐） | 空表；且未与 `change-log` 档案/doc_type 打通 |
| 机检 | `change_review_runs`（invariant/principle/eval 三族判定） | `stage_gate_rule`（460，阶段门）+ `filing_*`（458） | 两套"门"各自独立：GitNexus 管代码底线，multica 管文档门，没有统一 verdict 视图 |

---

## 3. 方案对比

### 方案 A：直推填满 457（最小连通）
GitNexus 本体构建后，CLI 把 4E 对象 + 图谱边按 457 现有 schema 推入 multica。
- 优点：不改表、不动 GitNexus，1 个 sync 扩展即可点亮画面 10/11
- 缺点：**把"对象清单"原样搬过去，D1/D2/D4/D5 一个都没解决**；策略与块对象进不去（CHECK 约束挡死）；模块仍是同名弱桥

### 方案 B：模块轴心的统一语义层（推荐）
保持两侧写路径不变（GitNexus 构建、CLI 快照上行、server 只存不算），在**数据模型层**做三件事：
1. **轴心升级**：`project_module` 从"轻量枚举"升级为语义轴心，本体对象/策略/块统一外键挂载；
2. **模型归一**：457 扩型到 18 型对象全集（4E + 13S + block），边扩到 16 型（含策略语义边），标识体系统一 URI 协议族；
3. **读模型投影**：以"多视角"为一等产出——模块视角 / 需求视角 / 数据视角 / 治理视角 / 文件视角，全部由同一事实表派生。
- 优点：直接回应 D1–D5；增量演进，不动 GitNexus 抽取内核；画面 10/11、B4 拆解、C2 档案全部受益
- 缺点：一次 migration（461）+ sync 协议升级 + 读取投影层新建，工作量三方案最大（约 5–7d 分批）

### 方案 C：multica 自算本体（去 GitNexus 化）
multica 从 `project_graph_snapshot` 的 nodes/edges 自行重算对象与策略。
- 优点：单系统闭环
- 缺点：丢弃 GitNexus 已收敛的 tier/role/双含义/块对象/治理引擎全部资产；重算与"server 永不读文件系统、不做重计算"的既定原则冲突；长期两套语义漂移。**否决**。

**推荐 B**。A 可作为 B 的第一批过渡形态（先让 4E 流起来），但不作为终态。

---

## 4. 推荐设计：模块轴心的统一语义层

### 4.1 统一标识体系（跨系统 join 的基石）

| 标识 | 形态 | 用途 |
|---|---|---|
| 对象 URI | `code://` / `blk://` / `strategy://{project}/{type}/{name}`（GitNexus 既有六协议） | 跨系统稳定外键；人可读 |
| `graph_node_id` | LadybugDB 节点 id（`Function:file:name#arity` 等） | 回链代码图谱快照（456 nodes）做下钻 |
| `sig_fingerprint` | 内容归一化 SHA1 前 12 位 | 行号漂移稳定键；跨 snapshot 同源判定的第二键 |
| `module_key` | `(project_id, project_module.id)` | 轴心外键 |

不变量：**URI + scan_id 定位一次构建中的对象；sig_fingerprint + URI 前缀定位跨构建的同一对象**。
multica 侧 `ontology_object.node_id` 复用为 URI 载体（语义升级，列名不动）。

### 4.2 对象模型归一（migration 461：`ontology_object` 扩型）

```
entity_type CHECK 扩展：'code'|'semantic'|'table'|'biz'
  → + 13 策略型（'term','lens','event','decision','praxis','action','playbook',
     'model','architecture','acceptance','principle','invariant','evaluation_spec'）
  → + 'block'（业务伪代码段）
```

列变更（全部可空/带默认，不动存量语义）：

| 新列 | 类型 | 语义 |
|---|---|---|
| `module_id` | UUID FK → project_module（SET NULL） | **轴心外键**；null = 游离对象（进待绑定） |
| `strategy_type` | TEXT | entity_type ∈ 策略族时的细分（冗余便于过滤） |
| `graph_node_id` | TEXT | 图谱回链（原在 properties 黑盒，提升为列） |
| `sig_fingerprint` | TEXT | 漂移稳定键 |
| `meaning_business` / `meaning_logic` | TEXT | 双含义提升为列（原在 properties），供列表直接渲染 |
| `meaning_source` / `meaning_confidence` | TEXT / REAL | 富化证据分档（rule/graph/llm/manual） |
| `entity_tier` | TEXT | core/member/trivial（默认视图过滤口径） |
| `properties` | JSONB（保留） | 类型专属稀疏 KV——沿用 GitNexus attrs「缺键为常态」惯例，不为每种策略建列 |

设计要点：
- **不为 13 种策略各建表**。GitNexus 侧 13 表是按"每型一表"早期决策演进来的；multica 侧是**读/投影库**，统一表 + JSONB 稀疏 KV 已经足够，且与 `project_artifact`/`issue` 的关联只需一个外键面。
- **策略↔对象关联走边，不走列**：`ontology_link` 的 CHECK 扩到 GitNexus 16 型全集（补 GOVERNS/AFFECTS/MONITORS/TRIGGERS/TESTS/DESCRIBES/READS/WRITES 等），`source_id/target_id` 语义升级为 URI（与 4.1 对齐），策略管谁 = 查它的出边。

### 4.3 模块轴心：`project_module` 升级

现状：`project_module(name, color, graph_node_id)`，`graph_node_id` 靠 Community 同名匹配（455）。

升级后模块的三类挂载来源（优先级从高到低）：

| 来源 | 机制 | 置信 |
|---|---|---|
| 人工绑定 | 模块详情页显式挂对象/策略（写 `ontology_object.module_id`） | 1.0 |
| 块对象主挂载 | GitNexus `entity_block_object` 的 mount_edge（§11.4 挂载矩阵，≥0.85 精确包含）随 sync 上行，映射到模块 | 0.85 |
| Community 同名 | 既有 rebridge 通道（保留，兜底） | 中 |

配套：
- `biz module` 对象与 `project_module` **合一**：sync 时 biz module 对象不再进 `ontology_object` 主列表（避免"模块既是一行对象又是轴心"的双胞胎），而是**匹配/创建 project_module 并回填 `graph_node_id` 与 `ontology_object.id` 互指**；`UnmatchedCommunities` 语义不变。
- 模块下对象归属：code/semantic/table 对象经 `module_id` 直挂（来源 = GitNexus `entity_code_object.module_id`，它本来就有模块归属，只是从未上行）；block 对象按主挂载对象传递归属。

### 4.4 需求↔对象闭环（治 D4）

| 现状 | 目标 |
|---|---|
| `issue.graph_context` 恒 `'{}'`，拆解 prompt 降级 | S2 拆解时由 server 自动填充**结构化图谱上下文**：`{modules:[{id,name,objects_top,object_count}], strategies:[...], tables:[...]}`，取自模块轴心投影（体积上限截断，如每模块 top 20 core 对象） |
| `feature_points` 是自由文本数组 | 功能点可挂接对象 URI 列表（`feature_points[].refs`，向后兼容纯文本）；验收策略（`evaluation_spec` 对象）与功能点互链 |
| S13 评测策略与 stage_gate_rule 互不相识 | `stage_gate_rule.required_doc_type` 之外新增**可选** `required_strategy_ref`（460 表加一列，可空）：S3 门可声明"evaluation_spec 存在且 last_verdict=pass"才算闭合；GitNexus change_review verdict 经 sync 上行后作为策略对象的 `properties.last_verdict` 投影 |

### 4.5 档案↔对象联动（治 D5 的一半）

- `ontology_changelog`（457 已有，空表）开始接收 sync 上行的 diff；`change_type` 不变。
- 新增投影：变更摘要可一键生成为 `change-log` doc_type 档案草稿（`source='server'`，写入走既有 artifact 通道，**Git 仍是事实源**，changelog 表只供查询）。
- `architecture` 档案 ↔ `strategy_architecture`/`strategy_principle` 对象：档案正文是人对原则的陈述，策略对象是机检参数（`meta.layer_rules`），双向链接（artifact ↔ ontology_object 关联表，见 4.6）。

### 4.6 多视角读模型（核心价值层）

写入路径保持"快照一次性事务"不变；**读取按视角建投影**（SQL 视图/查询层，不冗余落表）：

| 视角 | 回答的问题 | 组成 | 消费面 |
|---|---|---|---|
| **模块视角** | 这个功能模块有哪些对象/策略/块？质量如何？ | project_module ⋈ ontology_object(module_id) ⋈ 出边策略 ⋈ tier/role 分布 | 画面 10（模块列表/模块策略/模块对象替换 KV 拍平实现） |
| **需求视角** | 这个需求涉及哪些对象？验收依据是什么？ | issue.feature_points[].refs ⋈ 对象 ⋈ evaluation_spec ⋈ S3/S4 档案 | B4 需求工作台、C6 需求详情（graph_context 同源） |
| **数据视角** | 这张表被哪些模块读写？ | bus_matrix 单元格回链 `entity_type='table'` 对象（`tables[].name` → 对象 URI）⋈ QUERIES 边 | 画面 11 总线矩阵 drilldown 从"聚合数字"升级为"可跳对象" |
| **治理视角** | 最近构建变了什么？机检过了吗？ | ontology_changelog ⋈ principle/invariant/evaluation_spec 对象的 last_verdict ⋈ change-log 档案 | 项目 Tab 治理卡、变更评审 |
| **文件视角** | 打开这个文件，它的块/对象/挂载是什么？ | `GET /ontology/objects/by-file` 语义平移：block（pseudocode 段）+ 同文件对象 + 挂载边 | 桌面端代码检查器（对齐 GitNexus 三栏） |

实现形式：`packages/core/ontology/` 新建查询族（`moduleObjects` / `requirementObjects` / `tableConsumers` / `governanceFeed` / `fileBlocks`），server 侧 5 个只读端点，全部从 461 后的统一表派生。

### 4.7 同步协议升级（治 D6）

`GraphSyncPayload` 扩展（向后兼容，缺省即现状降级）：

```jsonc
{
  "scan_id": "...", "git_sha": "...", "gitnexus_version": "...",
  "nodes": [...], "edges": [...], "communities": [...],
  "stats": {...}, "module_summary": [...], "bus_matrix": [...],
  // 新增（可选）：本体段，缺省 = 457 表保持空，画面降级展示不变
  "ontology": {
    "objects": [ { "uri": "code://...", "entity_type": "code", "module_key": "…",
                   "graph_node_id": "…", "sig_fingerprint": "…",
                   "meaning_business": "…", "meaning_logic": "…",
                   "entity_tier": "core", "properties": {...} } ],
    "links":   [ { "source": "uri", "target": "uri", "link_type": "GOVERNS", "properties": {} } ],
    "changelog": [ ... ]
  }
}
```

- 生产端：GitNexus 本体构建（analyze 后 `buildOntologyForCurrentGraph` 已产出全量内存批次）加 `export --for-multica` 出口；`multica archive sync`（cmd_archive.go）升级为同事务推 archive manifest + graph snapshot + ontology 段（`syncGraphSnapshotInTx` 已支持组合事务）。
- server 端：457 三表写入沿用 `snapshot_id` 级联语义（留 5 份快照，旧本体随快照级联清除——**与现状一致**）；`module_id` 解析失败的对象保留 null 进「游离队列」，不静默丢弃（对齐档案待绑定的诚实原则）。
- 幂等：`UNIQUE(snapshot_id, node_id)` 不变，`node_id` = URI。

---

## 5. 不变量与红线

1. **server 永不读文件系统、不做重计算**：所有聚合（module_summary/bus_matrix/ontology 段）由 CLI/GitNexus 侧预计算，server 只存、只投影。（沿用 456 既有原则）
2. **Git 是文档事实源；图谱/本体快照是构建事实源**：本体对象可再生的唯一方式是重新 analyze + sync，不开放 Web 侧直接改对象（人工修正走 GitNexus 侧的 manual source_kind，下次 sync 携带上行）。
3. **诚实降级**：ontology 段缺省时，画面 10/11 维持现有降级展示；`graph_context` 缺省时拆解 prompt 维持"档案未就绪"文案。不伪造。
4. **宁缺毋滥**：模块挂载、对象关联、策略边只接受有证据的（人工/挂载矩阵/changelog），不做名字相似度的静默猜测（沿用 F 系列教训）。
5. **不回写**：multica 不写 GitNexus 的 SQLite / LadybugDB；反向通道只有"重新 sync"。

## 6. 迁移与落地批次

| 批次 | 内容 | 影响面 | 预估 |
|---|---|---|---|
| B1 | sync 协议加 ontology 段（4E + 16 型边）；457 CHECK 扩型；CLI projector 真产出 | migration 461a + GitNexus export + cmd_archive | ~2d |
| B2 | `ontology_object` 加列（module_id/strategy_type/graph_node_id/sig_fingerprint/双含义/tier）；biz module ↔ project_module 合一挂载 | migration 461b + rebridge 扩展 + 游离队列 | ~1.5d |
| B3 | 13S + block 对象上行；画面 10 模块对象/策略 Tab 换真数据源；文件视角端点 | sync 段扩型 + packages/core/ontology + f10 改造 | ~2d |
| B4 | 需求闭环：graph_context 自动填充、feature_points.refs、stage_gate_rule.required_strategy_ref；治理视角 + change-log 投影 | migration 461c + requirement_decompose + C6/B4 | ~1.5d |

每批次独立可交付：B1 后画面 10/11 即点亮 4E；B2 后模块成为真轴心；B3 后多视角读模型完整；B4 后流水线闭环。

## 7. 关键决策点（本次设计拍板项）

1. **轴心选择**：选 `project_module` 而非 GitNexus `biz module` 作为统一轴心——前者已被需求调度（451 锁/依赖）与日历色块使用，是产品语义所在；biz module 降级为轴心的构建证据来源。
2. **策略存储**：multica 侧用统一表 + JSONB 稀疏 KV，不复刻 GitNexus 13 表——multica 是读/投影库，类型专属字段无 join 需求。
3. **对象可改性**：本体对象在 multica 只读（Web 不提供编辑）；人工治理回流 GitNexus（manual source_kind），避免双写分叉。
4. **快照级联语义保留**：本体随快照 5 份保留策略级联清除；跨快照演进通过 `sig_fingerprint` 同源 + changelog 承载，不引入第二套版本机制。
5. **不做的事**：不改 GitNexus 抽取/富化内核；不引入 embedding/向量列（457 降级先行的既定策略不变）；不做 Web 侧本体编辑器。

## 8. 验证口径

- B1 验收：alsc-kg-web 级仓库 sync 后，`ontology_object` 行数与 GitNexus 侧 `ontology_snapshots.stats.entity_counts` 对账一致（±0）；画面 10 模块对象数 = module_summary.obj_count。
- B2 验收：模块轴心挂载率报表（matched / 游离 / 人工绑定三档），游离率 >30% 告警。
- B3 验收：画面 10「模块策略」不再是 properties KV 拍平（`GetModuleStrategies` 数据源切到 entity_type ∈ 策略族 + GOVERNS 出边）。
- B4 验收：新建需求 S2 拆解 prompt 中 `graph_context` 非空且含模块对象摘要；S4 验收可引用 evaluation_spec 对象。
