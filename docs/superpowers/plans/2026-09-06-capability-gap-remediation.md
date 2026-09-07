# 双原型差距补齐 — 技术方案与模块影响

- 日期：2026-09-06
- 上游：`../specs/2026-09-06-能力差距评估.md`（差距结论）
- 产品契约：`../specs/2026-09-06-calendar-module-elevation-design.md`（W1）
- 设计事实源：`../specs/2026-09-04-requirement-calendar-design.md` · `../specs/2026-09-05-project-archive-design.md`
- 原则：**组装优先，零新机制。** 不新建需求表、不给日历单独状态机、Web 不读文件系统。

---

## 0. 本轮范围与非目标

| 波次 | 做 | 不做 |
|---|---|---|
| W1 | 日历一级页面 + 抽屉 + 项目「需求详情」；工作区 Issues **去掉**日历 tab | 项目「任务概览」里的 IssueSurface 日历 **保留**（提升设计 §4） |
| W2 | f5 确认工作台加深（plan 分段、功能点 CRUD、图谱/验收审阅） | 不改确认 API 语义；Web 不直连 GitNexus |
| W3 | 档案控制台接 461 端点；矩阵带 issue 标题 | 不把「从模板创建」做进浏览器；存量 `migrate --apply` 需用户确认 |
| W4 | 改 parent 级联重算 root；WS3 收尾；一条 Playwright | override/改派、filing PDF、本体邻域 **延期** |

**已预埋、勿重复造：** `paths.calendar`、侧栏 `NavKey="calendar"`、`route-icons` 的 `CalendarDays`、四语言 `layout.nav.calendar`。缺的是**页面壳与内容**，不是导航声明。

---

## W1 · 日历成为一级模块

### 1.1 目标行为

1. 侧栏「日历」打开 `/{slug}/calendar`（web + desktop），不再 404。
2. 工作区 Issues 视图切换里不再出现「日历」；已持久化的 `viewMode=calendar` 回落到 list。
3. 色块点击打开右侧抽屉，**不跳** `issueDetail`；抽屉内复用 `RequirementFlowSection`。
4. 项目详情 tab 末尾加「需求详情」，点卡片开同一抽屉。项目「任务概览」仍可切 IssueSurface 日历。

### 1.2 数据与状态

**列表数据（日历页）：** 不走 IssueSurface / `usesServerStatusSurface`。新建 `calendarIssuesOptions(wsId)`：

```
GET /api/issues
  include_sub_issues=false
  limit=500（分页直到 total，封顶与 gantt 同 10_000）
```

客户端再滤：`parent_issue_id == null` 且存在 `start_at | start_date | due_date`。投影列已由修复 F/G 的 `requirementCalendarColumns` 齐备，**零后端**。

过滤（纯客户端，不把 `requirement_status` 当 server 过滤维——它是 CASE 派生）：

| 控件 | 依据 |
|---|---|
| 项目 | `issue.project_id` |
| PM | `issue_role_assignment` 已在详情；列表侧用 `assignee_*` 不够。**v1 用 issue.assignee（顶层责任人）近似**；精确 PM 需 `GET /issues/{id}/roles` 会 N+1。W1 先近似，W2 若痛再加 list 投影 `pm_assignee` |
| 拆解状态 | `requirement_status ∈ {未拆解, 拆解待确认, 原型待确认, …}` |
| 待确认 chip | `requirement_status ∈ {原型待确认, 拆解待确认}` |

**缩放：** 从 `CalendarView` 内读 `view-store.calendarZoom` **改为受控 props**（`zoom` / `onZoomChange`）。日历页自管 state（可 persist 到 `StorageAdapter` 键 `calendar.zoom`）。项目 IssueSurface 日历继续读 view-store，避免搬家时项目日历丢偏好。

**抽屉状态：** `useCanvasState` 不可用。用 URL `?req=<issueId>`（replace-not-push）+ React state。刷新可回放；与档案 `?view=` 同模式。

