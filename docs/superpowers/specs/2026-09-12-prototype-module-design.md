# 原型模块功能细节设计（stage 1 原型师 + 原型资产管理）

- 日期：2026-09-12（初稿）
- 状态：**待评审**
- 上位事实源：`2026-09-04-requirement-calendar-design.md`（流水线骨架 / migration 452–454 / 10 态状态机，已定稿）
- 原型参照：`2026-09-04-rMultica 原型 · 需求日历 + 角色化流水线.html` **画面 4**（原型师阶段 — 一键生成 + 细节标记 + 确认门）
- 关联文档：`2026-09-04-task-deliverables-design.md`（原型 HTML 复用交付物展示管道）、`2026-09-05-project-archive-design.md`（原型登记为 `project_artifact`，doc_type=`prototype`，S1 blocking 门）
- 关联选型：前端可视化基座采用 Storybook 混合架构的结论（GitNexus `frontend-visualization-vds-vs-storybook.md`）——本文 §9 给出原型 HTML 与受管 story 的关系界定

## 1. 定位与边界

原型模块有两副面孔，共用同一份数据事实：

| 面 | 载体 | 职责 |
|---|---|---|
| **流水线内：原型师工位** | 需求详情抽屉 stage 1 面板（原型画面 4） | 一键生成 → 细节标记 → 回流重生成 → 确认门，服务单个需求 |
| **流水线外：原型资产库** | 项目级「原型库」页面（新 TAB，与看板/列表/甘特图/日历并列） | 跨需求索引全部原型版本，支持检索、复用为参考原型、风格治理 |

**明确不做**（YAGNI）：
- 不做在线 HTML 编辑器（修改一律走「标记 → 回流 → 重生成」闭环，不允许手改产物，保证版本 ↔ commit 可追溯）；
- 不做自由画布（Canvas）管理面（选型结论：画布无法给 AI 提供稳定功能锚点，见 §9）；
- 不做 iOS 端专属交互，移动端复用同一套只读 + 标记能力（见 §8.4）。

## 2. 已确认决策（本模块级，上位决策 #12 的展开）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 产物形态 | **单文件 HTML**，写入业务仓 `docs/prototypes/<ISSUE-KEY>-<slug>.html`，版本 ↔ commit 一一对应 |
| 2 | 修改通道 | 唯一通道 = 细节标记回流重生成；产物本身只读 |
| 3 | 标记模型 | 三态 `ok / no / pending`；`no` 必填修正诉求 note；`pending` 不回流但确认前强提示 |
| 4 | 版本递增 | 每次重生成都 +1，旧版 `superseded` 永不覆盖；回滚 = 以旧版内容生成新版本（来源标 `rollback`） |
| 5 | 确认门 | 存在未处理 `no` 项禁止确认；允许显式「忽略此项」（须填理由）后确认；整条 stage 可「跳过原型」（须填理由，写入评论） |
| 6 | 提示词 | 五段固定模板自动组装（〔需求〕〔目标〕〔仓库〕〔产出〕〔风格〕）+ 条件段〔本轮修正〕；灰底段只读，其余可编辑；模板本身版本化 |
| 7 | 风格治理 | 〔风格〕段注入业务仓设计 token 快照；快照随版本落库，保证重生成风格可复现；禁止引入新组件库 |
| 8 | 细节清单来源 | 原型师 agent 随 HTML 一并产出结构化 `details.json`；用户可追加（来源标 `user`） |
| 9 | 确认操作端 | 确认 / 跳过 / 忽略 仅限 web + desktop；移动端只读预览 + 标记（防止小屏误过确认门） |
| 10 | 资产生成失败 | 自动重试 1 次 → 仍失败置 `failed`，通知需求负责人，不阻塞改走「跳过原型」 |

## 3. 功能分解与细节

### F1 一键生成（提示词自动组装）

**入口**：需求详情抽屉 stage 1 面板右栏「⚡ 一键构建可视化原型」（画面 4 anno 2）。

**组装规则**（模板版本 `prompt_template_version`，当前 `v1`）：

| 段 | 内容来源 | 可编辑性 |
|---|---|---|
| 〔需求〕 | issue 标题 + 描述 | 只读（改需求本体才变） |
| 〔目标〕 | `issue.goal` 全文 | 只读 |
| 〔仓库〕 | `issue.repo_url` + 「先读现有结构与 API 契约」约束句 | 只读 |
| 〔产出〕 | 文件路径约定 + **逐屏列出实现细节** 的输出契约（§F2 的 details.json） | 只读 |
| 〔风格〕 | 设计 token 快照（§F7）+ 「不引入新组件库」约束 | 只读 |
| 〔本轮修正〕 | 仅重生成时存在：当前版本所有 `verdict=no` 项的 `text + note` 拼段 | **可编辑**（用户可改写措辞） |
| 自由补充 | 用户任意追加 | 可编辑 |

