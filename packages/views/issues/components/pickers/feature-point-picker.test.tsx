// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ModuleWorkspace } from "@multica/core/types";
import { renderWithI18n } from "../../../test/i18n";
import { FeaturePointPicker } from "./feature-point-picker";

// 属性栏的「功能点」一行：候选项必须来自该模块的规格投影（项目 → 功能模块 →
// 原型图 → 功能点 的最后一跳），不是第二份元数据。这里把数据层挡掉，只钉
// 选择器对任务右栏的契约：单选、编号 + 标题回显、空值 = 不绑定、门控消失。

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

const requested: Array<{ ws: string; project: string; module?: string }> = [];

vi.mock("@multica/core/projects", () => ({
  moduleWorkspaceOptions: (ws: string, projectId: string, moduleId?: string) => {
    requested.push({ ws, project: projectId, module: moduleId });
    return { queryKey: ["module-workspace", moduleId] };
  },
  isModuleWorkspaceGated: (error: unknown) => error instanceof Error,
}));

const feature = (
  code: string,
  title: string,
  filled = 2,
  total = 6,
): ModuleWorkspace["features"][number] => ({
  code,
  title,
  kind: "core",
  spec_version: 4,
  detail: {},
  filled,
  total,
  acceptance_ok: 0,
  acceptance_total: 0,
});

const workspace: ModuleWorkspace = {
  module_id: "m-1",
  name: "本体对象页",
  color: "#64748b",
  spec_version: 4,
  canonical_prototype_version: 2,
  brief_version: 1,
  release_version: null,
  brief: {
    version: 1,
    base_version: null,
    fields: {},
    status: "published",
    source: "manual",
    diff_summary: "",
    changes: [],
    created_by_type: "member",
    created_at: "2026-10-30T00:00:00Z",
  },
  field_defs: [],
  features: [feature("FP-01", "对象列表"), feature("FP-02", "对象编辑", 6, 6)],
  versions: [],
  releases: [],
  feature_count: 2,
};

const queryState = vi.hoisted(() => ({
  data: undefined as ModuleWorkspace | undefined,
  error: undefined as Error | undefined,
  isError: false,
  isLoading: false,
}));

const optionsSeen: Array<{ enabled?: boolean }> = [];

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: (options: { enabled?: boolean }) => {
    optionsSeen.push(options);
    return queryState;
  },
}));

/** 列表行带 data-picker-item；触发器和搜索框没有。 */
const rows = () =>
  Array.from(document.querySelectorAll<HTMLElement>("button[data-picker-item]"));

const rowFor = (label: string) => {
  const row = rows().find((el) => el.textContent?.includes(label));
  if (!row) throw new Error(`no feature point row for "${label}"`);
  return row;
};

afterEach(() => {
  cleanup();
  requested.length = 0;
  optionsSeen.length = 0;
  queryState.data = undefined;
  queryState.error = undefined;
  queryState.isError = false;
  queryState.isLoading = false;
});

describe("FeaturePointPicker", () => {
  it("scopes the candidates to one workspace, project and module pair", () => {
    queryState.data = workspace;
    renderWithI18n(
      <FeaturePointPicker
        projectId="p-1"
        moduleId="m-1"
        value={null}
        onChange={() => {}}
        defaultOpen
      />,
    );

    expect(requested[0]).toEqual({ ws: "ws-1", project: "p-1", module: "m-1" });
    expect(optionsSeen[0]?.enabled).toBe(true);
    // 两个功能点 + 一行「不绑定」
    expect(rows()).toHaveLength(3);
    expect(rowFor("FP-02").textContent).toContain("对象编辑");
    expect(rowFor("FP-02").textContent).toContain("6/6");
  });

  it("writes the picked code and keeps one selection at a time", async () => {
    queryState.data = workspace;
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithI18n(
      <FeaturePointPicker
        projectId="p-1"
        moduleId="m-1"
        value="FP-01"
        onChange={onChange}
        defaultOpen
      />,
    );

    await user.click(rowFor("FP-02"));
    expect(onChange).toHaveBeenCalledWith("FP-02");
  });

  it("writes null for the module-granularity empty value", async () => {
    queryState.data = workspace;
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithI18n(
      <FeaturePointPicker
        projectId="p-1"
        moduleId="m-1"
        value="FP-01"
        onChange={onChange}
        defaultOpen
      />,
    );

    await user.click(rowFor("No feature point"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps showing the code when the spec no longer has it", () => {
    queryState.data = workspace;
    renderWithI18n(
      <FeaturePointPicker
        projectId="p-1"
        moduleId="m-1"
        value="FP-09"
        onChange={() => {}}
      />,
    );

    // 编号还在、规格里已经没有了：照实说话，不假装它还有标题。
    expect(document.body.textContent).toContain("FP-09");
    expect(document.body.textContent).toContain("No longer in the spec");
  });

  it("renders nothing without a module", () => {
    queryState.data = workspace;
    const { container } = renderWithI18n(
      <FeaturePointPicker projectId="p-1" moduleId={null} value="FP-01" onChange={() => {}} />,
    );

    // 没有模块就没有功能点，也不该发请求。
    expect(container).toBeEmptyDOMElement();
    expect(optionsSeen[0]?.enabled).toBe(false);
  });

  it("renders nothing when the module workspace endpoint is gated", () => {
    queryState.error = new Error("404 module workspace gated");
    queryState.isError = true;
    const { container } = renderWithI18n(
      <FeaturePointPicker projectId="p-1" moduleId="m-1" value="FP-01" onChange={() => {}} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("says the module has none rather than showing an empty list", () => {
    queryState.data = { ...workspace, features: [], feature_count: 0 };
    renderWithI18n(
      <FeaturePointPicker
        projectId="p-1"
        moduleId="m-1"
        value={null}
        onChange={() => {}}
        defaultOpen
      />,
    );

    expect(document.body.textContent).toContain(
      "This module has no feature points yet",
    );
  });
});
