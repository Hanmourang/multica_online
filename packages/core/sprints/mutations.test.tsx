// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// 迭代 mutations 单测（spec 02_迭代模块.md §G：core mutations 覆盖）。
// 锁三件事：api 委托参数、onSettled 的缓存失效片（sprint 片 + issue 行内嵌
// sprint_id 的 issue 缓存）、CAS 409 失败路径依然失效（UI 收敛到赢家状态）。

vi.mock("../hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("../api", () => ({
  api: {
    createProjectSprint: vi.fn(async () => ({ id: "s1" })),
    updateProjectSprint: vi.fn(async () => ({ id: "s1" })),
    deleteProjectSprint: vi.fn(async () => ({})),
    startProjectSprint: vi.fn(async () => ({ id: "s1" })),
    completeProjectSprint: vi.fn(async () => ({ id: "s1" })),
    reopenProjectSprint: vi.fn(async () => ({ id: "s1" })),
    assignSprintIssues: vi.fn(async () => ({})),
    removeSprintIssues: vi.fn(async () => ({})),
  },
}));

import { api } from "../api";
import {
  useAssignSprintIssues,
  useCompleteSprint,
  useCreateSprint,
  useRemoveSprintIssues,
} from "./mutations";

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { qc, invalidate, wrapper: Wrapper };
}

describe("sprint mutations", () => {
  it("useCreateSprint delegates to api and invalidates the sprint + issue slices", async () => {
    const { invalidate, wrapper } = makeWrapper();
    const { result } = renderHook(() => useCreateSprint("p1"), { wrapper });

    await result.current.mutateAsync({ name: "Sprint 01" });

    expect(api.createProjectSprint).toHaveBeenCalledWith("p1", { name: "Sprint 01" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sprints", "ws-1", "p1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["issues", "ws-1"] });
  });

  it("state transitions hit the CAS endpoints with just the sprint id", async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useCompleteSprint("p1"), { wrapper });

    await result.current.mutateAsync("s1");

    expect(api.completeProjectSprint).toHaveBeenCalledWith("p1", "s1");
  });

  it("CAS conflict (409) still settles into invalidation so the UI converges", async () => {
    vi.mocked(api.completeProjectSprint).mockRejectedValueOnce({ code: "sprint_not_active" });
    const { invalidate, wrapper } = makeWrapper();
    const { result } = renderHook(() => useCompleteSprint("p1"), { wrapper });

    await expect(result.current.mutateAsync("s1")).rejects.toMatchObject({
      code: "sprint_not_active",
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sprints", "ws-1", "p1"] });
  });

  it("batch assign / remove pass issue id arrays through", async () => {
    const { wrapper } = makeWrapper();
    const assign = renderHook(() => useAssignSprintIssues("p1"), { wrapper });
    await assign.result.current.mutateAsync({ sprintId: "s1", issueIds: ["i1", "i2"] });
    expect(api.assignSprintIssues).toHaveBeenCalledWith("p1", "s1", ["i1", "i2"]);

    const remove = renderHook(() => useRemoveSprintIssues("p1"), { wrapper });
    await remove.result.current.mutateAsync({ sprintId: "s1", issueIds: ["i1"] });
    expect(api.removeSprintIssues).toHaveBeenCalledWith("p1", "s1", ["i1"]);
  });
});
