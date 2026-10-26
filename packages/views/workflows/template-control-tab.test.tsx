// @vitest-environment jsdom

/**
 * 「流程把控」TAB 的验收（plan 20261025 §A2，对应收验表 A-1）：
 * TAB 内选项目 → 列出该模板在本项目的实例 → 进入详情 → 返回列表不丢项目选择。
 *
 * 实例详情用桩替换：这里要验的是「选择状态的保持」与「按 template_id 过滤」，
 * 详情自身的渲染已由 workflow-instance-detail.test.tsx 覆盖。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowInstance, WorkflowTemplate } from "@multica/core/types";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { NavigationProvider, type NavigationAdapter } from "../navigation";
import { renderWithI18n } from "../test/i18n";
import { TemplateControlTab } from "./template-control-tab";

const TEMPLATE = {
  id: "tpl-1",
  name: "需求日历 CoCo",
  project_id: "proj-2",
  status: "published",
  version: 3,
  official: false,
} as unknown as WorkflowTemplate;

function instance(id: string, templateId: string): WorkflowInstance {
  return {
    id,
    workspace_id: "ws-1",
    project_id: "proj-1",
    template_id: templateId,
    template_version: 3,
    root_issue_id: "req-1",
    sprint_id: null,
    workitem_snapshot: {},
    status: "running",
    started_by_type: "member",
    started_by_id: "u1",
    triggered_at: "2026-10-25T00:00:00Z",
    completed_at: "",
    created_at: "2026-10-25T00:00:00Z",
    updated_at: "2026-10-25T00:00:00Z",
  } as unknown as WorkflowInstance;
}

const INSTANCES = [
  instance("i-aaaa-1", "tpl-1"),
  instance("i-bbbb-2", "tpl-1"),
  instance("i-cccc-3", "tpl-other"),
];

// 渲染时才取数据，单用例可以换一份而不依赖执行顺序。
const store: { instances: WorkflowInstance[] } = { instances: INSTANCES };

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/projects", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/projects")>();
  return {
    ...mod,
    projectListOptions: () => ({
      queryKey: ["project-list"],
      queryFn: () =>
        Promise.resolve([
          { id: "proj-1", title: "项目一" },
          { id: "proj-2", title: "交易中台" },
        ]),
    }),
  };
});

vi.mock("@multica/core/workflow", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/workflow")>();
  return {
    ...mod,
    workflowInstancesOptions: (_wsId: string, projectId: string) => ({
      queryKey: ["workflow-instances", projectId],
      queryFn: () =>
        Promise.resolve({
          instances: store.instances,
          total: store.instances.length,
          status_counts: {},
        }),
    }),
  };
});

vi.mock("../projects/components/workflows/workflow-instance-detail", () => ({
  WorkflowInstanceDetail: ({
    instanceId,
    onBack,
  }: {
    instanceId: string;
    onBack: () => void;
  }) => (
    <div data-testid="detail-stub">
      {instanceId}
      <button type="button" onClick={onBack}>
        stub-back
      </button>
    </div>
  ),
}));

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const adapter: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/workflows/templates/tpl-1",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path: string) => path,
  };
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={adapter}>
        <WorkspaceSlugProvider slug="acme">
          <TemplateControlTab template={TEMPLATE} />
        </WorkspaceSlugProvider>
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

describe("TemplateControlTab", () => {
  afterEach(() => {
    store.instances = INSTANCES;
    cleanup();
  });

  it("A-1：默认落在模板所属项目，实例列表只显示本模板的运行", async () => {
    renderTab();
    const select = (await screen.findByTestId("workflow-control-project")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("proj-2"));
    await waitFor(() =>
      expect(screen.getByTestId("workflow-control-open-i-aaaa-1")).toBeTruthy(),
    );
    expect(screen.getByTestId("workflow-control-open-i-bbbb-2")).toBeTruthy();
    // 其它模板的实例不得混进来（template_id 过滤）。
    expect(screen.queryByTestId("workflow-control-open-i-cccc-3")).toBeNull();
    expect(screen.getAllByText("Running")).toHaveLength(2);
  });

  it("A-1：进入实例详情后返回，项目选择不丢", async () => {
    renderTab();
    const select = (await screen.findByTestId("workflow-control-project")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("proj-2"));
    fireEvent.change(select, { target: { value: "proj-1" } });
    await waitFor(() => expect(select.value).toBe("proj-1"));

    fireEvent.click(await screen.findByTestId("workflow-control-open-i-aaaa-1"));
    expect((await screen.findByTestId("detail-stub")).textContent).toContain("i-aaaa-1");

    fireEvent.click(screen.getByText("stub-back"));
    await waitFor(() => expect(screen.queryByTestId("detail-stub")).toBeNull());
    const backToSelect = (await screen.findByTestId(
      "workflow-control-project",
    )) as HTMLSelectElement;
    expect(backToSelect.value).toBe("proj-1");
  });

  it("该项目没有本模板运行时给出空态指引", async () => {
    store.instances = [];
    renderTab();
    expect(await screen.findByText(/No runs of this template/)).toBeTruthy();
  });
});
