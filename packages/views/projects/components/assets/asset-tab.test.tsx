import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import type { AssetCandidate } from "@multica/core/types";
import enAssets from "../../../locales/en/assets.json";
import { BindAssetDialog } from "./asset-tab";

// 候选池由后端决定（仓库 / 档案 / workspace.repos），这里只关心对话框怎么表现：
// 有候选时列出来，没候选时必须给出可点的「手动新增」去路 —— 早前只有一句静态
// 提示文案，任务右栏的绑定入口就停在那里，用户以为「绑定坏了」。
const poolMock = vi.hoisted(() => ({
  candidates: [] as AssetCandidate[],
  mutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/assets/queries", () => ({
  assetCandidatesOptions: () => ({
    queryKey: ["asset-candidates-test"],
    queryFn: async () => ({ candidates: poolMock.candidates }),
  }),
  assetListOptions: () => ({
    queryKey: ["asset-list-test"],
    queryFn: async () => ({ items: [], page: 1, pageSize: 20, totalCount: 0, totalPages: 1 }),
  }),
}));

vi.mock("@multica/core/assets/mutations", () => ({
  useBindIssueAsset: poolMock.mutation,
  useBindProjectAsset: poolMock.mutation,
  useUnbindIssueAsset: poolMock.mutation,
  useUnbindProjectAsset: poolMock.mutation,
  useSyncAssetsFromArchive: poolMock.mutation,
  useBatchUpdateAssetMeta: poolMock.mutation,
  useUpdateAssetMeta: poolMock.mutation,
}));

function candidate(overrides: Partial<AssetCandidate> = {}): AssetCandidate {
  return {
    asset_category: "code_repository",
    asset_name: "repo-a",
    subtype: "github",
    source: "github_repo",
    external_ref: { url: "https://git.example.com/group/repo-a.git" },
    already_bound: false,
    recommended: false,
    recommend_reason: "",
    score: 0,
    ...overrides,
  };
}

function renderDialog() {
  return render(
    <I18nProvider locale="en" resources={{ en: { assets: enAssets } }}>
      <QueryClientProvider client={new QueryClient()}>
        <BindAssetDialog
          projectId="p-1"
          issueId="issue-1"
          open
          onOpenChange={vi.fn()}
          defaultCategory="code_repository"
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("BindAssetDialog", () => {
  beforeEach(() => {
    poolMock.candidates = [];
  });

  it("offers a working way out when the candidate pool is empty", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(
      await screen.findByText("No matching candidates. Try another keyword, or add one manually."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Go to manual entry" }));
    expect(screen.getByPlaceholderText("e.g. order-service")).toBeInTheDocument();
  });

  it("lists candidates and keeps the guidance hidden when the pool has rows", async () => {
    poolMock.candidates = [candidate()];
    renderDialog();

    expect(await screen.findByText("repo-a")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to manual entry" })).not.toBeInTheDocument();
  });

  // 项目档案全部已入档时，候选行会被置灰（disabled），整列灰按钮同样走不通 ——
  // 必须显式告知原因并给出手动录入去路。
  it("explains a fully-bound candidate list and keeps manual entry reachable", async () => {
    const user = userEvent.setup();
    poolMock.candidates = [candidate({ already_bound: true })];
    renderDialog();

    expect(
      await screen.findByText("Every candidate is already bound to this project."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go to manual entry" }));
    expect(screen.getByPlaceholderText("e.g. order-service")).toBeInTheDocument();
  });

  // 上传与绑定入口复用同一弹窗实例：切到「目录导入」时标题必须换成上传口径，
  // 且同一时刻只留一个面板（旧面板未卸载会把弹窗撑高一整块候选区）。
  it("switches the header and leaves a single panel when opening folder import", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(
      await screen.findByText("No matching candidates. Try another keyword, or add one manually."),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bind" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Folder import" }));

    expect(await screen.findByRole("heading", { name: "Upload assets" })).toBeInTheDocument();
    expect(screen.getByText("Import from folder")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText("No matching candidates. Try another keyword, or add one manually."),
      ).not.toBeInTheDocument(),
    );
  });
});