**缓存：** 抽屉内 `issueDetailOptions` / `issueKeys.children` / `issueRolesOptions` / `decompositionOptions` / `prototypeVersionsOptions` **与详情页同 key**。确认/触发/verdict 后 `invalidateQueries(issueKeys.list*)` + `calendarIssues` 键，色块进度即时更新。

### 1.3 CalendarView 改造（搬家前必须做）

当前耦合（必须拆）：

| 现状 | 改造 |
|---|---|
| `useViewStore(s => s.calendarZoom)` | props：`zoom: "week"\|"month"` + `onZoomChange` |
| `AppLink href={paths.issueDetail}` | props：`onSelectIssue?(issue)`；未传则保持旧链（项目任务概览可继续跳详情，或同样开抽屉） |
| 工具栏「‹ › 今天 周/月」 | 保留在 CalendarView 内（纯受控） |
| 项目/PM/待确认过滤 | **不**进 CalendarView，由 `calendar-page` 负责 |

`git mv`：

```
packages/views/issues/components/calendar-view.tsx
packages/views/issues/components/calendar-view.test.tsx
  → packages/views/calendar/
```

`issue-surface.tsx` 改为 `import { CalendarView } from "../../calendar/calendar-view"`，并传入 `zoom`/`onZoomChange`（从 view-store 取，项目场景行为不变）。

### 1.4 抽屉

`packages/views/calendar/requirement-drawer.tsx`：

- 壳：`@multica/ui` 的 `Sheet` + `SheetContent`（`side=right`，宽 `min(720px, 100vw)`）。
- 头：identifier / title / `start_at~due_date` / 10 态徽标 / 班底头像（`issueRolesOptions`）。
- 体：`<RequirementFlowSection issue={detail} childIssues={children} />`。
- 关：清 `?req=`；`invalidateQueries` 日历列表。
- FlowSection **零改签名**（已是 `issue + childIssues`）。W2 加深的面板自动出现在抽屉里。

### 1.5 路由与三端壳

| 端 | 文件 | 动作 |
|---|---|---|
| web | `apps/web/app/[workspaceSlug]/(dashboard)/calendar/page.tsx` | 仿 `issues/page.tsx`：ErrorBoundary + Suspense + `<CalendarPage />`。**不要**挂 `useIssueViewUrlSync` |
| desktop | `apps/desktop/.../routes.tsx` | `:workspaceSlug/calendar` → `<CalendarPage />`，`handle.title = Calendar`。`sanitizeTabPath` 已接受任意 `/{slug}/…`，**不必改 tab-store** |
| mobile | — | 本轮不做；侧栏 mobile 若渲染 workspaceNav，点日历可先 toast「请在桌面打开」或隐藏该项（实现时看 `app-sidebar` 在 mobile 的裁剪） |

`packages/views/calendar/index.ts` 导出 `CalendarPage`、`RequirementDrawer`、`RequirementListPanel`、`CalendarView`。

### 1.6 Issues 子视图清理（工作区 only）

| 文件 | 改法 |
|---|---|
| `issues-page.tsx` | `modes` 去掉 `"calendar"` |
| `issues-header.tsx` | **日历 RadioItem 必须按 modes 门控**。现状：board/list/table/swimlane/calendar **写死**，只有 gantt 看 `allowGantt`。不改这里，IssuesPage 去 mode 后用户仍能切到日历，controller 会因 `allowedModes` 把 mode 打回 list，表现为「点了没反应」 |
| `issue-surface.tsx` | 保留 calendar 分支（项目任务概览要用） |
| `view-store.ts` / `types.ts` | **保留** `ViewMode` 的 `calendar`（项目面还在） |
| `save-view-dialog.tsx` | 工作区已存「日历」偏好：打开 Issues 时 fallback list，不删库 |
| `use-issue-view-url-sync` | 工作区 `?view=calendar` → 忽略，落到默认 list |
| `search-command.tsx` | 已有 calendar 关键词，把跳转从 issues+calendar 改为 `paths.calendar()` |

