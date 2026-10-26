// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@multica/core/types";
import {
  blankDefinition,
  addChildNode,
  addRequiredAsset,
  addStageInput,
  addTopNode,
  countBlocks,
  countStages,
  definitionFromLinearNodes,
  definitionFromTemplate,
  flattenGates,
  flattenStagesWithGroup,
  genNodeId,
  isRequiredAsset,
  listStageOutputs,
  moveNode,
  moveNodeTo,
  parseDefinition,
  removeInputAt,
  removeNode,
  roleName,
  setRoleName,
  setInputRequired,
  setStageField,
  stageGateDocTypes,
  stageNameById,
  stageRequiredAssets,
  validateCocoDefinition,
} from "./coco";

/**
 * 编辑器 JSON 前校验拦截（plan 20261024 §6 P0）的纯逻辑覆盖。服务端
 * service.ValidateWorkflowDefinition 是最终事实源，这里只锁住前端镜像的
 * 结构规则子集：重复 id / 非法 kind / gate 仅挂 iteration / 未知 fromStageId。
 */

function coco(nodes: WorkflowDefinition["nodes"]): WorkflowDefinition {
  return { schemaVersion: 2, kind: "coco.workflow.template", name: "t", description: "", nodes };
}

describe("blankDefinition", () => {
  it("is a valid single-stage skeleton", () => {
    expect(validateCocoDefinition(blankDefinition("Demo"))).toEqual([]);
  });
});

