import type {
  DefinitionGate,
  DefinitionInput,
  DefinitionNode,
  WorkflowDefinition,
  WorkflowNode,
} from "@multica/core/types";

/**
 * 工作流编辑器的前端 CoCo schema 工具（plan 20261024 §6 JSON 编辑实时校验）。
 *
 * 只用于保存前的即时反馈；服务端 service.ValidateWorkflowDefinition 是最终事实源
 * （展平后还额外校验节点数 1..50 与无环）。这里刻意保持「结构规则同形、不重复
 * 展平」，避免与 Go 侧漂移——展平规则变更只改 Go，前端自动以服务端错误兜底。
 */

export const COCO_KIND = "coco.workflow.template";

const NODE_KINDS = new Set(["stage", "iteration", "parallel", "branch"]);
const NODE_MODES = new Set(["auto", "human_loop"]);

/** 新建模板的空白骨架（挂在 iteration 之外的单个 stage 便于立即可编辑）。 */
export function blankDefinition(name = ""): WorkflowDefinition {
  return {
    schemaVersion: 2,
    kind: COCO_KIND,
    name,
    description: "",
    nodes: [
      {
        kind: "stage",
        id: "stage-1",
        name: "阶段 1",
        mode: "auto",
        inputs: [],
        outputs: [],
      },
    ],
  };
}

/** 安全解析：文本 → WorkflowDefinition；非法 JSON 或非对象时抛错由调用方兜住。 */
export function parseDefinition(text: string): WorkflowDefinition {
  const obj = JSON.parse(text) as unknown;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("definition must be a JSON object");
  }
  return obj as WorkflowDefinition;
}

/**
 * 把服务端旧版线性 WorkflowNode[]（需求日历等 official 模板的运行时形态：
 * mode 为 auto|human、用 next 表后继、带 stage 序号与 gate_doc_types）展开成
 * 编辑器 / 画布唯一渲染的 CoCo 嵌套 definition。
 *
 * 服务端只有 nested→linear 的 FlattenWorkflowDefinition、无反向展开，故线性→
 * 嵌套的适配只能在前端做（不改契约、不改 Go）。映射：按 stage 升序排为顶层
 * stage 块；mode human→human_loop、其余→auto；agent_ref→roleId；prompt 直传；
 * 每个块 inputs 由「哪些块 next 含本 id」反推（重建 DAG）。id 原样保留，因此
 * 展平回服务端时图等价。
 */
export function definitionFromLinearNodes(
  nodes: WorkflowNode[],
  meta: { name?: string; description?: string } = {},
): WorkflowDefinition {
  const list = [...(nodes ?? [])].sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0));
  const stageNodes: DefinitionNode[] = list.map((n) => {
    const predecessorInputs: DefinitionInput[] = list
      .filter((p) => (p.next ?? []).includes(n.id))
      .map((p) => ({ fromStageId: p.id }));
    // 线性态的 gate_doc_types = 本阶段执行前必检的外部/必备输入资产；
    // 展开为 required 的 in-input，保证与嵌套 definition 双向回环等价。
    const requiredAssets: DefinitionInput[] = (n.gate_doc_types ?? []).map((dt) => ({
      outputName: dt,
      assetRole: "in",
      required: true,
    }));
    return {
      kind: "stage",
      id: n.id,
      name: n.name ?? "",
      mode: n.mode === "human" ? "human_loop" : "auto",
      roleId: n.agent_ref || undefined,
      prompt: n.prompt,
      inputs: [...predecessorInputs, ...requiredAssets],
      outputs: (n.outputs ?? []) as DefinitionNode["outputs"],
    };
  });
  return {
    schemaVersion: 2,
    kind: COCO_KIND,
    name: meta.name ?? "",
    description: meta.description ?? "",
    nodes: stageNodes,
  };
}

/**
 * 从模板实体推导可编辑的 definition：definition 列已是 CoCo 嵌套态则直接用，
 * 否则从旧的线性 nodes 列展开（两者皆空时回退空白骨架）。编辑器种子化与
 * 克隆为草稿共用此入口，确保 official 模板也能看到真实流程、克隆不丢内容。
 */