### 1.7 项目「需求详情」TAB（最小 diff）

`project-archive-views.tsx`：

```
ARCHIVE_VIEWS += "requirements"
views 末尾 + { value: "requirements", label: archive.views.requirements }
渲染：<RequirementListPanel projectId onSelect={openDrawer} />
```

`locales/*/archive.json`：`views.overview` 文案 概览 → 任务概览；新增 `views.requirements`。

抽屉挂在 `ProjectArchiveViews` 这一层（概览/需求详情都能开），**不要**塞进 ArchiveTab / Filing 等业务组件。

`RequirementListPanel`：`api.listIssues({ project_id, include_sub_issues: false })`，客户端滤顶层，按 `start_at` 升序。卡片：编号 / 标题 / 时间窗 / 10 态 / 班底（班底 v1 可省略头像，只示状态，避免 N+1）。

### 1.8 文件清单（W1）

**新建**

- `packages/views/calendar/calendar-page.tsx` + `.test.tsx`
- `packages/views/calendar/requirement-drawer.tsx` + `.test.tsx`
- `packages/views/calendar/requirement-list-panel.tsx` + `.test.tsx`
- `packages/views/calendar/index.ts`
- `apps/web/app/[workspaceSlug]/(dashboard)/calendar/page.tsx`
- `packages/core/issues/queries.ts` 增 `calendarIssuesOptions`（或放 `packages/core/calendar/queries.ts`，避免把日历过滤塞进 issues 袋）

**移动**

- `calendar-view.tsx` + test → `packages/views/calendar/`

**修改（小）**

- `issue-surface.tsx`：import 路径 + 受控 zoom + `onSelectIssue`（项目面可继续 `issueDetail`）
- `issues-page.tsx`：modes
- `issues-header.tsx`：calendar radio 跟 `allowGantt` 同样门控
- `project-archive-views.tsx`：+1 tab + 抽屉宿主
- `project-detail.tsx`：仅当 views 容器没包到抽屉时才动；优先不动
- `apps/desktop/.../routes.tsx`：+1 route
- `search-command.tsx`：日历跳转
- `locales/*/archive.json`、`issues.json`（日历页工具栏词条）
- `packages/views/issues/components/index.ts`：若有 calendar-view 再导出，改为从 calendar 重导出或删除

**不改**

- `paths.ts` / `app-sidebar.tsx` / `route-icons.ts` / `layout.json`（已齐）
- daemon / WS3 / archive 业务组件（矩阵、filing、graph）

### 1.9 验收

- 侧栏日历：web + desktop 都能进页，月/周/过滤/待确认 chip 可用。
- 工作区 Issues 无日历项；旧 `viewMode=calendar` 自动 list。
- 色块开抽屉，确认拆解后色块进度变，详情页打开同一需求所见一致。
- 项目「需求详情」列表 → 同一抽屉。
- 项目任务概览仍能切日历（IssueSurface）。

---

## W2 · f5 确认工作台

### 2.1 目标行为

确认页变成「能审、能改、能挡住拆得不够」，**确认 API 路径与三类校验不变**。

### 2.2 类型与契约（向前兼容）

`DecomposeFeaturePoint` 现状：`title` / `kind` / `code_objects?`。Go 结构体同三字段。

**加可选字段，旧草稿仍合法：**

```ts
interface DecomposeFeaturePoint {
  title: string;
  kind: "new" | "modify" | "";
  code_objects?: string[];
  detail?: string;           // 实现细节，确认时原样写入 issue.feature_points JSONB
}

interface GraphContextView {
  nodes?: Array<string | { id?: string; label?: string }>;
  code_objects?: string[];
  dependencies?: string[];
  impacts?: string[];
  queried_at?: string;
  source_commit?: string;
}

interface AcceptanceSpecView {
  path?: string;
  version?: string;
  base_version?: string;
  assertions?: string[];
  cases?: Array<string | { name?: string }>;
  note?: string;
}
```

