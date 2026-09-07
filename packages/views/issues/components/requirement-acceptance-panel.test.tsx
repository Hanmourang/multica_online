/**
 * @vitest-environment jsdom
 *
 * RequirementAcceptancePanel（spec 画面 7）：验收阶段面板 —— 验收轮次、stage4 tester
 * 报告清单、stage3 打回链、pass/fail 人工仲裁（evidence 必填，调注入的
 * submitAcceptanceVerdict）；round>3 渲染验收失败仲裁 banner。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { RequirementAcceptancePanel } from "./requirement-acceptance-panel";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function requirement(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "req-1",
    identifier: "REQ-101",
    acceptance_round: 0,
    requirement_status: "验收中",
    ...overrides,
  } as unknown as Issue;
}

function child(id: string, stage: number, status: string): Issue {
  return { id, identifier: `REQ-${id}`, title: `子任务 ${id}`, stage, status } as unknown as Issue;
}

describe("RequirementAcceptancePanel", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("渲染轮次 + stage4 验收报告 + stage3 打回链", () => {
    renderWithI18n(
      <RequirementAcceptancePanel
        issue={requirement({ acceptance_round: 1 })}
        childIssues={[child("t1", 4, "todo"), child("r1", 3, "done")]}
        submitAcceptanceVerdict={vi.fn()}
      />,
    );
    expect(screen.getByTestId("acceptance-report-blocks")).toBeTruthy();
    expect(screen.getByTestId("acceptance-round").textContent).toContain("1");
    expect(screen.getByTestId("acceptance-tester-t1")).toBeTruthy();
    expect(screen.getByTestId("acceptance-repair-r1")).toBeTruthy();
  });

  it("round>3 渲染验收失败仲裁 banner", () => {
    renderWithI18n(
      <RequirementAcceptancePanel
        issue={requirement({ acceptance_round: 4 })}
        childIssues={[]}
        submitAcceptanceVerdict={vi.fn()}
      />,
    );
    expect(screen.getByTestId("acceptance-failed-banner")).toBeTruthy();
  });

  it("验收失败终态（round>3）：即使填了 evidence，pass/fail 仍禁用（前端校验，服务端另有守卫）", () => {
    renderWithI18n(
      <RequirementAcceptancePanel
        issue={requirement({ acceptance_round: 4 })}
        childIssues={[]}
        submitAcceptanceVerdict={vi.fn()}
      />,
    );
    expect(screen.getByTestId("acceptance-failed-banner")).toBeTruthy();
    fireEvent.change(screen.getByTestId("acceptance-evidence"), { target: { value: "仲裁证据" } });
    expect((screen.getByTestId("acceptance-pass") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("acceptance-fail") as HTMLButtonElement).disabled).toBe(true);
  });

  it("evidence 为空时 pass/fail 均禁用", () => {
    renderWithI18n(
      <RequirementAcceptancePanel issue={requirement()} childIssues={[]} submitAcceptanceVerdict={vi.fn()} />,
    );
    expect((screen.getByTestId("acceptance-pass") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("acceptance-fail") as HTMLButtonElement).disabled).toBe(true);
  });

  it("填 evidence 后点 pass 调用 submitAcceptanceVerdict(pass)", async () => {
    const submit = vi.fn().mockResolvedValue({ verdict: "pass", acceptance_round: 0, terminal: true });
    renderWithI18n(
      <RequirementAcceptancePanel issue={requirement()} childIssues={[]} submitAcceptanceVerdict={submit} />,
    );
    fireEvent.change(screen.getByTestId("acceptance-evidence"), { target: { value: "全部用例通过" } });
    fireEvent.click(screen.getByTestId("acceptance-pass"));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith("req-1", { verdict: "pass", evidence: "全部用例通过" }),
    );
  });

  it("点 fail 调用 submitAcceptanceVerdict(fail) 并带 evidence", async () => {
    const submit = vi
      .fn()
      .mockResolvedValue({ verdict: "fail", acceptance_round: 1, terminal: false, repair_issue_id: "r2" });
    renderWithI18n(
      <RequirementAcceptancePanel issue={requirement()} childIssues={[]} submitAcceptanceVerdict={submit} />,
    );
    fireEvent.change(screen.getByTestId("acceptance-evidence"), { target: { value: "用例 c1 失败" } });
    fireEvent.click(screen.getByTestId("acceptance-fail"));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith("req-1", { verdict: "fail", evidence: "用例 c1 失败" }),
    );
  });

  it("裁决被拒时 toast 服务端原因", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("invalid verdict"));
    renderWithI18n(
      <RequirementAcceptancePanel issue={requirement()} childIssues={[]} submitAcceptanceVerdict={submit} />,
    );
    fireEvent.change(screen.getByTestId("acceptance-evidence"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("acceptance-pass"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("invalid verdict"));
  });
});
