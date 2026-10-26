import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import type { Issue, ProjectArtifact, WorkspaceAssetBinding } from "@multica/core/types";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import { ResourcePickerDialog } from "./resource-picker-dialog";

vi.mock("@multica/core/api", () => ({
  api: {
    searchIssues: vi.fn(async () => ({ issues: [] })),
    listIssues: vi.fn(async () => ({ issues: [], total: 0 })),
  },
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () => ({ entryOf: () => undefined }),
}));

const artifact = {
  id: "artifact-1",
  workspace_id: "ws-1",
  project_id: "project-1",
  rel_path: "docs/product-brief.md",
} as ProjectArtifact;
const binding = {
  id: "binding-1",
  workspace_id: "ws-1",
  project_id: "project-1",
  asset_category: "other",
  external_ref: { artifact_id: artifact.id, rel_path: artifact.rel_path },
  asset_name: "Product brief",
  source: "manual",
  recommended: false,
  created_by_type: "member",
  created_by_id: "user-1",
  created_at: new Date(0).toISOString(),
} as WorkspaceAssetBinding;

vi.mock("@multica/core/assets/queries", () => ({
  workspaceAssetsOptions: () => ({
    queryKey: ["workspace-assets"],
    queryFn: async () => ({ items: [binding] }),
  }),
}));

describe("ResourcePickerDialog", () => {
  it("keeps the selected document snapshot so the composer can show its name", async () => {
    const onApply = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues } }}>
        <QueryClientProvider client={new QueryClient()}>
          <ResourcePickerDialog open onOpenChange={onOpenChange} selected={[]} onApply={onApply} />
        </QueryClientProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Documents" }));
    fireEvent.click(await screen.findByRole("button", { name: /Product brief/ }));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add 1 to composer" }));

    expect(onApply).toHaveBeenCalledWith([expect.objectContaining({
      type: "document",
      id: "artifact-1",
      source: "artifact",
      title: "Product brief",
    })]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("lists recent tasks before the search box has text", async () => {
    vi.mocked(api.listIssues).mockResolvedValue({
      issues: [{
        id: "issue-9",
        identifier: "MUL-9",
        title: "Recent task",
        status: "todo",
        priority: "medium",
      } as Issue],
      total: 1,
    });
    render(
      <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues } }}>
        <QueryClientProvider client={new QueryClient()}>
          <ResourcePickerDialog open onOpenChange={() => undefined} selected={[]} onApply={() => undefined} />
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(await screen.findByRole("button", { name: /MUL-9 · Recent task/ })).toBeInTheDocument();
    expect(api.searchIssues).not.toHaveBeenCalled();
    expect(api.listIssues).toHaveBeenCalledWith({
      kind: "task",
      limit: 30,
      sort_by: "updated_at",
      sort_direction: "desc",
    });
  });
});
