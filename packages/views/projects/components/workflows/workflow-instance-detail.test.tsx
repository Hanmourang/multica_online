// @vitest-environment jsdom

/**
 * 实例详情的运行视图验收（plan 20261025 §A1 / §B4 / §C1–C4，对应验收表 A-2/A-3/A-4/B-7/C-2/C-3）：
 * 阶段行的产物 chips、spec 目标/达成判定、blocked 红框与缺件清单、跳资产/跳工作项
 * 链接、重新校验动作，门禁裁决按钮采用模板自定义标签，以及四面板（子任务创建 / 产物落地追踪）。
 *
 * 只 mock 数据源（React Query options → fixture）与 mutation，渲染/交互走真实组件，
 * 因此 locale 缺键会在这里直接暴露成文本而不是静默通过。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AssetBinding, Issue, WorkflowStageRun } from "@multica/core/types";
import { paths } from "@multica/core/paths";
import { NavigationProvider, type NavigationAdapter } from "../../../navigation";
import { renderWithI18n } from "../../../test/i18n";
import { WorkflowInstanceDetail } from "./workflow-instance-detail";

const mocks = vi.hoisted(() => ({
  stageAction: vi.fn(() => Promise.resolve({})),
  decide: vi.fn(() => Promise.resolve({})),
  // 参数形状显式声明：否则 vitest 推断出空元组，断言写入参时拿不到类型。
  createIssue: vi.fn(
    (input: {
      title: string;
      description: string;
      parent_issue_id: string;
      project_id: string;
      stage: number;
    }) =>
      Promise.resolve({
        id: "child-1",
        identifier: "SIRI-30",
        title: input.title,
        status: "todo",
      }),
  ),
  createComment: vi.fn((input: { content: string }) =>
    Promise.resolve({ id: "comment-1", content: input.content }),
  ),
  // C-1 勾选回写：断言写入的是「当前已勾选条文全集」。
  criteriaCheck: vi.fn((checked: string[]) => Promise.resolve({ checked })),
  // 可变 fixture：个别用例需要「无 spec 快照」的旧实例形状 / 不同的产物落地行。
  detail: { current: null as unknown },
  bindings: { current: null as AssetBinding[] | null },
  children: { current: null as Partial<Issue>[] | null },
  issue: { current: null as Partial<Issue> | null },
}));

/** C-2：root issue 下已有的子任务（父任务进度面同源）。 */
const CHILDREN: Partial<Issue>[] = [
  { id: "child-0", identifier: "SIRI-27", title: "[1] 需求分析", status: "done" },
];

/** C-3：B3b 落地的产物绑定（external_ref.stage_run_id 是分组键）。 */
function landedBinding(id: string, stageRunId: string, name: string): AssetBinding {
  return {
    id,
    workspace_id: "ws-1",
    project_id: "proj-1",
    issue_id: "req-1",
    asset_category: "other",
    external_ref: {
      stage_run_id: stageRunId,
      instance_id: "i1",
      output_id: "o1",
      type: "doc",
    },
    asset_name: name,
    source: "workflow",
    recommended: false,
    asset_role: "output",
    created_by_type: "agent",
    created_by_id: "a1",
    created_at: "2026-10-25T00:00:00Z",
  } as unknown as AssetBinding;
}

const ISSUE: Partial<Issue> = {
  id: "req-1",
  identifier: "SIRI-26",
  title: "购物车合并结算",
  acceptance_round: 2,
  acceptance_spec: { assertions: ["合并后金额与逐项一致", "优惠不重复计算"] },
};

