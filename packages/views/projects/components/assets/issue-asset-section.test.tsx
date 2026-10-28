import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import type { AssetBinding } from "@multica/core/types";
import enAssets from "../../../locales/en/assets.json";
import enArchive from "../../../locales/en/archive.json";
import { IssueAssetSection } from "./issue-asset-section";

const apiMock = vi.hoisted(() => ({
  listIssueAssets: vi.fn(),
  getProjectArtifact: vi.fn(),
  getAttachmentTextContent: vi.fn(),
  searchAssetCandidates: vi.fn(),
}));

// `api` 是转发到 setApiInstance 单例的 Proxy，spyOn 不可用，按模块整体替换。
vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return { ...actual, api: { ...actual.api, ...apiMock } };
});

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspaceSlug: () => "hanmourang",
}));

function binding(overrides: Partial<AssetBinding> = {}): AssetBinding {
  return {
    id: "b-1",
    workspace_id: "ws-1",
    project_id: "p-1",
    issue_id: "issue-1",
    asset_category: "knowledge_repo",
    external_ref: {},
    asset_name: "spec.md",
    source: "archive",
    recommended: false,
    created_by_type: "member",
    created_by_id: "u-1",
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

function renderSection(rows: AssetBinding[]) {
  apiMock.listIssueAssets.mockResolvedValue({
    items: rows,
    page: 1,
    pageSize: 20,
    totalCount: rows.length,
    totalPages: 1,
  });
  return render(
    <I18nProvider locale="en" resources={{ en: { assets: enAssets, archive: enArchive } }}>
      <QueryClientProvider client={new QueryClient()}>
        <IssueAssetSection projectId="p-1" issueId="issue-1" />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("IssueAssetSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers an open action for archive-backed documents", async () => {
    renderSection([
      binding({ external_ref: { artifact_id: "art-1", rel_path: "docs/spec.md" } }),
    ]);

    expect(await screen.findByText("spec.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
  });

  it("keeps plain link assets without an open action", async () => {
    renderSection([
      binding({ asset_name: "design doc", external_ref: { url: "https://example.com/doc" } }),
    ]);

    expect(await screen.findByText("design doc")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
  });
});