export function definitionFromTemplate(t: {
  name?: string;
  description?: string | null;
  nodes?: WorkflowNode[];
  definition?: WorkflowDefinition | Record<string, never>;
}): WorkflowDefinition {
  const d = t.definition as Partial<WorkflowDefinition> | undefined;
  if (d && typeof d.schemaVersion === "number" && Array.isArray(d.nodes)) {
    return d as WorkflowDefinition;
  }
  const nodes = Array.isArray(t.nodes) ? t.nodes : [];
  if (nodes.length > 0) {
    return definitionFromLinearNodes(nodes, { name: t.name, description: t.description ?? "" });
  }
  return blankDefinition(t.name ?? "");
}

/**
 * 结构校验，返回错误信息数组（空数组 = 通过）。镜像 Go 的递归规则子集：
 * id 非空且全局唯一、kind 白名单、mode 白名单、gate 仅挂 iteration、
 * inputs[].fromStageId 引用存在、至少一个节点、schemaVersion 正整数。
 */
export function validateCocoDefinition(def: WorkflowDefinition | Record<string, unknown>): string[] {
  const errors: string[] = [];
  const d = def as Partial<WorkflowDefinition>;
  if (typeof d.schemaVersion !== "number" || d.schemaVersion <= 0) {
    errors.push("schemaVersion 必须为正整数");
  }
  if (d.kind && d.kind !== COCO_KIND) {
    errors.push(`kind 必须为 "${COCO_KIND}"`);
  }
  const nodes = Array.isArray(d.nodes) ? d.nodes : undefined;
  if (!nodes || nodes.length === 0) {
    errors.push("至少需要一个节点（nodes 非空）");
    return errors;
  }

  const ids = new Set<string>();
  const stageIds = new Set<string>();
  const gateIds = new Set<string>();

  const collect = (list: DefinitionNode[]): void => {
    for (const n of list) {
      if (!n || typeof n !== "object") {
        errors.push("存在非法节点对象");
        continue;
      }
      if (!n.id) {
        errors.push("节点 id 不能为空");
      } else if (ids.has(n.id)) {
        errors.push(`重复的节点 id：${n.id}`);
      } else {
        ids.add(n.id);
      }
      if (!NODE_KINDS.has(n.kind)) {
        errors.push(`节点 ${n.id || "?"} 的 kind 非法：${n.kind}`);
      }
      if (n.mode && !NODE_MODES.has(n.mode)) {
        errors.push(`节点 ${n.id || "?"} 的 mode 必须为 auto 或 human_loop`);
      }
      if (n.kind === "stage") {
        stageIds.add(n.id);
      }
      if (n.gate) {
        if (n.kind !== "iteration") {
          errors.push(`节点 ${n.id || "?"} 非 iteration 不能挂 gate`);
        }
        if (!n.gate.id) {
          errors.push(`iteration ${n.id || "?"} 的 gate 缺少 id`);
        } else if (gateIds.has(n.gate.id)) {
          errors.push(`重复的 gate id：${n.gate.id}`);
        } else if (ids.has(n.gate.id)) {
          errors.push(`gate id ${n.gate.id} 与节点 id 冲突`);
        } else {
          gateIds.add(n.gate.id);
          ids.add(n.gate.id);
        }
      }
      if (n.children && n.children.length) {
        collect(n.children);
      }
    }
  };
  collect(nodes);

  const checkRefs = (list: DefinitionNode[]): void => {
    for (const n of list) {
      for (const input of n.inputs ?? []) {
        if (input.fromStageId && !stageIds.has(input.fromStageId)) {
          errors.push(`节点 ${n.id} 的输入引用了未知 fromStageId：${input.fromStageId}`);
        }
      }
      if (n.children && n.children.length) {
        checkRefs(n.children);
      }
    }
  };
  checkRefs(nodes);

  return errors;
}

/** 统计展平后 stage/gate 数量（编辑器摘要用，非权威）。 */
export function countStages(def: WorkflowDefinition): { stages: number; gates: number } {
  let stages = 0;
  let gates = 0;
  const walk = (list: DefinitionNode[]): void => {
    for (const n of list) {
      if (n.kind === "stage") stages += 1;
      if (n.gate) gates += 1;
      if (n.children && n.children.length) walk(n.children);
    }
  };
  walk(def.nodes ?? []);
  return { stages, gates };
}