describe("validateCocoDefinition", () => {
  it("rejects a non-positive schemaVersion", () => {
    const errors = validateCocoDefinition({ ...coco([{ kind: "stage", id: "s1", name: "n" }]), schemaVersion: 0 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a flat single stage", () => {
    expect(validateCocoDefinition(coco([{ kind: "stage", id: "s1", name: "Stage", mode: "auto" }]))).toEqual([]);
  });

  it("flags duplicate node ids", () => {
    const errors = validateCocoDefinition(
      coco([
        { kind: "stage", id: "dup", name: "A" },
        { kind: "stage", id: "dup", name: "B" },
      ]),
    );
    expect(errors.some((e) => e.includes("dup"))).toBe(true);
  });

  it("flags an unknown node kind", () => {
    const errors = validateCocoDefinition(coco([{ kind: "weird" as never, id: "s1", name: "A" }]));
    expect(errors.some((e) => e.includes("kind"))).toBe(true);
  });

  it("flags a gate on a non-iteration node", () => {
    const errors = validateCocoDefinition(
      coco([{ kind: "stage", id: "s1", name: "A", gate: { id: "g1" } }]),
    );
    expect(errors.some((e) => e.includes("gate"))).toBe(true);
  });

  it("flags an input referencing an unknown fromStageId", () => {
    const errors = validateCocoDefinition(
      coco([
        { kind: "stage", id: "s1", name: "A" },
        { kind: "stage", id: "s2", name: "B", inputs: [{ fromStageId: "ghost" }] },
      ]),
    );
    expect(errors.some((e) => e.includes("ghost"))).toBe(true);
  });

  it("accepts a valid iteration with a gate over two stages", () => {
    const def = coco([
      {
        kind: "iteration",
        id: "it1",
        name: "Loop",
        gate: { id: "g1" },
        children: [
          { kind: "stage", id: "s1", name: "A", mode: "human_loop" },
          { kind: "stage", id: "s2", name: "B", inputs: [{ fromStageId: "s1" }] },
        ],
      },
    ]);
    expect(validateCocoDefinition(def)).toEqual([]);
  });

  it("rejects an empty nodes array", () => {
    expect(validateCocoDefinition(coco([])).length).toBeGreaterThan(0);
  });
});

describe("parseDefinition", () => {
  it("throws on a non-object payload", () => {
    expect(() => parseDefinition("[]")).toThrow();
    expect(() => parseDefinition("not json")).toThrow();
  });

  it("round-trips valid JSON", () => {
    const text = JSON.stringify(blankDefinition("X"));
    expect(parseDefinition(text).kind).toBe("coco.workflow.template");
  });
});

describe("countStages", () => {
  it("counts nested stages and gates", () => {
    const def = coco([
      {
        kind: "iteration",
        id: "it1",
        name: "Loop",
        gate: { id: "g1" },
        children: [
          { kind: "stage", id: "s1", name: "A" },
          { kind: "stage", id: "s2", name: "B" },
        ],
      },
    ]);
    expect(countStages(def)).toEqual({ stages: 2, gates: 1 });
  });
});

// 真实 CoCo 嵌套结构（iteration+gate / parallel+branch / 跨层输入 / roleNames），
// 锁住可视化编辑器所依赖的派生辅助函数。
function realDef(): WorkflowDefinition {
  return {
    schemaVersion: 2,
    kind: "coco.workflow.template",
    name: "前后端开发流程",
    description: "",
    nodes: [
      {
        kind: "iteration",
        id: "i1",
        name: "需求&编码&验证",
        gate: { id: "g10", mode: "auto", loopLabel: "再来一轮", exitLabel: "结束迭代" },
        children: [
          { kind: "stage", id: "s1", name: "需求澄清与方案设计", mode: "human_loop", roleId: "r-req", outputs: [{ id: "o1", name: "spec.md", type: "markdown" }] },
          { kind: "stage", id: "s2", name: "编码", mode: "auto", roleId: "r-code", inputs: [{ fromStageId: "s1", outputId: "o1", outputName: "spec.md" }] },
        ],
      },
      {
        kind: "parallel",
        id: "p6",
        name: "线上部署",
        children: [
          { kind: "branch", id: "b1", name: "Aone后端部署", children: [{ kind: "stage", id: "s6", name: "Aone后端部署", mode: "human_loop", roleId: "r-aone" }] },
          { kind: "branch", id: "b2", name: "O2应用线上部署", children: [{ kind: "stage", id: "s7", name: "O2应用线上部署", mode: "human_loop", roleId: "r-o2" }] },
        ],
      },
      { kind: "stage", id: "s9", name: "工作项归档", mode: "human_loop", roleId: "r-a1" },
    ],
    roleNames: { "r-req": "需求澄清Agent", "r-code": "编码Agent", "r-aone": "Aone部署Agent", "r-o2": "O2部署Agent", "r-a1": "A1通用Agent" },
  };
}

describe("visual editor helpers", () => {
  it("countBlocks tallies stages/gates/iterations/parallels", () => {
    expect(countBlocks(realDef())).toEqual({ stages: 5, gates: 1, iterations: 1, parallels: 1 });
  });

  it("flattenStagesWithGroup tags each stage with its nearest container + index", () => {
    const list = flattenStagesWithGroup(realDef());
    expect(list.map((s) => s.node.id)).toEqual(["s1", "s2", "s6", "s7", "s9"]);
    expect(list.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
    // 迭代内 stage 归迭代名；并行分支内 stage 归最近 branch 名；顶层 stage 无分组。
    expect(list.find((s) => s.node.id === "s1")?.group).toBe("需求&编码&验证");
    expect(list.find((s) => s.node.id === "s6")?.group).toBe("Aone后端部署");
    expect(list.find((s) => s.node.id === "s9")?.group).toBeNull();
  });

  it("flattenGates collects iteration gates", () => {
    const gates = flattenGates(realDef());
    expect(gates).toHaveLength(1);
    expect(gates[0]?.iteration.id).toBe("i1");
    expect(gates[0]?.gate.exitLabel).toBe("结束迭代");
  });

  it("roleName resolves agent display from roleNames map", () => {
    const def = realDef();
    expect(roleName(def, "r-req")).toBe("需求澄清Agent");
    expect(roleName(def, "missing")).toBe("");
    expect(roleName(def, undefined)).toBe("");
  });

  it("stageNameById resolves upstream refs and falls back to id", () => {
    const def = realDef();
    expect(stageNameById(def, "s1")).toBe("需求澄清与方案设计");
    expect(stageNameById(def, "unknown")).toBe("unknown");
  });

  it("real definition passes structural validation", () => {
    expect(validateCocoDefinition(realDef())).toEqual([]);
  });
});

// 结构性编辑纯函数：可视化块树的增删/移动/连线/智能体名维护。
describe("structural editing", () => {
  it("addTopNode appends a valid stage / iteration / parallel", () => {
    const base = realDef();
    const withStage = addTopNode(base, "stage");
    expect(withStage.nodes).toHaveLength(base.nodes.length + 1);
    expect(validateCocoDefinition(withStage)).toEqual([]);

    const iter = addTopNode(base, "iteration");
    const added = iter.nodes[iter.nodes.length - 1];
    expect(added?.kind).toBe("iteration");
    expect(added?.gate?.id).toBeTruthy();
    expect(added?.children?.[0]?.kind).toBe("stage");
    expect(validateCocoDefinition(iter)).toEqual([]);

    const par = addTopNode(base, "parallel");
    const p = par.nodes[par.nodes.length - 1];
    expect(p?.kind).toBe("parallel");
    expect(p?.children?.[0]?.kind).toBe("branch");
    expect(validateCocoDefinition(par)).toEqual([]);
  });

  it("addChildNode inserts into a container's children", () => {
    const base = realDef();
    const i1 = base.nodes[0];
    const before = i1?.children?.length ?? 0;
    const next = addChildNode(base, "i1", "stage");
    const after = next.nodes[0]?.children?.length ?? 0;
    expect(after).toBe(before + 1);
    expect(validateCocoDefinition(next)).toEqual([]);
  });

  it("removeNode drops the node and cascades dangling input refs", () => {
    const base = realDef();
    // s2.inputs 引用 s1 的产物；删 s1 后应清理悬空 fromStageId。
    const next = removeNode(base, "s1");
    const s2 = next.nodes[0]?.children?.find((n) => n.id === "s2");
    expect(s2?.inputs ?? []).toEqual([]);
    expect(stageNameById(next, "s1")).toBe("s1"); // gone → fallback id
    expect(validateCocoDefinition(next)).toEqual([]);
  });

  it("moveNode swaps siblings and is a no-op at the boundary", () => {
    const base = realDef(); // top-level order: i1, p6, s9
    expect(moveNode(base, "p6", "up").nodes.map((n) => n.id)).toEqual(["p6", "i1", "s9"]);
    expect(moveNode(base, "i1", "up").nodes.map((n) => n.id)).toEqual(["i1", "p6", "s9"]);
  });

  it("moveNodeTo moves a stage across containers and guards cycles", () => {
    const base = realDef();
    // 把顶层 s9 移进迭代 i1 末尾。
    const moved = moveNodeTo(base, "s9", "i1", 99);
    expect(moved.nodes.map((n) => n.id)).toEqual(["i1", "p6"]); // s9 不再在顶层
    expect(moved.nodes[0]?.children?.map((c) => c.id)).toEqual(["s1", "s2", "s9"]);
    expect(validateCocoDefinition(moved)).toEqual([]);
    // 自环防护：把迭代 i1 移入其子 stage s1 内 → 无效，原样返回。
    expect(moveNodeTo(base, "i1", "s1", 0).nodes.map((n) => n.id)).toEqual(["i1", "p6", "s9"]);
    // 移到顶层下标 0。
    expect(moveNodeTo(base, "s9", null, 0).nodes.map((n) => n.id)).toEqual(["s9", "i1", "p6"]);
  });

  it("addStageInput wires an upstream output onto a stage", () => {
    const base = realDef();
    const next = addStageInput(base, "s2", { fromStageId: "s9", outputId: "ox", outputName: "archive.md" });
    const s2 = next.nodes[0]?.children?.find((n) => n.id === "s2");
    expect(s2?.inputs?.some((i) => i.fromStageId === "s9")).toBe(true);
    expect(validateCocoDefinition(next)).toEqual([]);
  });

  it("setRoleName adds then removes a role mapping", () => {
    const base = realDef();
    const named = setRoleName(base, "r-new", "新智能体");
    expect(roleName(named, "r-new")).toBe("新智能体");
    const cleared = setRoleName(named, "r-new", "  ");
    expect(cleared.roleNames?.["r-new"]).toBeUndefined();
  });

  it("listStageOutputs excludes self and surfaces upstream artifacts", () => {
    const base = realDef();
    const list = listStageOutputs(base, "s2");
    expect(list.some((s) => s.stageId === "s2")).toBe(false);
    const s1 = list.find((s) => s.stageId === "s1");
    expect(s1?.outputs).toEqual([{ id: "o1", name: "spec.md" }]);
  });

  it("genNodeId avoids collisions with existing node and gate ids", () => {
    const base = realDef();
    expect(genNodeId(base, "stage")).not.toBe("s1");
    expect(genNodeId(base, "gate")).not.toBe("g10");
  });
});

describe("linear nodes <-> CoCo definition adapter", () => {
  // 需求日历 official 模板的真实线性形态（存在 workflow_template.nodes 列）。
  const calendar = [
    { id: "s1", name: "原型", mode: "human" as const, stage: 1, next: ["s2"], inputs: [], outputs: [], gate_doc_types: ["prototype"] },
    { id: "s2", name: "拆解", mode: "human" as const, stage: 2, next: ["s3"], inputs: [], outputs: [], gate_doc_types: ["plan"] },
    { id: "s3", name: "执行", mode: "auto" as const, stage: 3, next: ["s4"], inputs: [], outputs: [], gate_doc_types: ["design"] },
    { id: "s4", name: "验收", mode: "human" as const, stage: 4, next: [], inputs: [], outputs: [], gate_doc_types: ["acceptance"] },
  ];

  it("expands legacy linear nodes into a valid CoCo definition", () => {
    const def = definitionFromLinearNodes(calendar, { name: "需求日历标准流水线" });
    expect(validateCocoDefinition(def)).toEqual([]);
    expect(def.kind).toBe("coco.workflow.template");
    expect(def.nodes.map((n) => n.id)).toEqual(["s1", "s2", "s3", "s4"]);
    // mode 映射：human→human_loop，auto 保留。
    expect(def.nodes[0]?.mode).toBe("human_loop");
    expect(def.nodes[2]?.mode).toBe("auto");
    // DAG 重建：s2 的前驱是 s1（s1.next 含 s2）；s2 的 gate_doc_types=["plan"] 另展开为 required in-input。
    expect(def.nodes[1]?.inputs).toEqual([
      { fromStageId: "s1" },
      { outputName: "plan", assetRole: "in", required: true },
    ]);
    // s1 无前驱，但 gate_doc_types=["prototype"] → 一条 required in-input。
    expect(def.nodes[0]?.inputs).toEqual([{ outputName: "prototype", assetRole: "in", required: true }]);
  });

  it("definitionFromTemplate prefers nested definition over linear nodes", () => {
    const nested = coco([{ kind: "stage", id: "a", name: "A", mode: "auto", inputs: [], outputs: [] }]);
    expect(definitionFromTemplate({ name: "x", nodes: calendar, definition: nested })).toBe(nested);
  });

  it("definitionFromTemplate expands from nodes when definition column is empty", () => {
    const def = definitionFromTemplate({ name: "日历", description: "d", nodes: calendar, definition: {} });
    expect(def.nodes).toHaveLength(4);
    expect(def.name).toBe("日历");
    expect(validateCocoDefinition(def)).toEqual([]);
  });

  it("definitionFromTemplate falls back to a blank skeleton when both empty", () => {
    const def = definitionFromTemplate({ name: "新", nodes: [], definition: {} });
    expect(def.nodes).toHaveLength(1);
    expect(def.nodes[0]?.name).toBe("阶段 1");
  });
});

describe("资产准入 + 目标/模板纯函数（plan 101 C3/C4/C5）", () => {
  const linear = [
    { id: "s1", name: "原型", mode: "auto" as const, stage: 1, next: ["s2"], inputs: [], outputs: [], gate_doc_types: ["prototype"] },
    { id: "s2", name: "编码", mode: "auto" as const, stage: 2, next: [], inputs: [], outputs: [], gate_doc_types: ["architecture", "acceptance"] },
  ];

  it("definitionFromLinearNodes 把 gate_doc_types 展开为 required in-input", () => {
    const def = definitionFromLinearNodes(linear);
    const s2 = def.nodes[1]!;
    const req = (s2.inputs ?? []).filter(isRequiredAsset);
    expect(req.map((i) => i.outputName).sort()).toEqual(["acceptance", "architecture"]);
    expect(req.every((i) => i.assetRole === "in" && i.required === true)).toBe(true);
  });

  it("stageGateDocTypes 与 stageRequiredAssets 回读一致", () => {
    const def = definitionFromLinearNodes(linear);
    expect(stageRequiredAssets(def, "s2")).toHaveLength(2);
    expect(stageGateDocTypes(def, "s2").sort()).toEqual(["acceptance", "architecture"]);
  });

  it("addRequiredAsset / removeInputAt / setInputRequired 不可变且可回环", () => {
    const def = definitionFromLinearNodes(linear);
    const added = addRequiredAsset(def, "s1", "spec");
    expect(added).not.toBe(def);
    expect(stageGateDocTypes(added, "s1")).toEqual(["prototype", "spec"]);
    const toggled = setInputRequired(added, "s1", 0, false);
    expect(stageGateDocTypes(toggled, "s1")).toEqual(["spec"]);
    const removed = removeInputAt(added, "s1", 1);
    expect(stageGateDocTypes(removed, "s1")).toEqual(["prototype"]);
  });

  it("setStageField 只覆盖传入键、不动其他", () => {
    const def = definitionFromLinearNodes(linear);
    const next = setStageField(def, "s2", { goal: "完成编码", criteria: "分支已 push" });
    expect(next.nodes[1]?.goal).toBe("完成编码");
    expect(next.nodes[1]?.criteria).toBe("分支已 push");
    expect(next.nodes[1]?.name).toBe("编码");
    expect(next.nodes[0]?.goal).toBeUndefined();
  });

  it("准入映射后仍通过结构校验", () => {
    const def = addRequiredAsset(definitionFromLinearNodes(linear), "s2", "code-app-info");
    expect(validateCocoDefinition(def)).toEqual([]);
  });
});
