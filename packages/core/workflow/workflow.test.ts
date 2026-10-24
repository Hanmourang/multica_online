// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { workflowKeys, workflowInstancesOptions, workflowTemplatesOptions } from "./queries";
import {
  onWorkflowGateDecided,
  onWorkflowInstanceState,
  onWorkflowTemplateChanged,
  workflowActiveRefetchInterval,
} from "./ws-updaters";
import type { WorkflowInstanceDetailResponse } from "../types";

// plan 20261024 §01 F2/V9：key 工厂 + WS updater 的缓存收敛语义单测。
// 铁律 2 的机器背书：WS 事件只 patch/invalidate React Query，本文件同时
// 证明 updater 不依赖任何 store（纯 QueryClient 入参即可运行）。

describe("workflowKeys", () => {
  it("nests everything under wsId so a workspace switch invalidates wholesale", () => {
    expect(workflowKeys.all("ws1")).toEqual(["workflow", "ws1"]);
    expect(workflowKeys.project("ws1", "p1")).toEqual(["workflow", "ws1", "p1"]);
    expect(workflowKeys.templates("ws1", "p1")).toEqual([
      "workflow",
      "ws1",
      "p1",
      "templates",
    ]);
  });

  it("serializes list filters into the key — the key IS the request contract", () => {
    expect(workflowKeys.instances("ws1", "p1", { scope: "mine", status: ["running"] })).toEqual([
      "workflow",
      "ws1",
      "p1",
      "instances",
      { scope: "mine", status: ["running"] },
    ]);
    expect(workflowKeys.instances("ws1", "p1")).toEqual([
      "workflow",
      "ws1",
      "p1",
      "instances",
      {},
    ]);
  });

  it("scopes the issue reverse-lookup slice under the workspace (plan §G)", () => {
    expect(workflowKeys.instancesByIssue("ws1", "i1")).toEqual([
      "workflow",
      "ws1",
      "issue",
      "i1",
      "instances",
    ]);
  });
});

describe("query options enabled guards", () => {
  it("stays disabled until wsId and id are both present", () => {
    expect(workflowTemplatesOptions("", "p1").enabled).toBe(false);
    expect(workflowTemplatesOptions("ws1", "p1").enabled).toBe(true);
    expect(workflowInstancesOptions("ws1", "", {}).enabled).toBe(false);
  });
});

function detailFixture(status = "running"): WorkflowInstanceDetailResponse {
  const now = "2026-10-24T00:00:00Z";
  return {
    instance: {
      id: "i1",
      workspace_id: "ws1",
      project_id: "p1",
      template_id: "t1",
      template_version: 1,
      root_issue_id: null,
      sprint_id: null,
      workitem_snapshot: {},
      status: status as WorkflowInstanceDetailResponse["instance"]["status"],
      started_by_type: "member",
      started_by_id: "u1",
      triggered_at: now,
      completed_at: now,
      created_at: now,
      updated_at: now,
    },
    stages: [],
    gates: [],
  };
}

describe("onWorkflowInstanceState", () => {
  it("patches the cached detail in place and invalidates the ws-wide prefix", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    qc.setQueryData(workflowKeys.instance("ws1", "i1"), detailFixture("running"));

    onWorkflowInstanceState(qc, "ws1", { instance_id: "i1", status: "paused", source: "test" });

    const patched = qc.getQueryData<WorkflowInstanceDetailResponse>(
      workflowKeys.instance("ws1", "i1"),
    );
    expect(patched?.instance.status).toBe("paused");
    // 就地 patch 不 refetch 详情本体（key 命中），invalidate 只打在 all 前缀上。
    expect(invalidate).toHaveBeenCalledWith({ queryKey: workflowKeys.all("ws1") });
  });

  it("is a no-op without wsId or payload instance id", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    onWorkflowInstanceState(qc, "", { instance_id: "i1", status: "done", source: "x" });
    onWorkflowInstanceState(qc, "ws1", { instance_id: "", status: "done", source: "x" });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("still invalidates when the detail is not cached (list rows converge via refetch)", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    onWorkflowInstanceState(qc, "ws1", { instance_id: "i2", status: "failed", source: "s" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: workflowKeys.all("ws1") });
  });
});

describe("onWorkflowGateDecided / onWorkflowTemplateChanged", () => {
  it("gate decision busts the owning instance detail plus the ws prefix", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    onWorkflowGateDecided(qc, "ws1", {
      gate_id: "g1",
      instance_id: "i1",
      stage_run_id: "s1",
      decision: "loop",
      round: 2,
      generation: 3,
      status: "running",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: workflowKeys.instance("ws1", "i1"),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: workflowKeys.all("ws1") });
  });

  it("template_changed only invalidates (no row payload to patch)", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    onWorkflowTemplateChanged(qc, "ws1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: workflowKeys.all("ws1") });
    onWorkflowTemplateChanged(qc, "");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("workflowActiveRefetchInterval", () => {
  it("polls only active instances and stops on terminal / unknown states", () => {
    expect(workflowActiveRefetchInterval("waiting")).toBe(30_000);
    expect(workflowActiveRefetchInterval("running")).toBe(30_000);
    expect(workflowActiveRefetchInterval("paused")).toBe(false);
    expect(workflowActiveRefetchInterval("done")).toBe(false);
    expect(workflowActiveRefetchInterval(undefined)).toBe(false);
  });
});