/** 阶段流概览：段数 + 迭代块 / 并行块计数（对标 CoCo「8 段 · 1 并行块 · 1 迭代块」）。 */
export function countBlocks(
  def: WorkflowDefinition,
): { stages: number; gates: number; iterations: number; parallels: number } {
  let stages = 0;
  let gates = 0;
  let iterations = 0;
  let parallels = 0;
  const walk = (list: DefinitionNode[]): void => {
    for (const n of list) {
      if (n.kind === "stage") stages += 1;
      if (n.kind === "iteration") {
        iterations += 1;
        if (n.gate) gates += 1;
      }
      if (n.kind === "parallel") parallels += 1;
      if (n.children && n.children.length) walk(n.children);
    }
  };
  walk(def.nodes ?? []);
  return { stages, gates, iterations, parallels };
}

/** 一个 stage 连同其所属容器（最近的 iteration/parallel/branch 名称）与全局序号。 */
export interface StageWithGroup {
  node: DefinitionNode;
  group: string | null;
  index: number;
}

/** 深度优先收集全部 stage，附带所属分组名与 1-based 序号（可视化表单按此渲染）。 */
export function flattenStagesWithGroup(def: WorkflowDefinition): StageWithGroup[] {
  const out: StageWithGroup[] = [];
  let index = 0;
  const walk = (list: DefinitionNode[], group: string | null): void => {
    for (const n of list) {
      if (n.kind === "stage") {
        index += 1;
        out.push({ node: n, group, index });
      } else if (n.children && n.children.length) {
        walk(n.children, n.name || group);
      }
    }
  };
  walk(def.nodes ?? [], null);
  return out;
}

/** 收集全部 iteration 的门（可视化表单按此渲染门文案编辑）。 */
export function flattenGates(
  def: WorkflowDefinition,
): { iteration: DefinitionNode; gate: DefinitionGate }[] {
  const out: { iteration: DefinitionNode; gate: DefinitionGate }[] = [];
  const walk = (list: DefinitionNode[]): void => {
    for (const n of list) {
      if (n.kind === "iteration" && n.gate) out.push({ iteration: n, gate: n.gate });
      if (n.children && n.children.length) walk(n.children);
    }
  };
  walk(def.nodes ?? []);
  return out;
}

/** 从 definition.roleNames 解析智能体显示名；无映射回空串（调用方兜底 roleId）。 */
export function roleName(def: WorkflowDefinition, roleId?: string): string {
  if (!roleId) return "";
  return def.roleNames?.[roleId] ?? "";
}

/** 按 id 反查 stage 名（解析 inputs[].fromStageId 的展示），找不到回退 id。 */
export function stageNameById(def: WorkflowDefinition, id: string): string {
  let found = "";
  const walk = (list: DefinitionNode[]): void => {
    for (const n of list) {
      if (found) return;
      if (n.id === id && n.kind === "stage") {
        found = n.name || id;
        return;
      }
      if (n.children && n.children.length) walk(n.children);
    }
  };
  walk(def.nodes ?? []);
  return found || id;
}

// ---------------------------------------------------------------------------
// 结构性编辑纯函数（可视化块树用）。全部不可变：返回新 definition，供编辑器
// 回灌单一 JSON 文本缓冲。服务端 Validate/Flatten 仍是最终事实源，这里只保证
// 产出的结构合法（id 唯一、容器有子、删除级联清理悬空 fromStageId）。
// ---------------------------------------------------------------------------

/** 生成与现有节点 id / gate id 都不冲突的序号化 id。 */
export function genNodeId(def: WorkflowDefinition, prefix: string): string {
  const used = new Set<string>();
  const walk = (list: DefinitionNode[]): void => {
    for (const n of list) {
      if (n.id) used.add(n.id);
      if (n.gate?.id) used.add(n.gate.id);
      if (n.children && n.children.length) walk(n.children);
    }
  };
  walk(def.nodes ?? []);
  let i = 1;
  while (used.has(`${prefix}-${i}`)) i += 1;
  return `${prefix}-${i}`;
}

