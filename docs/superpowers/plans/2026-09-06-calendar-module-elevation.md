# 日历一级模块提升 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 日历从任务子视图提升为侧边栏一级模块（工作区维度 + 需求抽屉五阶段），项目详情页「概览」改名「任务概览」并新增「需求详情」TAB。

**Architecture:** 新路由 `/calendar` 渲染 `packages/views/calendar/calendar-page.tsx`（数据/过滤层）+ 复用纯受控 `CalendarView`（渲染层，git mv 搬家）；`RequirementDrawer` 复用 `RequirementFlowSection` 承载五阶段，日历页与项目需求 tab 双场景共享；项目详情 tab 容器做最小 diff（并行会话交接面）。

**Tech Stack:** React 19 + Next.js App Router + TanStack Query + zustand（view-store）+ Tailwind + lucide-react；测试 vitest + @testing-library/react。

**Spec:** `docs/superpowers/specs/2026-09-06-calendar-module-elevation-design.md`

**关键既有事实（侦察结论，勿重推导）：**
- `CalendarView({ issues }: { issues: Issue[] })` 纯受控，自带工具栏（prev/next/today + 周/月 seg），zoom 存于 view store 的 `calendarZoom`。
- `CalendarView` 依赖 `useViewStore` → 日历页须包 `ViewStoreProvider`，store 用 `getIssueSurfaceViewStore("calendar-page")` 独立实例。
- 色块点击：`RequirementBlock` 收 `href={paths.issueDetail(id)}`，内部 `AppLink` 跳详情页（calendar-view.tsx L461/L508）。
- `use-issue-surface-controller.ts` L245-255：modes 不含持久化 viewMode 时自动回落 `modes[0]`——/issues 页移除 calendar tab 无需处理残留偏好。
- 导航单一事实源：`packages/core/paths/route-icons.ts` 的 `WORKSPACE_PAGES`（Record 类型，缺 key 编译错误）+ views 层 `ROUTE_ICON_COMPONENTS`（Record 类型同理）。
- `issueListOptions(wsId, sort)` 返回 `Issue[]`，Issue 已含 `start_at/due_date/requirement_status/auto_trigger/decomposition_confirmed_at/acceptance_round/parent_issue_id`。
- `childIssuesOptions(wsId, id)`、`issueDetailOptions(wsId, id)` 现成；缓存键 `issueKeys` 与详情页共享。
- `RequirementFlowSection` props：`{ issue: Issue; childIssues: Issue[] }`（issue-detail.tsx L3251 挂载实证）。
- 抽屉基座：`@multica/ui/components/ui/sheet` 的 Sheet/SheetContent 存在。
- 项目详情 tab 容器 `project-archive-views.tsx`：`?view=` 驱动，白名单 `isProjectView` + views 数组 + 渲染分支三处触点；i18n 在 `locales/*/archive.json` 的 `views.*`。
- **并行交接面**：`project-archive-views.tsx`、`project-detail.tsx`、`locales/*/archive.json` 是 archive 会话未提交文件——只做最小 diff。
- 前端测试命令：`pnpm --filter @multica/views test -- <path>`；typecheck：`pnpm --filter @multica/views exec tsc --noEmit`。

---

### Task 1: 导航注册（路径 + 图标契约 + i18n + 侧边栏入口）

**Files:**
- Modify: `packages/core/paths/paths.ts`（workspace paths 对象内，L30 `issues:` 之后）
- Modify: `packages/core/paths/route-icons.ts`（RouteIconName L22 联合、NavLabelKey、WorkspacePageKey、WORKSPACE_PAGES）
- Modify: `packages/views/layout/route-icon-components.tsx`（import + ROUTE_ICON_COMPONENTS 映射）
- Modify: `packages/views/layout/app-sidebar.tsx`（NavKey L113、NavLabelKey L129、workspaceNav L152）
- Modify: `packages/views/locales/{zh-Hans,en,ja,ko}/layout.json`（nav.calendar）
- Test: `packages/core/paths/route-icons.test.ts`（若存在；否则新建）