Go `DecomposeFeaturePoint` 加 `Detail string \`json:"detail,omitempty"\``。`json.Marshal` 进 `issue.feature_points`，**不改表**。`GraphContext` / `AcceptanceSpec` 已是 `json.RawMessage`，前端加深展示即可，服务端继续原样落库。

确认请求体仍是 `{ drafts }`。现有校验（kind / 班底 / 同模块依赖）不动。新增前端门：`kind === ""` 或（可选）`title` 空 → disable 确认，与现 `hasUnmarkedFeaturePoint` 对齐。

### 2.3 plan 分段（零后端）

`GET /decomposition` 的 `plan` 是评论全文。前端用标题启发式切三段，**不要求 PM agent 改产出格式**；切不出则整段展示（现状），不报错。

识别顺序（大小写/中英都认）：

1. `## 目标分解` / `## Goals` / `## 目标`
2. `## 阶段划分` / `## Phases` / `## 阶段`
3. `## 风险` / `## Risks`

对照高亮：把各 stage3 草稿 `title` 与「目标分解」段落做包含/相似度（简单：规范化后 `includes`）。对不上的草稿标题旁黄点「未在 plan 中出现」——**不阻断确认**（避免误伤）。

### 2.4 右栏交互

| 能力 | 实现 |
|---|---|
| 卡片折叠 | 默认展开第一张 stage3 + 验收卡；其余 `<details>` |
| 功能点增删 | `patchDraft` 改 `feature_points` 数组；空 title 禁止确认 |
| kind + detail + code_objects | 行内编辑；待定 `kind=""` 红框（已有 class 可复用） |
| 执行人改动高亮 | 记录 `initialAssignee`（来自 resolveDraftAssignees 后的快照）；变更则 `.asg.edit` |
| 图谱四要素 | 从 `graph_context` 抽 nodes / code_objects / dependencies / impacts；缺则「档案未就绪」 |
| 重新查询 | **不**调 GitNexus。按钮写一条评论 `@<pm-agent> 请按当前仓库重跑 /impact-analysis，更新本需求拆解草稿的 graph_context`，走既有 comment → trigger。按钮旁注明「将派发 PM agent」 |
| 验收规约 | 展示 path / version / assertions / cases；stage4 卡只读（服务端指派 tester） |
| KV | 补 `decompose_mode` 文案映射（auto/confirm/manual） |

「修改基础信息回创建表单」：抽屉头放「打开详情」链接即可，不做第二套编辑器。

### 2.5 影响的模块

| 模块 | 影响 | 说明 |
|---|---|---|
| `requirement-decompose-panel.tsx` | **主改** | 工作台 UI |
| `requirement-decompose-panel.test.tsx` | 必更 | 增删 fp、对照高亮、折叠、确认 disable |
| `requirement-flow-section.tsx` | 极小 | 仅当 requery 需要 `createComment` 时把 mutation 注入；或面板自己 `useCreateComment` |
| `packages/core/types/api.ts` | 小 | FP + 两个 View 类型 |
| `server/.../requirement_decompose.go` | 小 | `Detail` 字段；校验逻辑不动 |
| 日历抽屉 / 详情页 | 无改 | 同组件双挂载，W2 自动出现在两处 |
| i18n `issues.json` 四语言 | 中 | `decompose_panel.*` 新键，受 `parity.test.ts` 门禁 |

### 2.6 验收

- 待定 kind / 空 title 无法确认。
- 增删功能点后 confirm payload 含新数组，服务端建出的 `feature_points` JSONB 含 `detail`。
- plan 有标准标题时分三块；无标题时整段，不崩。
- 「重新查询」产生一条带 mention 的评论（可用 test 捕获 mutation）。

---

## W3 · 档案最后一公里

### 3.1 前端接线（后端已有）