const STAGES: WorkflowStageRun[] = [
  {
    id: "s1",
    instance_id: "i1",
    seq: 1,
    node_id: "n1",
    name: "需求分析",
    mode: "auto",
    agent_id: "a1",
    prompt: null,
    task_id: "t1",
    state: "done",
    inputs: [{ outputId: "requirement-brief", outputName: "requirement-brief", required: true, assetRole: "in" }],
    outputs: [
      { id: "o1", name: "prototype", type: "doc" },
      { id: "o2", name: "architecture", type: "doc" },
    ],
    spec: {
      goal: "产出可评审原型",
      criteria: "原型走查通过",
      inputTpl: "工作项 #${workitem.id}：${workitem.title}\n参考资产：${project.assets}",
      outputTpl: "# 需求澄清与方案\n## 目标\n## 方案",
    },
    created_at: "2026-10-25T00:00:00Z",
    updated_at: "2026-10-25T00:00:00Z",
  },
  {
    id: "s2",
    instance_id: "i1",
    seq: 2,
    node_id: "n2",
    name: "方案设计",
    mode: "auto",
    agent_id: "a2",
    prompt: null,
    task_id: null,
    state: "blocked",
    inputs: [
      { fromStageId: "n1", outputId: "prototype", outputName: "prototype", required: true, assetRole: "in" },
      { outputId: "architecture", outputName: "architecture", required: true, assetRole: "in" },
    ],
    outputs: [{ id: "o3", name: "tech-design", type: "doc" }],
    spec: {
      goal: "补齐架构依赖后出方案",
      criteria: "方案评审通过",
      inputTpl: "依据：${inputs.prototype}\n架构：${inputs.architecture}",
      outputTpl: "# 方案设计\n## 关联仓库",
      loopLabel: "打回补充",
      exitLabel: "放行开发",
    },
    admission_missing: ["architecture", "prototype"],
    created_at: "2026-10-25T00:00:00Z",
    updated_at: "2026-10-25T00:00:00Z",
  },
];

const DETAIL = {
  instance: {
    id: "i1-00000000-0000-0000-0000-000000000001",
    workspace_id: "ws-1",
    project_id: "proj-1",
    template_id: "tpl-1",
    template_version: 3,
    root_issue_id: "req-1",
    sprint_id: "sp-1",
    workitem_snapshot: { title: "购物车合并结算" },
    status: "running",
    started_by_type: "member",
    started_by_id: "u1",
    triggered_at: "2026-10-25T00:00:00Z",
    completed_at: "",
    created_at: "2026-10-25T00:00:00Z",
    updated_at: "2026-10-25T00:00:00Z",
  },
  stages: STAGES,
  gates: [
    {
      id: "g1-00000000-0000-0000-0000-000000000001",
      instance_id: "i1",
      stage_run_id: "s2",
      round: 1,
      mode: "human",
      state: "waiting",
      decision: "",
      generation: 1,
      parent_id: null,
      decided_by_type: null,
      decided_by_id: null,
      created_at: "2026-10-25T00:00:00Z",
      decided_at: "",
    },
  ],
};

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/paths", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/paths")>();
  return { ...mod, useWorkspacePaths: () => mod.paths.workspace("acme") };
});

vi.mock("@multica/core/workflow", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/workflow")>();
  return {
    ...mod,
    workflowInstanceDetailOptions: () => ({
      queryKey: ["workflow-instance-detail", "i1"],
      queryFn: () => Promise.resolve(mocks.detail.current ?? DETAIL),
    }),
    workflowActiveRefetchInterval: () => false,
    workflowGateMessagesOptions: (_wsId: string, gateId: string) => ({
      queryKey: ["workflow-gate-messages", gateId],
      queryFn: () => Promise.resolve({ gate_run_id: gateId, messages: [] }),
    }),
    useDecideWorkflowGate: () => ({ mutateAsync: mocks.decide, isPending: false }),
    useWorkflowStageAction: () => ({ mutateAsync: mocks.stageAction, isPending: false }),
    useWorkflowInstanceAction: () => ({ mutateAsync: vi.fn(), isPending: false }),
    usePostWorkflowGateMessage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

vi.mock("@multica/core/issues/queries", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/issues/queries")>();
  return {
    ...mod,
    issueDetailOptions: () => ({
      queryKey: ["issue-detail", "req-1"],
      queryFn: () => Promise.resolve(mocks.issue.current ?? ISSUE),
    }),
    childIssuesOptions: () => ({
      queryKey: ["child-issues", "req-1"],
      queryFn: () => Promise.resolve(mocks.children.current ?? CHILDREN),
    }),
  };
});

vi.mock("@multica/core/issues/mutations", () => ({
  useCreateIssue: () => ({ mutateAsync: mocks.createIssue, isPending: false }),
  useCreateComment: () => ({ mutateAsync: mocks.createComment, isPending: false }),
  useUpdateAcceptanceCriteria: () => ({ mutateAsync: mocks.criteriaCheck, isPending: false }),
}));

vi.mock("@multica/core/assets/queries", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/assets/queries")>();
  return {
    ...mod,
    projectAssetsOptions: () => ({
      queryKey: ["project-assets", "proj-1"],
      queryFn: () => {
        const items = mocks.bindings.current ?? [landedBinding("b1", "s1", "prototype")];
        return Promise.resolve({ items, total: items.length });
      },
    }),
  };
});

