# 日历一级模块提升 — 设计（2026-09-06）

> 上游契约：`2026-09-04-requirement-calendar-design.md`（需求日历唯一设计事实源）
> 原型：`2026-09-04-requirement-calendar-prototype.html`（画面 1/2 日历、3 创建、4 原型、5 拆解、6 调度、7 验收）
> 本文档是「日历从任务子视图提升为侧边栏一级模块 + 项目模块需求 TAB」的设计事实源。

## 0. 需求与决策（已确认）

用户决策（2026-09-06 brainstorming 两轮确认）：

1. 日历模块与「任务/项目」**平级**，入口放左侧侧边栏（工作区维度，跨项目聚合需求）。
2. 任务（Issues）子视图下的「日历」tab **彻底移除**，日历只存在于一级页面。
3. 点击需求色块后五阶段能力以**页内抽屉**承载（不跳转详情页、不离开日历上下文）。
4. **项目模块也要展示需求**：项目详情页「概览」改名「任务概览」，tab 栏右侧新增「需求详情」TAB。
5. 原型图 f1 的「项目内日历 tab」形态被本设计取代（用户明确要求高于原型）。

已否决方案：B（IssuesPage forcedView 复用——壳太重且与"移除 tab"纠缠）、C（项目内日历 tab——已被用户否决）。

## 1. 架构与路由（侧边栏一级入口）

| 触点 | 改动 |
|---|---|
| `packages/core/paths/paths.ts` | 新增 `calendar: () => \`${ws}/calendar\`` |
| `apps/web/app/[workspaceSlug]/(dashboard)/calendar/page.tsx` | 新建；壳仿 `issues/page.tsx`（`"use client"` + ErrorBoundary + Suspense） |
| `packages/views/layout/app-sidebar.tsx` | `workspaceNav` 在 `issues` 之后插入 `{ key: "calendar", labelKey: "calendar" }`；`NavKey`/`NavLabelKey` 类型同步 |
| `packages/views/layout/route-icon-components.tsx` | 注册 `/calendar` → lucide `CalendarDays` |
| i18n | en/ja/ko/zh-Hans 四 locale 补 `nav.calendar` 词条 |
| 激活态 | `isNavActive` 前缀匹配天然覆盖 `/calendar/*` 子路由 |

新增路由域触点检查清单（防遗漏）：路径注册 → 侧栏 nav 数组 → NavKey/NavLabelKey 类型 → routeIconForPath 映射 → isNavActive → i18n 四语言。

## 2. 日历页面（packages/views/calendar/）

**分层原则：页面负责数据与过滤，渲染组件保持纯受控。**

- `calendar-page.tsx`：
  - 数据源：workspace scope issue 列表查询（与 `/issues` 同管道，`requirementCalendarColumns` 投影已齐），客户端过滤出需求（顶层、无 parent）。
  - 工具栏（原型 f1）：`‹ ›` `今天` ｜ 月份标题 ｜ **周/月 seg** ｜ 项目过滤 ｜ PM 过滤 ｜ 拆解状态过滤 ｜ 右侧 `⚠ 待确认 N` 聚合 chip（点击过滤 原型待确认 + 拆解待确认）。
  - 「＋新建需求」复用现有 `openCreateIssueWithPreference` 创建弹窗（日历字段 + git 库选择器已完成）。
- 渲染：`<CalendarView issues={filtered} />` 原样复用（纯受控组件；月/周渲染、跨日色块、状态点、拖拽调期均已完成于 T8/T9）。
- `calendar-view.tsx` **git mv 搬家**至 `packages/views/calendar/`，测试文件随迁；若组件内有对 IssuesPage view-store 的耦合（缩放/过滤读取），在搬家时一并参数化。

## 3. 需求抽屉（五阶段承载，双场景复用）

