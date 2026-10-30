// @vitest-environment jsdom

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleWorkspace } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { FeaturePointPanel } from "./feature-point-panel";

// 功能点信息面板回答「这个功能点到底要做什么」：模块目标 + 四段详情。
// 数据来自模块工作区，与「项目 → 功能模块」右栏同一份投影；这里钉的是
// 「缺什么就写缺」——空段落不隐藏，因为缺口本身就是 agent 要补的信息。

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/projects", () => ({
  moduleWorkspaceOptions: (_ws: string, _project: string, moduleId?: string) => ({
    queryKey: ["module-workspace", moduleId],
  }),
  isModuleWorkspaceGated: (error: unknown) => error instanceof Error,
}));

const queryState = vi.hoisted(() => ({
  data: undefined as ModuleWorkspace | undefined,
  error: undefined as Error | undefined,
  isError: false,
  isLoading: false,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => queryState,
}));

const workspace: ModuleWorkspace = {
  module_id: "m-1",
  name: "本体对象页",
  color: "#64748b",
  spec_version: 7,
  canonical_prototype_version: 3,
  brief_version: 2,
  release_version: null,
  brief: {
    version: 2,
    base_version: 1,
    fields: {
      "brief.goal": {
        value: "让本体对象可被检索、编辑与追溯",
        v: 2,
        by: "human",
        at: "2026-10-30T00:00:00Z",
      },
    },
    status: "published",
    source: "manual",
    diff_summary: "",
    changes: [],
    created_by_type: "member",
    created_at: "2026-10-30T00:00:00Z",
  },
  field_defs: [],
  features: [
    {
      code: "FP-02",
      title: "对象编辑",
      kind: "core",
      priority: "P1",
      group: "编辑",
      spec_version: 7,
      detail: {
        desc: "在右栏就地编辑对象属性",
        loc: "src/pages/objects/edit.tsx",
        req: ["字段级校验", "保存后回填列表"],
        interaction: "失焦即保存，失败原地提示",
        deps: "对象列表页",
        acceptance: [
          { text: "非法值不落库", ok: true },
          { text: "并发冲突有提示", ok: false },
        ],
      },
      filled: 6,
      total: 6,
      acceptance_ok: 1,
      acceptance_total: 2,
    },
  ],
  versions: [],
  releases: [],
  feature_count: 1,
};

afterEach(() => {
  cleanup();
  queryState.data = undefined;
  queryState.error = undefined;
  queryState.isError = false;
});

describe("FeaturePointPanel", () => {
  it("shows the module goal and every section of the bound feature point", () => {
    queryState.data = workspace;
    renderWithI18n(<FeaturePointPanel projectId="p-1" moduleId="m-1" code="FP-02" />);

    // 模块目标：迭代时「为什么做这个功能点」的锚点
    expect(screen.getByText("让本体对象可被检索、编辑与追溯")).toBeInTheDocument();
    expect(screen.getByText("在右栏就地编辑对象属性")).toBeInTheDocument();
    expect(screen.getByText("src/pages/objects/edit.tsx")).toBeInTheDocument();
    expect(screen.getByText("字段级校验")).toBeInTheDocument();
    expect(screen.getByText("失焦即保存，失败原地提示")).toBeInTheDocument();
    expect(screen.getByText("对象列表页")).toBeInTheDocument();
    // 验收标准的 ✓/○ 分开渲染，未完成的那条也要出现
    expect(screen.getByText("非法值不落库")).toBeInTheDocument();
    expect(screen.getByText("并发冲突有提示")).toBeInTheDocument();
    expect(screen.getByText("✓")).toBeInTheDocument();
    expect(screen.getByText("○")).toBeInTheDocument();
    // 卡片头的填充度与规格版本
    expect(screen.getByText("6/6 sections")).toBeInTheDocument();
    expect(screen.getByText("Spec v7")).toBeInTheDocument();
  });

  it("writes missing where a section is empty instead of hiding it", () => {
    queryState.data = {
      ...workspace,
      features: [
        {
          ...workspace.features[0]!,
          detail: { desc: "只有描述" },
          filled: 1,
          total: 6,
          acceptance_ok: 0,
          acceptance_total: 0,
        },
      ],
    };
    renderWithI18n(<FeaturePointPanel projectId="p-1" moduleId="m-1" code="FP-02" />);

    expect(screen.getByText("只有描述")).toBeInTheDocument();
    // 模块目标、定位、要求、交互、依赖、验收六段里剩下的都是「未填写」
    expect(screen.getAllByText("Not filled in").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("Acceptance 0/0")).toBeNull();
  });

  it("flags a code that is no longer in the module spec", () => {
    queryState.data = workspace;
    renderWithI18n(<FeaturePointPanel projectId="p-1" moduleId="m-1" code="FP-09" />);

    expect(document.body.textContent).toContain("FP-09");
    expect(document.body.textContent).toContain("no longer in the module spec");
  });

  it("renders nothing without both a module and a bound code", () => {
    queryState.data = workspace;
    const noCode = renderWithI18n(
      <FeaturePointPanel projectId="p-1" moduleId="m-1" code={null} />,
    );
    expect(noCode.container).toBeEmptyDOMElement();
    noCode.unmount();

    const noModule = renderWithI18n(
      <FeaturePointPanel projectId="p-1" moduleId={null} code="FP-02" />,
    );
    expect(noModule.container).toBeEmptyDOMElement();
  });

  it("renders nothing while the workspace endpoint is gated", () => {
    queryState.error = new Error("404 module workspace gated");
    queryState.isError = true;
    const { container } = renderWithI18n(
      <FeaturePointPanel projectId="p-1" moduleId="m-1" code="FP-02" />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
