// @vitest-environment jsdom

import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type {
  ModuleBriefFields,
  ModuleSpec,
  ModuleWorkspaceFeature,
} from "@multica/core/types";
import enArchive from "../../../../locales/en/archive.json";
import { FeatureSection } from "./prototype-inspector";

// 功能点的增删改都是「发布一份新 spec」，所以这里只需要盯 publish 的入参，
// 不必真的起后端：投影重建由 PublishModuleSpec 的事务负责。
const publishMutate = vi.fn();
let spec: ModuleSpec | null = null;
let specVersion = 3;

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/projects")>()),
  moduleSpecOptions: () => ({
    queryKey: ["test", "module-spec"],
    queryFn: async () => ({ spec, spec_version: specVersion }),
  }),
  usePublishModuleSpec: () => ({
    mutate: publishMutate,
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  usePatchModuleWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
}));

function featureRow(code: string, title: string, group?: string): ModuleWorkspaceFeature {
  return {
    code,
    title,
    kind: "core",
    group,
    spec_version: 3,
    detail: {},
    filled: 0,
    total: 4,
    acceptance_ok: 0,
    acceptance_total: 0,
  };
}

/** 选中的功能点由父级控制，测试里用一个最小容器承接。 */
function Harness({
  features,
  briefFields = {},
}: {
  features: ModuleWorkspaceFeature[];
  briefFields?: ModuleBriefFields;
}) {
  const [selected, setSelected] = useState("");
  return (
    <FeatureSection
      projectId="proj-1"
      moduleId="mod-1"
      features={features}
      points={[]}
      currentVersion={2}
      changedCodes={new Set()}
      selectedFp={selected || null}
      onSelectFp={setSelected}
      onClearFp={() => setSelected("")}
      onImport={() => {}}
      importPending={false}
      canImport={false}
      importableCount={0}
      hasPrototype={false}
      briefFields={briefFields}
    />
  );
}

function renderSection(
  features: ModuleWorkspaceFeature[],
  briefFields: ModuleBriefFields = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { archive: enArchive } }}>
        <Harness features={features} briefFields={briefFields} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** 最近一次发布请求的 body。 */
function lastPublishBody(): { spec: ModuleSpec; expected_version?: number } {
  const call = publishMutate.mock.calls.at(-1);
  return call?.[0] as { spec: ModuleSpec; expected_version?: number };
}

/** 发布出去的 spec 里的功能点编号。 */
function publishedCodes(): string[] {
  return (lastPublishBody().spec.features ?? []).map((item) => item.code);
}

describe("FeatureSection", () => {
  beforeEach(() => {
    publishMutate.mockReset();
    spec = {
      schema: "module_spec/v1",
      features: [
        { code: "FP-01", title: "智聊", kind: "core", group: "会话" },
        { code: "FP-02", title: "误建的", kind: "core", group: "会话" },
      ],
    };
    specVersion = 3;
  });

  it("deletes a feature by publishing the spec without it", async () => {
    renderSection([featureRow("FP-01", "智聊", "会话"), featureRow("FP-02", "误建的", "会话")]);

    fireEvent.click(screen.getByTestId("feature-remove-FP-02"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(publishMutate).toHaveBeenCalledTimes(1));
    expect(publishedCodes()).toEqual(["FP-01"]);
    const body = lastPublishBody();
    expect(body.expected_version).toBe(3);
    expect(body.spec.schema).toBe("module_spec/v1");
  });

  it("edits title and kind without touching the code", async () => {
    // spec 是真源：这里只留 FP-01，断言才聚焦在「改了哪几个字段」上。
    spec = { schema: "module_spec/v1", features: [{ code: "FP-01", title: "智聊", kind: "core", group: "会话" }] };
    renderSection([featureRow("FP-01", "智聊", "会话")]);

    fireEvent.click(screen.getByTestId("feature-row-FP-01"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit point" }));
    fireEvent.change(screen.getByPlaceholderText("Point title"), {
      target: { value: "智能会话" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edge" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(publishMutate).toHaveBeenCalledTimes(1));
    expect(lastPublishBody().spec.features).toEqual([
      { code: "FP-01", title: "智能会话", kind: "edge", group: "会话" },
    ]);
  });

  it("never reuses a code whose brief detail outlived the deletion", async () => {
    // FP-02 已从 spec 删掉，但 brief 里还留着 fp.FP-02.desc：
    // 再次新增要跳到 FP-03，否则残留详情会复活到新功能点上。
    renderSection(
      [featureRow("FP-01", "智聊", "会话")],
      { "fp.FP-02.desc": { value: "旧描述", v: 1, by: "human", at: "2026-10-01T00:00:00Z" } },
    );

    await waitFor(() => expect(screen.getByTestId("feature-row-FP-01")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "＋ Point" }));
    expect((screen.getByPlaceholderText("Code") as HTMLInputElement).value).toBe("FP-03");
  });
});
