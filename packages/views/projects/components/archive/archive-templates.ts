/** SOP 模板精简起步稿，对齐 _shared/sop/templates。 */

export function renderArchiveTemplate(input: {
  docType: string;
  title: string;
  requirementKey?: string | null;
  issueId?: string | null;
}): string {
  const title = input.title.trim() || "未命名文档";
  const req = input.requirementKey?.trim() || "REQ-YYYYMMDD-NN";
  const issue = input.issueId?.trim() || "【待填写：multica issue id】";
  const today = new Date().toISOString().slice(0, 10);

  const fm = [
    "---",
    `doc_type: ${input.docType}`,
    `multica_issue_id: ${issue}`,
    "status: draft",
    `updated_at: ${today}`,
    `title: ${title}`,
    "---",
    "",
  ].join("\n");

  switch (input.docType) {
    case "requirement":
      return `${fm}# 需求单：${req} ${title}

## 状态头

> status 取值：draft / designed / reviewed / ready / approved / executing / blocked / done / accepted。

## 子需求清单

| 子需求 | 标题 | 状态 | 备注 |
|---|---|---|---|
| S1 | 【待填写】 | draft |  |

## 需求背景

【待填写：需求来源、要解决的问题、预期收益】

## 需求描述

【待填写：具体要做什么；明确边界内 / 边界外】
`;
    case "plan":
      return `${fm}# 执行计划：${title}

## 目标分解

【待填写】

## 阶段节奏

| 阶段 | 内容 | 依赖 |
|---|---|---|
| T1 | 【待填写】 |  |
`;
    case "decomposition":
      return `${fm}# 拆解明细：${title}

## 功能点

| 编号 | 标题 | 种类 | 代码对象 | 验收标准 |
|---|---|---|---|---|
| F1 | 【待填写】 | new / modify |  |  |
`;
    case "design":
      return `${fm}# 方案设计：${title}

## 目标

【待填写】

## 方案

【待填写】

## 影响评估

【待填写：模块 / 数据 / 风险】
`;
    case "test-plan":
      return `${fm}# 测试方案：${title}

## 范围

【待填写】

## 用例

| 编号 | 场景 | 步骤 | 期望 |
|---|---|---|---|
| T1 | 【待填写】 |  |  |
`;
    case "acceptance":
      return `${fm}# 验收标准：${title}

## 验收项

| 编号 | 标准 | 结论 |
|---|---|---|
| A1 | 【待填写】 | 待验 |
`;
    case "report":
      return `${fm}# 验收报告：${title}

## 结论

【待填写：通过 / 不通过】

## 逐项结论

| 编号 | 标准 | 结论 | 证据 |
|---|---|---|---|
| A1 |  |  |  |
`;
    case "architecture":
      return `${fm}# 项目架构总纲：${title}

## 能力边界

【待填写】

## 关键决策

【待填写】
`;
    case "retrospective":
      return `${fm}# 复盘：${title}

## 过程

【待填写】

## 教训

【待填写】
`;
    default:
      return `${fm}# ${title}

【待填写】
`;
  }
}
