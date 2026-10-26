// @vitest-environment jsdom

/**
 * 可视化画布的富结构渲染验收（plan 20261025 §A3/§A-5）：导入的富模板 definition
 * 必须在 visual TAB 同时出现——紫边迭代含 GATE、蓝边并行、目标行、产物 chips。
 * 这是"不像原型"最大观感差距的自动化兜底（浏览器冒烟被禁时的等价证据）。
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { WorkflowDefinition } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";
import { FlowCanvas } from "./flow-canvas";

const RICH_DEF = {
  schemaVersion: 1,
  kind: "coco.workflow.template",
  name: "需求日历 CoCo 富模板",
  description: "",
  roleNames: { "r-design": "方案设计·小艺" },
  nodes: [
    {
      kind: "iteration",
      id: "iter1",
      name: "方案迭代",
      gate: { id: "g1", mode: "human_loop", loopLabel: "再来一轮", exitLabel: "进入开发" },
      children: [
        {
          kind: "stage",
          id: "s2",
          name: "方案设计",
          mode: "human_loop",
          roleId: "r-design",
          goal: "确定技术方案与架构边界",
          inputs: [{ outputName: "交互原型", assetRole: "in", required: true }],
          outputs: [{ id: "tech-design", name: "技术方案", type: "markdown" }],
        },
      ],
    },
    {
      kind: "parallel",
      id: "par1",
      name: "并行实现",
      children: [
        {
          kind: "branch",
          id: "br1",
          name: "前端",
          children: [
            {
              kind: "stage",
              id: "s4",
              name: "前端实现",
              mode: "auto",
              goal: "完成前端功能实现",
              outputs: [{ id: "fe-delivery", name: "前端交付", type: "json" }],
            },
          ],
        },
      ],
    },
  ],
} as unknown as WorkflowDefinition;

function renderCanvas(readOnly: boolean) {
  return renderWithI18n(
    <FlowCanvas def={RICH_DEF} readOnly={readOnly} onChange={vi.fn()} />,
  );
}

// 卡片外层容器与内层 span 的 textContent 相同，getByText 会双重命中；统一用存在性断言。
function expectText(text: string | RegExp) {
  expect(screen.getAllByText(text).length).toBeGreaterThan(0);
}

// 迭代 / 并行 / GATE / 目标 / 产物 chips 在可编辑与只读两种形态下都必须出现。
describe.each([
  ["可编辑态", false],
  ["只读态", true],
])("FlowCanvas 富结构（%s）", (_name, readOnly) => {
  it("A-5：迭代块显示名称并带出审批门标签", async () => {
    renderCanvas(readOnly);
    await waitFor(() => expectText("方案迭代"));
    // gate 的 loopLabel 优先作为门徽章文案。
    expectText("再来一轮");
  });

  it("A-5：并行块与其分支子阶段一并渲染", () => {
    renderCanvas(readOnly);
    expectText("并行实现");
    expectText("前端");
    expectText(/前端实现/);
  });

  it("A-5：阶段目标行与产物 chips 出现", () => {
    renderCanvas(readOnly);
    expectText("确定技术方案与架构边界");
    expectText("技术方案");
    expectText("前端交付");
  });
});