| 能力 | 后端 | 前端现状 | 做法 |
|---|---|---|---|
| 绑定候选 | `GET .../artifacts/bind-candidates` | client **0 方法** | `api.listArtifactBindCandidates(projectId)` + `artifactKeys.bindCandidates` |
| 真诊断 | `sync_diagnostics` + 上报/查询（461） | sync-console 推断五阶段 | 读最近 `sync_run_id` 的诊断行，按 stage 聚合；无行则保持「尚无分阶段回报」 |
| 同步配置 | `GET\|PUT .../sync-config` | 范围勾选 disabled | 控制台可写 `sync_mode` / `conflict_policy` / `batch_bind_threshold`；范围过滤仍只读（改它要 CLI 认 `scope_filter`，本轮只展示当前值） |
| 矩阵标题 | `GetArtifactMatrix` 只 `issue_id, stage, count` | `artifact-matrix.tsx` TODO | SQL `LEFT JOIN issue` 投影 `identifier, title`；DTO 加字段；前端不再猜 |

**绑定 UX：** 待绑定队列每行展示 top 候选 + conf。`conf >= threshold`（默认 0.85）可「批量绑定」→ 循环 `POST .../bind`。低于阈值只允许点选。绑定后 invalidate `artifactKeys.list` + `matrix`。

### 3.2 矩阵 SQL（唯一必改的档案后端）

```sql
SELECT pa.issue_id, pa.stage, COUNT(*)::bigint,
       i.identifier, i.title
FROM project_artifact pa
LEFT JOIN issue i ON i.id = pa.issue_id
WHERE pa.project_id = $1 AND pa.deleted_at IS NULL
GROUP BY pa.issue_id, pa.stage, i.identifier, i.title
```

`unbound`（`issue_id IS NULL`）标题空，前端继续走待绑定队列。

### 3.3 模块影响

| 模块 | 影响 |
|---|---|
| `packages/core/api/client.ts` + `client.test.ts` | +3 方法：candidates / diagnostics / syncConfig |
| `packages/core/types/artifact.ts` | 候选 DTO、诊断 DTO、syncConfig DTO；matrix cell +identifier/title |
| `packages/core/artifacts/queries.ts` | 新 query keys；修正 `unboundArtifactsOptions` 注释（专用 unbound 端点已存在则可改走它） |
| `sync-console.tsx` | 接诊断 + 候选 + 配置；删「推断阶段」TODO |
| `artifact-matrix.tsx` | 用服务端标题 |
| `handler/project_artifact.go` `GetArtifactMatrix` | JOIN |
| `project_archive_sync_config.go` | **不改**（已实现） |
| archive 其他（preview / filing / graph） | **不改** |

### 3.4 验收

- 控制台能看到最近一次 sync 的 scan/parse/upload/index 真错误。
- unbound 行带候选与 conf；≥0.85 可批量绑。
- 矩阵行显示 `SIRI-21 标题` 而不是裸 UUID。

---

## W4 · 运行时收口

### 4.1 改 parent 级联重算 root（P0）

**位置：** `handler/issue.go` 在 `rawFields["parent_issue_id"]` 写完 `params` 且 Update 成功后，同事务：

```sql
WITH RECURSIVE tree AS (
  SELECT id FROM issue WHERE id = $updated_id
  UNION ALL
  SELECT i.id FROM issue i JOIN tree t ON i.parent_issue_id = t.id
),
root AS (
  -- 沿 parent 链向上取根；无 parent 则自身
  ...
)
UPDATE issue SET root_requirement_id = root.id
WHERE id IN (SELECT id FROM tree);
```

规则：新 parent 的 root（或 parent 自身若是顶层）成为整棵子树的 root。清 parent → 该节点变顶层，自身 + 子孙 root = 该节点。

**测试：** 三级链 A←B←C，把 B 挂到 D，则 B、C 的 root 变为 D 的 root（或 D）。再清 B.parent → B、C root = B。

