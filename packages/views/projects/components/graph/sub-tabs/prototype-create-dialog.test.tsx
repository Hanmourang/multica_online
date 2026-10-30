// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enArchive from "../../../../locales/en/archive.json";
import { PrototypeCreateDialog } from "./prototype-create-dialog";

// 档案写入的根资源由 project.archive_resource_id / local_directory 决定；
// 测试只关心对话框如何反映这个前置条件，所以把数据源做成可切换的桩。
let archiveResourceId: string | null = null;
let resources: Array<{ id: string; resource_type: string }> = [];
let artifacts: Array<{ id: string; rel_path: string }> = [];

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/api", () => ({
  api: { uploadFile: vi.fn() },
}));

vi.mock("@multica/core/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/artifacts")>()),
  projectArtifactsOptions: () => ({
    queryKey: ["test", "artifacts"],
    queryFn: async () => artifacts,
  }),
  useCreateArtifact: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@multica/core/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/projects")>()),
  projectDetailOptions: () => ({
    queryKey: ["test", "project"],
    queryFn: async () => ({ archive_resource_id: archiveResourceId }),
  }),
  projectResourcesOptions: () => ({
    queryKey: ["test", "resources"],
    queryFn: async () => resources,
  }),
  useRegisterModulePrototype: () => ({ mutateAsync: vi.fn() }),
}));

function renderDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { archive: enArchive } }}>
        <PrototypeCreateDialog
          open
          onOpenChange={onOpenChange}
          projectId="proj-1"
          moduleId="mod-1"
          moduleName="1.1 AI assistant"
          nextVersion={2}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe("PrototypeCreateDialog", () => {
  beforeEach(() => {
    archiveResourceId = null;
    resources = [];
    artifacts = [];
  });

  it("closes through the footer button", async () => {
    const { onOpenChange } = renderDialog();
    expect(await screen.findByText("New prototype")).toBeTruthy();

    // 顶部的 X 也叫 "Close"（sr-only），这里只要页脚那个。
    const footerClose = screen
      .getAllByRole("button", { name: "Close" })
      .find((el) => el.getAttribute("data-slot") !== "dialog-close");
    expect(footerClose).toBeTruthy();
    fireEvent.click(footerClose!);

    // Base UI 在受控模式下只回报意图，真正的关闭由父级 state 决定。
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("blocks the upload branch until an archive root is bound", async () => {
    renderDialog();

    // 未绑定档案根目录：上传区直接说明原因，提交按钮禁用。
    expect(await screen.findByText(/no archive root yet/i)).toBeTruthy();
    await waitFor(() => {
      const submit = screen.getByRole("button", { name: "Register as v2" });
      expect((submit as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("leaves the upload branch usable once a local directory is bound", async () => {
    archiveResourceId = "res-1";
    resources = [{ id: "res-1", resource_type: "local_directory" }];
    renderDialog();

    await waitFor(() => {
      const submit = screen.getByRole("button", { name: "Register as v2" });
      expect((submit as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText(/no archive root yet/i)).toBeNull();
  });

  it("keeps the archive-pick branch enabled even without an archive root", async () => {
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pick from archive" }));
    });

    // 从档案挑文件不写 artifact，只登记版本行，因此不受档案根目录限制。
    const submit = screen.getByRole("button", { name: "Register as v2" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders archive rows as split path + file name with a clickable affordance", async () => {
    artifacts = [
      { id: "a1", rel_path: "change_logs/repo/20261012_prototype-v2.html" },
      { id: "a2", rel_path: "change_logs/repo/20261012_prototype-v3.html" },
    ];
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pick from archive" }));
    });

    // 计数行让用户知道列表还有多少，而不是靠数行。
    expect(await screen.findByText("2 HTML files in the archive")).toBeTruthy();

    const row = screen.getByRole("button", { name: /20261012_prototype-v2\.html/ });
    // 文件名与目录分层展示：目录在副行，且整行带原始路径的 title。
    expect(row.getAttribute("title")).toBe("change_logs/repo/20261012_prototype-v2.html");
    expect(row.textContent).toContain("change_logs/repo");
    // 默认态必须自己声明可点击，而不是只靠 hover 变色。
    expect(row.className).toContain("cursor-pointer");
    expect(row.className).toContain("border-surface-border");
  });

  it("echoes the picked archive path before submitting", async () => {
    artifacts = [{ id: "a1", rel_path: "change_logs/repo/proto.html" }];
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pick from archive" }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /proto\.html/ }));
    });

    expect(
      await screen.findByText(/Registers against the archive path change_logs\/repo\/proto\.html/),
    ).toBeTruthy();
  });

  it("offers a way out of the upload branch when the archive is unavailable", async () => {
    artifacts = [{ id: "a1", rel_path: "change_logs/repo/proto.html" }];
    renderDialog();

    // 上传分支走不通时，警告条必须直接给出可点的替代路径。
    expect(await screen.findByText(/no archive root yet/i)).toBeTruthy();
    const shortcut = await screen.findByRole("button", { name: /Switch to "Pick from archive"/ });
    fireEvent.click(shortcut);

    expect(await screen.findByText("1 HTML files in the archive")).toBeTruthy();
  });

  it("filters the archive list by keyword and reports the match count", async () => {
    artifacts = [
      { id: "a1", rel_path: "change_logs/repo/Login-v2.html" },
      { id: "a2", rel_path: "change_logs/repo/Home-v2.html" },
      { id: "a3", rel_path: "prototypes/dashboard/index.html" },
    ];
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pick from archive" }));
    });
    expect(await screen.findByText("3 HTML files in the archive")).toBeTruthy();

    // 上百条档案靠滚动找不现实，关键词过滤后计数行要同时给出命中数与总数。
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Search file name or path"), {
        target: { value: "dashboard" },
      });
    });

    expect(await screen.findByText("1 of 3 matched")).toBeTruthy();
    expect(screen.getByRole("button", { name: /index\.html/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Login-v2\.html/ })).toBeNull();
  });

  it("explains an empty filter result instead of rendering a blank list", async () => {
    artifacts = [{ id: "a1", rel_path: "change_logs/repo/Login-v2.html" }];
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pick from archive" }));
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Search file name or path"), {
        target: { value: "nothing-matches-this" },
      });
    });

    expect(
      await screen.findByText(/No archive file matches — try a different keyword\./),
    ).toBeTruthy();
  });
});