/**
 * 造一个新块。iteration 自带一个 gate 与一个子 stage、parallel 自带一个 branch
 * （内含一个 stage），保证插入即可通过结构校验、无需再手动补子节点。
 */
function makeNode(def: WorkflowDefinition, kind: DefinitionNode["kind"]): DefinitionNode {
  const newStage = (): DefinitionNode => ({
    kind: "stage",
    id: genNodeId(def, "stage"),
    name: "",
    mode: "auto",
    inputs: [],
    outputs: [],
  });
  if (kind === "stage") return newStage();
  if (kind === "iteration") {
    return {
      kind: "iteration",
      id: genNodeId(def, "iter"),
      name: "",
      gate: { id: genNodeId(def, "gate"), mode: "human_loop", loopLabel: "", exitLabel: "" },
      children: [newStage()],
    };
  }
  if (kind === "parallel") {
    return {
      kind: "parallel",
      id: genNodeId(def, "par"),
      name: "",
      children: [{ kind: "branch", id: genNodeId(def, "branch"), name: "", children: [newStage()] }],
    };
  }
  // branch
  return { kind: "branch", id: genNodeId(def, "branch"), name: "", children: [newStage()] };
}

/** 在顶层追加一个块（stage / iteration / parallel）。 */
export function addTopNode(def: WorkflowDefinition, kind: DefinitionNode["kind"]): WorkflowDefinition {
  return { ...def, nodes: [...(def.nodes ?? []), makeNode(def, kind)] };
}

/** 在指定容器（iteration/parallel/branch）下追加一个子块。 */
export function addChildNode(
  def: WorkflowDefinition,
  parentId: string,
  kind: DefinitionNode["kind"],
): WorkflowDefinition {
  const child = makeNode(def, kind);
  const walk = (list: DefinitionNode[]): DefinitionNode[] =>
    list.map((n) => {
      if (n.id === parentId) return { ...n, children: [...(n.children ?? []), child] };
      if (n.children && n.children.length) return { ...n, children: walk(n.children) };
      return n;
    });
  return { ...def, nodes: walk(def.nodes ?? []) };
}

/**
 * 删除任意节点（含容器）。级联清理所有节点上指向被删 id 的 inputs[].fromStageId，
 * 避免留下悬空引用导致服务端校验失败。删除后若某容器变空，保留空容器由校验兜底
 * （编辑器 UI 应阻止删除最后一个顶层节点）。
 */
export function removeNode(def: WorkflowDefinition, id: string): WorkflowDefinition {
  const drop = (list: DefinitionNode[]): DefinitionNode[] =>
    list.filter((n) => n.id !== id).map((n) => (n.children && n.children.length ? { ...n, children: drop(n.children) } : n));
  const cleanRefs = (list: DefinitionNode[]): DefinitionNode[] =>
    list.map((n) => ({
      ...n,
      inputs: n.inputs ? n.inputs.filter((inp) => inp.fromStageId !== id) : n.inputs,
      children: n.children && n.children.length ? cleanRefs(n.children) : n.children,
    }));
  return { ...def, nodes: cleanRefs(drop(def.nodes ?? [])) };
}

/** 子树（含自身）是否包含某 id——用于阻止把容器拖入其后代的自环。 */
function subtreeHasId(node: DefinitionNode, id: string): boolean {
  if (node.id === id) return true;
  return (node.children ?? []).some((c) => subtreeHasId(c, id));
}

/** 深度查找节点。 */
function findNode(list: DefinitionNode[], id: string): DefinitionNode | null {
  for (const n of list) {
    if (n.id === id) return n;
    const hit = n.children ? findNode(n.children, id) : null;
    if (hit) return hit;
  }
  return null;
}

/** 从列表（含嵌套）中摘除某节点，返回剩余列表与被摘节点（不动 inputs 引用）。 */
function detachNode(
  list: DefinitionNode[],
  id: string,
): { rest: DefinitionNode[]; removed: DefinitionNode | null } {
  const out: DefinitionNode[] = [];
  let removed: DefinitionNode | null = null;
  for (const n of list) {
    if (n.id === id) {
      removed = n;
      continue;
    }
    if (n.children && n.children.length) {
      const r = detachNode(n.children, id);
      if (r.removed) removed = r.removed;
      out.push({ ...n, children: r.rest });
    } else {
      out.push(n);
    }
  }
  return { rest: out, removed };
}