**影响：** `service/issue.go` Update 路径、`issue.sql` 可加 `RecomputeRootForSubtree`；daemon locker **不改**（认 root 列）。

### 4.2 WS3 收尾

进度文档 §3 剩余：claim 投影 `RootRequirementID`、claim 闸门 `NOT EXISTS` 同模块异 root、`TestClaimGateGroupMutex`、451 spec 修订、提交。与 W1–W3 **无文件重叠**，可先单独提交。

### 4.3 Playwright

一条：创建需求（confirm 模式、自动触发关）→ 开日历抽屉 → 若有 prototyper 则跳过或确认 → 拆解确认 → 手动触发 → 验收 fail → 见修复子任务。环境用 dev 工作区。不进本轮：filing PDF、override、图谱邻域。

---

## 模块影响总表

影响级别：主改 / 必改 / 小改 / 回归 / 不动。

### 应用层

| 模块 | W1 | W2 | W3 | W4 | 说明 |
|---|---|---|---|---|---|
| `apps/web` calendar page | 主改 | — | — | — | 新建壳 |
| `apps/web` issues page | 回归 | — | — | — | 不再挂日历 url sync |
| `apps/desktop` routes | 必改 | — | — | — | +1 路由 |
| `apps/desktop` tab-store | 不动 | — | — | — | 路径已合法 |
| `apps/mobile` | 不动 | — | — | — | 本轮不做 |

### 视图层 · 布局 / 导航

| 模块 | W1 | W2 | W3 | W4 |
|---|---|---|---|---|
| `layout/app-sidebar.tsx` | 不动（已有 calendar） | — | — | — |
| `layout/route-icon-components` | 不动 | — | — | — |
| `search/search-command.tsx` | 小改 | — | — | — |
| `locales/*/layout.json` | 不动 | — | — | — |

### 视图层 · 任务 / 日历

| 模块 | W1 | W2 | W3 | W4 | 说明 |
|---|---|---|---|---|---|
| **新建** `views/calendar/*` | 主改 | 间接受益 | — | — | 页 / 抽屉 / 列表 |
| `calendar-view.tsx` | 主改（搬家+受控） | — | — | — | 拆 view-store / 改点击 |
| `issues-page.tsx` | 必改 | — | — | — | modes 去 calendar |
| `issues-header.tsx` | 必改 | — | — | — | 日历 radio 按 modes 门控 |
| `issue-surface.tsx` | 必改 | — | — | — | import + 受控 zoom；**保留** calendar 分支 |
| `use-issue-surface-controller` | 回归 | — | — | — | 项目面仍走 calendar 分页 |
| `view-store` / `ViewMode` | 小改或不动 | — | — | — | **不要删** calendar 枚举 |
| `save-view-dialog.tsx` | 小改 | — | — | — | 工作区日历偏好 fallback |
| `issue-detail.tsx` | 不动 | 间接受益 | 不动 | — | FlowSection / Drill 已挂 |
| `requirement-flow-section.tsx` | 不动 | 小改（可选注入 comment） | — | — | |
| `requirement-decompose-panel` | — | **主改** | — | — | |
| `requirement-prototype/schedule/acceptance` | 不动 | 不动 | — | — | 抽屉自动复用 |
| `create-issue.tsx` | 不动 | — | — | — | 新建需求已有日历字段 |
| `RoleStrip` | 不动 | — | — | — | |

### 视图层 · 项目 / 档案

| 模块 | W1 | W2 | W3 | W4 | 说明 |
|---|---|---|---|---|---|
| `project-archive-views.tsx` | **必改（最小）** | — | 不动 | — | +1 tab + 抽屉宿主。档案并行会话冲突面 |
| `project-detail.tsx` | 尽量不动 | — | — | — | IssueSurface modes **仍含 calendar** |
| `archive/sync-console.tsx` | — | — | **主改** | — | |
| `archive/artifact-matrix.tsx` | — | — | 必改 | — | |
| `archive/archive-tab` 等其余 | 不动 | — | 不动 | — | |
| `requirement-drill/*` | 不动 | — | 不动 | 小（orphan 展示，若做） | 已挂在 issue-detail |
| `graph/*` / `filing/*` | 不动 | — | 不动 | 不动 | 本轮不承诺 |

