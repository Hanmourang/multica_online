// 资产五阶段 ↔ 档案 (stage, doc_type) 唯一映射（五阶段对齐 plan §5.1）。
//
// 与 Go 端 server/internal/handler/project_asset_archive_placement.go 的
// lifecyclePlacementMap 是同一张契约表，两侧取值必须一致（placement.test.ts
// 钉死；Go 侧 placement 单测镜像同一表）。货架列表、矩阵列、统计分母、
// 阶段筛选和编辑器一律从本模块派生，禁止在 TSX 中另写四/五阶段硬编码。
//
// S1 项目规划 ↔ 1 ↔ research；S2 产品原型 ↔ 2 ↔ product-design；
// S3 技术方案 ↔ 3 ↔ architecture；S4 问题复盘 ↔ 4 ↔ retrospective；
// S5 需求迭代 ↔ 5 ↔ iteration。general / 未标 → (null, 'asset') 未分阶保留区。
// S0 需求描述 ↔ (null, 'requirement')：不在 1..5 日历阶段域内，只作需求 × 阶段
// 矩阵的 S0 列归属（migration 500 放宽 lifecycle CHECK）。
//
// 货架归属只认 doc_type；doc_module 是货架内独立模块标签，不参与阶段映射。

import type { ArtifactStage } from "../types/artifact";
import type { AssetLifecycleStage } from "../types/asset";

/** 档案行的货架归属二元组；stage=null 表示未分阶。 */
export interface ArchivePlacement {
  readonly stage: ArtifactStage | null;
  readonly docType: string;
}

/** 未分阶保留区形态（与 Go assetUnstagedPlacement 同值）。 */
export const ASSET_UNSTAGED_PLACEMENT: ArchivePlacement = { stage: null, docType: "asset" };

/**
 * S0 需求描述：资产阶段 ↔ (stage NULL, doc_type 'requirement')。stage 置空是因为
 * 档案日历阶段只存 1..5；需求 × 阶段矩阵以 doc_type 'requirement' 认这列。
 */
export const ASSET_S0_PLACEMENT: ArchivePlacement = { stage: null, docType: "requirement" };

/** 五阶段映射表（顺序即货架/矩阵列顺序，与 Go lifecyclePlacementMap 同值）。 */
export const FIVE_STAGE_PLACEMENTS: readonly {
  lifecycle: AssetLifecycleStage;
  stage: ArtifactStage;
  docType: string;
}[] = [
  { lifecycle: "S1", stage: 1, docType: "research" },
  { lifecycle: "S2", stage: 2, docType: "product-design" },
  { lifecycle: "S3", stage: 3, docType: "architecture" },
  { lifecycle: "S4", stage: 4, docType: "retrospective" },
  { lifecycle: "S5", stage: 5, docType: "iteration" },
];

/** 五货架 doc_type 集合（资产关联行的合法归属，矩阵/货架列顺序同源）。 */
export const SHELF_DOC_TYPES: readonly string[] = FIVE_STAGE_PLACEMENTS.map((p) => p.docType);

/** 档案阶段 1..5 集合（矩阵列、筛选器分母；不含未分阶区）。 */
export const ARTIFACT_STAGES: readonly ArtifactStage[] = FIVE_STAGE_PLACEMENTS.map((p) => p.stage);

/** 未分阶保留区 doc_type。 */
export const UNSTAGED_DOC_TYPE = "asset";

export function isArtifactStage(value: unknown): value is ArtifactStage {
  return typeof value === "number" && (ARTIFACT_STAGES as readonly number[]).includes(value);
}

export function isShelfDocType(docType: string): boolean {
  return SHELF_DOC_TYPES.includes(docType);
}

/** 资产阶段 → 档案 placement；general/未知服务端值 → 未分阶保留区（防御式）。 */
export function placementForLifecycle(lifecycle: AssetLifecycleStage | string | null | undefined): ArchivePlacement {
  const key = (lifecycle ?? "").trim().toUpperCase();
  if (key === "S0") return ASSET_S0_PLACEMENT;
  for (const rule of FIVE_STAGE_PLACEMENTS) {
    if (rule.lifecycle === key) return { stage: rule.stage, docType: rule.docType };
  }
  return ASSET_UNSTAGED_PLACEMENT;
}

/** 档案 stage → 资产 lifecycle；null/越界 → general（未知值不抛错）。 */
export function lifecycleForArtifactStage(stage: ArtifactStage | null | undefined): AssetLifecycleStage {
  const key = (stage ?? null) as ArtifactStage | null;
  for (const rule of FIVE_STAGE_PLACEMENTS) {
    if (rule.stage === key) return rule.lifecycle;
  }
  return "general";
}

/**
 * 档案 placement → 资产 lifecycle。只接受五种合法组合与 (null, 'asset')；
 * 矛盾组合 / 未知 stage 一律返回 general（服务端为最终校正方，前端仅展示）。
 */
export function lifecycleForPlacement(placement: ArchivePlacement): AssetLifecycleStage {
  if (placement.stage == null) {
    return placement.docType === ASSET_S0_PLACEMENT.docType ? "S0" : "general";
  }
  for (const rule of FIVE_STAGE_PLACEMENTS) {
    if (rule.stage === placement.stage && rule.docType === placement.docType) return rule.lifecycle;
  }
  return "general";
}

/** doc_type → 档案 stage（非货架 doc_type 无法唯一确定，返回 null）。 */
export function stageForShelfDocType(docType: string): ArtifactStage | null {
  for (const rule of FIVE_STAGE_PLACEMENTS) {
    if (rule.docType === docType) return rule.stage;
  }
  return null;
}

/**
 * 标准货架间移动后的 rel_path：仅当前路径位于 overview/<旧货架>/ 前缀下才替换
 * 货架段；'asset/' 前缀与自定义路径返回 null（不动，防路径乒乓）。
 * 与 Go shelfRelPathForMove 同语义。
 */
export function shelfRelPathForMove(currentRelPath: string, oldDocType: string, newDocType: string): string | null {
  const rel = currentRelPath.trim();
  if (!oldDocType || !newDocType || oldDocType === newDocType) return null;
  const prefix = `overview/${oldDocType}/`;
  if (!rel.startsWith(prefix)) return null;
  return `overview/${newDocType}/${rel.slice(prefix.length)}`;
}