vi.mock("@multica/core/projects/queries", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/projects/queries")>();
  return {
    ...mod,
    projectDetailOptions: () => ({
      queryKey: ["project-detail", "proj-1"],
      queryFn: () => Promise.resolve({ id: "proj-1", title: "交易中台" }),
    }),
  };
});

vi.mock("@multica/core/sprints/queries", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@multica/core/sprints/queries")>();
  return {
    ...mod,
    sprintDetailOptions: () => ({
      queryKey: ["sprint-detail", "sp-1"],
      queryFn: () => Promise.resolve({ id: "sp-1", name: "第 42 迭代" }),
    }),
  };
});

function renderDetail() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const adapter: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/projects/proj-1",
    searchParams: new URLSearchParams("view=workflows"),
    hash: "",
    getShareableUrl: (path: string) => path,
  };
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={adapter}>
        <WorkflowInstanceDetail
          projectId="proj-1"
          instanceId="i1"
          onBack={vi.fn()}
        />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

describe("WorkflowInstanceDetail 运行视图", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detail.current = null;
    mocks.bindings.current = null;
    mocks.children.current = null;
    mocks.issue.current = null;
  });
  afterEach(() => cleanup());

  it("A-2：产物 chips 数量与 outputs 声明一致，task_id 非空的阶段给出工作项链接", async () => {
    renderDetail();
    const outputs = await screen.findByTestId("workflow-stage-outputs-1");
    expect(outputs.textContent).toContain("prototype");
    expect(outputs.textContent).toContain("architecture");
    const taskLink = await screen.findByTestId("workflow-stage-task-link-1");
    expect(taskLink).toHaveAttribute("href", paths.workspace("acme").issueDetail("req-1"));
    // 未派发的 blocked 阶段（task_id 为 null）不得出现工作项链接
    expect(screen.queryByTestId("workflow-stage-task-link-2")).toBeNull();
  });

  it("A-2：阶段行渲染 spec 快照的目标与达成判定", async () => {
    renderDetail();
    const row = await screen.findByTestId("workflow-stage-row-2");
    expect(row.textContent).toContain("补齐架构依赖后出方案");
    expect(row.textContent).toContain("方案评审通过");
  });

  it("A-3：blocked 行渲染缺件清单 + 去资产管理链接 + 可跳过", async () => {
    renderDetail();
    const missing = await screen.findByTestId("workflow-stage-missing-2");
    expect(missing.textContent).toContain("architecture");
    expect(missing.textContent).toContain("prototype");
    expect(missing.querySelector("a")).toHaveAttribute(
      "href",
      paths.workspace("acme").projectView("proj-1", "assets"),
    );
    const row = await screen.findByTestId("workflow-stage-row-2");
    expect(row.className).toContain("border-destructive");
    expect(row.textContent).toContain("Blocked");
    expect(screen.getByText("Skip")).toBeTruthy();
  });

  it("A-3：重新校验准入调用 stage action=recheck（不再复用 rerun 语义）", async () => {
    renderDetail();
    const recheck = await screen.findByTestId("workflow-stage-recheck-2");
    fireEvent.click(recheck);
    await waitFor(() =>
      expect(mocks.stageAction).toHaveBeenCalledWith({ stageRunId: "s2", action: "recheck" }),
    );
  });

  it("A-4：顶栏显示项目/需求/迭代上下文与 blocked 计数徽章", async () => {
    renderDetail();
    // 上下文三个名称来自异步查询，先等落位再断言（未落位时退化为 id 前缀）。
    await waitFor(() => {
      const context = screen.getByTestId("workflow-instance-context");
      expect(context.textContent).toContain("交易中台");
      expect(context.textContent).toContain("购物车合并结算");
      expect(context.textContent).toContain("SIRI-26");
      expect(context.textContent).toContain("第 42 迭代");
    });
    expect(
      screen.getByTestId("workflow-instance-context").querySelector("a"),
    ).toHaveAttribute("href", paths.workspace("acme").projectDetail("proj-1"));
    const badge = await screen.findByTestId("workflow-blocked-count");
    expect(badge.textContent).toContain("1");
  });

  it("B-7：门禁按钮文案取模板自定义标签，并展示验收标准与本阶段产物", async () => {
    renderDetail();
    expect((await screen.findByTestId("workflow-gate-exit-2")).textContent).toBe("放行开发");
    expect((await screen.findByTestId("workflow-gate-loop-2")).textContent).toContain("打回补充");
    const acceptance = await screen.findByTestId("workflow-gate-acceptance");
    expect(acceptance.textContent).toContain("合并后金额与逐项一致");
    expect(acceptance.textContent).toContain("Round 2");
  });

  it("B-7 回退：旧实例 spec 为 null 时按钮退回通用文案，不渲染目标行", async () => {
    mocks.detail.current = {
      ...DETAIL,
      stages: STAGES.map((stage) => ({ ...stage, spec: null })),
    };
    renderDetail();
    const exit = await screen.findByTestId("workflow-gate-exit-2");
    expect(exit.textContent).toBe("Approve (exit)");
    expect((await screen.findByTestId("workflow-gate-loop-2")).textContent).toContain(
      "Request rework (loop)",
    );
    expect(screen.queryByText("产出可评审原型")).toBeNull();
  });

  it("C-1：验收面板展示 goal + criteria + 轮次徽章，并跳既有验收面", async () => {
    renderDetail();
    const panel = await screen.findByTestId("workflow-panel-acceptance");
    // 验收面数据来自 root issue 的异步查询，先等落位（首帧 issue 为 undefined）。
    await waitFor(() => expect(panel.textContent).toContain("合并后金额与逐项一致"));
    expect(panel.textContent).toContain("Round 2");
    expect(panel.querySelector("a")).toHaveAttribute(
      "href",
      paths.workspace("acme").projectView("proj-1", "acceptance"),
    );
  });

  it("C-1 勾选回写：每条 criteria 渲染可勾选框，点选后回写「已勾选集」并显示进度", async () => {
    renderDetail();
    const panel = await screen.findByTestId("workflow-panel-acceptance");
    await waitFor(() => expect(panel.textContent).toContain("合并后金额与逐项一致"));
    // 两条断言 = 两个 checkbox；无 checked_criteria 时初值为 0/2。
    const boxes = within(panel).getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toHaveAttribute("aria-checked", "false");
    expect(panel.textContent).toContain("0/2");

    fireEvent.click(boxes[0]!);
    await waitFor(() =>
      expect(mocks.criteriaCheck).toHaveBeenCalledWith(["合并后金额与逐项一致"]),
    );
  });

  it("C-1 回读持久态：acceptance_spec.checked_criteria 回勾对应行并反映到进度徽章", async () => {
    mocks.issue.current = {
      ...ISSUE,
      acceptance_spec: {
        assertions: ["合并后金额与逐项一致", "优惠不重复计算"],
        checked_criteria: ["合并后金额与逐项一致"],
      },
    };
    renderDetail();
    const panel = await screen.findByTestId("workflow-panel-acceptance");
    await waitFor(() => expect(panel.textContent).toContain("合并后金额与逐项一致"));
    const boxes = within(panel).getAllByRole("checkbox");
    // 已落库的第一条回勾为选中，第二条未选；进度 1/2。
    expect(boxes[0]).toHaveAttribute("aria-checked", "true");
    expect(boxes[1]).toHaveAttribute("aria-checked", "false");
    expect(panel.textContent).toContain("1/2");

    // 在已含第一条的基础上勾选第二条 → 回写全集两条。
    fireEvent.click(boxes[1]!);
    await waitFor(() =>
      expect(mocks.criteriaCheck).toHaveBeenLastCalledWith([
        "合并后金额与逐项一致",
        "优惠不重复计算",
      ]),
    );
  });

  it("C-2：列子任务，并从阶段预填标题/描述/父任务创建工作项后回写评论", async () => {
    renderDetail();
    const panel = await screen.findByTestId("workflow-panel-subtasks");
    await waitFor(() => expect(panel.textContent).toContain("SIRI-27"));

    fireEvent.click(screen.getByTestId("workflow-subtask-create-2"));
    await waitFor(() =>
      expect(mocks.createIssue).toHaveBeenCalledWith({
        title: "[2] 方案设计",
        description: "补齐架构依赖后出方案",
        parent_issue_id: "req-1",
        project_id: "proj-1",
        stage: 2,
      }),
    );
    await waitFor(() =>
      expect(mocks.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("SIRI-30") }),
      ),
    );
    // 评论落在 root issue 上，不是阶段自己的（auto 阶段没有独立线程）。
    expect(mocks.createComment.mock.calls[0]?.[0].content).toContain("方案设计");
  });

  it("C-3：产物面板区分已落地与仅声明（声明 ∪ 落地）", async () => {
    renderDetail();
    const panel = await screen.findByTestId("workflow-panel-artifacts");
    const prototype = await screen.findByTestId("workflow-artifact-1-prototype");
    expect(prototype.textContent).toContain("Landed");
    expect((await screen.findByTestId("workflow-artifact-1-architecture")).textContent).toContain(
      "Declared",
    );
    expect((await screen.findByTestId("workflow-artifact-2-tech-design")).textContent).toContain(
      "Declared",
    );
    expect(panel.textContent).toContain("1. 需求分析");
  });

  it("C-4：实体关联映射面板渲染十条映射说明（对齐原型粒度）", async () => {
    renderDetail();
    const panel = await screen.findByTestId("workflow-panel-mapping");
    expect(panel.textContent).toContain("Entity mapping");
    // 模板/实例/阶段/门禁/验收/产物绑定 + 迭代/目标/产物/资产准入 = 10 行，均无新后端依赖。
    expect(panel.querySelectorAll("li")).toHaveLength(10);
    expect(panel.textContent).toContain("root issue");
    expect(panel.textContent).toContain("project asset binding");
    expect(panel.textContent).toContain("project_artifact");
    expect(panel.textContent).toContain("gate_doc_types");
  });

  it("D-1：阶段行「输入/输出模板」折叠展示 spec 模板原文，无 spec 时不渲染", async () => {
    renderDetail();
    const tpl = await screen.findByTestId("workflow-stage-templates-1");
    expect(tpl.textContent).toContain("工作项 #${workitem.id}");
    expect(tpl.textContent).toContain("# 需求澄清与方案");
    expect(tpl.textContent).toContain("Rendered into the task prompt");
    // B-7 回退形态：spec=null 时模板折叠不出现。
    cleanup();
    mocks.detail.current = {
      ...DETAIL,
      stages: STAGES.map((stage) => ({ ...stage, spec: null })),
    };
    renderDetail();
    expect(screen.queryByTestId("workflow-stage-templates-1")).toBeNull();
  });

  it("D-2：准入强制门禁面板按阶段列必检项 ✓/✗、来源与缺件绑定链接", async () => {
    renderDetail();
    const panel = await screen.findByTestId("workflow-panel-admission-gate");
    // 两个阶段都有必检项 → 计数徽章 1/2（s1 done 未报缺件=通过，s2 blocked 缺件=不通过）。
    expect(panel.textContent).toContain("1/2");
    const s1 = await screen.findByTestId("workflow-gate-stage-1");
    expect(s1.textContent).toContain("requirement-brief");
    expect(s1.textContent).toContain("Admission passed");
    expect(s1.textContent).toContain("External");
    const s2 = await screen.findByTestId("workflow-gate-stage-2");
    expect(s2.textContent).toContain("Missing");
    expect(s2.textContent).toContain("prototype");
    expect(s2.textContent).toContain("architecture");
    // prototype 来自上游阶段 n1（需求分析），需回显上游名。
    expect(s2.textContent).toContain("Upstream output · 需求分析");
    // 缺件行给「绑定资产」跳转链接。
    const bind = s2.querySelector("a");
    expect(bind).toHaveAttribute(
      "href",
      paths.workspace("acme").projectView("proj-1", "assets"),
    );
  });
});