### 领域层 · core

| 模块 | W1 | W2 | W3 | W4 |
|---|---|---|---|---|
| `paths/paths.ts` | 不动 | — | — | — |
| `issues/queries.ts` | 小改（calendar 列表 options） | — | — | — |
| `issues/mutations.ts` | 不动 | 不动（confirm 已有） | — | — |
| `types/api.ts` | — | 小改 | — | — |
| `types/artifact.ts` | — | — | 必改 | — |
| `api/client.ts` | 不动 | 不动 | 必改 | — |
| `artifacts/queries.ts` | — | — | 必改 | — |

### 后端

| 模块 | W1 | W2 | W3 | W4 |
|---|---|---|---|---|
| `handler/issue.go` Update parent | — | — | — | **主改** |
| `service/requirement_decompose.go` | — | 小（Detail 字段） | — | — |
| `handler/project_artifact.go` matrix | — | — | 必改 | — |
| `handler/project_archive_sync_config.go` | — | — | 不动 | — |
| `daemon/module_locker*` | — | — | — | 提交收尾（勿与 W1 混） |
| `handler/daemon.go` claim 投影 | — | — | — | WS3 |
| 触发 / 验收 / 班底 / 原型 API | 不动 | 不动 | 不动 | 不动 |

### 测试与 i18n

| 模块 | 影响 |
|---|---|
| `calendar-view.test.tsx` | 随迁；补 `onSelectIssue` / 受控 zoom |
| `use-issue-surface-controller.test.tsx` | 工作区 modes 不再含 calendar 的用例；项目面保留 |
| `issues-header` 相关 | 无 calendar mode 时不渲染 RadioItem |
| `locales/*/issues.json` | W1 日历页 + W2 decompose 新键 |
| `locales/*/archive.json` | W1 任务概览 / 需求详情 |
| `parity.test.ts` | 四语言必须齐 |

---

## 交叉影响与落地顺序

```
W4-WS3 提交（独立，先清工作区）
    │
    ├── W1 日历入口 ──────────────┐
    │     └─ 只碰 project-archive-views 最小 diff
    │
    ├── W2 f5 工作台（与 W1 并行）─┤  文件几乎不重叠
    │
    └── W1 合入后 → W3 档案接线 ──┤  避开 views 容器冲突
                                  │
                                  └─ W4 parent 级联 + Playwright
```

**并行纪律**

1. W1 对 `project-archive-views.tsx` / `locales/*/archive.json` 只加 tab + 文案，不重排档案组件。
2. W2 只改 decompose 面板 + 类型 + Go 一个 struct 字段。
3. W3 不改 `project-archive-views` 的 tab 顺序（W1 已加 requirements）。
4. WS3 locker 与上述无重叠，先提交减少脏工作区。

**共享缓存风险：** 抽屉与详情同 `issueKeys`。W1/W2 的 confirm/trigger 已有 invalidate；日历列表是新 query key，确认后必须显式失效，否则色块停在旧 `stage_progress`。

**ViewMode 残留：** 删除枚举会打断项目任务概览与已存偏好。正确做法是 **枚举保留、工作区入口收回**。

---

## 工作量再估

| 波次 | 人日 | 风险 |
|---|---|---|
| W1 | 6–8 | IssuesHeader 门控遗漏；desktop 路由漏加；project-archive-views 合并冲突 |
| W2 | 6–9 | plan 启发式误切（必须有整段 fallback）；Detail 字段漏加 Go |
| W3 | 5–7 | 诊断查询契约与 CLI 上报字段对齐 |
| W4 | 4–6 | parent 级联漏子孙；WS3 测试环境 |

合计约 **21–30 人日**，W1∥W2 可压到约三周日历。
