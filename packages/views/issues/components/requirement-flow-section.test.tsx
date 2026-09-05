/**
 * @vitest-environment jsdom
 *
 * RequirementFlowSection — the requirement pipeline block mounted at the top
 * of a top-level issue's detail page (spec画面 4/5 落点): a four-node stage
 * strip (原型 → plan+拆解 → 执行 → 验收) with the current stage highlighted,
 * plus the panel for the stage the requirement is currently in — the
 * prototype confirm panel while stage 1 is open (班底有启用原型师时), and the
 * decomposition entry / progress affordance at stage 2.
 *
 * Sub-issues never render the strip (a stage marker is only meaningful on the
 * requirement itself). Without an enabled prototyper the 原型 node renders
 * skipped and the flow starts at stage 2.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { Issue, PrototypeVersion, RoleAssignment, DecomposeDraftTask } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import {
  RequirementFlowSection,
  deriveFlowStage,
} from "./requirement-flow-section";

const mockApi = vi.hoisted(() => ({
  listIssueRoleAssignments: vi.fn(),
  listPrototypeVersions: vi.fn(),
  getDecomposition: vi.fn(),
  generatePrototype: vi.fn(),
  updatePrototypeMarks: vi.fn(),
  confirmPrototype: vi.fn(),
  decomposeRequirement: vi.fn(),
  confirmDecomposition: vi.fn(),
  listProjectModules: vi.fn(),
  listProjectResources: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
  ApiError: class ApiError extends Error {},
}));

// 与 requirement-decompose-panel.test.tsx 同一约定：拆解面板内的 actor 名称/头像
// 依赖 workspace hooks，stub 掉以保持容器测试可断言。
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `actor-${id}`,
  }),
}));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));

function requirement(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "req-1",
    identifier: "REQ-101",
    number: 101,
    title: "积分体系重构",
    description: "",
    status: "todo",
    priority: "medium",
    workspace_id: "workspace-1",
    project_id: "proj-1",
    parent_issue_id: null,
    assignee_id: null,
    assignee_type: null,
    creator_id: "user-1",
    creator_type: "member",
    labels: [],
    position: 0,
    stage: null,
    start_date: null,
    due_date: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    goal: "把积分规则引擎化",
    decomposition_confirmed_at: null,
    ...overrides,
  } as unknown as Issue;
}

function rosterRow(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: "ra-1",
    role: "prototyper",
    assignee_type: "agent",
    assignee_id: "agent-1",
    enabled: true,
    ordinal: 0,
    ...overrides,
  };
}

function protoVersion(overrides: Partial<PrototypeVersion> = {}): PrototypeVersion {
  return {
    id: "pv-1",
    issue_id: "req-1",
    version: 1,
    html_path: "docs/prototypes/REQ-101-x.html",
    prompt: "〔需求〕…",
    marks: [],
    status: "pending",
    created_by_type: "member",
    created_by_id: "user-1",
    created_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function renderSection(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApi.listIssueRoleAssignments.mockResolvedValue({ roles: [], total: 0 });
  mockApi.listPrototypeVersions.mockResolvedValue({ versions: [] });
  mockApi.getDecomposition.mockResolvedValue({
    plan: null,
    drafts: [],
    source_comment_id: null,
  });
  mockApi.decomposeRequirement.mockResolvedValue({});
  mockApi.confirmDecomposition.mockResolvedValue({ issues: [] });
  mockApi.listProjectModules.mockResolvedValue([]);
  mockApi.listProjectResources.mockResolvedValue({ resources: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("deriveFlowStage", () => {
  it("stage-1 子任务未终态 → 当前 = 1（原型）", () => {
    expect(
      deriveFlowStage({
        children: [{ stage: 1, terminal: false }],
        hasPrototyper: true,
        hasConfirmedPrototype: false,
        decompositionConfirmed: false,
      }),
    ).toBe(1);
  });

  it("无原型师且未确认拆解 → 当前 = 2（拆解）", () => {
    expect(
      deriveFlowStage({
        children: [],
        hasPrototyper: false,
        hasConfirmedPrototype: false,
        decompositionConfirmed: false,
      }),
    ).toBe(2);
  });

  it("原型已确认但未确认拆解 → 当前 = 2", () => {
    expect(
      deriveFlowStage({
        children: [{ stage: 1, terminal: true }],
        hasPrototyper: true,
        hasConfirmedPrototype: true,
        decompositionConfirmed: false,
      }),
    ).toBe(2);
  });

  it("拆解已确认 → 当前 = 3；有 stage-4 子任务 → 4", () => {
    expect(
      deriveFlowStage({
        children: [{ stage: 3, terminal: false }],
        hasPrototyper: true,
        hasConfirmedPrototype: true,
        decompositionConfirmed: true,
      }),
    ).toBe(3);
    expect(
      deriveFlowStage({
        children: [
          { stage: 3, terminal: true },
          { stage: 4, terminal: false },
        ],
        hasPrototyper: true,
        hasConfirmedPrototype: true,
        decompositionConfirmed: true,
      }),
    ).toBe(4);
  });
});

describe("RequirementFlowSection", () => {
  it("子 issue 不渲染流水线区块", async () => {
    renderSection(
      <RequirementFlowSection
        issue={requirement({ parent_issue_id: "parent-1" })}
        childIssues={[]}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("requirement-flow")).toBeNull();
    });
    expect(mockApi.listIssueRoleAssignments).not.toHaveBeenCalled();
  });

  it("顶层需求 + 启用原型师 → 渲染 stage 条与原型面板", async () => {
    mockApi.listIssueRoleAssignments.mockResolvedValue({
      roles: [rosterRow()],
      total: 1,
    });
    mockApi.listPrototypeVersions.mockResolvedValue({
      versions: [protoVersion()],
    });
    renderSection(
      <RequirementFlowSection issue={requirement()} childIssues={[]} />,
    );
    await screen.findByTestId("requirement-flow");
    // stage 条四节点齐备，原型节点为当前
    const strip = screen.getByTestId("requirement-flow");
    expect(strip.querySelectorAll("[data-stage-node]").length).toBe(4);
    expect(
      strip.querySelector('[data-stage-node="1"][data-current="true"]'),
    ).not.toBeNull();
    // 原型面板挂载（一键生成按钮可见）
    expect(await screen.findByTestId("proto-generate")).toBeTruthy();
  });

  it("无原型师 → 原型节点跳过态，当前 = 拆解，展示「发起拆解」", async () => {
    mockApi.listIssueRoleAssignments.mockResolvedValue({
      roles: [rosterRow({ role: "pm", enabled: true })],
      total: 1,
    });
    renderSection(
      <RequirementFlowSection issue={requirement()} childIssues={[]} />,
    );
    const strip = await screen.findByTestId("requirement-flow");
    await waitFor(() => {
      expect(
        strip.querySelector('[data-stage-node="1"][data-skipped="true"]'),
      ).not.toBeNull();
      expect(
        strip.querySelector('[data-stage-node="2"][data-current="true"]'),
      ).not.toBeNull();
    });
    const startBtn = await screen.findByTestId("decompose-start");
    fireEvent.click(startBtn);
    await waitFor(() => {
      expect(mockApi.decomposeRequirement).toHaveBeenCalledWith("req-1");
    });
  });

  it("已发起拆解（存在 stage-2 子任务）→ 显示拆解进行中而非发起按钮", async () => {
    mockApi.listIssueRoleAssignments.mockResolvedValue({
      roles: [rosterRow({ role: "pm" })],
      total: 1,
    });
    renderSection(
      <RequirementFlowSection
        issue={requirement()}
        childIssues={[{ stage: 2, status: "todo" } as unknown as Issue]}
      />,
    );
    await screen.findByTestId("requirement-flow");
    await waitFor(() => {
      expect(screen.queryByTestId("decompose-start")).toBeNull();
      expect(screen.getByTestId("decompose-running")).toBeTruthy();
    });
  });

  it("原型已确认 → 当前阶段推进到 2", async () => {
    mockApi.listIssueRoleAssignments.mockResolvedValue({
      roles: [rosterRow()],
      total: 1,
    });
    mockApi.listPrototypeVersions.mockResolvedValue({
      versions: [protoVersion({ status: "confirmed" })],
    });
    renderSection(
      <RequirementFlowSection issue={requirement()} childIssues={[]} />,
    );
    const strip = await screen.findByTestId("requirement-flow");
    await waitFor(() => {
      expect(
        strip.querySelector('[data-stage-node="2"][data-current="true"]'),
      ).not.toBeNull();
    });
    // 原型面板不再占主区（已确认）
    expect(screen.queryByTestId("proto-generate")).toBeNull();
  });

  it("拆解草稿已产出 → 渲染确认面板，角色指派解析为班底成员", async () => {
    mockApi.listIssueRoleAssignments.mockResolvedValue({
      roles: [
        rosterRow({ role: "pm" }),
        rosterRow({
          id: "ra-2",
          role: "developer",
          assignee_type: "agent",
          assignee_id: "agent-dev-1",
        }),
      ],
      total: 2,
    });
    mockApi.getDecomposition.mockResolvedValue({
      plan: "## plan 正文",
      drafts: [
        {
          temp_id: "t1",
          title: "账户模型",
          stage: 3,
          assignee_role: "developer",
          feature_points: [{ title: "积分账户", kind: "new" }],
        },
      ],
      source_comment_id: "c-1",
    });
    renderSection(
      <RequirementFlowSection
        issue={requirement()}
        childIssues={[{ stage: 2, status: "in_progress" } as unknown as Issue]}
      />,
    );
    // 面板替代进行中占位
    await screen.findByTestId("decompose-panel");
    expect(screen.queryByTestId("decompose-running")).toBeNull();

    fireEvent.click(await screen.findByTestId("decompose-confirm"));
    await waitFor(() => {
      expect(mockApi.confirmDecomposition).toHaveBeenCalled();
    });
    const calls = mockApi.confirmDecomposition.mock.calls;
    expect(calls.length).toBe(1);
    const drafts = calls[0]?.[1] as DecomposeDraftTask[];
    expect(drafts[0]?.assignee_type).toBe("agent");
    expect(drafts[0]?.assignee_id).toBe("agent-dev-1");
  });

  it("无 PM 子任务但草稿已产出（manual 模式） → 直接渲染确认面板", async () => {
    mockApi.listIssueRoleAssignments.mockResolvedValue({
      roles: [rosterRow({ role: "pm" })],
      total: 1,
    });
    mockApi.getDecomposition.mockResolvedValue({
      plan: "人工整理",
      drafts: [
        {
          temp_id: "t1",
          title: "手工任务",
          stage: 3,
          feature_points: [{ title: "fp", kind: "modify" }],
        },
      ],
      source_comment_id: "c-9",
    });
    renderSection(
      <RequirementFlowSection issue={requirement()} childIssues={[]} />,
    );
    await screen.findByTestId("decompose-panel");
    expect(screen.queryByTestId("decompose-start")).toBeNull();
  });
});
