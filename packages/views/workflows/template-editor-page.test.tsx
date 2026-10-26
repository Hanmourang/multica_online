// @vitest-environment jsdom

/**
 * 可视化编辑 TAB 的 inspector 补齐验收（plan 20261025 §C5/§C6/§C7 UI，对应收验表 C-5）：
 *   - 执行智能体从自由文本改为目录下拉，选中后显示名自动带出且仍可编辑；
 *   - 旧模板的自由文本 roleId 不被下拉静默清掉；
 *   - 必检项显示来源（上游阶段名 / 外部·资产管理）并给出跳资产模块的链接；
 *   - 「测试运行」面板挂在 inspector 内，阶段候选来自 definition。
 *
 * 渲染整页而非私有子组件：NodeEditor / AdmissionEditor 是页面内部函数，
 * 同时这样才连 flow-canvas 与 coco 展平链一起跑真逻辑。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowDefinition, WorkflowTemplate } from "@multica/core/types";
import { paths } from "@multica/core/paths";
import { NavigationProvider, type NavigationAdapter } from "../navigation";
import { renderWithI18n } from "../test/i18n";
import { WorkflowTemplateEditorPage } from "./template-editor-page";

const mocks = vi.hoisted(() => ({
  dryRun: vi.fn((input: { templateId: string; nodeId?: string }) =>
    Promise.resolve({
      node_id: input.nodeId ?? "n1",
      node_name: "需求分析",
      mode: "auto",
      prompt: "阶段目标：产出可评审原型",
      warnings: ["${workitem.goal}"],
      spec: null,
      node_count: 2,
    }),
  ),
}));

const DEF = {
  schemaVersion: 1,
  kind: "workflow",
  name: "需求日历 CoCo",
  description: "",
  roleNames: {},
  nodes: [
    {
      id: "n1",
      kind: "stage",
      name: "需求分析",
      mode: "auto",
      roleId: "",
      goal: "产出可评审原型",
      // 无 fromStageId 的必检项＝外部资产：来源要显示「外部·资产管理」并可跳转。
      inputs: [{ outputName: "prototype", assetRole: "in", required: true }],
      outputs: [{ id: "o1", name: "prototype", type: "markdown" }],
    },
    {
      id: "n2",
      kind: "stage",
      name: "方案设计",
      mode: "auto",
      roleId: "legacy-role-9",
      inputs: [
        { fromStageId: "n1", outputId: "o1", outputName: "prototype", assetRole: "in", required: true },
      ],
      outputs: [],
    },
  ],
} as unknown as WorkflowDefinition;

const TEMPLATE = {
  id: "tpl-1",
  workspace_id: "ws-1",
  project_id: "proj-1",
  name: "需求日历 CoCo",
  description: "",
  status: "draft",
  version: 3,
  official: false,
  enforce: false,
  definition: DEF,
  nodes: [],
  created_by_type: "member",
  created_by_id: "u1",
  created_at: "2026-10-25T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
} as unknown as WorkflowTemplate;

const AGENTS = [
  { id: "ag-1", name: "阿宝", archived_at: null },
  { id: "ag-2", name: "小艺", archived_at: null },
  { id: "ag-3", name: "归档君", archived_at: "2026-01-01T00:00:00Z" },
];

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/paths", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/paths")>();
  return { ...mod, useWorkspacePaths: () => mod.paths.workspace("acme") };
});

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "张三" }),
}));

vi.mock("@multica/core/workspace/queries", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/workspace/queries")>();
  return {
    ...mod,
    agentListOptions: () => ({
      queryKey: ["agents", "ws-1"],
      queryFn: () => Promise.resolve(AGENTS),
    }),
  };
});

vi.mock("@multica/core/projects", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/projects")>();
  return {
    ...mod,
    projectListOptions: () => ({
      queryKey: ["project-list"],
      queryFn: () => Promise.resolve([{ id: "proj-1", title: "交易中台" }]),
    }),
  };
});

vi.mock("@multica/core/workflow", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/workflow")>();
  const idle = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    ...mod,
    workspaceTemplatesOptions: () => ({
      queryKey: ["workspace-templates"],
      queryFn: () => Promise.resolve({ templates: [TEMPLATE], total: 1 }),
    }),
    useUpdateWorkflowTemplateDefinition: idle,
    usePublishWorkflowTemplate: idle,
    useSetWorkflowTemplateEnforce: idle,
    useCreateWorkflowTemplate: idle,
    useDryRunWorkflowTemplate: () => ({ mutateAsync: mocks.dryRun, isPending: false }),
  };
});

function renderPage() {
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
        <WorkflowTemplateEditorPage templateId="tpl-1" />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

describe("WorkflowTemplateEditorPage inspector", () => {
  afterEach(() => {
    mocks.dryRun.mockClear();
    cleanup();
  });

  it("C-6：智能体下拉取目录（排除归档），选中后显示名自动带出", async () => {
    renderPage();
    const select = (await screen.findByTestId("workflow-editor-agent-n1")) as HTMLSelectElement;
    // 目录是异步查询，先等 option 落位再读（否则拿到的是「未选择」列表）。
    await waitFor(() =>
      expect(Array.from(select.querySelectorAll("option")).map((o) => o.textContent)).toContain(
        "阿宝",
      ),
    );
    const labels = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(labels).toContain("小艺");
    // 归档智能体不能被新阶段引用
    expect(labels).not.toContain("归档君");

    fireEvent.change(select, { target: { value: "ag-1" } });
    await waitFor(() =>
      expect(screen.getByTestId("workflow-editor-agent-name-n1")).toHaveValue("阿宝"),
    );
  });

  it("C-6：旧模板的自由文本 roleId 不在目录里也不被清空", async () => {
    renderPage();
    const select = (await screen.findByTestId("workflow-editor-agent-n2")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("legacy-role-9"));
    expect(Array.from(select.querySelectorAll("option")).map((o) => o.value)).toContain(
      "legacy-role-9",
    );
  });

  it("C-5：外部必检项显示「外部·资产管理」并给出跳资产模块链接", async () => {
    renderPage();
    const link = await screen.findByTestId("workflow-admission-assets-0");
    expect(link).toHaveAttribute(
      "href",
      paths.workspace("acme").projectView("proj-1", "assets"),
    );
    expect(link.textContent).toBe("Open assets");
    expect(link.parentElement?.textContent).toContain("External · asset management");
  });

  it("C-5：上游必检项显示来源阶段名", async () => {
    renderPage();
    const stage = await screen.findByTestId("workflow-editor-stage-n2");
    expect(stage.textContent).toContain("From stage 需求分析");
  });

  it("C-7：测试运行面板挂在 inspector，阶段候选来自 definition", async () => {
    renderPage();
    const panel = await screen.findByTestId("workflow-dryrun-panel");
    const nodeSelect = screen.getByTestId("workflow-dryrun-node") as HTMLSelectElement;
    const values = Array.from(nodeSelect.querySelectorAll("option")).map((o) => o.value);
    expect(values).toEqual(["n1", "n2"]);
    expect(panel.textContent).toContain("Render preview (zero side effects)");
  });

  it("C-7：跑预览传入选中阶段与 mock 工作项，回显 prompt 与未解析变量", async () => {
    renderPage();
    await screen.findByTestId("workflow-dryrun-panel");
    fireEvent.change(screen.getByTestId("workflow-dryrun-workitem"), {
      target: { value: "购物车合并结算" },
    });
    fireEvent.click(screen.getByTestId("workflow-dryrun-run"));
    await waitFor(() =>
      expect(mocks.dryRun).toHaveBeenCalledWith({
        templateId: "tpl-1",
        nodeId: "n1",
        workitem: { title: "购物车合并结算" },
      }),
    );
    const result = await screen.findByTestId("workflow-dryrun-result");
    expect(result.textContent).toContain("阶段目标：产出可评审原型");
    expect(screen.getByTestId("workflow-dryrun-warnings").textContent).toContain(
      "${workitem.goal}",
    );
  });
});
