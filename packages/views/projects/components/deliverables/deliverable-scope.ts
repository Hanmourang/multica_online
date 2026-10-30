import type { ProjectArtifact } from "@multica/core/types";

/**
 * 交付物口径（C9 交付物 TAB）：只有产出物进交付物 TAB。
 *
 * 判定分两类，事实源不同但结论同形：
 *  1. 没有关联资产（asset_binding_id 为空）= git 同步 / agent 归档 / 手工建档
 *     的档案行，本来就是需求产出，保留。
 *  2. 关联了资产（原生入档或 archive-import）= 资产管理侧的条目，按资产「对象」
 *     判定：output（产物）保留；input（输入）/ 未标 / 未解析到一律不进——
 *     在资产管理上传的资料默认是输入，只有显式标成产物才算交付物。
 *
 * 服务端只在列表响应上补 asset_binding_id / asset_role 两个字段，档案 TAB、
 * 矩阵、阶段门禁仍读全量行，因此本口径只影响交付物 TAB 与其徽标。
 */
export function isDeliverableArtifact(artifact: ProjectArtifact): boolean {
  if (!artifact.asset_binding_id) return true;
  return artifact.asset_role === "output";
}

/** 拆分出交付物与「因对象≠产物而被挡下」的条数（用于如实提示隐藏了多少）。 */
export function splitDeliverables(artifacts: ProjectArtifact[]): {
  deliverables: ProjectArtifact[];
  hiddenNonOutput: number;
} {
  const deliverables: ProjectArtifact[] = [];
  let hiddenNonOutput = 0;
  for (const artifact of artifacts) {
    if (isDeliverableArtifact(artifact)) deliverables.push(artifact);
    else hiddenNonOutput += 1;
  }
  return { deliverables, hiddenNonOutput };
}
