import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import type { AssetBinding } from "@multica/core/types";
import enAssets from "../../../../locales/en/assets.json";
import { AssetTable } from "./asset-table";
import { AssetCardGrid } from "./asset-card-grid";
import { AssetSelectionToolbar } from "./asset-selection-toolbar";
import { AssetBatchEditDialog } from "./asset-batch-edit-dialog";

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

// 行内编辑的 mutation 在共享层测试中只验证装配关系（按行 project_id 提交），
// 真实请求链路由 core mutations 自己的测试覆盖。
vi.mock("@multica/core/assets/mutations", () => ({
  useUpdateAssetMeta: () => ({ mutate: vi.fn(), isPending: false }),
  useBatchUpdateAssetMeta: () => ({ mutate: vi.fn(), isPending: false }),
}));

function binding(id: string, overrides: Partial<AssetBinding> = {}): AssetBinding {
  return {
    id,
    workspace_id: "ws-1",
    project_id: "p-1",
    asset_category: "knowledge_repo",
    external_ref: {},
    asset_name: `asset-${id}`,
    source: "archive",
    recommended: false,
    created_by_type: "member",
    created_by_id: "u-1",
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const categoryLabels = { knowledge_repo: "Knowledge repo" };

function renderUi(ui: React.ReactElement) {
  return render(<I18nProvider locale="en" resources={{ en: { assets: enAssets } }}>{ui}</I18nProvider>);
}

describe("AssetTable", () => {
  it("renders the shared column set without a selection column", () => {
    renderUi(
      <AssetTable rows={[binding("1"), binding("2")]} />,
    );
    const header = screen.getByRole("columnheader", { name: "Name" });
    expect(header).toBeTruthy();
    screen.getByRole("columnheader", { name: "Stage" });
    screen.getByRole("columnheader", { name: "Object" });
    // 「分类」列已按产品要求下线
    expect(screen.queryByRole("columnheader", { name: "Category" })).toBeNull();
    // 「来源」列同步下线（字段仅作数据属性，不再占列宽）
    expect(screen.queryByRole("columnheader", { name: "Source" })).toBeNull();
    // 未传选择态 → 无勾选列
    expect(screen.queryAllByRole("checkbox").length).toBe(0);
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 rows
  });

  it("wires current-page selection: header select-all and per-row toggle", () => {
    const onToggleSelect = vi.fn();
    const onToggleAll = vi.fn();
    renderUi(
      <AssetTable
        rows={[binding("1"), binding("2")]}
        selectedIds={new Set(["1"])}
        onToggleSelect={onToggleSelect}
        onToggleAll={onToggleAll}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(3); // header + 2 rows
    fireEvent.click(checkboxes[1]!);
    expect(onToggleSelect).toHaveBeenCalledWith("1");
    fireEvent.click(checkboxes[0]!);
    expect(onToggleAll).toHaveBeenCalled();
  });

  it("shows preview affordance only for previewable rows and unbind per row", () => {
    const onPreview = vi.fn();
    const onUnbind = vi.fn();
    renderUi(
      <AssetTable
        rows={[
          binding("1", { external_ref: { artifact_id: "art-1" } }),
          binding("2", { external_ref: { url: "https://example.com" } }),
        ]}
        onPreview={onPreview}
        onUnbind={onUnbind}
      />,
    );
    fireEvent.click(screen.getByText("asset-1")); // 名称即预览入口
    expect(onPreview).toHaveBeenCalledTimes(1);
    // 第二行不可预览：行级 Preview 按钮只属于第一行
    expect(screen.getAllByLabelText("Preview")).toHaveLength(1);
  });

  it("injects workspace-specific links, ownership and edit through features", () => {
    const onEdit = vi.fn();
    renderUi(
      <AssetTable
        rows={[binding("1", { links: [{ issue_id: "issue-1234567890", link_type: "produces" }] })]}
        features={{
          showLinks: true,
          showOwnership: true,
          issueInfoById: new Map([["issue-1234567890", { title: "登录改造", status: "in_progress", is_requirement: true }]]),
          issueHref: (id) => `/ws/issues/${id}`,
          onEdit,
          ownershipLabel: (row) => <span data-testid="own">bound:{row.project_id}</span>,
        }}
      />,
    );
    // 原单列「Links」已拆为「Requirements / Tasks」两列
    expect(screen.queryByRole("columnheader", { name: "Links" })).toBeNull();
    screen.getByRole("columnheader", { name: "Requirements" });
    screen.getByRole("columnheader", { name: "Tasks" });
    screen.getByText("Requirements 1");
    screen.getByRole("columnheader", { name: "Bound to" });
    screen.getByTestId("own");
    fireEvent.click(screen.getByLabelText("Edit"));
    expect(onEdit).toHaveBeenCalled();
  });

  it("keeps read-only badges when inlineEdit is off and inline selects when on", () => {
    const rows = [binding("1", { lifecycle_stage: "S5", asset_role: "input", tags: ["prd"] })];
    const { unmount } = renderUi(<AssetTable rows={rows} />);
    screen.getByText("S5 Requirement Iteration"); // 只读阶段徽标（五阶段新名）
    unmount();

    renderUi(<AssetTable rows={rows} features={{ inlineEdit: true }} />);
    // 行内编辑：阶段/对象列渲染为 Select（combobox），标签列为编辑按钮；
    // 分类列下线后仅剩阶段+对象两个行内 combobox。
    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("AssetCardGrid", () => {
  it("renders cards with selection, ownership slot and actions", () => {
    const onToggleSelect = vi.fn();
    const onUnbind = vi.fn();
    renderUi(
      <AssetCardGrid
        rows={[binding("1", { lifecycle_stage: "S2" })]}
        categoryLabels={categoryLabels}
        selectedIds={new Set(["1"])}
        onToggleSelect={onToggleSelect}
        onUnbind={onUnbind}
        features={{ showOwnership: true, ownershipLabel: () => <span data-testid="own">P</span> }}
      />,
    );
    const grid = screen.getByTestId("asset-card-grid");
    within(grid).getByText("asset-1");
    within(grid).getByText("S2 Product Prototype");
    screen.getByTestId("own");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggleSelect).toHaveBeenCalledWith("1");
    fireEvent.click(within(grid).getByLabelText("Unbind"));
    expect(onUnbind).toHaveBeenCalled();
  });
});

describe("AssetSelectionToolbar", () => {
  it("hides when nothing is selected and reports actions", () => {
    const { rerender } = renderUi(
      <AssetSelectionToolbar count={0} onClear={vi.fn()} onBatchEdit={vi.fn()} />,
    );
    expect(screen.queryByText("0 selected")).toBeNull();
    rerender(
      <I18nProvider locale="en" resources={{ en: { assets: enAssets } }}>
        <AssetSelectionToolbar count={2} onClear={vi.fn()} onBatchEdit={vi.fn()} />
      </I18nProvider>,
    );
    screen.getByText("2 selected");
    fireEvent.click(screen.getByText("Batch edit"));
    fireEvent.click(screen.getByText("Clear selection"));
  });
});

describe("AssetBatchEditDialog", () => {
  it("keeps Apply disabled until something changes, then submits the built request", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderUi(
      <AssetBatchEditDialog
        open
        onOpenChange={vi.fn()}
        selectedIds={["1", "2"]}
        isPending={false}
        onSubmit={onSubmit}
      />,
    );
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getAllByRole("combobox")[0]!);
    await user.click(await screen.findByRole("option", { name: "S5 Requirement Iteration" }));
    expect(apply.hasAttribute("disabled")).toBe(false);
    await user.click(apply);
    expect(onSubmit).toHaveBeenCalledWith({
      binding_ids: ["1", "2"],
      lifecycle_stage: "S5",
    });
  });

  it("blocks duplicate submit and closing while pending, and shows resultNote", () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    renderUi(
      <AssetBatchEditDialog
        open
        onOpenChange={onOpenChange}
        selectedIds={["1"]}
        isPending
        onSubmit={onSubmit}
        resultNote="Succeeded in 1 project(s), 1 failed"
      />,
    );
    screen.getByText("Succeeded in 1 project(s), 1 failed");
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