**执行契约**：点击后创建 stage 1 子任务（`parent_issue_id`=需求、`stage`=1、assignee=班底原型师），agent_run 关联；**生成中禁止重复点击**（按钮转 loading + 置灰，轮询 agent_run 状态）；默认超时 10 分钟，超时按失败处理（决策 #10）。

**产出登记**：HTML 落仓成功后，(a) 写 `issue_prototype_version`（version = 当前 max+1），(b) 登记 `project_artifact`（doc_type=`prototype`）进交付物面板，(c) 需求评论留痕（版本号 + 提示词 diff 摘要）。

### F2 原型预览与逐屏打点

- 详情抽屉内嵌 `iframe` 预览（`sandbox="allow-same-origin"`，禁脚本执行，防原型里夹带副作用）；「⤢ 打开全屏预览」开独立路由全宽渲染。
- viewport 切换：桌面 1440 / 移动 375 两档（移动档用于校验 App 类需求原型）。
- **双向打点**：原型师输出 HTML 时须在每个「屏/区块」根节点标 `data-detail-id`；预览层读取后与左侧细节清单联动——hover 清单行 → 预览对应区块高亮并滚动到位；点击预览区块右缘徽章 → 定位清单行。清单与锚点 1:1，锚点缺失的清单行在头部计数区告警（「2 条细节未锚定」）。
- HTML > 2MB 时预览降级为「首屏截图 + 下载/全屏打开」，不在抽屉内渲染（性能护栏）。

### F3 实现细节逐项标记

**数据结构**（落地为 `issue_prototype_version.detail_items JSONB`，见 §4 修订）：

```json
[{ "detail_id": "d1", "text": "退款提交后立即返回异步处理中…", "source": "agent|user",
   "screen_anchor": "#sec-apply", "verdict": "ok|no|pending", "note": "修正诉求…",
   "ignored": false, "ignore_reason": "" }]
```

**规则**：
- 点击标记循环切换 `ok → no → pending → ok`；置 `no` 时行内展开 note 输入框，**note 为空视为未处理**（沿用上位 spec §5.3 确认门校验语义）。
- 用户可「＋ 追加一条实现细节」（`source=user`，无锚点，参与全部后续流程）。
- `ignored=true` 的 `no` 项视为已处理（须填 `ignore_reason`），不进入〔本轮修正〕段。
- 头部实时计数 `✓ n · ✗ n · ○ n`，与画面 4 一致。

### F4 ✗ 回流 → 重生成闭环

1. 任意 `no` 且未 ignored 的项变更 → 右栏提示词预览**实时**重拼〔本轮修正〕段（红底，画面 4 anno 4）；
2. 「↻ 按提示词重新生成」→ 走 F1 同一执行契约，`prompt` 落库为当轮完整快照；
3. 新版本 `detail_items` 以**新产出**的 details.json 为准；对旧版逐项按 `detail_id` 匹配继承 `verdict=ok` 的标记（已符合的项不必重标），其余重置为未标记；继承来源在 UI 注明「继承自 v{n}」；
4. `pending` 项不回流（画面 4 anno 4 明确），但确认时若有 `pending` 项弹二次确认列表。

### F5 版本管理

- 版本历史列表（画面 4 anno 8）：版本号 / 来源（`initial` 一键生成 / `regen` 提示词重生成 / `rollback` 回滚）/ 修正摘要 / 时间 / commit_sha；
- 任一历史版本可预览；两个版本可**并排对比**（双 iframe + 细节清单 verdict 差异列）；
- 回滚 = 以目标版本 HTML 内容生成 version+1（`source=rollback`，commit 内容同旧版），保证「当前版」指针单调前进，历史不被改写；
- 旧版本 status 置 `superseded`，确认中的版本 `confirmed` 后同需求不再生成新版本（确认即冻结，要改需走新需求或跳过记录）。

### F6 确认门

**放行条件（全部满足）**：
1. 当前 `pending` 版本不存在 `verdict=no 且 note 非空 且 ignored=false` 的项；
2. 存在 `pending` 项 → 弹窗列清单二次确认；
3. 操作端为 web / desktop（决策 #9）。

