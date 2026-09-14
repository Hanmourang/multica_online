/**
 * 从模板创建的正文必须与 projects_mgmt/_shared/format/templates 同构。
 * 改章节先改正本，再改本文件。禁止再手写一套货架目录（overview/prd、overview/mrd）。
 */

export type ArchiveTemplateInput = {
  docType: string;
  title: string;
  requirementKey?: string | null;
  issueId?: string | null;
};

export type ArchiveDocChoice = {
  value: string;
  label: string;
  /** CONTRACT 货架 / 阶段 doc_type，写入 artifact 与路径。 */
  shelf: string;
  docClass?: string;
};

/** 创建下拉：人口语 + 货架名。value 可是别名，提交时用 shelf。 */
export const ARCHIVE_CREATE_TYPES: ArchiveDocChoice[] = [
  { value: "mrd", label: "MRD（立项调研）", shelf: "research", docClass: "mrd" },
  { value: "prd", label: "项目 PRD", shelf: "product-design", docClass: "prd" },
  { value: "research", label: "research", shelf: "research" },
  { value: "product-design", label: "product-design", shelf: "product-design" },
  { value: "architecture", label: "architecture", shelf: "architecture" },
  { value: "retrospective", label: "retrospective", shelf: "retrospective" },
  { value: "requirement", label: "需求单 / 需求级 PRD", shelf: "requirement", docClass: "prd" },
  { value: "plan", label: "plan", shelf: "plan" },
  { value: "decomposition", label: "decomposition", shelf: "decomposition" },
  { value: "design", label: "design", shelf: "design" },
  { value: "test-plan", label: "test-plan", shelf: "test-plan" },
  { value: "deliverables", label: "deliverables", shelf: "deliverables" },
  { value: "acceptance", label: "acceptance", shelf: "acceptance" },
  { value: "report", label: "report", shelf: "report" },
  { value: "work-plan", label: "work-plan（会话计划）", shelf: "work-plan" },
  { value: "change-log", label: "change-log", shelf: "change-log" },
  { value: "filing-software-copyright", label: "filing-software-copyright", shelf: "filing-software-copyright" },
];

const ALIAS_TO_SHELF: Record<string, { shelf: string; docClass?: string }> = {
  prd: { shelf: "product-design", docClass: "prd" },
  mrd: { shelf: "research", docClass: "mrd" },
  brd: { shelf: "research", docClass: "brd" },
  roadmap: { shelf: "work-plan", docClass: "roadmap" },
};

export function resolveArchiveDocChoice(docType: string): {
  shelf: string;
  docClass?: string;
  templateKey: string;
} {
  const key = docType.trim().toLowerCase();
  const listed = ARCHIVE_CREATE_TYPES.find((item) => item.value === key);
  if (listed) {
    return {
      shelf: listed.shelf,
      docClass: listed.docClass,
      templateKey: key,
    };
  }
  const alias = ALIAS_TO_SHELF[key];
  if (alias) {
    return { ...alias, templateKey: key };
  }
  return { shelf: key, templateKey: key };
}

export function renderArchiveTemplate(input: ArchiveTemplateInput): string {
  const today = new Date().toISOString().slice(0, 10);
  const title = input.title.trim() || "未命名文档";
  const req = input.requirementKey?.trim() || "REQ-YYYYMMDD-NN";
  const issue = input.issueId?.trim() || "【待填写：multica issue id】";
  const resolved = resolveArchiveDocChoice(input.docType);
  const raw = SHARED_TEMPLATES[resolved.templateKey] ?? SHARED_TEMPLATES[resolved.shelf] ?? fallbackBody(resolved.shelf, title);
  return fillSharedTemplate(raw, {
    title,
    req,
    issue,
    today,
    shelf: resolved.shelf,
    docClass: resolved.docClass,
  });
}