- [ ] **Step 1: 写失败测试**

`packages/core/paths/route-icons.test.ts` 追加（若文件不存在则新建并保留既有断言风格）：

```ts
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_PAGES,
  resolveRouteIconName,
  pageForSegment,
} from "./route-icons";

describe("calendar workspace page", () => {
  it("registers calendar with CalendarDays icon and nav key", () => {
    expect(WORKSPACE_PAGES.calendar).toEqual({
      segment: "calendar",
      icon: "CalendarDays",
      navKey: "calendar",
    });
  });

  it("resolves /{slug}/calendar to the CalendarDays icon", () => {
    expect(resolveRouteIconName("/acme/calendar")).toBe("CalendarDays");
    expect(pageForSegment("calendar")).toBe("calendar");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @multica/core test -- route-icons`
Expected: FAIL（`WORKSPACE_PAGES.calendar` undefined / "CalendarDays" 不在联合类型）

- [ ] **Step 3: 实现**

`packages/core/paths/paths.ts`（L30 附近，`issues:` 行之后插入）：

```ts
    issues: () => `${ws}/issues`,
    calendar: () => `${ws}/calendar`,
```

`packages/core/paths/route-icons.ts`：

```ts
// RouteIconName 联合类型加：
  | "CalendarDays"

// NavLabelKey 联合类型加：
  | "calendar"

// WorkspacePageKey 联合类型加：
  | "calendar"

// WORKSPACE_PAGES 在 issues 行之后加：
  calendar: { segment: "calendar", icon: "CalendarDays", navKey: "calendar" },
```

`packages/views/layout/route-icon-components.tsx`：import 列表加 `CalendarDays`，`ROUTE_ICON_COMPONENTS` 加 `CalendarDays,`。

`packages/views/layout/app-sidebar.tsx`：`NavKey` 与 `NavLabelKey` 联合类型各加 `| "calendar"`；`workspaceNav` 改为：

```ts
const workspaceNav: { key: NavKey; labelKey: NavLabelKey }[] = [
  { key: "issues", labelKey: "issues" },
  { key: "calendar", labelKey: "calendar" },
  { key: "projects", labelKey: "projects" },
];
```