**确认动作**：版本 `confirmed` → S1 阶段门（`stage_gate_rule` doc_type=`prototype`）满足 → stage barrier 放行 stage 2（PM plan+拆解），目标覆盖对照（F8）的未覆盖项随上下文移交 PM。

**跳过通道**：「⏭ 跳过原型」须填理由 → 写入需求评论 + `issue_prototype_version` 记一行 `status=skipped` 的零产物版本（version 占位，html_path 空串）保证审计完整；stage 1 直接放行。

### F7 风格治理（设计 token 管理）

- **token 快照**：生成时从业务仓提取设计 token（优先 `packages/ui/styles/tokens.css`，缺失时回退「从现有页面 CSS 变量抓取」），注入〔风格〕段，**快照原文随版本存 `style_snapshot JSONB`**——重生成/回滚时默认沿用当版快照而非重新提取，保证同需求内风格稳定；
- **约束句固化**：「沿用 token，不引入新组件库/新字体/新色板」为模板固定文案；
- **漂移检测**（轻量）：产出 HTML 解析内联色值/字体，不在 token 快照集合内的硬编码值计数 > 阈值（默认 5）→ 预览头部黄条警告「风格漂移 N 处」，不阻断确认，仅提示。

### F8 目标覆盖对照

- 生成后由原型师 agent 输出 `goal_coverage`：把 `issue.goal` 拆条，逐条标 `covered`（原型体现，附锚点）/ `deferred`（后端约束原型不体现 → 转 PM 拆解关注）/ `missing`（遗漏）；
- 面板展示（画面 4 anno 7）；`missing > 0` 时确认门追加一条警告（不阻断）；
- `deferred` 项在确认时自动写入 stage 2 PM 子任务的上下文（plan 关注清单）。

### F9 原型资产库（跨需求管理面）

- 项目视图新增「原型库」TAB：`project_artifact` 中 doc_type=`prototype` 的全量索引，列 = 需求 KEY / 标题 / 模块色 / 版本 / 状态 / 更新时间；筛选 = 模块 / 状态 / 创建人；搜索 = 标题 + 需求 KEY；
- **复用为参考原型**：创建需求时可指定一份已确认原型为「参考」，其 token 快照 + 屏结构清单注入新需求〔产出〕段（风格与信息架构复用，不复制内容）；
- 条目点击 → 对应需求详情抽屉 stage 1 面板（单点事实，不另建详情页）。

## 4. 数据模型修订（对 migration 454 的增量）

`issue_prototype_version` **补列**（新 migration 顺延编号）：

```sql
ALTER TABLE issue_prototype_version
  ADD COLUMN detail_items JSONB NOT NULL DEFAULT '[]',   -- F3 结构化细节清单（吸收原 marks 语义）
  ADD COLUMN prompt_template_version TEXT NOT NULL DEFAULT 'v1',
  ADD COLUMN style_snapshot JSONB NOT NULL DEFAULT '{}', -- F7 token 快照
  ADD COLUMN goal_coverage JSONB NOT NULL DEFAULT '[]',  -- F8 [{item, verdict, anchor?}]
  ADD COLUMN commit_sha TEXT NOT NULL DEFAULT '',
  ADD COLUMN source TEXT NOT NULL DEFAULT 'initial'
      CHECK (source IN ('initial','regen','rollback')),
  ADD COLUMN generation_run_id UUID REFERENCES agent_run(id);
```

- 原 `marks` 列语义被 `detail_items` 吸收（verdict/note 内联）；若 454 已上线则写迁移把 `marks` 按 `detail_id` 并入 `detail_items`，随后 `marks` 列只读冻结（不删列，守既有门禁）。
- `status` CHECK 增加 `'skipped'`（F6 跳过通道的占位版本）。
- 全局资产面**不建新表**，复用 `project_artifact`（456）+ 上述版本表 join。

## 5. API 端点（server REST，handler/prototype.go）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/issues/:id/prototype:generate` | 一键生成 / 重新生成（body 带可编辑段覆盖）；幂等：存在 running 中 generation_run 直接返回该 run |
| GET | `/issues/:id/prototype/versions` | 版本列表（含 detail_items 计数聚合） |
| GET | `/prototype-versions/:vid/preview` | HTML 内容流（带 sandbox 响应头），支持 `?viewport=` |
| GET | `/prototype-versions/:vid/diff?other=:vid2` | 双版本对比数据（细节 verdict 差异 + HTML 文本 diff） |
| PATCH | `/prototype-versions/:vid/details/:detailId` | 三态标记 / note / ignored |
| POST | `/prototype-versions/:vid/details` | 用户追加细节项 |
| POST | `/issues/:id/prototype:confirm` | 确认门（服务端复校 §F6 条件，409 返回未过项清单） |
| POST | `/issues/:id/prototype:skip` | 跳过（body.reason 必填） |
| GET | `/projects/:pid/prototypes` | F9 资产库索引 |