- `requirement-drawer.tsx`（`packages/views/calendar/`）：右侧滑出抽屉。
  - 概要头：编号 / 标题 / 时间窗（start_at ~ due_date 分钟粒度）/ 班底头像 / 派生状态徽标（10 态）。
  - 主体：**直接复用 `<RequirementFlowSection issue={issue} childIssues={children} />`**——四阶段条（①原型 → ②拆解 → ③执行 → ④验收）+ 当前阶段面板（原型规划 / 需求拆解 / 执行调度 / 交付验收）自动就位。面板组件已是独立受控组件，零手术。
  - issue / childIssues 由抽屉内 `issueDetailOptions` 等 query 获取，**与详情页同 React Query 缓存键（`issueKeys`）**，抽屉与详情页双向操作即时一致。
  - 打开时按派生状态自动定位当前阶段（FlowSection 内部 `deriveFlowStage` 已有推导）。
  - 抽屉内操作（原型确认 / 拆解确认 / 手动触发 / 验收 verdict）走现有 mutation；关闭后日历/列表查询失效刷新。
- issue 详情页**保留** RequirementFlowSection 原挂载不变（同组件双场景复用）。
- 复用方：日历页色块点击 + 项目「需求详情」tab 卡片点击（§4b）。

## 4. 任务子视图清理

- IssuesPage 视图 tab 移除「日历」（看板/列表/表格/泳道/甘特回归无日历态）。
- 同步收敛：view type 枚举的 `calendar` 分支、`useIssueViewUrlSync` 的 calendar 序列化、`usesServerStatusSurface` 挂载点、view-store FilterSnapshot 的 calendar 残留。
- IssuesPage 不再 import calendar-view。
- **注意**：项目详情页 IssueSurface 的 `modes` 数组当前含 `calendar`（project-detail.tsx L562）——项目内「任务概览」的视图模式是否保留 calendar 由 §4b 决策：保留（项目内任务视角的日历仍有价值，且它是 IssueSurface 既有能力，不属于本次"任务子视图"清理范围；用户否决的是**工作区 /issues 页**的日历 tab）。

## 4b. 项目模块：任务概览改名 + 需求详情 TAB

项目详情页 tab 容器 `project-archive-views.tsx`（`?view=` URL 驱动分段控件，现有 概览/档案/产品功能/数据模型/申报就绪度 五 tab）：

| 改动 | 内容 |
|---|---|
| 改名 | `archive.views.overview` 四语言文案：概览 → **任务概览**（en/ja/ko 同步对应） |
| 新增 tab | views 数组末尾加 `requirements`「**需求详情**」；`isProjectView` 白名单 + 渲染分支同步 |
| tab 内容 | `requirement-list-panel.tsx`（放 `packages/views/calendar/` 与抽屉同目录，跨场景复用）：该项目下顶层需求卡片列表（编号/标题/时间窗/10 态徽标/班底头像/阶段进度），默认按 start_at 升序 |
| 复用 | 点击卡片 → 打开与日历页共享的同一个 RequirementDrawer |

**交接面声明**：`project-archive-views.tsx`、`project-detail.tsx`、`locales/*/archive.json` 属 archive 并行会话未提交文件。本设计对其只做最小 diff（+1 tab 定义/白名单/渲染分支 + 1 处文案改），不重构、不动 archive 业务组件；若实现时发现并行会话已改动同区域，以最小冲突方式合并。

## 5. 错误处理

| 场景 | 处理 |
|---|---|
| 列表查询失败 | toast + 页面级重试 |
| 拖拽改期 409（已触发需求） | 沿用现有 toast 提示（行为不变） |
| 抽屉内 query 失败 | 各面板既有错误态（不新增） |
| 页面级渲染异常 | ErrorBoundary（壳已含） |

## 6. 测试

- `calendar-page.test.tsx`：渲染 + 项目/PM/拆解状态过滤 + 待确认聚合 chip。
- `requirement-drawer.test.tsx`：打开（传 issue id）→ FlowSection 渲染 + 阶段定位；关闭后查询失效。
- `requirement-list-panel.test.tsx`：项目维度过滤 + 卡片渲染 + 点击开抽屉。
- 侧边栏：`/calendar` 前缀激活测试。
- IssuesPage 移除 tab 后现有测试回归更新（视图枚举收窄影响面）。

## 7. 风险与边界

- 抽屉与详情页共享缓存键，双向操作一致性由 React Query 失效机制保证。
- 拖拽改期仍走 `useUpdateIssue`，已触发需求 409 保护不变。
- 零后端改动（五阶段 API/投影全部就绪）；零接触 WS3 daemon 与 archive 业务组件。
- `packages/views/calendar/` 新包需在 views 包出口（index）注册。
