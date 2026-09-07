/**
 * @vitest-environment jsdom
 *
 * Decomposition confirm panel (spec画面 5): left column renders the
 * requirement basics (identifier / module / repo / minute window / roster /
 * goal) plus the PM plan; right column lists draft cards with the
 * feature-point table (new/modify tags), graph + acceptance summaries,
 * assignee fine-tuning limited to enabled roster members, and dependency
 * chips. The confirm button is disabled with a red hint while any exec
 * feature point lacks a kind; on confirm the panel calls the confirm API and
 * shows the materialized children.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Issue, RoleAssignment } from "@multica/core/types";
import type { DecomposeDraftTask } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { RequirementDecomposePanel } from "./requirement-decompose-panel";

// Actor names resolve via workspace hooks; stub to the raw id suffix so roster
// chips and assignee options stay assertable.
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
    due_date: "2026-09-12",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    goal: "把积分规则引擎化",
    start_at: "2026-09-10T09:30:00Z",
    decompose_mode: "confirm",
    module_id: "mod-1",
    ...overrides,
  } as unknown as Issue;
}

const ROSTER: RoleAssignment[] = [
  { id: "r1", role: "pm", assignee_type: "member", assignee_id: "u-pm", enabled: true, ordinal: 0 },
  { id: "r2", role: "developer", assignee_type: "member", assignee_id: "u-dev", enabled: true, ordinal: 1 },
  { id: "r3", role: "developer", assignee_type: "member", assignee_id: "u-dev2", enabled: false, ordinal: 2 },
  { id: "r4", role: "tester", assignee_type: "member", assignee_id: "u-test", enabled: true, ordinal: 3 },
  { id: "r5", role: "prototyper", assignee_type: "agent", assignee_id: "a-proto", enabled: true, ordinal: 4 },
];

function execDraft(tempId: string, title: string, overrides: Partial<DecomposeDraftTask> = {}): DecomposeDraftTask {
  return {
    temp_id: tempId,
    title,
    stage: 3,
    assignee_type: "member",
    assignee_id: "u-dev",
    feature_points: [
      { title: `${title} fp`, kind: "modify", code_objects: ["server/internal/x.go"] },
    ],
    graph_context: { nodes: ["n1"], edges: [] },
    acceptance_spec: { version: 1, cases: [{ name: "c1" }] },
    ...overrides,
  };
}

function materialized(title: string, n: number): Issue {
  return requirement({ id: `child-${n}`, identifier: `REQ-10${n + 1}`, title, stage: 3 });
}

interface RenderOptions {
  drafts?: DecomposeDraftTask[];
  confirm?: (issueId: string, drafts: DecomposeDraftTask[]) => Promise<Issue[]>;
}

function renderPanel(opts: RenderOptions = {}) {
  const drafts = opts.drafts ?? [
    execDraft("t1", "账户模型扩展"),
    execDraft("t2", "积分规则引擎", { feature_points: [{ title: "规则引擎", kind: "new", code_objects: [] }], depends_on: ["t1"] }),
    { temp_id: "t3", title: "整体验收", stage: 4, depends_on: ["t2"] } as DecomposeDraftTask,
  ];
  const confirm = opts.confirm ?? vi.fn().mockResolvedValue([
    materialized("账户模型扩展", 1),
    materialized("积分规则引擎", 2),
    materialized("整体验收", 3),
  ]);
  renderWithI18n(
    <RequirementDecomposePanel
      issue={requirement()}
      moduleName="内核"
      repoLabel="multica/app"
      roster={ROSTER}
      plan="先做账户模型，再落地规则引擎。"
      drafts={drafts}
      onDraftsChange={() => {}}
      confirmDecomposition={confirm}
    />,
  );
  return { confirm };
}

describe("RequirementDecomposePanel", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("左栏渲染需求基础信息 kv + plan", () => {
    renderPanel();
    const kv = screen.getByTestId("decompose-kv");
    expect(within(kv).getByText("REQ-101")).toBeTruthy();
    expect(within(kv).getByText("内核")).toBeTruthy();
    expect(within(kv).getByText("multica/app")).toBeTruthy();
    // Minute-granularity window: start_at 09:30 UTC ~ due_date.
    expect(kv.textContent).toMatch(/09:30/);
    // Roster chips list enabled role members.
    const roster = screen.getByTestId("decompose-kv-roster");
    expect(roster.textContent).toContain("actor-u-pm");
    expect(roster.textContent).toContain("actor-u-dev");
    expect(roster.textContent).not.toContain("actor-u-dev2"); // disabled hidden
    expect(within(kv).getByText("把积分规则引擎化")).toBeTruthy();
    expect(screen.getByText("先做账户模型，再落地规则引擎。")).toBeTruthy();
  });

  it("草稿卡可以改标题", () => {
    const onDraftsChange = vi.fn();
    renderWithI18n(
      <RequirementDecomposePanel
        issue={requirement()}
        moduleName="内核"
        repoLabel="multica/app"
        roster={ROSTER}
        plan="先做账户模型"
        drafts={[execDraft("t1", "账户模型扩展")]}
        onDraftsChange={onDraftsChange}
        confirmDecomposition={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("draft-title-t1"), {
      target: { value: "账户模型改造" },
    });
    expect(onDraftsChange).toHaveBeenCalledWith([
      expect.objectContaining({ temp_id: "t1", title: "账户模型改造" }),
    ]);
  });

  it("子任务功能点表标注新增/改造", () => {
    renderPanel();
    const card = screen.getByTestId("draft-card-t1");
    expect(within(card).getByDisplayValue("账户模型扩展 fp")).toBeTruthy();
    expect(within(card).getByText("Modify")).toBeTruthy();
    expect(within(card).getByText("server/internal/x.go")).toBeTruthy();
    const card2 = screen.getByTestId("draft-card-t2");
    expect(within(card2).getByText("New")).toBeTruthy();
  });

  it("草稿卡渲染图谱上下文与验收代码摘要框（display-only）", () => {
    renderPanel();
    // exec 草稿 t1 带 graph_context.nodes=["n1"] 与 acceptance_spec.cases=[{name:"c1"}]。
    const gn = screen.getByTestId("draft-gn-t1");
    expect(within(gn).getByText("Graph context")).toBeTruthy();
    expect(within(gn).getByText("n1")).toBeTruthy();
    const acc = screen.getByTestId("draft-acc-t1");
    expect(within(acc).getByText("Acceptance spec")).toBeTruthy();
    expect(within(acc).getByText("c1")).toBeTruthy();
    // stage4 无图谱/规约时仍渲染区块，文案降级为档案未就绪。
    expect(screen.getByTestId("draft-gn-t3").textContent).toMatch(/not ready|未就绪|未準備|준비되지/i);
    expect(screen.getByTestId("draft-acc-t3").textContent).toMatch(/not ready|未就绪|未準備|준비되지/i);
  });

  it("splits a headed plan, flags titles missing from goals, and lets requery fire", async () => {
    const requery = vi.fn().mockResolvedValue(undefined);
    renderWithI18n(
      <RequirementDecomposePanel
        issue={requirement()}
        moduleName="内核"
        repoLabel="multica/app"
        roster={ROSTER}
        plan={"## 目标\n账户模型扩展\n## 阶段\n二期\n## 风险\n回滚"}
        drafts={[
          execDraft("t1", "账户模型扩展"),
          execDraft("t2", "完全无关的标题"),
        ]}
        onDraftsChange={() => {}}
        confirmDecomposition={vi.fn()}
        requeryGraph={requery}
      />,
    );
    expect(screen.getByTestId("decompose-plan-goals").textContent).toContain("账户模型扩展");
    expect(screen.getByTestId("draft-mismatch-t2")).toBeTruthy();
    fireEvent.click(screen.getByTestId("decompose-requery"));
    await vi.waitFor(() => expect(requery).toHaveBeenCalledTimes(1));
  });

  it("存在未标注 kind 的功能点时确认按钮禁用并提示", () => {
    renderPanel({
      drafts: [
        execDraft("t1", "账户模型扩展", {
          feature_points: [{ title: "缺标注", kind: "", code_objects: [] }],
        }),
      ],
    });
    const confirmBtn = screen.getByTestId("decompose-confirm") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(screen.getByTestId("decompose-kind-warning").textContent).toMatch(
      /new\/modify/i,
    );
  });

  it("执行人微调下拉仅列班底内启用角色成员", () => {
    renderPanel();
    const select = screen.getByTestId("draft-asg-t1") as HTMLSelectElement;
    const labels = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(labels).toContain("actor-u-pm");
    expect(labels).toContain("actor-u-dev");
    expect(labels).toContain("actor-u-test");
    expect(labels).toContain("actor-a-proto");
    expect(labels).not.toContain("actor-u-dev2"); // disabled role excluded
  });

  it("确认后调用 confirm API 并展示子任务生效结果", async () => {
    const confirm = vi.fn().mockResolvedValue([
      materialized("账户模型扩展", 1),
      materialized("积分规则引擎", 2),
      materialized("整体验收", 3),
    ]);
    renderPanel({ confirm });
    fireEvent.click(screen.getByTestId("decompose-confirm"));
    await screen.findByTestId("decompose-confirmed");

    expect(confirm).toHaveBeenCalledTimes(1);
    const [issueId, payload] = vi.mocked(confirm).mock.calls[0] as [string, DecomposeDraftTask[]];
    expect(issueId).toBe("req-1");
    expect(payload.map((d) => d.temp_id)).toEqual(["t1", "t2", "t3"]);
    expect(payload[0]?.feature_points?.[0]?.kind).toBe("modify");

    const result = screen.getByTestId("decompose-confirmed");
    expect(result.textContent).toContain("REQ-102");
    expect(result.textContent).toContain("积分规则引擎");
    expect(result.textContent).toContain("整体验收");
  });
});