## 6. 状态机（版本级）

```
none → generating → pending_review ──confirm──▶ confirmed（冻结，stage 放行）
                   │      └────────skip(零产物占位)──▶ skipped
                   ├─regen→ generating（新版 pending_review，旧版 superseded）
                   └─fail（重试 1 次后）→ failed → 可再 generate 或 skip
```

- 需求级「原型待确认」派生态不变（上位 spec §6 序 4），版本级状态为其事实来源；
- `confirmed/skipped` 后 stage 1 只读，生成入口隐藏。

## 7. 异常与边界

| 场景 | 处理 |
|---|---|
| 生成超时（10min）/ agent 失败 | 自动重试 1 次 → `failed`，通知负责人，保留「重试 / 跳过」双按钮 |
| 业务仓写入冲突（docs/prototypes 同名） | 文件名单调后缀 `-v{n}`，永不覆盖旧文件 |
| 重生成后旧标记作废 | F4-3 的 ok 继承规则；未继承项在清单顶部提示「N 条待重新标记」 |
| 并发标记（多端同开） | detail 级 PATCH 带 `If-Match: version.updated_at`，冲突返 409 + 最新值 |
| 大 HTML | >2MB 预览降级（F2）；>10MB 拒绝落仓并报错 |
| 无原型师班底的需求 | stage 1 面板整态替换为「未启用原型师」说明 + 一键启用入口（回画面 3 改班底） |

## 8. 端适配

8.1 **web/desktop**：全量能力（生成、标记、对比、确认/跳过）。
8.2 **mobile**：只读预览（全屏 WebView）+ 三态标记 + note；确认/跳过/忽略按钮隐藏并提示「请前往桌面端确认」（决策 #9）。
8.3 预览内容经 API 取流，移动端复用 `bypass-tunnel-reminder` 头注入链路（既有规范）。
8.4 三端共用同一份 `detail_items`，标记实时同步（ws 推送版本级 invalidation）。

## 9. 与 Storybook 受管层的关系（承接选型结论）

- 本模块产物 = **草图交付物**（单文件 HTML，随业务仓版本化），生命周期止于需求确认；它服务「想清楚 + 确认对齐」。
- 需求进入执行后，前端模块定稿由 **Storybook story** 承接（受管层：story = 功能锚点，parameters 挂功能点/源码路径/验收标准），服务「改得准 + 迭代治理」。
- 本期仅在 `project_artifact` 原型记录上预留 `story_ref TEXT` 空字段（后续「确认后一键转 story」迭代使用），不实现转换逻辑。

## 10. 验收标准（本模块落地自验）

1. 全流程 e2e：创建需求（启用原型师）→ 一键生成 → 标记 1 ✗ + note → 重生成 → v2 出现且 v1 superseded → 确认 → stage 2 放行（barrier 放行日志可查）；
2. 确认门：存在未处理 ✗ 时 confirm 返 409 且 UI 禁点；忽略须填理由；skip 须填理由并落评论；
3. 版本 ↔ commit：每版 `commit_sha` 非空且文件存在于业务仓对应路径；回滚生成新版且 `source=rollback`；
4. 风格：重生成沿用同版 token 快照（`style_snapshot` 不变）；漂移超阈值出现警告条；
5. 目标覆盖：`deferred` 项在确认后出现在 stage 2 PM 子任务上下文；
6. 移动端：可预览可标记，确认按钮不出现；
7. 幂等：生成中重复点击只产生一个 agent_run。

## 11. 开放问题（初稿裁决，评审可推翻）

| # | 问题 | 初稿裁决 |
|---|------|----------|
| 1 | 原型是否支持多页面（多文件） | 否，坚持单文件 HTML；多屏用锚点分区表达，控制版本治理复杂度 |
| 2 | 确认后再想改原型 | 不允许重开 stage 1；以「新需求 + 参考原型」承接，保持流水线单向 |
| 3 | details.json 与 HTML 锚点不一致 | 生成契约内自检（锚点缺失清单行告警，F2）；不阻断，容忍原型师漏标 |
| 4 | 修正轮次上限 | 不设硬上限（不同于验收 3 轮）；连续 5 版仍未确认时建议跳过（提示不阻断） |
