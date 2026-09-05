/**
 * @vitest-environment jsdom
 *
 * Prototype panel (spec画面 4): left column shows the prototype preview strip
 * (numbered detail dots, ✗ items turn red) plus the per-detail marks list
 * (three-state ✓/✗/○ cycling; a ✗ mark requires a correction note before
 * saving); right column shows the assembled five-section prompt read-only, a
 * red 〔本轮修正〕 preview composed from ✗+note marks, the one-click generate /
 * regenerate button (regenerate carries the current marks in the POST body),
 * the version history rows, and the goal-coverage block. The confirm button
 * is disabled with a red hint while any ✗ mark is unresolved.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { Issue, PrototypeVersion } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import {
  RequirementPrototypePanel,
  type RequirementPrototypePanelProps,
} from "./requirement-prototype-panel";

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
    stage: 1,
    start_date: null,
    due_date: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    goal: "把积分规则引擎化",
    ...overrides,
  } as unknown as Issue;
}

function protoVersion(overrides: Partial<PrototypeVersion> = {}): PrototypeVersion {
  return {
    id: "pv-1",
    issue_id: "req-1",
    version: 1,
    html_path: "docs/prototypes/REQ-101-积分体系重构.html",
    prompt: "〔需求〕积分体系重构\n〔目标〕把积分规则引擎化",
    marks: [{ detail_id: "d1", verdict: "pending", note: "" }],
    status: "pending",
    created_by_type: "member",
    created_by_id: "user-1",
    created_at: "2026-09-05T10:00:00Z",
    ...overrides,
  };
}

type ListVersionsFn = RequirementPrototypePanelProps["listVersions"];
type GenerateFn = RequirementPrototypePanelProps["generatePrototype"];
type SaveMarksFn = RequirementPrototypePanelProps["saveMarks"];
type ConfirmFn = RequirementPrototypePanelProps["confirmPrototype"];

interface Mocks {
  listVersions: ReturnType<typeof vi.fn<ListVersionsFn>>;
  generatePrototype: ReturnType<typeof vi.fn<GenerateFn>>;
  saveMarks: ReturnType<typeof vi.fn<SaveMarksFn>>;
  confirmPrototype: ReturnType<typeof vi.fn<ConfirmFn>>;
}

function renderPanel(mocks: Partial<Mocks> = {}) {
  const listVersions =
    mocks.listVersions ?? vi.fn<ListVersionsFn>().mockResolvedValue([protoVersion()]);
  const generatePrototype =
    mocks.generatePrototype ??
    vi.fn<GenerateFn>().mockResolvedValue({
      version: protoVersion(),
      task: requirement({ id: "child-1" }),
    });
  const saveMarks = mocks.saveMarks ?? vi.fn<SaveMarksFn>().mockResolvedValue(protoVersion());
  const confirmPrototype =
    mocks.confirmPrototype ??
    vi.fn<ConfirmFn>().mockResolvedValue(protoVersion({ status: "confirmed" }));
  renderWithI18n(
    <RequirementPrototypePanel
      issue={requirement()}
      listVersions={listVersions}
      generatePrototype={generatePrototype}
      saveMarks={saveMarks}
      confirmPrototype={confirmPrototype}
    />,
  );
  return { listVersions, generatePrototype, saveMarks, confirmPrototype };
}

describe("RequirementPrototypePanel", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("一键生成按钮触发 generate 并轮询新版本", async () => {
    const v1 = protoVersion();
    const listVersions = vi
      .fn<ListVersionsFn>()
      .mockResolvedValueOnce([]) // mount: no versions yet
      .mockResolvedValue([v1]); // poll after generate: v1 appears
    const generatePrototype = vi.fn<GenerateFn>().mockResolvedValue({
      version: v1,
      task: requirement({ id: "child-1", stage: 1 }),
    });
    renderPanel({ listVersions, generatePrototype });

    // Empty state offers the one-click generate button.
    const btn = await screen.findByTestId("proto-generate");
    fireEvent.click(btn);

    // The panel polls the version history until v1 shows up.
    const row = await screen.findByTestId("proto-ver-1");
    expect(row.textContent).toContain("v1");
    expect(row.textContent).toContain("current");

    expect(generatePrototype).toHaveBeenCalledTimes(1);
    const [issueId, body] = generatePrototype.mock.calls[0]!;
    expect(issueId).toBe("req-1");
    expect(body.marks).toBeUndefined(); // first generate carries no marks
  });

  it("细节标记三态切换且 ✗ 必填修正诉求", async () => {
    const saveMarks = vi.fn<SaveMarksFn>().mockResolvedValue(protoVersion());
    renderPanel({ saveMarks });

    const cycle = await screen.findByTestId("proto-mark-d1");
    expect(cycle.textContent).toContain("Pending");
    fireEvent.click(cycle);
    expect(cycle.textContent).toContain("OK");
    fireEvent.click(cycle);
    expect(cycle.textContent).toContain("No");

    // ✗ without a correction note → save disabled + hint.
    const save = screen.getByTestId("proto-marks-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId("proto-marks-hint").textContent).toMatch(/✗/);

    fireEvent.change(screen.getByTestId("proto-note-d1"), {
      target: { value: "重试上限 3 次" },
    });
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    expect(saveMarks).toHaveBeenCalledTimes(1);
    const [, version, marks] = saveMarks.mock.calls[0]!;
    expect(version).toBe(1);
    expect(marks).toEqual([{ detail_id: "d1", verdict: "no", note: "重试上限 3 次" }]);
  });

  it("存在未处理 ✗ 时确认按钮禁用", async () => {
    const listVersions = vi.fn<ListVersionsFn>().mockResolvedValue([
      protoVersion({ marks: [{ detail_id: "d1", verdict: "no", note: "重试上限" }] }),
    ]);
    renderPanel({ listVersions });

    const confirm = (await screen.findByTestId("proto-confirm")) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByTestId("proto-confirm-blocked").textContent).toMatch(/✗/);
  });

  it("重新生成请求体携带当前 marks", async () => {
    const v1 = protoVersion({
      marks: [{ detail_id: "d1", verdict: "no", note: "重试上限" }],
    });
    const v2 = protoVersion({ id: "pv-2", version: 2, marks: [] });
    const listVersions = vi
      .fn<ListVersionsFn>()
      .mockResolvedValueOnce([v1]) // mount
      .mockResolvedValue([v2, v1]); // poll after regenerate
    const generatePrototype = vi.fn<GenerateFn>().mockResolvedValue({
      version: v2,
      task: requirement({ id: "child-1", stage: 1 }),
    });
    renderPanel({ listVersions, generatePrototype });

    const btn = await screen.findByTestId("proto-generate");
    fireEvent.click(btn);
    await screen.findByTestId("proto-ver-2");

    expect(generatePrototype).toHaveBeenCalledTimes(1);
    const [, body] = generatePrototype.mock.calls[0]!;
    expect(body.marks).toEqual([{ detail_id: "d1", verdict: "no", note: "重试上限" }]);
  });
});