function spliceAt(list: DefinitionNode[], node: DefinitionNode, index: number): DefinitionNode[] {
  const copy = [...list];
  const clamped = Math.max(0, Math.min(index, copy.length));
  copy.splice(clamped, 0, node);
  return copy;
}

/**
 * 把一个节点移动到目标容器（targetParentId=null 表示顶层）的指定下标。
 * 画布拖拽重排/跨块移动的唯一写入口。防护：不能移到自身或自己的后代内；
 * 移动不改 id，故其他节点指向它的 inputs 仍有效（不做引用清理）。
 */
export function moveNodeTo(
  def: WorkflowDefinition,
  nodeId: string,
  targetParentId: string | null,
  targetIndex: number,
): WorkflowDefinition {
  if (nodeId === targetParentId) return def;
  const nodes = def.nodes ?? [];
  const moving = findNode(nodes, nodeId);
  if (!moving) return def;
  if (targetParentId && subtreeHasId(moving, targetParentId)) return def;
  const { rest, removed } = detachNode(nodes, nodeId);
  if (!removed) return def;
  const moved = removed;
  if (!targetParentId) {
    return { ...def, nodes: spliceAt(rest, moved, targetIndex) };
  }
  const insert = (list: DefinitionNode[]): DefinitionNode[] =>
    list.map((n) => {
      if (n.id === targetParentId) return { ...n, children: spliceAt(n.children ?? [], moved, targetIndex) };
      if (n.children && n.children.length) return { ...n, children: insert(n.children) };
      return n;
    });
  return { ...def, nodes: insert(rest) };
}

/** 在同一父列表内上移 / 下移一个节点；已在边界则原样返回。 */
export function moveNode(
  def: WorkflowDefinition,
  id: string,
  dir: "up" | "down",
): WorkflowDefinition {
  const swapIn = (list: DefinitionNode[]): { list: DefinitionNode[]; moved: boolean } => {
    const idx = list.findIndex((n) => n.id === id);
    if (idx >= 0) {
      const j = dir === "up" ? idx - 1 : idx + 1;
      if (j < 0 || j >= list.length) return { list, moved: true };
      const copy = [...list];
      const a = copy[idx] as DefinitionNode;
      const b = copy[j] as DefinitionNode;
      copy[idx] = b;
      copy[j] = a;
      return { list: copy, moved: true };
    }
    let moved = false;
    const next = list.map((n) => {
      if (!n.children || !n.children.length || moved) return n;
      const r = swapIn(n.children);
      if (r.moved) {
        moved = true;
        return { ...n, children: r.list };
      }
      return n;
    });
    return { list: next, moved };
  };
  return { ...def, nodes: swapIn(def.nodes ?? []).list };
}

/** 为一个 stage 追加一条来自上游 stage 产物的输入连线。 */
export function addStageInput(
  def: WorkflowDefinition,
  stageId: string,
  input: DefinitionInput,
): WorkflowDefinition {
  const walk = (list: DefinitionNode[]): DefinitionNode[] =>
    list.map((n) => {
      if (n.id === stageId) return { ...n, inputs: [...(n.inputs ?? []), input] };
      if (n.children && n.children.length) return { ...n, children: walk(n.children) };
      return n;
    });
  return { ...def, nodes: walk(def.nodes ?? []) };
}

/** 维护 definition.roleNames 映射（智能体显示名）；名空则删除该键。 */
export function setRoleName(def: WorkflowDefinition, roleId: string, name: string): WorkflowDefinition {
  const roleNames = { ...(def.roleNames ?? {}) };
  if (name.trim()) roleNames[roleId] = name;
  else delete roleNames[roleId];
  return { ...def, roleNames };
}

/** 可连线上游清单：除自身外所有 stage 及其产物（连线下拉数据源）。 */
export function listStageOutputs(
  def: WorkflowDefinition,
  excludeId: string,
): { stageId: string; stageName: string; outputs: { id: string; name: string }[] }[] {
  const out: { stageId: string; stageName: string; outputs: { id: string; name: string }[] }[] = [];
  const walk = (list: DefinitionNode[]): void => {
    for (const n of list) {
      if (n.kind === "stage" && n.id !== excludeId) {
        out.push({
          stageId: n.id,
          stageName: n.name || n.id,
          outputs: (n.outputs ?? []).map((o) => ({ id: o.id, name: o.name })),
        });
      }
      if (n.children && n.children.length) walk(n.children);
    }
  };
  walk(def.nodes ?? []);
  return out;
}