四语言 `layout.json` 的 `nav` 对象加 `"calendar"`：
- zh-Hans: `"calendar": "日历"`
- en: `"calendar": "Calendar"`
- ja: `"calendar": "カレンダー"`
- ko: `"calendar": "캘린더"`

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @multica/core test -- route-icons && pnpm --filter @multica/views exec tsc --noEmit`
Expected: PASS；tsc 零错误（Record 契约强制两层同步，漏一处即编译错）

- [ ] **Step 5: Commit**

```bash
git add packages/core/paths packages/views/layout packages/views/locales/*/layout.json
git commit -m "feat(nav): 日历一级导航注册（路径/图标契约/侧边栏/i18n）"
```

---

### Task 2: calendar-view 搬家 + onOpenRequirement 可选 prop

**Files:**
- Move: `packages/views/issues/components/calendar-view.tsx` → `packages/views/calendar/calendar-view.tsx`（git mv 保历史）
- Move: `packages/views/issues/components/calendar-view.test.tsx` → `packages/views/calendar/calendar-view.test.tsx`
- Modify: `packages/views/issues/surface/issue-surface.tsx`（L30 import 路径）
- Create: `packages/views/calendar/index.ts`（包出口）

- [ ] **Step 1: git mv + 修正 import**

```bash
mkdir -p packages/views/calendar
git mv packages/views/issues/components/calendar-view.tsx packages/views/calendar/calendar-view.tsx
git mv packages/views/issues/components/calendar-view.test.tsx packages/views/calendar/calendar-view.test.tsx
```

calendar-view.tsx 内相对 import 深度减一层（`../../navigation` → `../navigation`，`../../i18n` → `../i18n`；`@multica/*` 包名 import 不变）。issue-surface.tsx L30：

```ts
import { CalendarView } from "../../calendar/calendar-view";
```

`packages/views/calendar/index.ts`：

```ts
export { CalendarView } from "./calendar-view";
```

- [ ] **Step 2: 写 onOpenRequirement 失败测试**

calendar-view.test.tsx 追加：

```tsx
it("calls onOpenRequirement instead of navigating when provided", async () => {
  const onOpen = vi.fn();
  render(<CalendarView issues={[requirementFixture]} onOpenRequirement={onOpen} />, { wrapper: viewStoreWrapper() });
  await userEvent.click(screen.getByText(requirementFixture.title));
  expect(onOpen).toHaveBeenCalledWith(requirementFixture.id);
});
```

（fixture/渲染辅助沿用该文件既有模式；`requirementFixture` 用文件里已有的需求 issue 样例。）

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @multica/views test -- calendar-view`
Expected: FAIL（onOpenRequirement prop 不存在，TS 错或断言失败）

- [ ] **Step 4: 实现 onOpenRequirement**

calendar-view.tsx：

```tsx
export function CalendarView({
  issues,
  onOpenRequirement,
}: {
  issues: Issue[];
  /** 提供时色块点击走回调（抽屉），缺省保持 AppLink 跳详情页。 */
  onOpenRequirement?: (issueId: string) => void;
}) {
```

`RequirementBlock` 调用点（L455-462）加 prop 透传：

```tsx
<RequirementBlock
  ...
  href={paths.issueDetail(span.issue.id)}
  onOpen={onOpenRequirement}
/>
```

`RequirementBlock` 签名加 `onOpen`，AppLink 包一层点击拦截：

```tsx
<AppLink
  href={href}
  className="block min-w-0"
  onClick={
    onOpen
      ? (e) => {
          e.preventDefault();
          onOpen(issueId);
        }
      : undefined
  }
>
```

（RequirementBlock 需新增 `issueId` prop 或从既有 prop 取；href 保留供右键新标签打开。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @multica/views test -- calendar-view`
Expected: 全部 PASS（既有用例 + 新用例）

- [ ] **Step 6: Commit**

```bash
git add packages/views/calendar packages/views/issues
git commit -m "refactor(calendar): CalendarView 搬家至 views/calendar 并支持 onOpenRequirement 回调"
```

---

### Task 3: RequirementDrawer（需求抽屉，五阶段承载）

**Files:**
- Create: `packages/views/calendar/requirement-drawer.tsx`
- Test: `packages/views/calendar/requirement-drawer.test.tsx`
- Modify: `packages/views/calendar/index.ts`（出口加 drawer）

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@multica/core/issues/queries", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/issues/queries")>();
  return { ...mod };
});