function fillSharedTemplate(
  raw: string,
  vars: { title: string; req: string; issue: string; today: string; shelf: string; docClass?: string },
): string {
  let out = raw;
  out = out.replaceAll("REQ-YYYYMMDD-NN", vars.req);
  out = out.replaceAll("【待填写：multica issue id】", vars.issue);
  out = out.replaceAll("【待填写：绑定的 issue id】", vars.issue);
  out = out.replaceAll("【待填写：YYYY-MM-DD HH:MM】", vars.today);
  out = out.replace(/^updated_at: .+$/m, `updated_at: ${vars.today}`);
  out = out.replace(/^title: .+$/m, `title: ${vars.title}`);
  out = out.replace(/^# .+$/m, (line) => line.replace(/【待填写：[^\]]+】/, vars.title));
  out = out.replace(/^doc_type: .+$/m, `doc_type: ${vars.shelf}`);
  if (vars.docClass) {
    if (/^doc_class:/m.test(out)) {
      out = out.replace(/^doc_class: .+$/m, `doc_class: ${vars.docClass}`);
    } else {
      out = out.replace(/^doc_type: .+$/m, `doc_type: ${vars.shelf}\ndoc_class: ${vars.docClass}`);
    }
  }
  return out;
}

function fallbackBody(shelf: string, title: string): string {
  return `---
doc_type: ${shelf}
title: ${title}
---

# ${title}

【待填写】
`;
}

/** 正本：projects_mgmt/_shared/format/templates/*.md */
const SHARED_TEMPLATES: Record<string, string> = {
  prd: `---
doc_type: product-design
doc_class: prd
title: 【待填写：PRD 标题】
version: 1
---

# PRD：【待填写：产品/模块】

> **项目级**放置：\`projects/<key>/overview/product-design/\`（本文默认）。
> **需求级**不要用这份当正本：去写 \`requirements/<REQ-KEY>/requirement.md\`，并设 \`doc_class: prd\`，用 \`related\` 指回总 PRD。
> \`doc_type\` 必须是 \`product-design\`；禁止建 \`overview/prd/\`。

## 目标与场景

【待填写：问题、用户、核心场景】

## 范围

| 做 | 不做 |
|---|---|
|  |  |

## 用户动线

【待填写：从进入到完成的步骤】

## 界面与规则

【待填写：页面/状态/权限】

## 验收要点

【待填写：可判定；需求级应落到该 REQ 的 \`acceptance.md\`】

## 边界与异常

【待填写】
`,
  mrd: `---
doc_type: research
doc_class: mrd
title: 【待填写：MRD 标题】
version: 1
---

# MRD：【待填写：主题】

> 放置：\`projects/<key>/overview/research/\`。\`doc_type\` 必须是 \`research\`（C2 调研卡）；\`doc_class: mrd\` 仅供检索。
> 禁止建 \`overview/mrd/\`。

## 结论先行

【待填写：做不做、服务谁、为什么是现在】

## 市场与用户

【待填写：细分、规模、竞品、证据】

## 机会与非目标

【待填写：要抓住的机会；明确不做什么】

## 成功指标

【待填写：可度量】

## 遗留问题

【待填写】
`,
  requirement: `---
doc_type: requirement
multica_issue_id: 【待填写：multica issue id】
status: draft
updated_at: 【待填写：YYYY-MM-DD HH:MM】
title: 【待填写：需求标题】
---

# 需求单：REQ-YYYYMMDD-NN 【待填写：需求标题】

## 状态头

> 需求状态以本文档 frontmatter 为准（status / updated_at）；req_id 与 project 由路径承载（REQ 目录名与 project_key），不再重复书写。
> status 取值：draft / designed / reviewed / ready / approved / executing / blocked /
> switching-model / blocked-escalated / done / accepted。每次状态变更必须同步更新 frontmatter 的 updated_at。

## 子需求清单

| 子需求 | 标题 | 状态 | 备注 |
|---|---|---|---|
| S1 | 【待填写】 | draft | 【待填写】 |

> 每个子需求独立走完整闭环：设计 → 评审 → 测试方案 → 验收标准 → 终审 → 执行 → 心跳 → done → accepted。
> 子需求是 change_logs 记录的最小单位。

## 需求背景

【待填写：需求来源、要解决的问题、预期收益】

## 需求描述

【待填写：具体要做什么；明确边界内 / 边界外】

## 流程记录

| 时间 | 环节 | 产出 | 执行者 |
|---|---|---|---|
| 【待填写】 | 建单 | requirement.md | agent |
`,
  plan: `---
doc_type: plan
multica_issue_id: 【待填写：multica issue id】
status: draft
updated_at: 【待填写：YYYY-MM-DD HH:MM】
title: 【待填写：计划标题】
---

# 执行计划：REQ-YYYYMMDD-NN 【待填写：需求标题】

> 产出角色：PM。确认拆解前必须齐备；与 \`decomposition.md\`、issue.goal 三段同源。

## 目标分解

【待填写：相对需求目标，本轮要拆成哪几块】

## 阶段节奏

| 阶段 | 内容 | 依赖 |
|---|---|---|
| T1 | 【待填写】 |  |

## 风险

【待填写：风险点 / 等级 / 对策】
`,
  decomposition: `---
doc_type: decomposition
multica_issue_id: 【待填写：multica issue id】
status: draft
updated_at: 【待填写：YYYY-MM-DD HH:MM】
title: 【待填写：拆解标题】
---

# 拆解明细：REQ-YYYYMMDD-NN 【待填写：需求标题】

> 确认后写入 issue.feature_points，并批量生成子任务（parent_issue_id / stage / assignee）。

## 功能点

| 编号 | 标题 | 种类 | 代码对象 | 验收标准 |
|---|---|---|---|---|
| F1 | 【待填写】 | new / modify |  |  |

## 图谱影响面

【待填写：模块 / 表 / 接口】
`,
  design: `---
doc_type: design
multica_issue_id: 【待填写：multica issue id】
status: draft
updated_at: 【待填写：YYYY-MM-DD HH:MM】
title: 【待填写：方案标题】
---

# 方案设计：REQ-YYYYMMDD-NN-Sx 【待填写：子需求标题】

> 产出角色：kimi-k3（design）。
> 若为 API 不可用时的规则回退产出，必须在本文件第一行标注：\`> ⚠ 规则回退产出（会话 agent 起草）\`。

## 方案概述

【待填写：一句话说明方案核心思路】

## 详细设计

【待填写：实现方式、涉及模块/文件、关键接口与数据流】

## 影响评估

【待填写：改动影响面（功能/模块/数据）、风险点与等级（low/medium/high/critical）、是否影响既有功能】

## 回滚方案

【待填写：出问题时的回退步骤】
`,
  "test-plan": `---
doc_type: test-plan
multica_issue_id: 【待填写：multica issue id】
status: draft
updated_at: 【待填写：YYYY-MM-DD HH:MM】
title: 【待填写：测试方案标题】
---

# 测试方案：REQ-YYYYMMDD-NN-Sx 【待填写：子需求标题】

> 产出角色：kimi-k3（test）。

## 测试范围

【待填写：本次需要验证的功能点清单】

## 测试用例

| 编号 | 用例 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| T1 | 【待填写】 | 【待填写】 | 【待填写】 | 【待填写】 |

## 回归范围

【待填写：可能受影响的既有功能及回归验证方式】
`,
  acceptance: `---
doc_type: acceptance
multica_issue_id: 【待填写：multica issue id】
status: draft
updated_at: 【待填写：YYYY-MM-DD HH:MM】
title: 【待填写：验收标准标题】
---

# 验收标准：REQ-YYYYMMDD-NN-Sx 【待填写：子需求标题】

> 产出角色：kimi-k3（acceptance）。验收由用户按本清单逐项确认，accepted 仅由用户触发。

## 验收清单

| 编号 | 验收项 | 判定标准 | 结果 |
|---|---|---|---|
| A1 | 【待填写】 | 【待填写】 | 待验收 |

## 验收结论

- 验收人：【待填写】
- 结论：【待填写：通过 / 不通过 / 有条件通过】
- 备注：【待填写】
`,
  report: `---
doc_type: report
title: 【待填写：REQ-KEY】 验收报告
multica_issue_id: 【待填写：绑定的 issue id】
status: done
version: 1
---

# 验收报告：REQ-YYYYMMDD-NN 【待填写：需求标题】

> 放置位置：\`projects/<key>/requirements/<REQ-KEY>/s4-acceptance/\`，文件名多版本时加 \`-r<N>\` 后缀（如 report-r2.md）。

## 验收清单逐项结论

【待填写：对照 acceptance.md 逐项给出 通过/不通过 + 证据】

## 回归验证结果

【待填写：测试执行范围、通过率、失败项处置】

## 遗留风险

【待填写：未覆盖场景、遗留 bug、后续跟进项】
`,
  architecture: `---
doc_type: architecture
title: 【待填写：技术主题】
version: 1
---

# 技术方案：【待填写：技术主题】

> 放置位置：\`projects/<key>/overview/architecture/\`（scope=project，无需 multica_issue_id）。
> 项目架构总纲（checklist 必备项）也在本目录。

## 背景与约束

【待填写：业务背景、技术约束（性能/兼容/依赖现状）】

## 方案对比与决策理由

【待填写：候选方案对比表 + 最终选择与理由（为何淘汰其余方案）】

## 架构设计

【待填写：模块划分、数据流、关键接口、存储设计】

## 影响面

【待填写：受影响的模块/功能/数据；风险点与等级】

## 回退策略

【待填写：出问题时的回退步骤与降级方案】
`,
  research: `---
doc_type: research
title: 【待填写：调研主题】
version: 1
---

# 调研：【待填写：调研主题】

> 放置位置：\`projects/<key>/overview/research/\`（scope=project，无需 multica_issue_id）；
> 跨项目通用调研放 \`_shared/research/\`。

## 结论先行

【待填写：一段话给出调研结论与推荐方向】

## 候选方案对比

【待填写：候选方案清单与对比维度表（能力/成本/生态/风险）】

## 证据来源

【待填写：每项结论的来源链接/文档/实验记录，可复查】

## 遗留问题

【待填写：未决问题与后续跟进建议】
`,
  "product-design": `---
doc_type: product-design
title: 【待填写：功能名】
version: 1
---

# 产品设计：【待填写：功能名】

> 放置位置：\`projects/<key>/overview/product-design/\`（scope=project，无需 multica_issue_id）。

## 目标与场景

【待填写：解决什么问题、目标用户、核心场景】

## 用户动线

【待填写：用户从进入到完成目标的完整操作动线（步骤化）】

## 界面与交互

【待填写：页面/组件结构、关键交互、状态变化】

## 边界与异常

【待填写：空态/错误态/权限边界/极端数据下的表现】
`,
  retrospective: `---
doc_type: retrospective
title: 【待填写：复盘主题】
version: 1
---

# 复盘：【待填写：复盘主题】

> 放置位置：\`projects/<key>/overview/retrospective/\`（scope=project，无需 multica_issue_id）。

## 做了什么

【待填写：本期工作主线与交付物清单（附链接）】

## 踩坑与修复

【待填写：故障模式 → 根因 → 修复方式 → 防再发措施】

## 经验沉淀

【待填写：可复用的经验，应回写到 SOP/记忆系统的条目】

## 待办

【待填写：未完成项与后续计划】
`,
  "work-plan": `---
doc_type: work-plan
project_key: 【待填写：与 projects.yaml key 一致】
tool: cursor
title: 【待填写：计划标题】
related: []
---

# 【待填写：计划标题】

> 放置：\`change_logs/<project_key>/plans/YYYYMMDD_<标题>.md\`。
> 这是会话工作计划，**不是** S2 阶段门的 \`s2-plan/plan.md\`。升级为拆解门时另写档案文件并在 \`related\` 互指。

## 目标

【待填写：这一次会话要完成什么 / 不做什么】

## 步骤

| # | 步骤 | 产出落点（09 章） | 状态 |
|---|---|---|---|
| 1 | 【待填写】 |  | 待做 |

## 风险与依赖

【待填写】

## 完成后

- [ ] 按 [10](../../process/10-开发流程与交付标准.md) DoD 自检
- [ ] 执行记录写 \`change_logs/<key>/daily_logs/\`
`,
  "change-log": `---
doc_type: change-log
project_key: 【待填写】
title: 【待填写】
---

# YYYYMMDD 【待填写：简述】

> 放置：\`change_logs/<project_key>/daily_logs/YYYYMMDD-<简述>.md\`。

## 执行记录

- 时间：
- 工具 / 模型：
- 需求：REQ-… / 无
- 改动文件：
- 对应 run：无 / \`s3-execution/runs/run-NN.md\`

## 影响情况

- 功能影响面：
- 回归验证：
- 遗留风险：
`,
  deliverables: `---
doc_type: deliverables
multica_issue_id: 【待填写】
status: draft
updated_at: 【待填写：YYYY-MM-DD HH:MM】
title: 【待填写：本次交付】
---

# 交付清单：REQ-YYYYMMDD-NN 【待填写】

> 放置：\`projects/<key>/requirements/<REQ-KEY>/s3-execution/deliverables.md\`。
> 只列**本次会话真实 Write/Edit** 的文件，禁止把只读过的文件算作交付。

## 本次文件

| 路径 | 动作 | 说明 |
|---|---|---|
|  | write / edit |  |

## 未交付（只读 / 计划中）

【待填写：无则写「无」】

## 验证

【待填写：跑过的命令、浏览器路径、结果】
`,
};