// ---------------------------------------------------------------------------
// 阶段资产准入 + 目标/模板编辑纯函数（plan 101 C3/C4/C5）。
// 全部不可变：回灌同一 definition，供编辑器 JSON 缓冲保持一致。
// ---------------------------------------------------------------------------

/** 深度查找 stage 并应用变换（不改其他节点）。 */
function mapStage(
  def: WorkflowDefinition,
  stageId: string,
  fn: (n: DefinitionNode) => DefinitionNode,
): WorkflowDefinition {
  const walk = (list: DefinitionNode[]): DefinitionNode[] =>
    list.map((n) => {
      if (n.kind === "stage" && n.id === stageId) return fn(n);
      if (n.children && n.children.length) return { ...n, children: walk(n.children) };
      return n;
    });
  return { ...def, nodes: walk(def.nodes ?? []) };
}

/** 一条输入是否为「执行前必检的外部/必备输入」：required 且非本阶段自产(out)。 */
export function isRequiredAsset(input: DefinitionInput): boolean {
  return input.required === true && input.assetRole !== "out";
}

/** 本阶段准入必检项（供画布徽标 / 门禁条 / 映射回 gate_doc_types）。 */
export function stageRequiredAssets(def: WorkflowDefinition, stageId: string): DefinitionInput[] {
  let found: DefinitionInput[] = [];
  const walk = (list: DefinitionNode[]): void => {
    for (const n of list) {
      if (found.length) return;
      if (n.kind === "stage" && n.id === stageId) {
        found = (n.inputs ?? []).filter(isRequiredAsset);
        return;
      }
      if (n.children && n.children.length) walk(n.children);
    }
  };
  walk(def.nodes ?? []);
  return found;
}

/** 本阶段准入必检项的资产名清单（映射引擎 WorkflowNode.gate_doc_types）。 */
export function stageGateDocTypes(def: WorkflowDefinition, stageId: string): string[] {
  return stageRequiredAssets(def, stageId).map((i) => i.outputName || i.outputId || "").filter(Boolean);
}

/** 设置 stage 的目标/判定/输入模板/输出模板/正文等标量字段（只覆盖传入键）。 */
export function setStageField(
  def: WorkflowDefinition,
  stageId: string,
  patch: Partial<Pick<DefinitionNode, "name" | "prompt" | "goal" | "criteria" | "inputTpl" | "outputTpl">>,
): WorkflowDefinition {
  return mapStage(def, stageId, (n) => ({ ...n, ...patch }));
}

/** 追加一个执行前必检的外部/必备输入资产（assetRole=in, required=true）。 */
export function addRequiredAsset(
  def: WorkflowDefinition,
  stageId: string,
  name: string,
): WorkflowDefinition {
  const trimmed = name.trim();
  if (!trimmed) return def;
  return mapStage(def, stageId, (n) => ({
    ...n,
    inputs: [...(n.inputs ?? []), { outputName: trimmed, assetRole: "in", required: true }],
  }));
}

/** 删除某条输入（按数组下标）。 */
export function removeInputAt(
  def: WorkflowDefinition,
  stageId: string,
  index: number,
): WorkflowDefinition {
  return mapStage(def, stageId, (n) => {
    const inputs = [...(n.inputs ?? [])];
    if (index < 0 || index >= inputs.length) return n;
    inputs.splice(index, 1);
    return { ...n, inputs };
  });
}

/** 切换某条输入的必检标记。 */
export function setInputRequired(
  def: WorkflowDefinition,
  stageId: string,
  index: number,
  required: boolean,
): WorkflowDefinition {
  return mapStage(def, stageId, (n) => {
    const inputs = [...(n.inputs ?? [])];
    const target = inputs[index];
    if (!target) return n;
    inputs[index] = { ...target, required };
    return { ...n, inputs };
  });
}
