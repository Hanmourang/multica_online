import { UNSTAGED_DOC_TYPE } from "@multica/core/artifacts";
import type { ArtifactStage, ProjectArtifact } from "@multica/core/types";

/**
 * 需求证据文档类型：由文件名 / 路径段判定，不看 `doc_type`——同步侧把需求级
 * 文档的 doc_type 记成货架名（research / product-design / architecture），
 * 只有路径与文件名稳定承载「这是哪份证据」。
 */
export type RequirementDocKind =
  | "requirement"
  | "prototype"
  | "plan"
  | "decomposition"
  | "design"
  | "test-plan"
  | "acceptance"
  | "report"
  | "other";

/** 需求 × 阶段矩阵四列：S0 需求描述 / S2 产品原型 / S3 技术方案 / S4 落地及复盘。 */
export type RequirementColumn = "s0" | "s2" | "s3" | "s4";

export const REQUIREMENT_COLUMNS: readonly RequirementColumn[] = ["s0", "s2", "s3", "s4"];

/** 每列收录的文档类型；计划/拆解是 S3 的过程稿，进列但不设门。 */
export const COLUMN_DOC_KINDS: Record<RequirementColumn, RequirementDocKind[]> = {
  s0: ["requirement"],
  s2: ["prototype"],
  s3: ["plan", "decomposition", "design", "test-plan"],
  s4: ["acceptance", "report"],
};

/** 与 checklist.yaml / stage_gate 对齐的 blocking 缺件：一列内必须有齐的类型。 */
export const BLOCKING_BY_COLUMN: Record<RequirementColumn, RequirementDocKind[]> = {
  s0: ["requirement"],
  s2: ["prototype"],
  s3: ["design", "test-plan"],
  s4: ["acceptance", "report"],
};

/** 缺件一键新建的落点：与 requirements/<KEY>/s<N>-<slug>/ 目录契约一致。 */
export const DOC_KIND_PLACEMENT: Record<
  RequirementDocKind,
  { stage: ArtifactStage | null; docType: string }
> = {
  requirement: { stage: null, docType: "requirement" },
  prototype: { stage: 1, docType: "prototype" },
  plan: { stage: 2, docType: "plan" },
  decomposition: { stage: 2, docType: "decomposition" },
  design: { stage: 3, docType: "design" },
  "test-plan": { stage: 3, docType: "test-plan" },
  acceptance: { stage: 4, docType: "acceptance" },
  report: { stage: 4, docType: "report" },
  other: { stage: null, docType: "requirement" },
};

/** 文件名优先：plan.md / report-r1.md / prototype-v2.html 之类一眼可判。 */
const BASENAME_KIND: Array<[RequirementDocKind, RegExp]> = [
  ["requirement", /^requirement(?:$|[-_.])/],
  ["prototype", /^prototype(?:$|[-_.])/],
  ["decomposition", /^decomposition(?:$|[-_.])/],
  ["test-plan", /^test-?plan(?:$|[-_.])/],
  ["design", /^(?:design|tech-design)(?:$|[-_.])/],
  ["acceptance", /^acceptance(?:$|[-_.])/],
  ["report", /^report(?:$|[-_.])/],
  ["plan", /^plan(?:$|[-_.])/],
];

/** 文件名不可判时退到目录段（s1-prototype / s2-plan / s3-execution / s4-acceptance）。 */
const SEGMENT_KIND: Array<[RequirementDocKind, RegExp]> = [
  ["prototype", /^s1-prototype$/],
  ["plan", /^s2-plan$/],
  ["design", /^s3-execution$/],
  ["acceptance", /^s4-acceptance$/],
  ["requirement", /^s0-/],
];

export function docKindOf(artifact: ProjectArtifact): RequirementDocKind {
  const segments = artifact.rel_path.replace(/\\/g, "/").toLowerCase().split("/");
  const base = (segments.pop() ?? "").replace(/\.(md|mdx|html?|txt)$/i, "");
  for (const [kind, pattern] of BASENAME_KIND) {
    if (pattern.test(base)) return kind;
  }
  for (const [kind, pattern] of SEGMENT_KIND) {
    if (segments.some((segment) => pattern.test(segment))) return kind;
  }
  return "other";
}

/**
 * 资产节点分布 → 矩阵列：S0 需求描述 / S2 产品原型 / S3 技术方案 / S4 落地及复盘。
 * S1（需求侧仍是 s1-prototype 目录）归产品原型，S5 迭代归落地及复盘；
 * 未标 / general 不由资产决定，继续走文档类型判定。
 */
export const ASSET_STAGE_COLUMN: Record<string, RequirementColumn> = {
  S0: "s0",
  S1: "s2",
  S2: "s2",
  S3: "s3",
  S4: "s4",
  S5: "s4",
};

/**
 * 档案 → 矩阵列。资产节点优先（人工标注的阶段），再退到文件名 / 目录段；
 * 仍无法判定时落 S0，保证「标记了需求 / 任务的档案一定能进矩阵」不丢行。
 */
export function columnForArtifact(
  artifact: ProjectArtifact,
  assetStage?: string | null,
): RequirementColumn {
  const byAsset = assetStage
    ? ASSET_STAGE_COLUMN[assetStage.trim().toUpperCase()]
    : undefined;
  if (byAsset) return byAsset;
  const kind = docKindOf(artifact);
  for (const column of REQUIREMENT_COLUMNS) {
    if (COLUMN_DOC_KINDS[column].includes(kind)) return column;
  }
  switch (artifact.stage) {
    case 1:
      return "s2";
    case 2:
    case 3:
      return "s3";
    case 4:
    case 5:
      return "s4";
    default:
      return "s0";
  }
}

/**
 * 文档是否进「需求 × 阶段矩阵」：项目内有需求 / 任务归属（issue_id 或 task_id）
 * 即纳入，不再只认 scope=requirement；需求级档案即使暂无归属也保留（历史同步
 * 清单只带 requirement_key）。change-log（项目流水）与未分阶保留区不参与。
 */
export function entersRequirementMatrix(artifact: ProjectArtifact): boolean {
  if (artifact.scope === "shared") return false;
  if (artifact.doc_type === "change-log" || artifact.doc_type === UNSTAGED_DOC_TYPE) {
    return false;
  }
  if (artifact.scope === "requirement") return true;
  return Boolean(artifact.issue_id || artifact.task_id);
}

export function missingBlockingDocKinds(
  column: RequirementColumn,
  files: ProjectArtifact[],
): RequirementDocKind[] {
  const present = new Set(files.map(docKindOf));
  return BLOCKING_BY_COLUMN[column].filter((kind) => !present.has(kind));
}

export function requirementMissingBlocking(
  cells: Map<RequirementColumn, ProjectArtifact[]>,
): boolean {
  return REQUIREMENT_COLUMNS.some(
    (column) => missingBlockingDocKinds(column, cells.get(column) ?? []).length > 0,
  );
}

/** 就绪度分母 = 四列；每列必须有齐 blocking 类型才算填上。 */
export function columnReadiness(cells: Map<RequirementColumn, ProjectArtifact[]>): {
  filled: number;
  total: number;
} {
  const filled = REQUIREMENT_COLUMNS.filter(
    (column) => missingBlockingDocKinds(column, cells.get(column) ?? []).length === 0,
  ).length;
  return { filled, total: REQUIREMENT_COLUMNS.length };
}