describe("RequirementDrawer", () => {
  it("renders flow section for the given issue and closes on demand", async () => {
    // 用 QueryClientProvider + mock api.getIssue / listChildIssues 返回 fixture
    // 断言：抽屉渲染需求标题 + FlowSection 阶段条；点关闭按钮触发 onOpenChange(false)
  });

  it("renders nothing when issueId is null", () => {
    // open=false / issueId=null 时不渲染 SheetContent
  });
});
```

（具体 mock 形态参考 `requirement-flow-section.test.tsx` 的既有 harness——同包同查询键。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @multica/views test -- requirement-drawer`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```tsx
"use client";

/**
 * RequirementDrawer — 需求五阶段抽屉（spec §3）：
 * 概要头（编号/标题/时间窗/班底/10 态徽标）+ RequirementFlowSection 复用。
 * 与 issue 详情页共享 issueKeys 缓存；日历页与项目需求 tab 双场景复用。
 */
import { useQuery } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@multica/ui/components/ui/sheet";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  issueDetailOptions,
  childIssuesOptions,
} from "@multica/core/issues/queries";
import { RequirementFlowSection } from "../issues/components/requirement-flow-section";
import { useT } from "../i18n";

export function RequirementDrawer({
  issueId,
  onOpenChange,
}: {
  issueId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const wsId = useWorkspaceId();
  const { t } = useT("calendar");
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, issueId ?? ""),
    enabled: !!issueId,
  });
  const { data: childIssues = [] } = useQuery({
    ...childIssuesOptions(wsId, issueId ?? ""),
    enabled: !!issueId,
  });

  return (
    <Sheet open={!!issueId} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[55%] min-w-[420px] max-w-[760px] overflow-y-auto p-4">
        {issue && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className="text-muted-foreground">#{issue.number}</span>
                {issue.title}
              </SheetTitle>
              {/* 概要头：时间窗 + 派生状态徽标（requirement_status） */}
              <p className="text-caption text-muted-foreground">
                {issue.start_at ?? "—"} ~ {issue.due_date ?? "—"}
              </p>
            </SheetHeader>
            <RequirementFlowSection issue={issue} childIssues={childIssues} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

（班底头像/10 态徽标复用 FlowSection 及既有小组件；概要头细节以既有 issue-detail 头部样式为准做减法——YAGNI，先保证五阶段面板可达。）

index.ts 出口加 `export { RequirementDrawer } from "./requirement-drawer";`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @multica/views test -- requirement-drawer`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/views/calendar
git commit -m "feat(calendar): RequirementDrawer 需求五阶段抽屉（复用 RequirementFlowSection）"
```

---

### Task 4: CalendarPage + 路由 + 新建需求 + 抽屉接线

**Files:**
- Create: `packages/views/calendar/calendar-page.tsx`
- Test: `packages/views/calendar/calendar-page.test.tsx`
- Create: `apps/web/app/[workspaceSlug]/(dashboard)/calendar/page.tsx`
- Modify: `packages/views/calendar/index.ts`

- [ ] **Step 1: 写失败测试**

```tsx
describe("CalendarPage", () => {
  it("renders only top-level requirements (no children) in the calendar", () => {
    // mock issueListOptions 返回 1 需求 + 1 子任务；断言只有需求色块出现
  });

  it("opens the requirement drawer when a block is clicked", async () => {
    // 点击色块 → RequirementDrawer 出现（SheetContent 可见）
  });

  it("filters by project via the toolbar chip", async () => {
    // 选项目过滤后，其他项目的需求色块消失
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @multica/views test -- calendar-page`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 calendar-page.tsx**

```tsx
"use client";

/**
 * CalendarPage — 工作区级需求日历（spec §2）。
 * 页面负责数据/过滤；CalendarView 纯受控渲染。zoom 存于独立 view store
 * 实例（"calendar-page"），不与 /issues 表面的偏好互相污染。
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Plus } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueListOptions } from "@multica/core/issues/queries";
import { projectListOptions } from "@multica/core/projects/queries";
import { openCreateIssueWithPreference } from "@multica/core/issues/stores/create-mode-store";
import {
  ViewStoreProvider,
} from "@multica/core/issues/stores/view-store-context";
import { getIssueSurfaceViewStore } from "@multica/core/issues/stores/surface-view-store";
import { PageHeader } from "../layout/page-header";
import { useT } from "../i18n";
import { CalendarView } from "./calendar-view";
import { RequirementDrawer } from "./requirement-drawer";

function CalendarSurface({
  projectFilter,
  onOpenRequirement,
}: {
  projectFilter: string | null;
  onOpenRequirement: (id: string) => void;
}) {
  const wsId = useWorkspaceId();
  const { data: issues = [] } = useQuery(issueListOptions(wsId));
  const requirements = useMemo(
    () =>
      issues.filter(
        (i) =>
          !i.parent_issue_id &&
          (i.start_at || i.due_date || i.requirement_status) &&
          (!projectFilter || i.project_id === projectFilter),
      ),
    [issues, projectFilter],
  );
  return <CalendarView issues={requirements} onOpenRequirement={onOpenRequirement} />;
}

export function CalendarPage() {
  const { t } = useT("calendar");
  const wsId = useWorkspaceId();
  const store = useMemo(() => getIssueSurfaceViewStore("calendar-page"), []);
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [drawerIssueId, setDrawerIssueId] = useState<string | null>(null);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageHeader>
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-body font-medium">{t(($) => $.page.title)}</h1>
        <div className="ml-auto flex items-center gap-2">
          {/* 项目过滤 chip：全部 / 各项目（PM/拆解状态过滤与待确认聚合
              为二期增强，先保项目维度——YAGNI） */}
          <select
            aria-label={t(($) => $.page.project_filter)}
            className="h-7 rounded-md border border-surface-border bg-transparent px-2 text-caption"
            value={projectFilter ?? ""}
            onChange={(e) => setProjectFilter(e.target.value || null)}
          >
            <option value="">{t(($) => $.page.all_projects)}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
          <Button size="sm" onClick={() => openCreateIssueWithPreference()}>
            <Plus className="h-3.5 w-3.5" /> {t(($) => $.page.new_requirement)}
          </Button>
        </div>
      </PageHeader>
      <ViewStoreProvider store={store}>
        <CalendarSurface
          projectFilter={projectFilter}
          onOpenRequirement={setDrawerIssueId}
        />
      </ViewStoreProvider>
      <RequirementDrawer
        issueId={drawerIssueId}
        onOpenChange={(open) => !open && setDrawerIssueId(null)}
      />
    </div>
  );
}
```

注意：`openCreateIssueWithPreference` 的真实签名以 `@multica/core/issues/stores/create-mode-store` 出口为准（app-sidebar.tsx L35 已 import，可参考其调用处补参）。

`apps/web/app/[workspaceSlug]/(dashboard)/calendar/page.tsx`：

```tsx
"use client";

import { ErrorBoundary } from "@multica/ui/components/common/error-boundary";
import { CalendarPage } from "@multica/views/calendar";

export default function Page() {
  return (
    <ErrorBoundary>
      <CalendarPage />
    </ErrorBoundary>
  );
}
```

i18n 新增 `packages/views/locales/*/calendar.json`（新 namespace）：
- zh-Hans: `{ "page": { "title": "日历", "new_requirement": "新建需求", "project_filter": "项目过滤", "all_projects": "全部项目" } }`
- en/ja/ko 对应翻译。

（i18n namespace 注册机制：参考 archive.json 如何被 `useT("archive")` 发现——若是约定式按文件名加载则零注册；否则在 locales index 注册。实现时以 archive.json 的接线为模板。）

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @multica/views test -- calendar-page && pnpm --filter @multica/views exec tsc --noEmit`
Expected: PASS + 零类型错误

- [ ] **Step 5: 浏览器冒烟（dev 环境）**

Run: `make up C=web`（若 api/web 已在跑则跳过）→ 打开 `http://localhost:13147/dev/calendar`
Expected: 侧边栏「日历」入口高亮；DEV-1/DEV-2 需求色块渲染；点击色块抽屉打开；周/月切换正常；拖拽调期正常。

- [ ] **Step 6: Commit**

```bash
git add packages/views/calendar "apps/web/app/[workspaceSlug]/(dashboard)/calendar" packages/views/locales
git commit -m "feat(calendar): 工作区级日历页面 + 路由 + 抽屉接线"
```

---

### Task 5: 任务子视图移除日历 tab

**Files:**
- Modify: `packages/views/issues/components/issues-page.tsx`（L62 modes）
- Test: `packages/views/issues/components/issues-page.test.tsx`（如有 modes 断言则更新）

- [ ] **Step 1: 更新/写测试**

issues-page.test.tsx：断言渲染的视图 tab 不含「日历」（若既有测试断言 modes 数组内容，改为四态）。

- [ ] **Step 2: 跑测试确认失败（若测试先行写了新断言）**

Run: `pnpm --filter @multica/views test -- issues-page`

- [ ] **Step 3: 实现**

```tsx
modes={["board", "list", "table", "swimlane"]}
```

（controller 的 allowedModes 回退机制自动把残留 calendar 偏好弹回 board——use-issue-surface-controller.ts L245-255，无需额外处理。）

- [ ] **Step 4: 跑测试确认通过 + surface 回归**

Run: `pnpm --filter @multica/views test -- issues-page && pnpm --filter @multica/views test -- issue-surface`
Expected: PASS（issue-surface 的 calendar 渲染分支保留——项目详情 modes 仍含 calendar）

- [ ] **Step 5: Commit**

```bash
git add packages/views/issues
git commit -m "feat(issues): 任务子视图移除日历 tab（日历已提升为一级模块）"
```

---

### Task 6: 项目详情页 — 任务概览改名 + 需求详情 TAB

**Files:**
- Modify: `packages/views/locales/{zh-Hans,en,ja,ko}/archive.json`（views.overview 文案 + views.requirements 新增）
- Modify: `packages/views/projects/components/project-archive-views.tsx`（白名单/views 数组/渲染分支，最小 diff）
- Create: `packages/views/calendar/requirement-list-panel.tsx`
- Test: `packages/views/calendar/requirement-list-panel.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
describe("RequirementListPanel", () => {
  it("lists only top-level requirements of the given project, sorted by start_at", () => {
    // mock issueListOptions：2 需求（乱序 start_at）+ 1 子任务 + 1 他项目需求
    // 断言：仅本项目 2 需求渲染，按 start_at 升序
  });

  it("opens RequirementDrawer on card click", async () => {
    // 点击卡片 → 抽屉出现
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @multica/views test -- requirement-list-panel`
Expected: FAIL

- [ ] **Step 3: 实现 requirement-list-panel.tsx**

```tsx
"use client";

/**
 * RequirementListPanel — 项目维度需求列表（spec §4b 需求详情 TAB）。
 * 卡片：编号/标题/时间窗/10 态徽标/阶段进度；点击开 RequirementDrawer。
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueListOptions } from "@multica/core/issues/queries";
import { useT } from "../i18n";
import { RequirementDrawer } from "./requirement-drawer";

export function RequirementListPanel({ projectId }: { projectId: string }) {
  const wsId = useWorkspaceId();
  const { t } = useT("calendar");
  const { data: issues = [] } = useQuery(issueListOptions(wsId));
  const [drawerIssueId, setDrawerIssueId] = useState<string | null>(null);

  const requirements = useMemo(
    () =>
      issues
        .filter(
          (i) =>
            i.project_id === projectId &&
            !i.parent_issue_id &&
            (i.start_at || i.due_date || i.requirement_status),
        )
        .sort((a, b) => (a.start_at ?? "").localeCompare(b.start_at ?? "")),
    [issues, projectId],
  );

  if (requirements.length === 0) {
    return (
      <p className="py-8 text-center text-caption text-muted-foreground">
        {t(($) => $.list.empty)}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {requirements.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => setDrawerIssueId(r.id)}
          className="flex w-full items-center gap-3 rounded-lg border border-surface-border px-3 py-2 text-left hover:bg-muted/50"
        >
          <span className="text-caption text-muted-foreground">#{r.number}</span>
          <span className="min-w-0 flex-1 truncate text-body">{r.title}</span>
          <span className="text-caption text-muted-foreground">
            {r.start_at?.slice(0, 10) ?? "—"} ~ {r.due_date ?? "—"}
          </span>
          {r.requirement_status && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-caption">
              {r.requirement_status}
            </span>
          )}
        </button>
      ))}
      <RequirementDrawer
        issueId={drawerIssueId}
        onOpenChange={(open) => !open && setDrawerIssueId(null)}
      />
    </div>
  );
}
```

i18n `calendar.json` 补 `"list": { "empty": "该项目暂无需求" }`（四语言）。

- [ ] **Step 4: archive.json 四语言文案（并行交接面最小 diff）**

`packages/views/locales/*/archive.json` 的 `views` 对象：
- zh-Hans: `"overview": "概览"` → `"overview": "任务概览"`；加 `"requirements": "需求详情"`
- en: `"overview": "Overview"` → `"overview": "Tasks"`；加 `"requirements": "Requirements"`
- ja/ko 对应翻译。

- [ ] **Step 5: project-archive-views.tsx 最小 diff**

```tsx
// L25 白名单：
const ARCHIVE_VIEWS = ["archive", "features", "data-model", "filing", "requirements"] as const;
// import 加：
import { RequirementListPanel } from "../../calendar/requirement-list-panel";
// views 数组（L155-161）末尾加：
    { value: "requirements", label: t(($) => $.views.requirements) },
// 渲染分支（L190 附近）加：
            {activeView === "requirements" && (
              <RequirementListPanel projectId={projectId} />
            )}
```

- [ ] **Step 6: 跑测试确认通过 + 项目页冒烟**

Run: `pnpm --filter @multica/views test -- requirement-list-panel && pnpm --filter @multica/views exec tsc --noEmit`
浏览器：项目详情页 tab 栏显示「任务概览 … 需求详情」；点需求详情 tab 渲染列表；点卡片开抽屉。

- [ ] **Step 7: Commit**

```bash
git add packages/views/calendar packages/views/projects/components/project-archive-views.tsx packages/views/locales
git commit -m "feat(projects): 概览改名任务概览 + 新增需求详情 TAB（RequirementListPanel + 抽屉复用）"
```

---

### Task 7: 全量回归 + 文档收尾

**Files:**
- Modify: `docs/superpowers/plans/2026-09-06-requirement-calendar-progress.md`（补录本次提交）

- [ ] **Step 1: views 全量测试 + typecheck**

Run: `pnpm --filter @multica/views test && pnpm --filter @multica/views exec tsc --noEmit && pnpm --filter @multica/core test`
Expected: 全绿（既有 calendar-view 测试随迁后仍通过；若断言 import 路径需随迁修正）

- [ ] **Step 2: web 应用构建验证**

Run: `pnpm --filter @multica/web build`（或 dev 环境浏览器全链路：/dev/calendar 页 + 项目详情需求详情 tab + 抽屉五阶段操作）
Expected: 构建通过；/issues 无日历 tab；侧边栏日历入口工作

- [ ] **Step 3: 进度文档补录 + Commit**

```bash
git add docs/superpowers/plans/2026-09-06-requirement-calendar-progress.md
git commit -m "docs: 进度文档补录日历一级模块提升（Task 1-6 提交映射）"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1→Task 1；§2→Task 2/4；§3→Task 3/4；§4→Task 5；§4b→Task 6；§5 错误处理→各 Task 既有模式复用（无新增错误面）；§6 测试→各 Task Step 内嵌 + Task 7 全量。✅
- **占位符**：Task 3/4 测试细节以「参考既有 harness」指向具体文件（requirement-flow-section.test.tsx / calendar-view.test.tsx），非空泛 TODO。✅
- **类型一致**：`onOpenRequirement(issueId: string)`、`RequirementDrawer({ issueId, onOpenChange })`、`RequirementListPanel({ projectId })` 全计划一致。✅
- **并行交接面**：Task 6 Step 4/5 最小 diff；若合并冲突以并行会话版本为准重放本 diff。✅
