import {
  FIVE_STAGE_PLACEMENTS,
  lifecycleForPlacement,
  placementForLifecycle,
} from "@multica/core/artifacts";
import type {
  ArtifactStage,
  AssetBinding,
  AssetLifecycleStage,
  ProjectArtifact,
} from "@multica/core/types";

/**
 * 新增档案弹窗的三类正文来源：
 *  - write  手写正文（模板起步，现状行为）
 *  - upload 上传本地文件（先存附件，再落档案，可选同步为资产）
 *  - asset  从项目资产管理里挑已上传的文件直接挂载到当前档案位置
 */
export type ArtifactSourceMode = "write" | "upload" | "asset";

/**
 * 档案 placement → 可同步的资产阶段。S0..S5 返回对应值；(NULL,'asset')、
 * 矛盾组合与开放式 doc_type 返回 null —— 资产侧没有对应阶段时禁止同步，
 * 否则服务端按 general 回写会把档案踢进未分阶保留区、从矩阵里消失。
 */
export function syncLifecycleForPlacement(input: {
  stage: ArtifactStage | null;
  docType: string;
}): AssetLifecycleStage | null {
  const lifecycle = lifecycleForPlacement({
    stage: input.stage,
    docType: input.docType,
  });
  return lifecycle === "general" ? null : lifecycle;
}

/**
 * 同步到资产时档案实际落库的 doc_type，取资产阶段的唯一映射值。
 * 服务端 bind 会在同一事务里按 lifecycle 回写原档案的 (stage, doc_type)，
 * 创建时就用映射值可以让回写幂等，避免 design → architecture 的二次跳变。
 */
export function docTypeForSyncLifecycle(lifecycle: AssetLifecycleStage): string {
  return placementForLifecycle(lifecycle).docType;
}

/**
 * 上传 / 资产挂载时档案落库的 doc_type。
 *
 * 矩阵缺件给的是「证据种类」（design / test-plan / prototype …），而服务端只认
 * 五货架组合，`(stage 3, 'design')` 无法映射资产阶段。挂文件时按 stage 归一到
 * 货架 doc_type（3 → architecture），证据种类继续由 rel_path 的文件名承载
 * （matrix 的 docKindOf 只看路径），列归属与缺件判定都不受影响。
 */
export function shelfDocTypeForMount(
  stage: ArtifactStage | null,
  docType: string,
): string {
  if (stage != null) {
    const shelf = FIVE_STAGE_PLACEMENTS.find((rule) => rule.stage === stage);
    if (shelf) return shelf.docType;
  }
  return docType;
}

/** 纯文本类扩展名：可以读回正文、参与 frontmatter 写回。 */
const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "yaml",
  "yml",
  "csv",
  "log",
  "xml",
]);

/** 取文件名末段的扩展名（小写、不带点）；无扩展名返回 ""。 */
export function fileExtension(name: string): string {
  const base = name.trim().split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isTextArchiveFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(fileExtension(name));
}

/**
 * 把 rel_path 末段的扩展名换成本地文件的扩展名：`.../design.md` +
 * `架构设计.pdf` → `.../design.pdf`。基名不变，矩阵仍按 docKind 认列。
 */
export function withFileExtension(relPath: string, fileName: string): string {
  const ext = fileExtension(fileName);
  const trimmed = relPath.trim();
  if (!ext || !trimmed) return relPath;
  if (/\.[^./\\]+$/.test(trimmed)) return `${trimmed.replace(/\.[^./\\]+$/, "")}.${ext}`;
  return `${trimmed}.${ext}`;
}

/** 资产名：去掉扩展名的文件名（空则回退原值）。 */
export function assetNameFromFile(fileName: string): string {
  const base = fileName.trim().split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim() || base || "untitled";
}

/** 人类可读的文件大小（KB / MB 一位小数）。 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 可挂载的资产候选：必须有附件指针，且未被任何档案占用。 */
export interface AssetMountCandidate {
  binding: AssetBinding;
  attachmentId: string;
  filename: string;
  /** 已有档案引用同一附件，或该行本身就是「档案 → 资产」导入行。 */
  mounted: boolean;
}

/**
 * 资产库 → 挂载候选。只收 external_ref.attachment_id 可用的行（没有附件就没有
 * 可挂载的正文）；已入档（含档案导入行）沉底并禁用，避免同一附件重复挂载。
 */
export function assetMountCandidates(
  bindings: readonly AssetBinding[],
  artifacts: readonly ProjectArtifact[],
): AssetMountCandidate[] {
  const mountedAttachments = new Set(
    artifacts
      .map((artifact) => artifact.attachment_id)
      .filter((id): id is string => Boolean(id)),
  );
  const out: AssetMountCandidate[] = [];
  for (const binding of bindings) {
    const ref = binding.external_ref ?? {};
    const attachmentId =
      typeof ref.attachment_id === "string" ? ref.attachment_id.trim() : "";
    if (!attachmentId) continue;
    const imported =
      typeof ref.artifact_id === "string" && ref.artifact_id.trim() !== "";
    const refFilename =
      typeof ref.filename === "string" && ref.filename.trim() !== ""
        ? ref.filename.trim()
        : "";
    const filename =
      refFilename ||
      [binding.asset_name, binding.asset_subtype]
        .filter((part): part is string => Boolean(part))
        .join(".");
    out.push({
      binding,
      attachmentId,
      filename,
      mounted: imported || mountedAttachments.has(attachmentId),
    });
  }
  return out.sort(
    (a, b) =>
      Number(a.mounted) - Number(b.mounted) ||
      a.filename.localeCompare(b.filename),
  );
}

/** 资产候选按文件名 / 资产名做本地检索。 */
export function filterMountCandidates(
  candidates: readonly AssetMountCandidate[],
  query: string,
): AssetMountCandidate[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return [...candidates];
  return candidates.filter((candidate) =>
    `${candidate.filename} ${candidate.binding.asset_name} ${
      candidate.binding.asset_subtype ?? ""
    }`
      .toLowerCase()
      .includes(keyword),
  );
}
